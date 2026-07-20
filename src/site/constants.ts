/**
 * Static site knowledge: category slugs, centres, level mapping, base URL and the
 * Drupal Views container selector. Values here were verified against the recorded
 * fixtures in `test/fixtures/` and the live site during analysis (see the plan doc).
 */

export interface CategoryDef {
  /** URL slug used in the listing path, e.g. `https://plaveckaakademia.sk/kurzy/plavanie-pre-deti/<slug>`. */
  readonly slug: string;
  /** Slovak display name, exactly as it appears on the site. */
  readonly name: string;
  /** Whether this category is offered at `*` / `**` sub-levels (scraped/confirmed live, not just this static flag). */
  readonly hasSubLevels: boolean;
}

/** The four skill categories. Order matches the site's own progression (youngest first). */
export const CATEGORIES: readonly CategoryDef[] = [
  { slug: 'morsky-konik', name: 'Morský koník', hasSubLevels: false },
  { slug: 'korytnacka', name: 'Korytnačka', hasSubLevels: true },
  { slug: 'delfin', name: 'Delfín', hasSubLevels: true },
  { slug: 'zralok', name: 'Žralok', hasSubLevels: true },
];

/** Exact `stredisko[]` values accepted by the exposed filter form. */
export const CENTRES: readonly string[] = [
  'Banšelova',
  'Barónka',
  'Devínska',
  'Dúbravka',
  'Limbach',
  'Podunajské Biskupice',
  'Ružinov',
  'Šustekova',
];

/** Sub-level symbol -> upstream `uroven[]` filter value. */
export const LEVEL_TO_PARAM = { '*': '0', '**': '1' } as const;

export type LevelSymbol = keyof typeof LEVEL_TO_PARAM;

/** Star-image count on a row -> level symbol. Zero stars means "no sub-level". */
export function starsToLevel(starCount: number): LevelSymbol | null {
  if (starCount === 1) return '*';
  if (starCount === 2) return '**';
  return null;
}

export type CapacityStatus = 'free' | 'last_one' | 'last_two' | 'unknown';

export interface Capacity {
  /** All three known capacity classes (and, defensively, any unrecognised one) mean "bookable". */
  available: boolean;
  status: CapacityStatus;
  raw: string;
}

/**
 * Maps a single capacity `<span>` class to a normalised status. All three known classes
 * mean "bookable"; an unrecognised class maps to "unknown" rather than being dropped, in
 * case the site ever adds a genuinely sold-out/closed state we haven't seen yet.
 */
export function capacityClassToStatus(className: string): CapacityStatus {
  switch (className) {
    case 'greenc':
      return 'free';
    case 'orangec':
      return 'last_one';
    case 'redc':
      return 'last_two';
    default:
      return 'unknown';
  }
}

/** Canonical Slovak weekday names, Monday first, matching the site's own capitalisation. */
export const SLOVAK_WEEKDAYS: readonly string[] = [
  'Pondelok',
  'Utorok',
  'Streda',
  'Štvrtok',
  'Piatok',
  'Sobota',
  'Nedeľa',
];

/** English weekday names in the same Monday-first order, for bilingual input. */
export const ENGLISH_WEEKDAYS: readonly string[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/** Slovak month names (nominative, as rendered by the site), January first. */
export const SLOVAK_MONTHS: readonly string[] = [
  'január',
  'február',
  'marec',
  'apríl',
  'máj',
  'jún',
  'júl',
  'august',
  'september',
  'október',
  'november',
  'december',
];

export const BASE_URL = 'https://plaveckaakademia.sk';

/** Hosts accepted by the `get_course({ url })` SSRF guard. Exact match only, never a prefix check. */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'plaveckaakademia.sk',
  'www.plaveckaakademia.sk',
]);

/** The Drupal Views block that renders the course listing; every other block on the page must be ignored. */
export const LISTING_VIEW_SELECTOR =
  'div.view-id-22_zoznam_terminov_kurzov.view-display-id-block_3';

/** Defensive cap on the `?page=N` pagination loop (the view is verified unpaged; this guards against future drift). */
export const MAX_LISTING_PAGES = 20;

/**
 * Resolves an href scraped from a page against the site base and refuses anything that
 * leaves the allowlisted hosts.
 *
 * Every URL this server hands back is presented to an LLM as authoritative and may be shown
 * to (or clicked by) a person, so an href on a page we don't control must never survive into
 * the output. Two separate mistakes are guarded here, both of which shipped once already in
 * the listing parser: matching an id pattern that isn't anchored (so `https://evil.example/
 * plavecky-kurz/a/b/123` matches the tail and passes), and building the absolute URL by
 * string concatenation (which turns an absolute href into the garbage
 * `https://plaveckaakademia.skhttps://evil.example/...` rather than rejecting it).
 */
export function resolveSiteUrl(href: string, context: string): string {
  let parsed: URL;
  try {
    parsed = new URL(href, BASE_URL);
  } catch {
    throw new Error(
      `Could not parse the ${context} URL "${href}"; the site markup may have changed.`,
    );
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `The ${context} URL "${href}" points outside plaveckaakademia.sk; refusing to surface it.`,
    );
  }
  return parsed.toString();
}

/**
 * Builds the listing URL for a category with optional centre/level filters.
 * Multi-select params repeat (`stredisko[]` once per centre); `URLSearchParams`
 * percent-encodes UTF-8 values (and the `[]` literal) the same way the site expects.
 */
export function buildCourseListUrl(
  categorySlug: string,
  filters: { centres?: readonly string[] | undefined; levelParam?: ('0' | '1') | undefined } = {},
): string {
  const url = new URL(`${BASE_URL}/kurzy/plavanie-pre-deti/${categorySlug}`);
  for (const centre of filters.centres ?? []) {
    url.searchParams.append('stredisko[]', centre);
  }
  if (filters.levelParam !== undefined) {
    url.searchParams.append('uroven[]', filters.levelParam);
  }
  return url.toString();
}
