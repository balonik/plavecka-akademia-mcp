/**
 * Scoped listing parser. Parses the course listing HTML into `CourseSummary[]`.
 *
 * Two gotchas drive the shape of this file (see the plan doc for how they were verified):
 *  - The page contains *other* Views blocks; every selector below is scoped inside
 *    `LISTING_VIEW_SELECTOR` so those extra rows are never counted.
 *  - An empty result renders the view container with no `.view-content` child at all
 *    (detected structurally, not by matching the Slovak sentinel text) -> `[]`.
 *    A missing container entirely means the selector has drifted -> throw loudly.
 */

import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import {
  BASE_URL,
  capacityClassToStatus,
  LISTING_VIEW_SELECTOR,
  starsToLevel,
  type Capacity,
  type LevelSymbol,
} from './constants.js';
import {
  parsePrice,
  parseSlovakDate,
  parseTimeRange,
  truncateFreeText,
  type ParsedSlovakDate,
  type Price,
} from './normalize.js';

export interface DaySlot {
  day: string;
  from: string;
  to: string;
}

export interface CourseSummary {
  id: string;
  url: string;
  poolSlug: string;
  centre: string;
  level: LevelSymbol | null;
  frequency: string;
  schedule: DaySlot[];
  startDate: ParsedSlovakDate;
  price: Price;
  lessonsRaw: string;
  capacity: Capacity;
}

// Anchored with `^` so an absolute, attacker-supplied `href` (e.g.
// "https://evil.example/plavecky-kurz/a/b/123") can never match -- only a same-origin
// relative path starting with "/plavecky-kurz/" is accepted.
const HREF_PATTERN = /^\/plavecky-kurz\/([^/]+)\/([^/]+)\/(\d+)$/;

/** Returns only the direct text-node children of a selection, ignoring nested elements (e.g. a `.views-label` div). */
function ownText<T extends AnyNode>(selection: cheerio.Cheerio<T>): string {
  return selection
    .contents()
    .filter((_i, node) => (node as { type?: string }).type === 'text')
    .text()
    .trim()
    .replace(/\s+/g, ' ');
}

export interface ParseListOptions {
  /** Reference date for resolving the year-less `zaciatok-kurzu` dates. Defaults to now. */
  referenceDate?: Date | undefined;
}

export function parseList(html: string, options: ParseListOptions = {}): CourseSummary[] {
  const $ = cheerio.load(html);
  const container = $(LISTING_VIEW_SELECTOR);
  if (container.length === 0) {
    throw new Error(
      `Could not find the course listing container (selector "${LISTING_VIEW_SELECTOR}"); the site markup may have changed.`,
    );
  }

  const viewContent = container.children('div.view-content');
  if (viewContent.length === 0) {
    // Structural empty-result sentinel: container present, but it has no view-content
    // child at all. Deliberately not matching on the Slovak "no results" text.
    return [];
  }

  const rows = viewContent.children('div.views-row');
  const courses: CourseSummary[] = [];
  rows.each((_i, rowEl) => {
    // parseRow throws on any unparseable field (price, date, missing selector). That is
    // deliberate all-or-nothing: one malformed row fails the whole category listing rather
    // than dropping a row, because a silently missing course is exactly the plausible-looking
    // wrong answer this codebase refuses to emit (see CLAUDE.md, "Parsers fail loudly"). The
    // trade-off is availability -- a single upstream typo takes the category offline until
    // it's fixed or the parser is taught to tolerate it -- and it's accepted knowingly.
    courses.push(parseRow($, $(rowEl), options.referenceDate));
  });
  return courses;
}

function parseRow(
  $: cheerio.CheerioAPI,
  row: cheerio.Cheerio<Element>,
  referenceDate: Date | undefined,
): CourseSummary {
  const anchor = row.find('a.termin-link').first();
  const href = anchor.attr('href') ?? '';
  const captured = HREF_PATTERN.exec(href);
  if (!captured) {
    throw new Error(
      `Could not parse a course id out of href "${href}"; the site markup may have changed.`,
    );
  }
  const poolSlug = captured[2];
  const id = captured[3];
  if (poolSlug === undefined || id === undefined) {
    throw new Error(
      `Could not parse a course id out of href "${href}"; the site markup may have changed.`,
    );
  }

  const frequency = truncateFreeText(
    row.find('.frekvencia li:first-child strong').first().text().trim(),
  );
  if (frequency === '') {
    throw new Error(
      `Could not find the frequency text (selector ".frekvencia li:first-child strong") for row with href "${href}"; the site markup may have changed.`,
    );
  }

  const scheduleEls = row.find('.frekvencia .dayhod');
  if (scheduleEls.length === 0) {
    throw new Error(
      `Could not find any schedule slots (selector ".frekvencia .dayhod") for row with href "${href}"; the site markup may have changed.`,
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

  const startDateRaw = ownText(row.find('.zaciatok-kurzu').first());
  const startDate = parseSlovakDate(startDateRaw, referenceDate);

  const centre = truncateFreeText(ownText(row.find('.stredisko').first()));
  if (centre === '') {
    throw new Error(
      `Could not find the centre text (selector ".stredisko") for row with href "${href}"; the site markup may have changed.`,
    );
  }

  // A zero-star row is legitimate (no sub-level) and must map to `level: null`, but the
  // container element itself must always exist -- its absence means the selector drifted,
  // which is indistinguishable from a legitimate zero-star row unless checked separately.
  const urovenContainer = row.find('.uroven .field-uroven');
  if (urovenContainer.length === 0) {
    throw new Error(
      `Could not find the level container (selector ".uroven .field-uroven") for row with href "${href}"; the site markup may have changed.`,
    );
  }
  const starCount = urovenContainer.find('img').length;
  const level = starsToLevel(starCount);

  const priceRaw = row.find('.cena-kurzu .suma-span').first().text().trim();
  const price = parsePrice(priceRaw);
  const lessonsRaw = truncateFreeText(row.find('.cena-kurzu .pocet-lekcii').first().text().trim());

  const capacityEl = row.find('.views-field-field-kapacita-kurzu span').first();
  if (capacityEl.length === 0) {
    throw new Error(
      `Could not find the capacity element (selector ".views-field-field-kapacita-kurzu span") for row with href "${href}"; the site markup may have changed.`,
    );
  }
  const capacityRaw = truncateFreeText(capacityEl.text().trim());
  const capacityClassAttr = capacityEl.attr('class') ?? '';
  const status =
    capacityClassAttr
      .split(/\s+/)
      .map(capacityClassToStatus)
      .find((s) => s !== 'unknown') ?? 'unknown';
  // All three known classes (and, per spec, an unrecognised one too) mean "bookable" --
  // never silently drop a row just because its capacity markup doesn't match a known class.
  const capacity: Capacity = { available: true, status, raw: capacityRaw };

  return {
    id,
    url: new URL(href, BASE_URL).toString(),
    poolSlug,
    centre,
    level,
    frequency,
    schedule,
    startDate,
    price,
    lessonsRaw,
    capacity,
  };
}
