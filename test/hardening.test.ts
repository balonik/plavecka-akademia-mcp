/**
 * Regression tests for the remaining review findings: redirect handling (M1), the wasted
 * second upstream request (M4), duplicate-category collapse (L2), limit/offset clamping
 * (L3) and absolute-href URL building (L5).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache, get, parseHeaderCount, type FetchFn } from '../src/site/client.js';
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

describe('redirect handling (REVIEW.md M1)', () => {
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

describe('listing pagination cost (REVIEW.md M4)', () => {
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

describe('find_common_slots duplicate categories (REVIEW.md L2)', () => {
  it('collapses aliases of the same category instead of counting it twice', async () => {
    const fetchFn: FetchFn = async () => htmlResponse(readFixture('korytnacka-all.html'));

    // "korytnacka" and "Korytnačka" resolve to the same slug. Undeduplicated, the
    // "every requested category is present" check was satisfied twice by one category's
    // courses, reporting slots as serving two categories when they serve one.
    const result = await findCommonSlots({ categories: ['korytnacka', 'Korytnačka'] }, { fetchFn });

    for (const match of result.matches) {
      expect(Object.keys(match.coursesByCategory)).toEqual(['korytnacka']);
    }
  });
});

describe('limit/offset clamping (REVIEW.md L3)', () => {
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

describe('course URL construction (REVIEW.md L5)', () => {
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
