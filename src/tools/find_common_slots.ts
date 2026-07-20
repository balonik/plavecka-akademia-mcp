/**
 * `find_common_slots` tool: fetches the (cached) listing for each requested
 * category+level, groups courses by centre and weekday, and returns only the
 * centre/day combinations where every requested (category, level) has at least
 * one matching course.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fetchPaginated, type ClientOptions } from '../site/client.js';
import { buildCourseListUrl, LEVEL_TO_PARAM, SLOVAK_WEEKDAYS } from '../site/constants.js';
import { resolveCategory, resolveCentre, resolveDay } from '../site/normalize.js';
import { parseList, type CourseSummary } from '../site/parseList.js';
import { courseSchema } from './list_courses.js';
import { applyPaging } from './paging.js';

export interface CategoryLevelRequest {
  category: string;
  // `| undefined` kept explicit for exactOptionalPropertyTypes, matching the convention
  // used throughout this file and list_courses.ts.
  level?: '*' | '**' | 'any' | undefined;
}

export interface FindCommonSlotsInput {
  categories: CategoryLevelRequest[];
  location?: string | undefined;
  day?: string | undefined;
  onlyAvailable?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface CommonSlotGroup {
  category: string;
  level: '*' | '**' | 'any';
  courses: CourseSummary[];
}

export interface CommonSlotMatch {
  centre: string;
  day: string;
  groups: CommonSlotGroup[];
}

export type FindCommonSlotsOutput = {
  total: number;
  returned: number;
  offset: number;
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

interface Requirement {
  key: string;
  slug: string;
  level: '*' | '**' | 'any';
}

export async function findCommonSlots(
  input: FindCommonSlotsInput,
  options: ClientOptions = {},
): Promise<FindCommonSlotsOutput> {
  if (input.categories.length === 0) {
    throw new Error('Provide at least one category.');
  }

  const resolved = input.categories.map((c) => {
    const def = resolveCategory(c.category);
    const level = c.level ?? 'any';
    if (level !== 'any' && !def.hasSubLevels) {
      throw new Error(
        `Category "${def.slug}" does not offer sub-levels, so "level" must be omitted or "any".`,
      );
    }
    return { def, level };
  });

  // De-duplicate on the (slug, level) pair: "korytnacka" and "Korytnačka" are the same
  // category, and without this the "every requested (category, level) is present" check
  // below is satisfied twice over by one requirement's courses, reporting slots as
  // serving two requirements when they serve one. The composite key also means the same
  // category at two different levels (e.g. Žralok* and Žralok**) stays two distinct
  // requirements rather than collapsing into one.
  const requirements = [
    ...new Map(
      resolved.map(({ def, level }) => [
        `${def.slug}|${level}`,
        { key: `${def.slug}|${level}`, slug: def.slug, level },
      ]),
    ).values(),
  ];

  const centre = input.location !== undefined ? resolveCentre(input.location) : undefined;
  const day = input.day !== undefined ? resolveDay(input.day) : undefined;
  const onlyAvailable = input.onlyAvailable ?? false;

  const perRequirement = await mapWithConcurrency(
    requirements,
    CONCURRENCY_LIMIT,
    async (req: Requirement) => {
      const levelParam = req.level === 'any' ? undefined : LEVEL_TO_PARAM[req.level];
      const url = buildCourseListUrl(req.slug, {
        centres: centre !== undefined ? [centre] : undefined,
        levelParam,
      });
      let courses = await fetchPaginated(url, parseList, options);
      if (req.level !== 'any') {
        // Zero-star rows come back under BOTH upstream uroven[] values, so a specific
        // level must post-filter on the exact star count. See CLAUDE.md site-fact #4.
        courses = courses.filter((c) => c.level === req.level);
      }
      if (onlyAvailable) {
        courses = courses.filter((c) => c.capacity.available);
      }
      return { requirement: req, courses };
    },
  );

  // buckets: centre -> day -> requirement key -> matching courses
  const buckets = new Map<string, Map<string, Map<string, CourseSummary[]>>>();
  for (const { requirement, courses } of perRequirement) {
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
        let byRequirement = byDay.get(slot.day);
        if (!byRequirement) {
          byRequirement = new Map();
          byDay.set(slot.day, byRequirement);
        }
        let list = byRequirement.get(requirement.key);
        if (!list) {
          list = [];
          byRequirement.set(requirement.key, list);
        }
        list.push(course);
      }
    }
  }

  const matches: CommonSlotMatch[] = [];
  for (const [centreName, byDay] of buckets) {
    for (const [dayName, byRequirement] of byDay) {
      const hasAllRequirements = requirements.every(
        (req) => (byRequirement.get(req.key)?.length ?? 0) > 0,
      );
      if (!hasAllRequirements) {
        continue;
      }
      const groups: CommonSlotGroup[] = requirements.map((req) => ({
        category: req.slug,
        level: req.level,
        courses: byRequirement.get(req.key) ?? [],
      }));
      matches.push({ centre: centreName, day: dayName, groups });
    }
  }

  matches.sort((a, b) => {
    if (a.centre !== b.centre) return a.centre.localeCompare(b.centre);
    return SLOVAK_WEEKDAYS.indexOf(a.day) - SLOVAK_WEEKDAYS.indexOf(b.day);
  });

  // Paged for the same reason list_courses is: a broad request (one category, no location)
  // matches every centre/day pair and attaches every course to it, which is a larger payload
  // than the unpaged listing this tool exists to spare the caller from reading.
  const paged = applyPaging(matches, input.limit, input.offset);
  return {
    total: paged.total,
    returned: paged.returned,
    offset: paged.offset,
    matches: paged.items,
  };
}

const inputSchema = {
  categories: z
    .array(
      z.object({
        category: z
          .string()
          .describe(
            'Category slug or display name, e.g. "zralok" or "Žralok" (diacritic/case-insensitive).',
          ),
        level: z
          .enum(['*', '**', 'any'])
          .optional()
          .describe(
            'Sub-level filter for this category; omit or "any" for no filter. Must be omitted (or "any") for categories with no sub-levels (e.g. morsky-konik).',
          ),
      }),
    )
    .min(1)
    .describe(
      'Category + optional level requirements, e.g. [{"category":"zralok","level":"**"},{"category":"delfin"}]. The same category may appear twice at different levels.',
    ),
  location: z
    .string()
    .optional()
    .describe('Restrict to a single centre, diacritic/case-insensitive.'),
  day: z.string().optional().describe('Restrict to a single weekday, Slovak or English.'),
  onlyAvailable: z
    .boolean()
    .optional()
    .describe(
      'Forward-compatibility hook, currently a no-op: the site has no sold-out state, so every listed course is bookable (free / last one / last two places) and this narrows nothing. Do not pass it expecting fewer results.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of centre/day matches to return. Omit for all of them.'),
  offset: z.number().int().nonnegative().optional(),
};

const outputSchema = {
  total: z.number(),
  returned: z.number(),
  offset: z.number(),
  matches: z.array(
    z.object({
      centre: z.string(),
      day: z.string(),
      groups: z.array(
        z.object({
          category: z.string(),
          level: z.enum(['*', '**', 'any']),
          courses: z.array(courseSchema),
        }),
      ),
    }),
  ),
};

function formatGroupLabel(group: { category: string; level: '*' | '**' | 'any' }): string {
  return group.level === 'any' ? group.category : `${group.category} ${group.level}`;
}

export function registerFindCommonSlotsTool(server: McpServer): void {
  server.registerTool(
    'find_common_slots',
    {
      title: 'Find common centre/day slots across categories',
      description:
        'Finds centre + weekday combinations where every requested category (optionally at a specific sub-level) has at least one matching course, with the concrete courses per requirement. Useful for "book Žralok** + Delfín* at the same place" style questions.',
      inputSchema,
      outputSchema,
    },
    async (input) => {
      try {
        const result = await findCommonSlots(input);
        const text =
          result.total === 0
            ? 'No centre/day combination has all requested categories available.'
            : [
                `${String(result.total)} centre/day combination(s) match, showing ${String(result.returned)} from offset ${String(result.offset)}.`,
                ...result.matches.map(
                  (m) => `${m.centre} on ${m.day}: ${m.groups.map(formatGroupLabel).join(', ')}`,
                ),
              ].join('\n');
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
