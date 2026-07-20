/**
 * `list_courses` tool: fetches the (upstream centre/level-filtered) listing for a
 * category and applies every other filter in-server over the full, defensively
 * paginated result set.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fetchPaginated, type ClientOptions } from '../site/client.js';
import { buildCourseListUrl, LEVEL_TO_PARAM } from '../site/constants.js';
import { resolveCategory, resolveCentre, resolveDay } from '../site/normalize.js';
import { parseList, type CourseSummary } from '../site/parseList.js';
import { applyPaging } from './paging.js';

export interface ListCoursesInput {
  category: string;
  // Optional fields are typed `T | undefined` (rather than bare `field?: T`) so this
  // interface stays compatible with `exactOptionalPropertyTypes` regardless of whether
  // the zod-parsed MCP callback argument includes the key with an explicit `undefined`
  // value or omits it entirely.
  location?: string | undefined;
  level?: '*' | '**' | 'any' | undefined;
  day?: string | undefined;
  timeFrom?: string | undefined;
  timeTo?: string | undefined;
  startAfter?: string | undefined;
  startBefore?: string | undefined;
  maxPrice?: number | undefined;
  onlyAvailable?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export type ListCoursesOutput = {
  total: number;
  returned: number;
  offset: number;
  courses: CourseSummary[];
};

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/**
 * Parses "HH:MM" into minutes, throwing on anything else.
 *
 * Validating rather than coercing matters: an unparseable value used to yield `NaN`, and
 * every subsequent comparison against `NaN` is false, so a typo'd `timeFrom` silently
 * returned the entire unfiltered listing as though it had been filtered. The zod schema
 * guards the MCP transport only -- `listCourses` is exported and called directly.
 */
function timeToMinutes(time: string, field: string): number {
  const match = TIME_PATTERN.exec(time.trim());
  const hours = match?.[1];
  const minutes = match?.[2];
  if (hours === undefined || minutes === undefined) {
    throw new Error(`"${field}" must be a time in HH:MM form, got "${time}".`);
  }
  const hoursNum = Number(hours);
  const minutesNum = Number(minutes);
  if (hoursNum > 23 || minutesNum > 59) {
    throw new Error(`"${field}" is not a valid time of day, got "${time}".`);
  }
  return hoursNum * 60 + minutesNum;
}

export async function listCourses(
  input: ListCoursesInput,
  options: ClientOptions = {},
): Promise<ListCoursesOutput> {
  const category = resolveCategory(input.category);
  const centre = input.location !== undefined ? resolveCentre(input.location) : undefined;
  const day = input.day !== undefined ? resolveDay(input.day) : undefined;
  const level = input.level ?? 'any';
  const { timeFrom, timeTo, startAfter, startBefore, maxPrice } = input;
  const onlyAvailable = input.onlyAvailable ?? false;
  const offset = input.offset ?? 0;
  const { limit } = input;

  const levelParam = level === 'any' ? undefined : LEVEL_TO_PARAM[level];
  const url = buildCourseListUrl(category.slug, {
    centres: centre !== undefined ? [centre] : undefined,
    levelParam,
  });

  let courses = await fetchPaginated(url, parseList, options);

  if (level !== 'any') {
    // Zero-star rows are returned under both upstream `uroven[]` filter values, so a
    // specific level request must post-filter to the exact star count.
    courses = courses.filter((c) => c.level === level);
  }

  if (day !== undefined || timeFrom !== undefined || timeTo !== undefined) {
    const fromMinutes = timeFrom !== undefined ? timeToMinutes(timeFrom, 'timeFrom') : undefined;
    const toMinutes = timeTo !== undefined ? timeToMinutes(timeTo, 'timeTo') : undefined;
    courses = courses.filter((c) =>
      c.schedule.some((slot) => {
        if (day !== undefined && slot.day !== day) return false;
        if (fromMinutes !== undefined && timeToMinutes(slot.from, 'schedule') < fromMinutes) {
          return false;
        }
        if (toMinutes !== undefined && timeToMinutes(slot.to, 'schedule') > toMinutes) {
          return false;
        }
        return true;
      }),
    );
  }

  if (startAfter !== undefined) {
    courses = courses.filter((c) => c.startDate.iso >= startAfter);
  }
  if (startBefore !== undefined) {
    courses = courses.filter((c) => c.startDate.iso <= startBefore);
  }
  if (maxPrice !== undefined) {
    courses = courses.filter((c) => c.price.amount <= maxPrice);
  }
  if (onlyAvailable) {
    courses = courses.filter((c) => c.capacity.available);
  }

  const paged = applyPaging(courses, limit, offset);
  return {
    total: paged.total,
    returned: paged.returned,
    offset: paged.offset,
    courses: paged.items,
  };
}

const dayInputSchema = z.object({ day: z.string(), from: z.string(), to: z.string() });

export const courseSchema = z.object({
  id: z.string(),
  url: z.string(),
  poolSlug: z.string(),
  centre: z.string(),
  level: z.enum(['*', '**']).nullable(),
  frequency: z.string(),
  schedule: z.array(dayInputSchema),
  startDate: z.object({ raw: z.string(), iso: z.string(), yearInferred: z.boolean() }),
  price: z.object({ amount: z.number(), currency: z.literal('EUR'), raw: z.string() }),
  lessonsRaw: z.string(),
  capacity: z.object({
    available: z.boolean(),
    status: z.enum(['free', 'last_one', 'last_two', 'unknown']),
    raw: z.string(),
  }),
});

const inputSchema = {
  category: z
    .string()
    .describe(
      'Category slug or display name, e.g. "zralok" or "Žralok" (diacritic/case-insensitive).',
    ),
  location: z
    .string()
    .optional()
    .describe('Centre name, diacritic/case-insensitive, e.g. "devinska" -> "Devínska".'),
  level: z
    .enum(['*', '**', 'any'])
    .optional()
    .describe('Sub-level filter; omit or "any" for no filter.'),
  day: z.string().optional().describe('Weekday, Slovak or English, e.g. "piatok" or "friday".'),
  timeFrom: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .optional()
    .describe('Only courses with a schedule slot starting at or after this time (HH:MM).'),
  timeTo: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .optional()
    .describe('Only courses with a schedule slot ending at or before this time (HH:MM).'),
  startAfter: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Only courses starting on or after this ISO date.'),
  startBefore: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Only courses starting on or before this ISO date.'),
  maxPrice: z.number().positive().optional(),
  onlyAvailable: z
    .boolean()
    .optional()
    .describe(
      'Forward-compatibility hook, currently a no-op: the site has no sold-out state, so every listed course is bookable (free / last one / last two places) and this narrows nothing. Do not pass it expecting fewer results.',
    ),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
};

const outputSchema = {
  total: z.number(),
  returned: z.number(),
  offset: z.number(),
  courses: z.array(courseSchema),
};

export function registerListCoursesTool(server: McpServer): void {
  server.registerTool(
    'list_courses',
    {
      title: 'List swimming courses',
      description:
        'Lists course terms for a category, filtered by centre/level upstream and by day, time window, start date range, price and availability in-server. Returns { total, returned, offset, courses[] }.',
      inputSchema,
      outputSchema,
    },
    async (input) => {
      try {
        const result = await listCourses(input);
        const text =
          `${String(result.total)} course(s) match, showing ${String(result.returned)} from offset ${String(result.offset)}.\n` +
          result.courses
            .map(
              (c) =>
                `#${c.id} ${c.centre} - ${c.schedule.map((s) => `${s.day} ${s.from}-${s.to}`).join(', ')} - starts ${c.startDate.iso} - ${c.price.raw} - ${c.capacity.status}`,
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
