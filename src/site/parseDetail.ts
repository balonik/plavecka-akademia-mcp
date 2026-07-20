/**
 * Detail-page parser. Parses a single course detail page into a `CourseDetail`.
 *
 * The detail page has no equivalent of the listing's "other views" problem, but it is
 * scoped to `.node-kurz` anyway for consistency and because the calendar/booking markup
 * all lives inside it. A missing container, missing canonical link, or a missing
 * `.termin-row` for any of the fields we rely on throws loudly rather than returning
 * partial/undefined data, matching the listing parser's fail-loud philosophy.
 */

import * as cheerio from 'cheerio';
import type { AnyNode, Element, Text } from 'domhandler';
import {
  capacityClassToStatus,
  resolveSiteUrl,
  starsToLevel,
  type Capacity,
  type LevelSymbol,
} from './constants.js';
import {
  exactSlovakDate,
  parsePrice,
  parseSlovakDate,
  parseTimeRange,
  stripDiacritics,
  truncateFreeText,
  type ParsedSlovakDate,
  type Price,
} from './normalize.js';
import type { DaySlot } from './parseList.js';

export type CourseDetail = {
  id: string;
  url: string;
  categorySlug: string;
  categoryName: string;
  subLevel: LevelSymbol | null;
  ageRange: string;
  venueName: string;
  centre: string;
  address: string;
  dateRange: { start: ParsedSlovakDate; end: ParsedSlovakDate };
  schedule: DaySlot[];
  lessons: { total: number; replaceable: number };
  price: Price;
  capacity: Capacity;
  bookingUrl: string | null;
  /** ISO (YYYY-MM-DD) dates of the individual lesson sessions, ascending. */
  sessions: string[];
};

// Anchored with `^` and matched against the resolved *pathname*, never the raw href. An
// unanchored pattern matches the tail of an absolute off-site URL
// (`https://evil.example/plavecky-kurz/a/b/123`), which would then be surfaced as the
// course's canonical URL. `parseList`'s HREF_PATTERN carries the same guard.
const CANONICAL_ID_PATTERN = /^\/plavecky-kurz\/[^/]+\/[^/]+\/(\d+)$/;

/**
 * Replaces an inferred (guessed-year) date with the matching session date, which carries
 * an explicit year. Matching is on month+day, so a session list that doesn't contain the
 * range endpoint at all leaves the inferred value untouched rather than inventing one.
 */
function anchorToSessions(
  inferred: ParsedSlovakDate,
  sessions: readonly string[],
): ParsedSlovakDate {
  const monthDay = inferred.iso.slice(5);
  const exact = sessions.find((session) => session.slice(5) === monthDay);
  return exact === undefined ? inferred : exactSlovakDate(inferred.raw, exact);
}

function isTextNode(node: unknown): node is Text {
  return (node as { type?: string }).type === 'text';
}

