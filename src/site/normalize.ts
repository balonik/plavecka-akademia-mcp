/**
 * Pure string/date normalisation helpers. Nothing here touches the DOM or the
 * network, so it is unit-testable purely against strings.
 */

import {
  CATEGORIES,
  CENTRES,
  ENGLISH_WEEKDAYS,
  SLOVAK_MONTHS,
  SLOVAK_WEEKDAYS,
  type CategoryDef,
} from './constants.js';

// Built via charCode (rather than a \u escape or literal character) so the regex range
// (Unicode combining diacritical marks, U+0300 - U+036F) is unambiguous regardless of
// source file encoding.
const DIACRITIC_MARKS_PATTERN = new RegExp(
  `[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`,
  'gu',
);

/** Strips combining diacritical marks via NFD decomposition, e.g. "Devínska" -> "Devinska". */
export function stripDiacritics(input: string): string {
  return input.normalize('NFD').replace(DIACRITIC_MARKS_PATTERN, '');
}

/** Diacritic- and case-insensitive comparison key: strip accents, lowercase, collapse/trim whitespace. */
export function normalizeKey(input: string): string {
  return stripDiacritics(input).toLowerCase().trim().replace(/\s+/g, ' ');
}

export interface Price {
  amount: number;
  currency: 'EUR';
  raw: string;
}

/** Parses a Slovak-formatted price like "35,6 €" or "78 €" into a structured amount. */
export function parsePrice(raw: string): Price {
  const trimmed = raw.trim();
  const match = /^(\d+)(?:,(\d+))?\s*€$/.exec(trimmed);
  if (!match) {
    throw new Error(`Unrecognized price format: "${raw}"`);
  }
  const [, intPart, decPart] = match;
  const amount = Number(`${intPart ?? '0'}.${decPart ?? '0'}`);
  if (Number.isNaN(amount)) {
    throw new Error(`Unrecognized price format: "${raw}"`);
  }
  return { amount, currency: 'EUR', raw: trimmed };
}

export interface TimeRange {
  from: string;
  to: string;
}

/** Parses "17:30-18:30", " 17:30 – 18:30" (en dash, extra spaces) etc. into {from, to}. */
export function parseTimeRange(raw: string): TimeRange {
  const trimmed = raw.trim();
  const match = /^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/.exec(trimmed);
  if (!match) {
    throw new Error(`Unrecognized time range format: "${raw}"`);
  }
  const [, from, to] = match;
  if (from === undefined || to === undefined) {
    throw new Error(`Unrecognized time range format: "${raw}"`);
  }
  return { from, to };
}

function lookupMonthIndex(monthName: string): number {
  const key = normalizeKey(monthName);
  const index = SLOVAK_MONTHS.findIndex((m) => normalizeKey(m) === key);
  if (index === -1) {
    throw new Error(`Unrecognized Slovak month name: "${monthName}"`);
  }
  return index;
}

function utcDateOrNull(year: number, monthIndex: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, monthIndex, day));
  // Date.UTC silently overflows (e.g. Feb 29 on a non-leap year rolls into March):
  // detect that and report "no such date this year" instead of a wrong date.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export interface ParsedSlovakDate {
  raw: string;
  iso: string;
  /**
   * Whether the year was guessed from the reference date (listing rows carry no year) or
   * read from an explicit source such as the detail page's session calendar.
   */
  yearInferred: boolean;
}

const MAX_YEAR_SEARCH_ATTEMPTS = 8;

/**
 * How far into the past a year-less date may resolve before we assume it means *next*
 * year instead. The site lists courses that have already started (a detail page stays
 * reachable by id afterwards), so a forward-only search reports a course that began last
 * week as beginning next year -- and on a detail page that then contradicts the session
 * calendar, which does carry explicit years. 60 days comfortably covers a course that has
 * run its length while staying far short of the ~6 months where "which year?" gets
 * genuinely ambiguous.
 */
const PAST_WINDOW_DAYS = 60;
const MS_PER_DAY = 86_400_000;

/** The site and its users are in Bratislava; "today" must be the site's civil date, not the server's UTC one. */
const SITE_TIME_ZONE = 'Europe/Bratislava';

/**
 * The civil date at the site's timezone, as a UTC-midnight Date, so all downstream
 * arithmetic can stay in UTC while the reference point is correct. Between 00:00 and
 * 02:00 Bratislava time (summer), the UTC date is still "yesterday" -- using it directly
 * would put dates on the wrong side of a day boundary for a two-hour window every night.
 */
