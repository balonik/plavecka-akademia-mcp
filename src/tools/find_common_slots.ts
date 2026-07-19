/**
 * `find_common_slots` tool: fetches the (cached) listing for each requested category,
 * groups courses by centre and weekday, and returns only the centre/day combinations
 * where every requested category has at least one matching course.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fetchPaginated, type ClientOptions } from '../site/client.js';
import { buildCourseListUrl, SLOVAK_WEEKDAYS } from '../site/constants.js';
import { resolveCategory, resolveCentre, resolveDay } from '../site/normalize.js';
import { parseList, type CourseSummary } from '../site/parseList.js';
import { courseSchema } from './list_courses.js';

export interface FindCommonSlotsInput {
  categories: string[];
  // `| undefined` kept explicit alongside `?:` for exactOptionalPropertyTypes
  // compatibility with the zod-parsed MCP callback argument.
  location?: string | undefined;
  day?: string | undefined;
  onlyAvailable?: boolean | undefined;
}

export interface CommonSlotMatch {
  centre: string;
  day: string;
  coursesByCategory: Record<string, CourseSummary[]>;
}

export type FindCommonSlotsOutput = {
  matches: CommonSlotMatch[];
};

/** Small concurrency cap on the multi-category fan-out, so we don't hammer the upstream site. */
const CONCURRENCY_LIMIT = 3;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) {
        return;
      }
      const item = items[current];
      if (item === undefined) {
        return;
      }
      results[current] = await fn(item);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function findCommonSlots(
  input: FindCommonSlotsInput,
  options: ClientOptions = {},
): Promise<FindCommonSlotsOutput> {
  if (input.categories.length === 0) {
    throw new Error('Provide at least one category.');
  }
  // De-duplicate by resolved slug: "korytnacka" and "Korytnačka" are the same category, and
  // without this the "every requested category is present" check below is satisfied twice
  // over by one category's courses, reporting slots as serving two categories when they
  // serve one.
  const categoryDefs = [
    ...new Map(
      input.categories.map((c) => resolveCategory(c)).map((def) => [def.slug, def]),
    ).values(),
  ];
  const centre = input.location !== undefined ? resolveCentre(input.location) : undefined;
  const day = input.day !== undefined ? resolveDay(input.day) : undefined;
  const onlyAvailable = input.onlyAvailable ?? false;

  const perCategory = await mapWithConcurrency(categoryDefs, CONCURRENCY_LIMIT, async (def) => {
    const url = buildCourseListUrl(def.slug, {
      centres: centre !== undefined ? [centre] : undefined,
    });
    let courses = await fetchPaginated(url, parseList, options);
    if (onlyAvailable) {
      courses = courses.filter((c) => c.capacity.available);
    }
    return { category: def.slug, courses };
  });

  // buckets: centre -> day -> category slug -> matching courses
  const buckets = new Map<string, Map<string, Map<string, CourseSummary[]>>>();
  for (const { category, courses } of perCategory) {
    for (const course of courses) {
      for (const slot of course.schedule) {
        if (day !== undefined && slot.day !== day) {
          continue;
        }
        let byDay = buckets.get(course.centre);
        if (!byDay) {
          byDay = new Map();
          buckets.set(course.centre, byDay);
        }
        let byCategory = byDay.get(slot.day);
        if (!byCategory) {
          byCategory = new Map();
          byDay.set(slot.day, byCategory);
        }
        let list = byCategory.get(category);
        if (!list) {
          list = [];
          byCategory.set(category, list);
        }
        list.push(course);
      }
    }
  }

  const requestedSlugs = categoryDefs.map((d) => d.slug);
  const matches: CommonSlotMatch[] = [];
  for (const [centreName, byDay] of buckets) {
    for (const [dayName, byCategory] of byDay) {
      const hasAllCategories = requestedSlugs.every(
        (slug) => (byCategory.get(slug)?.length ?? 0) > 0,
      );
      if (!hasAllCategories) {
        continue;
      }
      const coursesByCategory: Record<string, CourseSummary[]> = {};
      for (const slug of requestedSlugs) {
        coursesByCategory[slug] = byCategory.get(slug) ?? [];
      }
      matches.push({ centre: centreName, day: dayName, coursesByCategory });
    }
  }

  matches.sort((a, b) => {
    if (a.centre !== b.centre) return a.centre.localeCompare(b.centre);
    return SLOVAK_WEEKDAYS.indexOf(a.day) - SLOVAK_WEEKDAYS.indexOf(b.day);
  });

  return { matches };
}

const inputSchema = {
  categories: z
    .array(z.string())
    .min(1)
    .describe('Category slugs or display names, e.g. ["zralok", "delfin", "korytnacka"].'),
  location: z
    .string()
    .optional()
    .describe('Restrict to a single centre, diacritic/case-insensitive.'),
  day: z.string().optional().describe('Restrict to a single weekday, Slovak or English.'),
  onlyAvailable: z.boolean().optional(),
};

const outputSchema = {
  matches: z.array(
    z.object({
      centre: z.string(),
      day: z.string(),
      coursesByCategory: z.record(z.string(), z.array(courseSchema)),
    }),
  ),
};

export function registerFindCommonSlotsTool(server: McpServer): void {
  server.registerTool(
    'find_common_slots',
    {
      title: 'Find common centre/day slots across categories',
      description:
        'Finds centre + weekday combinations where every requested category has at least one matching course, with the concrete courses per category. Useful for "book Žralok + Delfín + Korytnačka at the same place" style questions.',
      inputSchema,
      outputSchema,
    },
    async (input) => {
      try {
        const result = await findCommonSlots(input);
        const text =
          result.matches.length === 0
            ? 'No centre/day combination has all requested categories available.'
            : result.matches
                .map(
                  (m) => `${m.centre} on ${m.day}: ${Object.keys(m.coursesByCategory).join(', ')}`,
                )
                .join('\n');
        return { content: [{ type: 'text' as const, text }], structuredContent: result };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
          ],
          isError: true,
        };
      }
    },
  );
}