/** Returns only the direct text-node children of a selection, ignoring nested elements (e.g. a `.views-label` div). */
function ownText<T extends AnyNode>(selection: cheerio.Cheerio<T>): string {
  return selection
    .contents()
    .toArray()
    .filter(isTextNode)
    .map((node) => node.data)
    .join('')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Returns each direct text-node child of a selection as a separate trimmed, non-empty string. */
function textNodeParts<T extends AnyNode>(selection: cheerio.Cheerio<T>): string[] {
  return selection
    .contents()
    .toArray()
    .filter(isTextNode)
    .map((node) => node.data.trim())
    .filter((part) => part.length > 0);
}

function findRowContent(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<Element>,
  label: string,
): cheerio.Cheerio<Element> {
  const rows = root.find('.termin-info').children('.termin-row');
  let result: cheerio.Cheerio<Element> | undefined;
  rows.each((_i, el) => {
    // Stop at the FIRST match. Overwriting on every match would silently prefer the last
    // duplicate -- e.g. if the site ever renders a struck-through original price next to a
    // discounted one, we'd quietly report the wrong row.
    if (result !== undefined) return;
    const $el = $(el);
    if ($el.children('.label').first().text().trim() === label) {
      result = $el.children('.row-content').first();
    }
  });
  if (!result || result.length === 0) {
    throw new Error(
      `Could not find the "${label}" row on the detail page; the site markup may have changed.`,
    );
  }
  return result;
}

export interface ParseDetailOptions {
  /** Reference date for resolving the year-less date-range dates. Defaults to now. */
  referenceDate?: Date | undefined;
}

export function parseDetail(html: string, options: ParseDetailOptions = {}): CourseDetail {
  const $ = cheerio.load(html);
  const root = $('.node-kurz').first();
  if (root.length === 0) {
    throw new Error(
      'Could not find the ".node-kurz" detail container; the site markup may have changed.',
    );
  }

  const canonicalHref = $('link[rel="canonical"]').attr('href') ?? '';
  if (canonicalHref === '') {
    throw new Error(
      'Could not determine the course id from the canonical link; the site markup may have changed.',
    );
  }
  const canonicalUrl = resolveSiteUrl(canonicalHref, 'canonical link');
  const idMatch = CANONICAL_ID_PATTERN.exec(new URL(canonicalUrl).pathname);
  const id = idMatch?.[1];
  if (id === undefined) {
    throw new Error(
      'Could not determine the course id from the canonical link; the site markup may have changed.',
    );
  }

  const categoryAnchor = root.find('.breadcrumb a[href^="/kurzy/plavanie-pre-deti/"]').first();
  const categoryName = categoryAnchor.text().trim();
  const categoryHref = categoryAnchor.attr('href') ?? '';
  const categorySlug = categoryHref.split('/').filter(Boolean).pop() ?? '';
  if (!categoryName || !categorySlug) {
    throw new Error(
      'Could not determine the course category from the breadcrumb; the site markup may have changed.',
    );
  }

  // Lessons: "2          lekcie ... (nahraditeľné:\n  1) ... Ako fungujú náhradné hodiny?"
  const lessonsText = findRowContent($, root, 'Počet lekcií kurzu').text();
  const totalMatch = /(\d+)\s*lekci/i.exec(lessonsText);
  const replaceableMatch = /nahraditel\w*\s*:?\s*(\d+)/i.exec(stripDiacritics(lessonsText));
  const totalRaw = totalMatch?.[1];
  const replaceableRaw = replaceableMatch?.[1];
  if (totalRaw === undefined || replaceableRaw === undefined) {
    throw new Error(`Could not parse the lesson counts from "${lessonsText}"`);
  }
  const lessons = { total: Number(totalRaw), replaceable: Number(replaceableRaw) };

  // The session calendar carries explicit `rel="YYYY-MM-DD"` years, unlike the year-less
  // "Trvanie kurzu" text. Parse it first so the date range can be anchored to it rather
  // than guessed -- otherwise a course that has already finished reports next year's dates
  // while its own `sessions` array says otherwise, contradicting itself in one response.
  const sessions = root
    .find('.calendars table.calendar td.day.selected')
    .map((_i, el) => $(el).attr('rel') ?? '')
    .get()
    .filter((rel) => /^\d{4}-\d{2}-\d{2}$/.test(rel))
    .sort();

  // Date range: "22. júl            –\n            29. júl"
  const dateRangeText = findRowContent($, root, 'Trvanie kurzu').text().replace(/\s+/g, ' ').trim();
  const dateRangeMatch = /^(.+?)\s*[-–—]\s*(.+)$/.exec(dateRangeText);
  const startRaw = dateRangeMatch?.[1];
  const endRaw = dateRangeMatch?.[2];
  if (startRaw === undefined || endRaw === undefined) {
    throw new Error(`Could not parse the date range from "${dateRangeText}"`);
  }
  const inferredStart = parseSlovakDate(startRaw, options.referenceDate);
  // Resolve the end date's year relative to the (already-resolved) start date rather than
  // "today", so a course spanning a year boundary (e.g. starts in December, ends in
  // January) rolls over correctly instead of both dates independently snapping to
  // "nearest occurrence relative to today".
  const inferredEnd = parseSlovakDate(endRaw, new Date(`${inferredStart.iso}T00:00:00Z`));
  const start = anchorToSessions(inferredStart, sessions);
  const end = anchorToSessions(inferredEnd, sessions);

  // Day/time: one or more `.dayhod` entries. An empty result means the selector drifted --
  // a course always runs on at least one day -- so throw rather than return a course with no
  // schedule, matching `parseList`'s handling of the same markup.
  const dayCazContent = findRowContent($, root, 'Deň a čas');
  const scheduleEls = dayCazContent.find('.dayhod');
  if (scheduleEls.length === 0) {
    throw new Error(
      'Could not find any schedule slots (selector ".dayhod" inside the "Deň a čas" row) on the detail page; the site markup may have changed.',
    );
  }
  const schedule: DaySlot[] = scheduleEls
    .map((_i, el) => {
      const $el = $(el);
      const day = $el.find('.day').text().trim();
      const hourRaw = $el.find('.hour').text().trim();
      const { from, to } = parseTimeRange(hourRaw);
      return { day, from, to };
    })
    .get();

  const venueName = truncateFreeText(
    findRowContent($, root, 'Stredisko').text().replace(/\s+/g, ' '),
  );

  const vekParts = textNodeParts(findRowContent($, root, 'Veková skupina'));
  const ageRange = truncateFreeText(vekParts[1] ?? vekParts[0] ?? '');

  const starCount = findRowContent($, root, 'Úroveň').find('img').length;
  const subLevel = starsToLevel(starCount);

  const priceRaw = findRowContent($, root, 'Cena').find('.cena').first().text().trim();
  const price = parsePrice(priceRaw);

  const capacityEl = root.find('.prihlasit_row span').first();
  if (capacityEl.length === 0) {
    throw new Error(
      'Could not find the capacity element (selector ".prihlasit_row span") on the detail page; the site markup may have changed.',
    );
  }
  const capacityRaw = truncateFreeText(capacityEl.text());
  const capacityClassAttr = capacityEl.attr('class') ?? '';
  const status =
    capacityClassAttr
      .split(/\s+/)
      .map(capacityClassToStatus)
      .find((s) => s !== 'unknown') ?? 'unknown';
  const capacity: Capacity = { available: true, status, raw: capacityRaw };

  // A course with no booking link is legitimate (`null`), but an off-site one is not: this
  // value is the single most likely field in the whole response for a human to click.
  const bookingHref = root.find('.prihlasit_row a.prihlasit').first().attr('href');
  const bookingUrl =
    bookingHref === undefined || bookingHref === ''
      ? null
      : resolveSiteUrl(bookingHref, 'booking link');

  const centre = truncateFreeText(root.find('.stredisko-row .centrum h3').first().text());
  if (centre === '') {
    throw new Error(
      'Could not find the centre name (selector ".stredisko-row .centrum h3") on the detail page; the site markup may have changed.',
    );
  }
  const addressEl = root.find('.stredisko-row .address').first();
  if (addressEl.length === 0) {
    throw new Error(
      'Could not find the address element (selector ".stredisko-row .address") on the detail page; the site markup may have changed.',
    );
  }
  const address = truncateFreeText(ownText(addressEl).replace(/[-–—]\s*$/, ''));

  return {
    id,
    url: canonicalUrl,
    categorySlug,
    categoryName,
    subLevel,
    ageRange,
    venueName,
    centre,
    address,
    dateRange: { start, end },
    schedule,
    lessons,
    price,
    capacity,
    bookingUrl,
    sessions,
  };
}
