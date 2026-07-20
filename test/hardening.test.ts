/**
 * Regression tests for review findings that aren't about listing-parser drift (that lives in
 * drift.test.ts): redirect handling, the wasted second upstream request, duplicate-category
 * collapse, limit/offset clamping, absolute-href URL building on both parsers, and the
 * find_common_slots paging and list_courses time-validation findings.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache, get, parseHeaderCount, type FetchFn } from '../src/site/client.js';
import { parseDetail } from '../src/site/parseDetail.js';
import { parseList } from '../src/site/parseList.js';
import { findCommonSlots } from '../src/tools/find_common_slots.js';
import { listCourses } from '../src/tools/list_courses.js';
import { readFixture, urlOf } from './helpers.js';

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

function redirectTo(location: string, status = 302): Response {
  return new Response('', { status, headers: { location } });
}

beforeEach(() => {
  clearCache();
});

describe('redirect handling', () => {
  const detailUrl = 'https://plaveckaakademia.sk/plavecky-kurz/a/b/1313637';

  it('re-checks the allowlist on every hop and refuses to follow off-host', async () => {
    // With fetch's default redirect:'follow', only the FIRST url is ever checked, so an
    // open redirect upstream would hand back another host's body (on Azure, notably the
    // IMDS endpoint at 169.254.169.254).
    const fetchFn: FetchFn = async (input) =>
      urlOf(input) === detailUrl
        ? redirectTo('https://evil.example/secret')
        : htmlResponse('SHOULD-NEVER-BE-RETURNED');

    await expect(get(detailUrl, { fetchFn })).rejects.toThrow(/not allowed/i);
  });

  it('follows a same-host redirect', async () => {
    const fetchFn: FetchFn = async (input) =>
      urlOf(input) === detailUrl
        ? redirectTo('https://plaveckaakademia.sk/plavecky-kurz/a/b/999')
        : htmlResponse('<html>final</html>');

    await expect(get(detailUrl, { fetchFn })).resolves.toBe('<html>final</html>');
  });

  it('gives up rather than looping forever on a redirect cycle', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => redirectTo(detailUrl));
    await expect(get(detailUrl, { fetchFn })).rejects.toThrow(/Too many redirects/);
    // Bounded: initial request plus at most MAX_REDIRECTS follow-ups.
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('errors on a 30x with no Location header instead of treating it as a body', async () => {
    const fetchFn: FetchFn = async () => new Response('', { status: 302 });
    await expect(get(detailUrl, { fetchFn })).rejects.toThrow(/no Location header/);
  });
});

describe('listing pagination cost', () => {
  it('reads the header count and issues exactly one upstream request', async () => {
    const html = readFixture('korytnacka-all.html');
    const fetchFn = vi.fn<FetchFn>(async () => htmlResponse(html));

    const result = await listCourses({ category: 'korytnacka' }, { fetchFn });

    expect(result.total).toBe(140);
    // Previously this always fetched `?page=1` as well, just to discover there was no
    // page 1 -- doubling upstream load on every cold-cache call.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('parses the header count, and returns null for the no-results sentinel', () => {
    expect(parseHeaderCount(readFixture('korytnacka-all.html'))).toBe(140);
    expect(parseHeaderCount(readFixture('zralok-all.html'))).toBe(12);
    // The empty-result page prints Slovak prose in place of a number.
    expect(parseHeaderCount(readFixture('empty-result.html'))).toBeNull();
  });
});

describe('find_common_slots duplicate categories', () => {
  it('collapses aliases of the same category instead of counting it twice', async () => {
    const fetchFn: FetchFn = async () => htmlResponse(readFixture('korytnacka-all.html'));

    // "korytnacka" and "Korytnačka" resolve to the same slug. Undeduplicated, the
    // "every requested category is present" check was satisfied twice by one category's
    // courses, reporting slots as serving two categories when they serve one.
    const result = await findCommonSlots(
      { categories: [{ category: 'korytnacka' }, { category: 'Korytnačka' }] },
      { fetchFn },
    );

    for (const match of result.matches) {
      expect(match.groups.map((g) => g.category)).toEqual(['korytnacka']);
    }
  });
});

describe('limit/offset clamping', () => {
  const fetchAll: FetchFn = async () => htmlResponse(readFixture('korytnacka-all.html'));

  it('treats a negative offset as 0 rather than slicing from the end', async () => {
    // Array.slice(-5) returns the LAST five rows, which would be served as if they were
    // the first page.
    const result = await listCourses(
      { category: 'korytnacka', offset: -5, limit: 3 },
      { fetchFn: fetchAll },
    );
    const first = await listCourses(
      { category: 'korytnacka', offset: 0, limit: 3 },
      { fetchFn: fetchAll },
    );

    expect(result.offset).toBe(0);
    expect(result.courses.map((c) => c.id)).toEqual(first.courses.map((c) => c.id));
  });

  it('floors a fractional limit instead of returning nothing', async () => {
    const result = await listCourses({ category: 'korytnacka', limit: 2.7 }, { fetchFn: fetchAll });
    expect(result.returned).toBe(2);
    expect(result.total).toBe(140);
  });
});

describe('listing-page URL construction', () => {
  it('does not concatenate an absolute href onto the base URL', () => {
    const html = readFixture('zralok-all.html').replace(
      '/plavecky-kurz/plavanie-pre-deti-zralok/plavaren-baronka-raca/1313637',
      'https://evil.example/plavecky-kurz/a/b/1313637',
    );
    // The old unanchored pattern + string concatenation produced
    // "https://plaveckaakademia.skhttps://evil.example/..." -- a garbage URL handed to an
    // LLM that may show it to a user. An off-site href must be rejected outright.
    expect(() => parseList(html)).toThrow(/href/i);
  });
});

describe('find_common_slots paging', () => {
  const fetchFn: FetchFn = async () => htmlResponse(readFixture('korytnacka-all.html'));

  it('reports the full match count while returning only the requested slice', async () => {
    const full = await findCommonSlots({ categories: [{ category: 'korytnacka' }] }, { fetchFn });
    expect(full.total).toBeGreaterThan(3);
    expect(full.returned).toBe(full.total);

    const page = await findCommonSlots(
      { categories: [{ category: 'korytnacka' }], limit: 3, offset: 1 },
      { fetchFn },
    );
    expect(page.total).toBe(full.total);
    expect(page.offset).toBe(1);
    expect(page.returned).toBe(3);
    expect(page.matches.map((m) => `${m.centre}|${m.day}`)).toEqual(
      full.matches.slice(1, 4).map((m) => `${m.centre}|${m.day}`),
    );
  });

  it('clamps a negative offset rather than slicing from the end', async () => {
    const page = await findCommonSlots(
      { categories: [{ category: 'korytnacka' }], limit: 2, offset: -5 },
      { fetchFn },
    );
    expect(page.offset).toBe(0);
    expect(page.returned).toBe(2);
  });
});

describe('time filter validation', () => {
  const fetchFn: FetchFn = async () => htmlResponse(readFixture('korytnacka-all.html'));

  it('rejects an unparseable timeFrom instead of silently returning everything', async () => {
    // NaN comparisons are always false, so the filter used to match every course while
    // appearing to have been applied.
    await expect(
      listCourses({ category: 'korytnacka', timeFrom: 'not-a-time' }, { fetchFn }),
    ).rejects.toThrow(/"timeFrom" must be a time in HH:MM form/);
  });

  it('rejects an out-of-range time of day', async () => {
    await expect(
      listCourses({ category: 'korytnacka', timeTo: '99:99' }, { fetchFn }),
    ).rejects.toThrow(/not a valid time of day/);
  });

  it('still accepts a well-formed time', async () => {
    const result = await listCourses({ category: 'korytnacka', timeFrom: '16:00' }, { fetchFn });
    expect(result.total).toBeGreaterThan(0);
  });
});

describe('detail-page URL construction', () => {
  const html = readFixture('detail-1313637.html');

  it('rejects an off-site canonical link instead of reporting it as the course URL', () => {
    // The canonical id pattern used to be unanchored, so this matched on its tail and the
    // attacker's host was returned verbatim as `url` in structuredContent.
    const drifted = html.replace(
      /<link rel="canonical" href="[^"]*"/,
      '<link rel="canonical" href="https://evil.example/plavecky-kurz/a/b/1313637"',
    );
    expect(() => parseDetail(drifted)).toThrow(/outside plaveckaakademia\.sk/i);
  });

  it('rejects an off-site booking link rather than emitting a mangled URL', () => {
    // Previously produced "https://plaveckaakademia.skhttps://evil.example/steal" by
    // concatenation -- the same class of defect the "listing-page URL construction" tests
    // above guard in parseList. bookingUrl is the field a human is most likely to actually
    // click.
    const drifted = html.replace(
      /(<a[^>]*class="[^"]*prihlasit[^"]*"[^>]*href=")[^"]*"/,
      '$1https://evil.example/steal"',
    );
    expect(drifted).not.toBe(html);
    expect(() => parseDetail(drifted)).toThrow(/outside plaveckaakademia\.sk/i);
  });

  it('still accepts a relative booking href and resolves it against the site', () => {
    expect(parseDetail(html).bookingUrl).toMatch(/^https:\/\/plaveckaakademia\.sk\//);
  });
});