function siteCivilMidnight(referenceDate: Date): Date {
  // 'en-CA' formats as YYYY-MM-DD, which is exactly the ISO shape we need.
  const civil = new Intl.DateTimeFormat('en-CA', {
    timeZone: SITE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(referenceDate);
  return new Date(`${civil}T00:00:00Z`);
}

/**
 * Parses a year-less Slovak date like "22. júl" into an ISO date, inferring the year as
 * the nearest occurrence relative to `referenceDate` (defaults to now), evaluated at the
 * site's timezone.
 *
 * The search is asymmetric: a candidate up to `PAST_WINDOW_DAYS` in the past is accepted
 * as-is (a course that has already started), and only beyond that do we roll forward a
 * year. Handles both rollover directions (a December date seen in January resolves to the
 * coming December) and leap-day inputs ("29. február" in a non-leap year skips to the next
 * leap year) by comparing full calendar dates rather than bare month numbers.
 */
export function parseSlovakDate(raw: string, referenceDate: Date = new Date()): ParsedSlovakDate {
  const trimmed = raw.trim();
  const match = /^(\d{1,2})\.\s*([^\s.]+)\.?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Unrecognized Slovak date format: "${raw}"`);
  }
  const [, dayStr, monthName] = match;
  if (dayStr === undefined || monthName === undefined) {
    throw new Error(`Unrecognized Slovak date format: "${raw}"`);
  }
  const day = Number(dayStr);
  const monthIndex = lookupMonthIndex(monthName);

  // Reference point is the site's civil date; arithmetic from here on is UTC so a caller
  // can chain dates reliably by passing `new Date(`${previous.iso}T00:00:00Z`)`.
  const refMidnight = siteCivilMidnight(referenceDate);
  const earliestAccepted = refMidnight.getTime() - PAST_WINDOW_DAYS * MS_PER_DAY;

  // Start a year BEFORE the reference year and walk forward, taking the first candidate
  // inside the accepted window. Walking in chronological order is what makes the past
  // window work in both directions: "20. december" read on 5 January must resolve to last
  // month, not eleven months away, and starting at the reference year would skip straight
  // past it.
  let year = refMidnight.getUTCFullYear() - 1;
  let candidate: Date | null = null;
  for (let attempt = 0; attempt < MAX_YEAR_SEARCH_ATTEMPTS; attempt++) {
    const attemptDate = utcDateOrNull(year, monthIndex, day);
    if (attemptDate && attemptDate.getTime() >= earliestAccepted) {
      candidate = attemptDate;
      break;
    }
    year += 1;
  }
  if (!candidate) {
    throw new Error(`Could not resolve a plausible date for "${raw}"`);
  }

  return {
    raw: trimmed,
    iso: candidate.toISOString().slice(0, 10),
    yearInferred: true,
  };
}

/** Builds a `ParsedSlovakDate` from a known-exact ISO date, so it is not marked as a guess. */
export function exactSlovakDate(raw: string, iso: string): ParsedSlovakDate {
  return { raw: raw.trim(), iso, yearInferred: false };
}

/** Upper bound on any free-text field echoed from the site into LLM context. */
export const MAX_FREE_TEXT_LENGTH = 200;

/**
 * Caps a free-text field scraped from the site. These values flow verbatim into the
 * calling model's context, so they are untrusted input: bounding the length limits how
 * much attacker-influenced text a compromised or user-editable upstream page can inject.
 */
export function truncateFreeText(value: string, maxLength = MAX_FREE_TEXT_LENGTH): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}…`;
}

/** Resolves free-text day input (Slovak or English, any case/diacritics) to the canonical Slovak name. Throws with the valid list otherwise. */
export function resolveDay(input: string): string {
  const key = normalizeKey(input);
  const slovakMatch = SLOVAK_WEEKDAYS.find((d) => normalizeKey(d) === key);
  if (slovakMatch !== undefined) {
    return slovakMatch;
  }
  const englishIndex = ENGLISH_WEEKDAYS.findIndex((d) => normalizeKey(d) === key);
  if (englishIndex !== -1) {
    const mapped = SLOVAK_WEEKDAYS[englishIndex];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  throw new Error(
    `Unknown day "${input}". Valid values: ${SLOVAK_WEEKDAYS.join(', ')} (or the English equivalents: ${ENGLISH_WEEKDAYS.join(', ')}).`,
  );
}

/** Resolves free-text centre input to the exact `stredisko[]` value. Throws with the valid list otherwise. */
export function resolveCentre(input: string, allowed: readonly string[] = CENTRES): string {
  const key = normalizeKey(input);
  const found = allowed.find((c) => normalizeKey(c) === key);
  if (!found) {
    throw new Error(`Unknown location "${input}". Valid values: ${allowed.join(', ')}.`);
  }
  return found;
}

/** Resolves free-text category input (slug or display name, diacritic/case-insensitive) to its definition. */
export function resolveCategory(input: string): CategoryDef {
  const key = normalizeKey(input);
  const found = CATEGORIES.find(
    (c) => normalizeKey(c.slug) === key || normalizeKey(c.name) === key,
  );
  if (!found) {
    throw new Error(
      `Unknown category "${input}". Valid values: ${CATEGORIES.map((c) => c.slug).join(', ')}.`,
    );
  }
  return found;
}
