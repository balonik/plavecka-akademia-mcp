/**
 * `get_course` tool: fetches a single live detail page by numeric id or by URL.
 *
 * SSRF guard: when a `url` is supplied, its parsed hostname must EXACTLY equal
 * `plaveckaakademia.sk` or `www.plaveckaakademia.sk` (case-insensitively) and its
 * protocol must be `https:`. This is a strict equality check against an allowlist Set,
 * never a prefix/substring/`startsWith` check -- those are trivially bypassable
 * (e.g. `https://plaveckaakademia.sk.evil.example/` would pass a naive `startsWith`
 * check but must be rejected here).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { assertAllowedHost, get, type ClientOptions } from '../site/client.js';
import { BASE_URL } from '../site/constants.js';
import { parseDetail, type CourseDetail } from '../site/parseDetail.js';

export interface GetCourseInput {
  // `| undefined` kept explicit alongside `?:` for exactOptionalPropertyTypes
  // compatibility with the zod-parsed MCP callback argument.
  courseId?: string | undefined;
  url?: string | undefined;
}

/**
 * Paths this tool has any legitimate reason to fetch: a canonical course detail page, or
 * the numeric-id shortlink. Without this the tool is an open GET proxy -- a caller could
 * point it at any path on the host (`/user/login?destination=...`, admin paths, anything
 * user-submittable) and have the response parsed into the calling model's context.
 */
const ALLOWED_PATH_PATTERNS = [/^\/plavecky-kurz\/[^/]+\/[^/]+\/\d+$/, /^\/node\/\d+$/];

function validateAllowedUrl(rawUrl: string): string {
  // Protocol / exact host / port / credentials are all enforced by the shared client
  // guard, which also re-checks every redirect hop.
  const parsed = assertAllowedHost(rawUrl);
  if (!ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(parsed.pathname))) {
    throw new Error(
      `"url" path "${parsed.pathname}" is not a course detail page; expected /plavecky-kurz/<category>/<pool>/<id> or /node/<id>.`,
    );
  }
  return parsed.toString();
}

function resolveTargetUrl(input: GetCourseInput): string {
  const { courseId, url } = input;
  if (courseId !== undefined && url !== undefined) {
    throw new Error('Provide either "courseId" or "url", not both.');
  }
  if (url !== undefined) {
    return validateAllowedUrl(url);
  }
  if (courseId !== undefined) {
    if (!/^\d+$/.test(courseId)) {
      throw new Error(`"courseId" must be a numeric id, got "${courseId}".`);
    }
    // The site's own shortlink form. Verified live: it serves the detail page with a 200
    // directly rather than redirecting, so no redirect-following is required here.
    return `${BASE_URL}/node/${courseId}`;
  }
  throw new Error('Provide either "courseId" or "url".');
}

export async function getCourse(
  input: GetCourseInput,
  options: ClientOptions = {},
): Promise<CourseDetail> {
  const targetUrl = resolveTargetUrl(input);
  const html = await get(targetUrl, options);
  return parseDetail(html);
}

const daySlotSchema = z.object({ day: z.string(), from: z.string(), to: z.string() });
const dateSchema = z.object({ raw: z.string(), iso: z.string(), yearInferred: z.boolean() });

const outputSchema = {
  id: z.string(),
  url: z.string(),
  categorySlug: z.string(),
  categoryName: z.string(),
  subLevel: z.enum(['*', '**']).nullable(),
  ageRange: z.string(),
  venueName: z.string(),
  centre: z.string(),
  address: z.string(),
  dateRange: z.object({ start: dateSchema, end: dateSchema }),
  schedule: z.array(daySlotSchema),
  lessons: z.object({ total: z.number(), replaceable: z.number() }),
  price: z.object({ amount: z.number(), currency: z.literal('EUR'), raw: z.string() }),
  capacity: z.object({
    available: z.boolean(),
    status: z.enum(['free', 'last_one', 'last_two', 'unknown']),
    raw: z.string(),
  }),
  bookingUrl: z.string().nullable(),
  sessions: z.array(z.string()),
};

const inputSchema = {
  courseId: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe('Numeric course id (the trailing segment of a course URL).'),
  url: z
    .url()
    .optional()
    .describe(
      'Full detail-page URL; must be https://plaveckaakademia.sk/... (or www.). Provide this or courseId, not both.',
    ),
};

export function registerGetCourseTool(server: McpServer): void {
  server.registerTool(
    'get_course',
    {
      title: 'Get course details',
      description:
        'Fetches the live detail page for a single course by numeric id or URL: address, date range, day/time, price, lesson counts, age range, availability, booking URL and session calendar.',
      inputSchema,
      outputSchema,
    },
    async (input) => {
      try {
        const detail = await getCourse(input);
        const text = [
          `${detail.categoryName}${detail.subLevel ?? ''} at ${detail.centre} (${detail.venueName})`,
          `Address: ${detail.address}`,
          `Age range: ${detail.ageRange}`,
          `Dates: ${detail.dateRange.start.iso} - ${detail.dateRange.end.iso}`,
          `Schedule: ${detail.schedule.map((s) => `${s.day} ${s.from}-${s.to}`).join(', ')}`,
          `Price: ${detail.price.raw} (${String(detail.lessons.total)} lessons, ${String(detail.lessons.replaceable)} replaceable)`,
          `Availability: ${detail.capacity.raw}`,
          `Booking: ${detail.bookingUrl ?? 'n/a'}`,
        ].join('\n');
        return { content: [{ type: 'text' as const, text }], structuredContent: detail };
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
