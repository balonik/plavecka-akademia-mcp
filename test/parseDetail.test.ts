import { describe, expect, it } from 'vitest';
import { parseDetail } from '../src/site/parseDetail.js';
import { readFixture } from './helpers.js';

describe('parseDetail', () => {
  const html = readFixture('detail-1313637.html');
  // The fixture's own calendar renders July 2026 sessions on the 22nd and 29th, so a
  // reference date safely before that keeps the year-less date-range resolution
  // deterministic regardless of when this suite actually runs.
  const referenceDate = new Date('2026-01-01T00:00:00Z');

  it('extracts identity, category and sub-level', () => {
    const detail = parseDetail(html, { referenceDate });
    expect(detail.id).toBe('1313637');
    expect(detail.url).toBe(
      'https://plaveckaakademia.sk/plavecky-kurz/plavanie-pre-deti-zralok/plavaren-baronka-raca/1313637',
    );
    expect(detail.categorySlug).toBe('zralok');
    expect(detail.categoryName).toBe('Žralok');
    expect(detail.subLevel).toBe('*');
  });

  it('extracts the venue, centre and address', () => {
    const detail = parseDetail(html, { referenceDate });
    expect(detail.venueName).toBe('Plaváreň Barónka, Rača');
    expect(detail.centre).toBe('Barónka');
    expect(detail.address).toBe('Mudrochova 2, Rača');
  });

  it('extracts the age range', () => {
    const detail = parseDetail(html, { referenceDate });
    expect(detail.ageRange).toBe('6 až 12 rokov');
  });

  it('extracts the date range, anchoring both ends to the explicit session calendar', () => {
    const detail = parseDetail(html, { referenceDate });
    // yearInferred is false: the year came from the calendar's rel="YYYY-MM-DD", not a guess.
    expect(detail.dateRange.start).toEqual({
      raw: '22. júl',
      iso: '2026-07-22',
      yearInferred: false,
    });
    expect(detail.dateRange.end).toEqual({
      raw: '29. júl',
      iso: '2026-07-29',
      yearInferred: false,
    });
  });

  it('never contradicts its own session calendar, even long after the course has ended', () => {
    // Regression: with a forward-only year search this returned a 2027 dateRange while
    // `sessions` (read from explicit rel="2026-07-22" attributes) said 2026 -- a
    // self-contradicting response in a single payload.
    const detail = parseDetail(html, { referenceDate: new Date('2026-12-01T00:00:00Z') });
    const firstSession = detail.sessions[0];
    const lastSession = detail.sessions.at(-1);
    expect(firstSession).toBe('2026-07-22');
    expect(detail.dateRange.start.iso).toBe(firstSession);
    expect(detail.dateRange.end.iso).toBe(lastSession);
    expect(detail.dateRange.start.yearInferred).toBe(false);
  });

  it('extracts the day/time schedule', () => {
    const detail = parseDetail(html, { referenceDate });
    expect(detail.schedule).toEqual([{ day: 'Streda', from: '17:30', to: '18:30' }]);
  });

  it('extracts the lesson count and replaceable-lesson count', () => {
    const detail = parseDetail(html, { referenceDate });
    expect(detail.lessons).toEqual({ total: 2, replaceable: 1 });
  });

  it('extracts the price', () => {
    const detail = parseDetail(html, { referenceDate });
    expect(detail.price).toEqual({ amount: 35.6, currency: 'EUR', raw: '35,6 €' });
  });

  it('extracts availability', () => {
    const detail = parseDetail(html, { referenceDate });
    expect(detail.capacity).toEqual({ available: true, status: 'free', raw: 'Voľné miesta' });
  });

  it('extracts the booking URL', () => {
    const detail = parseDetail(html, { referenceDate });
    expect(detail.bookingUrl).toBe(
      'https://plaveckaakademia.sk/node/add/ucastnik?field_kurz=1313637&destination=node/add/ucastnik?field_kurz=1313637',
    );
  });

  it('extracts the per-session calendar dates, ascending', () => {
    const detail = parseDetail(html, { referenceDate });
    expect(detail.sessions).toEqual(['2026-07-22', '2026-07-29']);
  });

  it('throws when the ".node-kurz" container is missing (selector drift must fail loudly)', () => {
    expect(() => parseDetail('<html><body><p>not a course page</p></body></html>')).toThrow(
      /Could not find the ".node-kurz" detail container/,
    );
  });

  it('throws when there is no canonical link to determine the course id from', () => {
    const html = '<div class="node-kurz"><p>no canonical link anywhere on this page</p></div>';
    expect(() => parseDetail(html)).toThrow(
      /Could not determine the course id from the canonical link/,
    );
  });

  it('throws when a required termin-row (e.g. "Počet lekcií kurzu") is missing', () => {
    const html = `
      <link rel="canonical" href="https://plaveckaakademia.sk/plavecky-kurz/plavanie-pre-deti-zralok/plavaren-baronka-raca/1313637" />
      <div class="node-kurz">
        <div class="breadcrumb-row"><ul class="breadcrumb"><li><a href="/kurzy/plavanie-pre-deti/zralok">Žralok</a></li></ul></div>
        <div class="termin-info"></div>
      </div>`;
    expect(() => parseDetail(html)).toThrow(
      /Could not find the "Počet lekcií kurzu" row on the detail page/,
    );
  });
});
