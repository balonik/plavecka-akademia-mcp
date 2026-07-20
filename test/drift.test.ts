/**
 * Regression tests for the review findings about SILENT DEGRADATION.
 *
 * The project's stated worst failure mode is a parser that answers "no courses" when it
 * has actually stopped understanding the page. Every test here mutates a real fixture the
 * way a site redesign would (renaming one class or id) and asserts we THROW rather than
 * returning a well-formed, empty, entirely wrong answer.
 *
 * See REVIEW.md H1 and H2.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clearCache, type FetchFn } from '../src/site/client.js';
import { parseDetail } from '../src/site/parseDetail.js';
import { parseList } from '../src/site/parseList.js';
import { listCategories } from '../src/tools/list_categories.js';
import { listCourses } from '../src/tools/list_courses.js';
import { readFixture } from './helpers.js';

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

beforeEach(() => {
  clearCache();
});

describe('parseList drift detection (REVIEW.md H1)', () => {
  const html = readFixture('korytnacka-all.html');

  it('parses the intact fixture (baseline for the mutations below)', () => {
    expect(parseList(html)).toHaveLength(140);
  });

  const mutations: { name: string; mutate: (input: string) => string; expected: RegExp }[] = [
    {
      name: 'the day/time block is renamed',
      mutate: (input) => input.replaceAll('dayhod', 'day-hod'),
      expected: /schedule|dayhod/i,
    },
    {
      name: 'the centre field is renamed',
      mutate: (input) => input.replaceAll('views-field-field-n-zov-v-tabulkach stredisko', 'x'),
      expected: /centre|stredisko/i,
    },
    {
      name: 'the level container is renamed',
      mutate: (input) => input.replaceAll('field-uroven', 'field-uroven-x'),
      expected: /uroven|level/i,
    },
    {
      name: 'the capacity field is renamed',
      mutate: (input) => input.replaceAll('views-field-field-kapacita-kurzu', 'x'),
      expected: /capacity|kapacita/i,
    },
  ];

  for (const { name, mutate, expected } of mutations) {
    it(`throws when ${name}, instead of returning 140 hollow rows`, () => {
      expect(() => parseList(mutate(html))).toThrow(expected);
    });
  }

  it('a day-filtered query surfaces drift as an error, not as "0 courses match"', async () => {
    // The end-to-end shape of the bug: unfiltered still returned 140, so a smoke test
    // passed while every filtered query silently answered "nothing available".
    const drifted = html.replaceAll('dayhod', 'day-hod');
    const fetchFn: FetchFn = async () => htmlResponse(drifted);
    await expect(
      listCourses({ category: 'korytnacka', day: 'piatok' }, { fetchFn }),
    ).rejects.toThrow();
  });
});

describe('parseDetail drift detection (AUDIT.md B1)', () => {
  const html = readFixture('detail-1313637.html');

  it('parses the intact fixture (baseline for the mutations below)', () => {
    expect(parseDetail(html).id).toBe('1313637');
  });

  // The listing parser threw for every one of these; the detail parser used to return a
  // well-formed course with an empty schedule / centre / address / availability instead --
  // the exact "plausible-looking wrong answer" this suite exists to prevent.
  const mutations: { name: string; mutate: (input: string) => string; expected: RegExp }[] = [
    {
      name: 'the day/time block is renamed',
      mutate: (input) => input.replaceAll('dayhod', 'day-hod'),
      expected: /schedule|dayhod/i,
    },
    {
      name: 'the centre heading is renamed',
      mutate: (input) => input.replaceAll('centrum', 'centrum-x'),
      expected: /centre|centrum/i,
    },
    {
      name: 'the address block is renamed',
      mutate: (input) => input.replaceAll('class="address"', 'class="address-x"'),
      expected: /address/i,
    },
    {
      name: 'the capacity/booking row is renamed',
      mutate: (input) => input.replaceAll('prihlasit_row', 'prihlasit-row-x'),
      expected: /capacity|prihlasit/i,
    },
  ];

  for (const { name, mutate, expected } of mutations) {
    it(`throws when ${name}, instead of returning a hollow course`, () => {
      expect(() => parseDetail(mutate(html))).toThrow(expected);
    });
  }
});

describe('listCategories drift detection (REVIEW.md H2)', () => {
  it('throws on a junk page rather than reporting every category as offered nowhere', async () => {
    const fetchFn: FetchFn = async () => htmlResponse('<html><body>hello</body></html>');
    await expect(listCategories({ fetchFn })).rejects.toThrow();
  });

  it('throws when the age-group label drifts, instead of reporting an empty age range', async () => {
    // AUDIT.md B2: extractAgeRange used to return '' here while its neighbour extractCentres
    // threw, so every category came back claiming to have no age range at all.
    const drifted = readFixture('korytnacka-all.html').replace(
      /<strong>[^<]*<\/strong>/g,
      '<strong>RENAMED</strong>',
    );
    const fetchFn: FetchFn = async () => htmlResponse(drifted);
    await expect(listCategories({ fetchFn })).rejects.toThrow(/age range/i);
  });

  it('throws when the centre filter form id drifts', async () => {
    const drifted = readFixture('korytnacka-all.html').replaceAll(
      'edit-stredisko-wrapper',
      'edit-stredisko-box',
    );
    const fetchFn: FetchFn = async () => htmlResponse(drifted);
    // `hasSubLevels: false` + `centres: []` from a drifted page is worse than an error:
    // it is an affirmative false claim that steers the model away from the level filter.
    await expect(listCategories({ fetchFn })).rejects.toThrow(/centre filter form/i);
  });
});
