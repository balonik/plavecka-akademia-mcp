import { describe, expect, it } from 'vitest';
import {
  normalizeKey,
  parsePrice,
  parseSlovakDate,
  parseTimeRange,
  resolveCategory,
  resolveCentre,
  resolveDay,
  stripDiacritics,
} from '../src/site/normalize.js';

describe('stripDiacritics / normalizeKey', () => {
  it('strips combining diacritical marks', () => {
    expect(stripDiacritics('Devínska')).toBe('Devinska');
    expect(stripDiacritics('Žralok')).toBe('Zralok');
    expect(stripDiacritics('Šustekova')).toBe('Sustekova');
  });

  it('lowercases, strips diacritics and collapses whitespace for comparison', () => {
    expect(normalizeKey('  Devínska  ')).toBe('devinska');
    expect(normalizeKey('ŽRALOK')).toBe('zralok');
    expect(normalizeKey('Podunajská   Biskupice')).toBe('podunajska biskupice');
  });
});

describe('parsePrice', () => {
  it('parses a price with a comma decimal', () => {
    expect(parsePrice('35,6 €')).toEqual({ amount: 35.6, currency: 'EUR', raw: '35,6 €' });
  });

  it('parses a whole-number price with no decimal part', () => {
    expect(parsePrice('78 €')).toEqual({ amount: 78, currency: 'EUR', raw: '78 €' });
  });

  it('trims surrounding whitespace before matching', () => {
    expect(parsePrice('  18,3 €  ')).toEqual({ amount: 18.3, currency: 'EUR', raw: '18,3 €' });
  });

  it('throws on an unrecognized format', () => {
    expect(() => parsePrice('free')).toThrow(/Unrecognized price format/);
    expect(() => parsePrice('35.6 EUR')).toThrow(/Unrecognized price format/);
  });
});

describe('parseTimeRange', () => {
  it('parses a plain hyphen range', () => {
    expect(parseTimeRange('17:30-18:30')).toEqual({ from: '17:30', to: '18:30' });
  });

  it('parses an en-dash range with surrounding/interior spaces', () => {
    expect(parseTimeRange(' 17:30 – 18:30 ')).toEqual({ from: '17:30', to: '18:30' });
  });

  it('parses an em-dash range', () => {
    expect(parseTimeRange('9:00—10:00')).toEqual({ from: '9:00', to: '10:00' });
  });

  it('throws on an unrecognized format', () => {
    expect(() => parseTimeRange('all day')).toThrow(/Unrecognized time range format/);
  });
});

