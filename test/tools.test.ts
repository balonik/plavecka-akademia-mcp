import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache, type FetchFn } from '../src/site/client.js';
import { CENTRES } from '../src/site/constants.js';
import { stripDiacritics } from '../src/site/normalize.js';
import { findCommonSlots } from '../src/tools/find_common_slots.js';
import { getCourse } from '../src/tools/get_course.js';
import { listCourses } from '../src/tools/list_courses.js';
import { buildListingHtml, readFixture, urlOf } from './helpers.js';

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

beforeEach(() => {
  clearCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('list_courses', () => {
  const korytnackaAll = readFixture('korytnacka-all.html');
  const fetchAll: FetchFn = async () => htmlResponse(korytnackaAll);

  it('filters by day', async () => {
    const result = await listCourses(
      { category: 'korytnacka', day: 'streda' },
      { fetchFn: fetchAll },
    );
    expect(result.total).toBeGreaterThan(0);
    expect(result.total).toBeLessThan(140);
    for (const course of result.courses) {
      expect(course.schedule.some((slot) => slot.day === 'Streda')).toBe(true);
    }
  });

  it('filters out a course whose only slot starts before timeFrom', async () => {
    // Fixture row #1 (id 1309868) runs Pondelok 16:30-17:30.
    const result = await listCourses(
      { category: 'korytnacka', timeFrom: '17:00' },
      { fetchFn: fetchAll },
    );
    expect(result.courses.some((c) => c.id === '1309868')).toBe(false);
    expect(result.total).toBeGreaterThan(0);
    expect(result.total).toBeLessThan(140);
  });

  it('keeps a course whose slot starts at or after timeFrom', async () => {
    const result = await listCourses(
      { category: 'korytnacka', timeFrom: '16:00' },
      { fetchFn: fetchAll },
    );
    expect(result.courses.some((c) => c.id === '1309868')).toBe(true);
  });

  it('filters by maxPrice', async () => {
    const unfiltered = await listCourses({ category: 'korytnacka' }, { fetchFn: fetchAll });
    const filtered = await listCourses(
      { category: 'korytnacka', maxPrice: 40 },
      { fetchFn: fetchAll },
    );
    expect(filtered.total).toBeLessThan(unfiltered.total);
    expect(filtered.total).toBeGreaterThan(0);
    for (const course of filtered.courses) {
      expect(course.price.amount).toBeLessThanOrEqual(40);
    }
  });

  it('onlyAvailable keeps every course, since all three known capacity classes mean "bookable"', async () => {
    // `parseList` always sets `capacity.available = true` for the three known classes
    // (and, defensively, for an unrecognised one too) -- there is no observed "sold out"
    // state on the live site. This documents that behaviour rather than a filtering bug.
    const unfiltered = await listCourses({ category: 'korytnacka' }, { fetchFn: fetchAll });
    const filtered = await listCourses(
      { category: 'korytnacka', onlyAvailable: true },
      { fetchFn: fetchAll },
    );
    expect(filtered.total).toBe(unfiltered.total);
  });

  it('limit/offset slice the full result while total still reflects the whole set', async () => {
    const full = await listCourses({ category: 'korytnacka' }, { fetchFn: fetchAll });
    expect(full.total).toBe(140);

    const page = await listCourses(
      { category: 'korytnacka', limit: 10, offset: 5 },
      { fetchFn: fetchAll },
    );
    expect(page.total).toBe(140);
    expect(page.offset).toBe(5);
    expect(page.returned).toBe(10);
    expect(page.courses).toHaveLength(10);
    expect(page.courses.map((c) => c.id)).toEqual(full.courses.slice(5, 15).map((c) => c.id));
  });

  it('rejects an unknown location with an error listing the valid values, not an empty result', async () => {
    await expect(
      listCourses({ category: 'korytnacka', location: 'Atlantis' }, { fetchFn: fetchAll }),
    ).rejects.toThrow(/Unknown location "Atlantis"/);
    await expect(
      listCourses({ category: 'korytnacka', location: 'Atlantis' }, { fetchFn: fetchAll }),
    ).rejects.toThrow(/Barónka/);
  });

  it('rejects an unknown category with an error listing the valid slugs', async () => {
    await expect(listCourses({ category: 'nemo' }, { fetchFn: fetchAll })).rejects.toThrow(
      /Unknown category "nemo"/,
    );
  });

  it('resolves a location diacritic/case-insensitively and sends it upstream', async () => {
    // Location is filtered by the SITE, not in-server, so the observable behaviour is the
    // outgoing URL. Assert the loosely-spelled input resolves to the site's exact value.
    const seen: string[] = [];
    const fetchBaronka: FetchFn = async (url) => {
      seen.push(urlOf(url));
      return htmlResponse(readFixture('korytnacka-baronka.html'));
    };

    const result = await listCourses(
      { category: 'korytnacka', location: 'baronka' },
      { fetchFn: fetchBaronka },
    );

    expect(seen[0]).toContain('stredisko%5B%5D=Bar%C3%B3nka');
    expect(result.total).toBe(27);
    expect(result.courses.every((c) => c.centre === 'Barónka')).toBe(true);
  });

  it('resolves every known centre name from its diacritic-stripped spelling', async () => {
    // Guards the class of bug where a constant is misspelled relative to the site's own
    // filter value (e.g. "Podunajská" vs the site's actual "Podunajské" Biskupice), which
    // would otherwise silently send an unmatched value upstream and return nothing.
    const seen: string[] = [];
    const capture: FetchFn = async (url) => {
      seen.push(urlOf(url));
      return htmlResponse(korytnackaAll);
    };

    for (const centre of CENTRES) {
      clearCache();
      await listCourses(
        { category: 'korytnacka', location: stripDiacritics(centre) },
        { fetchFn: capture },
      );
      // URLSearchParams encodes a space as "+", which is exactly what the site's own form sends.
      const expected = new URLSearchParams({ 'stredisko[]': centre }).toString();
      expect(seen.at(-1)).toContain(expected);
    }
  });

  it('filters by startAfter/startBefore, resolving the year-less dates against "now"', async () => {
    vi.useFakeTimers();
    // Well before the fixture's July dates, so "nearest future occurrence" resolves them
    // all into the same year (2026) deterministically -- see test/parseList.test.ts for
    // the same fixture rows' raw dates ("20. júl" / "21. júl").
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const after = await listCourses(
      { category: 'korytnacka', startAfter: '2026-07-21' },
      { fetchFn: fetchAll },
    );
    expect(after.courses.some((c) => c.id === '1309868')).toBe(false); // starts 2026-07-20
    expect(after.courses.some((c) => c.id === '1312915')).toBe(true); // starts 2026-07-21

    const before = await listCourses(
      { category: 'korytnacka', startBefore: '2026-07-20' },
      { fetchFn: fetchAll },
    );
    expect(before.courses.some((c) => c.id === '1309868')).toBe(true);
    expect(before.courses.some((c) => c.id === '1312915')).toBe(false);
  });
});

describe('get_course', () => {
  const detailHtml = readFixture('detail-1313637.html');
  const fetchDetail: FetchFn = async () => htmlResponse(detailHtml);

  it('fetches and parses a course by its detail URL', async () => {
    const detail = await getCourse(
      {
        url: 'https://plaveckaakademia.sk/plavecky-kurz/plavanie-pre-deti-zralok/plavaren-baronka-raca/1313637',
      },
      { fetchFn: fetchDetail },
    );
    expect(detail.id).toBe('1313637');
    expect(detail.centre).toBe('Barónka');
  });

  it('resolves a numeric courseId to the shortlink URL and still parses the result', async () => {
    const calledUrls: string[] = [];
    const impl: FetchFn = async (input) => {
      calledUrls.push(urlOf(input));
      return htmlResponse(detailHtml);
    };
    const detail = await getCourse({ courseId: '1313637' }, { fetchFn: impl });
    expect(detail.id).toBe('1313637');
    expect(calledUrls).toEqual(['https://plaveckaakademia.sk/node/1313637']);
  });

  it('rejects a non-numeric courseId without fetching anything', async () => {
    const explodingFetch: FetchFn = () => {
      throw new Error('fetchFn must not be called for an invalid courseId');
    };
    await expect(getCourse({ courseId: 'abc' }, { fetchFn: explodingFetch })).rejects.toThrow(
      /"courseId" must be a numeric id/,
    );
  });

  it('rejects when both courseId and url are given', async () => {
    await expect(
      getCourse(
        { courseId: '1313637', url: 'https://plaveckaakademia.sk/x' },
        { fetchFn: fetchDetail },
      ),
    ).rejects.toThrow(/Provide either "courseId" or "url", not both/);
  });

  it('rejects when neither courseId nor url is given', async () => {
    await expect(getCourse({}, { fetchFn: fetchDetail })).rejects.toThrow(
      /Provide either "courseId" or "url"/,
    );
  });

  describe('SSRF guard on the `url` argument', () => {
    const explodingFetch: FetchFn = () => {
      throw new Error('fetchFn must not be called for a rejected url');
    };

    it('rejects a look-alike subdomain host (plaveckaakademia.sk.evil.com)', async () => {
      await expect(
        getCourse({ url: 'https://plaveckaakademia.sk.evil.com/x' }, { fetchFn: explodingFetch }),
      ).rejects.toThrow(/not allowed/);
    });

    it('rejects a plain http URL even for the real host', async () => {
      await expect(
        getCourse({ url: 'http://plaveckaakademia.sk/x' }, { fetchFn: explodingFetch }),
      ).rejects.toThrow(/Only https is permitted/);
    });

    it('rejects an explicit port on the allowed host', async () => {
      await expect(
        getCourse(
          { url: 'https://plaveckaakademia.sk:8443/plavecky-kurz/a/b/1313637' },
          { fetchFn: explodingFetch },
        ),
      ).rejects.toThrow(/non-default port/);
    });

    it('rejects credentials embedded in the URL', async () => {
      await expect(
        getCourse(
          { url: 'https://user:pass@plaveckaakademia.sk/plavecky-kurz/a/b/1313637' },
          { fetchFn: explodingFetch },
        ),
      ).rejects.toThrow(/Credentials embedded/);
    });

    it('rejects any path that is not a course detail page (no open GET proxy)', async () => {
      for (const path of ['/', '/admin', '/user/login?destination=http://169.254.169.254/']) {
        await expect(
          getCourse({ url: `https://plaveckaakademia.sk${path}` }, { fetchFn: explodingFetch }),
        ).rejects.toThrow(/is not a course detail page/);
      }
    });

    it('rejects an unrelated host with the real domain only in the path', async () => {
      await expect(
        getCourse({ url: 'https://evil.com/plaveckaakademia.sk' }, { fetchFn: explodingFetch }),
      ).rejects.toThrow(/not allowed/);
    });
  });
});

describe('find_common_slots', () => {
  it('returns only centre/day combinations where every requested category has a matching course', async () => {
    const korytnackaHtml = readFixture('korytnacka-all.html');
    const zralokHtml = readFixture('zralok-all.html');
    const impl: FetchFn = async (input) => {
      const url = urlOf(input);
      return htmlResponse(url.includes('/zralok') ? zralokHtml : korytnackaHtml);
    };

    const result = await findCommonSlots(
      { categories: [{ category: 'korytnacka' }, { category: 'zralok' }] },
      { fetchFn: impl },
    );

    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      const korytnacka = match.groups.find((g) => g.category === 'korytnacka');
      const zralok = match.groups.find((g) => g.category === 'zralok');
      expect(korytnacka?.courses.length).toBeGreaterThan(0);
      expect(zralok?.courses.length).toBeGreaterThan(0);
    }
  });

  it('returns no matches when the requested categories share no centre+day combination', async () => {
    const korytnackaHtml = buildListingHtml([
      {
        categorySlug: 'plavanie-pre-deti-korytnacka',
        id: '5000001',
        centre: 'Limbach',
        day: 'Pondelok',
      },
    ]);
    const zralokHtml = buildListingHtml([
      {
        categorySlug: 'plavanie-pre-deti-zralok',
        id: '5000002',
        centre: 'Šustekova',
        day: 'Piatok',
      },
    ]);
    const impl: FetchFn = async (input) => {
      const url = urlOf(input);
      return htmlResponse(url.includes('/zralok') ? zralokHtml : korytnackaHtml);
    };

    const result = await findCommonSlots(
      { categories: [{ category: 'korytnacka' }, { category: 'zralok' }] },
      { fetchFn: impl },
    );
    expect(result.matches).toEqual([]);
  });

  it('rejects an empty categories list', async () => {
    await expect(findCommonSlots({ categories: [] })).rejects.toThrow(
      /Provide at least one category/,
    );
  });

  it('narrows a category to a specific level while another category stays unfiltered', async () => {
    const zralokHtml = buildListingHtml([
      {
        categorySlug: 'plavanie-pre-deti-zralok',
        id: '6000001',
        centre: 'Limbach',
        day: 'Pondelok',
        starCount: 1,
      },
      {
        categorySlug: 'plavanie-pre-deti-zralok',
        id: '6000002',
        centre: 'Limbach',
        day: 'Pondelok',
        starCount: 2,
      },
    ]);
    const korytnackaHtml = buildListingHtml([
      {
        categorySlug: 'plavanie-pre-deti-korytnacka',
        id: '6000003',
        centre: 'Limbach',
        day: 'Pondelok',
      },
    ]);
    const impl: FetchFn = async (input) => {
      const url = urlOf(input);
      return htmlResponse(url.includes('/zralok') ? zralokHtml : korytnackaHtml);
    };

    const result = await findCommonSlots(
      { categories: [{ category: 'zralok', level: '**' }, { category: 'korytnacka' }] },
      { fetchFn: impl },
    );

    expect(result.matches).toHaveLength(1);
    const zralokGroup = result.matches[0]?.groups.find((g) => g.category === 'zralok');
    expect(zralokGroup?.courses.map((c) => c.id)).toEqual(['6000002']);
  });

  it('allows the same category twice at different levels and matches only where both are present', async () => {
    const bothLevels = buildListingHtml([
      {
        categorySlug: 'plavanie-pre-deti-zralok',
        id: '6000010',
        centre: 'Limbach',
        day: 'Pondelok',
        starCount: 1,
      },
      {
        categorySlug: 'plavanie-pre-deti-zralok',
        id: '6000011',
        centre: 'Limbach',
        day: 'Pondelok',
        starCount: 2,
      },
    ]);
    const onlyOneLevel = buildListingHtml([
      {
        categorySlug: 'plavanie-pre-deti-zralok',
        id: '6000012',
        centre: 'Ružinov',
        day: 'Utorok',
        starCount: 1,
      },
    ]);

    const bothResult = await findCommonSlots(
      {
        categories: [
          { category: 'zralok', level: '*' },
          { category: 'zralok', level: '**' },
        ],
      },
      { fetchFn: async () => htmlResponse(bothLevels) },
    );
    expect(bothResult.matches).toHaveLength(1);
    expect(bothResult.matches[0]?.groups).toHaveLength(2);

    // Both requests resolve to the same upstream URLs (same category/level, no location),
    // so without clearing the cache the second call would be served the first call's
    // cached response instead of exercising `onlyOneLevel`.
    clearCache();
    const oneLevelResult = await findCommonSlots(
      {
        categories: [
          { category: 'zralok', level: '*' },
          { category: 'zralok', level: '**' },
        ],
      },
      { fetchFn: async () => htmlResponse(onlyOneLevel) },
    );
    expect(oneLevelResult.matches).toEqual([]);
  });

  it('sends the resolved level upstream as uroven[]', async () => {
    const seen: string[] = [];
    const impl: FetchFn = async (input) => {
      seen.push(urlOf(input));
      return htmlResponse(buildListingHtml([]));
    };

    await findCommonSlots({ categories: [{ category: 'zralok', level: '**' }] }, { fetchFn: impl });

    expect(seen[0]).toContain('uroven%5B%5D=1');
  });

  it('rejects a level requested for a category with no sub-levels', async () => {
    await expect(
      findCommonSlots({ categories: [{ category: 'morsky-konik', level: '*' }] }),
    ).rejects.toThrow(/does not offer sub-levels/);
  });
});
