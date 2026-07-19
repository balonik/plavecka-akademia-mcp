import { describe, expect, it } from 'vitest';
import {
  BASE_URL,
  buildCourseListUrl,
  capacityClassToStatus,
  starsToLevel,
} from '../src/site/constants.js';

describe('starsToLevel', () => {
  it('maps star image counts to the level symbol', () => {
    expect(starsToLevel(1)).toBe('*');
    expect(starsToLevel(2)).toBe('**');
  });

  it('maps zero stars to null (no sub-level)', () => {
    expect(starsToLevel(0)).toBeNull();
  });

  it('maps an unexpected star count defensively to null rather than guessing', () => {
    expect(starsToLevel(3)).toBeNull();
  });
});

describe('capacityClassToStatus', () => {
  it('maps all three known capacity classes to their status', () => {
    expect(capacityClassToStatus('greenc')).toBe('free');
    expect(capacityClassToStatus('orangec')).toBe('last_one');
    expect(capacityClassToStatus('redc')).toBe('last_two');
  });

  it('maps an unrecognised class to "unknown" rather than dropping it', () => {
    expect(capacityClassToStatus('some-future-class')).toBe('unknown');
  });
});

describe('buildCourseListUrl', () => {
  it('builds an unfiltered category URL with no query string', () => {
    const url = buildCourseListUrl('korytnacka');
    expect(url).toBe(`${BASE_URL}/kurzy/plavanie-pre-deti/korytnacka`);
  });

  it('repeats stredisko[] once per centre, in order, for multi-select', () => {
    const url = buildCourseListUrl('korytnacka', { centres: ['Barónka', 'Devínska', 'Ružinov'] });
    const parsed = new URL(url);
    expect(parsed.searchParams.getAll('stredisko[]')).toEqual(['Barónka', 'Devínska', 'Ružinov']);
  });

  it('UTF-8 percent-encodes accented centre values exactly as the site expects', () => {
    const url = buildCourseListUrl('korytnacka', { centres: ['Barónka'] });
    // Verified against the live site (see the plan doc): "Barónka" -> "Bar%C3%B3nka".
    expect(url).toContain('stredisko%5B%5D=Bar%C3%B3nka');
  });

  it('appends uroven[] for a level filter', () => {
    const url = buildCourseListUrl('zralok', { levelParam: '0' });
    const parsed = new URL(url);
    expect(parsed.searchParams.getAll('uroven[]')).toEqual(['0']);

    const url2 = buildCourseListUrl('zralok', { levelParam: '1' });
    expect(new URL(url2).searchParams.getAll('uroven[]')).toEqual(['1']);
  });

  it('combines repeated centre params with a level param', () => {
    const url = buildCourseListUrl('korytnacka', {
      centres: ['Barónka', 'Devínska'],
      levelParam: '1',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.getAll('stredisko[]')).toEqual(['Barónka', 'Devínska']);
    expect(parsed.searchParams.getAll('uroven[]')).toEqual(['1']);
  });

  it('omits uroven[] entirely when no level filter is given', () => {
    const url = buildCourseListUrl('korytnacka', { centres: ['Barónka'] });
    expect(new URL(url).searchParams.has('uroven[]')).toBe(false);
  });
});