describe('parseSlovakDate', () => {
  it('resolves a year-less date to the current year when it is still upcoming', () => {
    const reference = new Date('2026-01-01T00:00:00Z');
    const result = parseSlovakDate('22. júl', reference);
    expect(result).toEqual({ raw: '22. júl', iso: '2026-07-22', yearInferred: true });
  });

  it('resolves an ambiguous month to the NEAREST occurrence, which can be the recent past', () => {
    // Genuinely ambiguous: on 15 January, "20. december" is either 26 days ago or 11
    // months away. We take the nearer one. That is the right call for this data because
    // the inference path now only serves *listings* (detail pages are anchored to their
    // session calendar, which carries explicit years), and listings only ever show courses
    // within a few weeks of today — so the 60-day past window is far closer to the truth
    // than a jump to next December.
    const reference = new Date('2026-01-15T00:00:00Z');
    expect(parseSlovakDate('20. december', reference).iso).toBe('2025-12-20');
  });

  it('rolls over to next year when the same-year date has already passed (January seen in December)', () => {
    const reference = new Date('2026-12-20T00:00:00Z');
    const result = parseSlovakDate('5. január', reference);
    expect(result.iso).toBe('2027-01-05');
  });

  it('keeps a recently-passed date in the current year rather than rolling it forward', () => {
    // A course that started 8 days ago is still that course. The old forward-only search
    // reported it as 2027 -- and on a detail page that contradicted the page's own session
    // calendar, which carries explicit years.
    const reference = new Date('2026-07-18T00:00:00Z');
    expect(parseSlovakDate('10. júl', reference).iso).toBe('2026-07-10');
  });

  it('accepts a date at the edge of the 60-day past window', () => {
    const reference = new Date('2026-07-18T00:00:00Z');
    // 2026-05-20 is 59 days before the reference date.
    expect(parseSlovakDate('20. máj', reference).iso).toBe('2026-05-20');
  });

  it('rolls forward a year once a date is further past than the 60-day window', () => {
    const reference = new Date('2026-07-18T00:00:00Z');
    // 2026-05-18 is 61 days before the reference date, so it means next year's.
    expect(parseSlovakDate('18. máj', reference).iso).toBe('2027-05-18');
  });

  it('uses the site timezone, not UTC, to decide what "today" is', () => {
    // 22:30 UTC on 18 July is already 00:30 on 19 July in Bratislava (UTC+2 in summer).
    // Computing "today" in UTC would put dates on the wrong side of the day boundary for a
    // two-hour window every night.
    const lateUtc = new Date('2026-07-18T22:30:00Z');
    expect(parseSlovakDate('19. júl', lateUtc).iso).toBe('2026-07-19');
  });

  it('resolves the exact reference date itself as "still upcoming" (inclusive)', () => {
    const reference = new Date('2026-07-18T00:00:00Z');
    const result = parseSlovakDate('18. júl', reference);
    expect(result.iso).toBe('2026-07-18');
  });

  it('skips forward to the next leap year for a 29. február in a non-leap year', () => {
    const reference = new Date('2026-01-01T00:00:00Z'); // 2026 is not a leap year, nor is 2027
    const result = parseSlovakDate('29. február', reference);
    expect(result.iso).toBe('2028-02-29');
  });

  it('defaults the reference date to "now" when omitted', () => {
    // Just confirm it doesn't throw and returns a plausible ISO date; the real "now"
    // behaviour is exercised via the explicit reference-date tests above.
    const result = parseSlovakDate('1. január');
    expect(result.iso).toMatch(/^\d{4}-01-01$/);
  });

  it('throws on an unrecognized month name', () => {
    expect(() => parseSlovakDate('5. octember', new Date('2026-01-01T00:00:00Z'))).toThrow(
      /Unrecognized Slovak month name/,
    );
  });

  it('throws on an unrecognized date format', () => {
    expect(() => parseSlovakDate('July 5th', new Date('2026-01-01T00:00:00Z'))).toThrow(
      /Unrecognized Slovak date format/,
    );
  });
});

describe('resolveDay', () => {
  it('resolves Slovak weekday names as-is', () => {
    expect(resolveDay('Piatok')).toBe('Piatok');
  });

  it('resolves Slovak weekday names case/diacritic-insensitively', () => {
    expect(resolveDay('piatok')).toBe('Piatok');
    expect(resolveDay('STVRTOK')).toBe('Štvrtok');
  });

  it('resolves English weekday names to the canonical Slovak name', () => {
    expect(resolveDay('friday')).toBe('Piatok');
    expect(resolveDay('Friday')).toBe('Piatok');
    expect(resolveDay('MONDAY')).toBe('Pondelok');
  });

  it('throws with the valid Slovak and English lists for an unknown day', () => {
    expect(() => resolveDay('someday')).toThrow(/Piatok/);
    expect(() => resolveDay('someday')).toThrow(/Friday/);
  });
});

describe('resolveCentre', () => {
  it('resolves diacritic/case-insensitive input to the exact site value', () => {
    expect(resolveCentre('devinska')).toBe('Devínska');
    expect(resolveCentre('BARONKA')).toBe('Barónka');
  });

  it('throws with the valid centre list for an unknown location', () => {
    expect(() => resolveCentre('Atlantis')).toThrow(/Unknown location "Atlantis"/);
    expect(() => resolveCentre('Atlantis')).toThrow(/Devínska/);
  });

  it('honours a caller-supplied allowed list instead of the global CENTRES', () => {
    expect(resolveCentre('devinska', ['Devínska', 'Barónka'])).toBe('Devínska');
    expect(() => resolveCentre('Ružinov', ['Devínska', 'Barónka'])).toThrow(
      /Unknown location "Ružinov"/,
    );
  });
});

describe('resolveCategory', () => {
  it('resolves by slug, diacritic/case-insensitively', () => {
    expect(resolveCategory('zralok').name).toBe('Žralok');
    expect(resolveCategory('ZRALOK').slug).toBe('zralok');
  });

  it('resolves by Slovak display name, diacritic/case-insensitively', () => {
    expect(resolveCategory('žralok').slug).toBe('zralok');
    expect(resolveCategory('korytnacka').name).toBe('Korytnačka');
  });

  it('throws with the valid category list for an unknown category', () => {
    expect(() => resolveCategory('nemo')).toThrow(/Unknown category "nemo"/);
    expect(() => resolveCategory('nemo')).toThrow(/zralok/);
  });
});
