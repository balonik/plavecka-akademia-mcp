import { beforeEach, describe, expect, it } from 'vitest';
import { clearCache, type FetchFn } from '../src/site/client.js';
import { listCategories } from '../src/tools/list_categories.js';
import { readFixture, urlOf } from './helpers.js';

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

beforeEach(() => {
  clearCache();
});

describe('listCategories', () => {
  it('scrapes age range, sub-level availability and centres per category from each category page', async () => {
    const morskyKonikHtml = readFixture('morsky-konik.html');
    // Every category page shares the same site-wide "skupiny" age-range panel and filter
    // form furniture, so re-using the Korytnačka fixture for the other three category
    // requests still exercises the real extraction logic faithfully.
    const korytnackaHtml = readFixture('korytnacka-all.html');
    const impl: FetchFn = async (input) => {
      const url = urlOf(input);
      return htmlResponse(url.includes('/morsky-konik') ? morskyKonikHtml : korytnackaHtml);
    };

    const result = await listCategories({ fetchFn: impl });
    expect(result.categories).toHaveLength(4);
    expect(result.categories.map((c) => c.slug)).toEqual([
      'morsky-konik',
      'korytnacka',
      'delfin',
      'zralok',
    ]);

    const morskyKonik = result.categories.find((c) => c.slug === 'morsky-konik');
    expect(morskyKonik).toMatchObject({
      name: 'Morský koník',
      ageRange: '2 až 3 roky',
      hasSubLevels: false,
    });
    // Recorded directly from the fixture's own (smaller) centre list -- distinct from
    // Korytnačka's, proving centres are scraped per-category rather than hardcoded.
    expect(morskyKonik?.centres).toEqual(['Barónka', 'Devínska', 'Limbach']);

    const korytnacka = result.categories.find((c) => c.slug === 'korytnacka');
    expect(korytnacka).toMatchObject({
      name: 'Korytnačka',
      ageRange: '3 až 6 rokov',
      hasSubLevels: true,
    });
    expect(korytnacka?.centres).toHaveLength(8);
    expect(korytnacka?.centres).toContain('Barónka');

    const zralok = result.categories.find((c) => c.slug === 'zralok');
    expect(zralok?.ageRange).toBe('6 až 12 rokov');
  });
});
