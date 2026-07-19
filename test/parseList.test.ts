import { describe, expect, it } from 'vitest';
import { parseList } from '../src/site/parseList.js';
import { readFixture } from './helpers.js';

describe('parseList', () => {
  it('parses the unfiltered Korytnačka listing to exactly 140 courses, not 145 (the container-scoping trap)', () => {
    const html = readFixture('korytnacka-all.html');
    const courses = parseList(html);
    expect(courses).toHaveLength(140);
  });

  it('parses the field-by-field first row of the Korytnačka listing correctly', () => {
    const html = readFixture('korytnacka-all.html');
    const courses = parseList(html);
    expect(courses[0]).toMatchObject({
      id: '1309868',
      poolSlug: 'dubravka',
      centre: 'Dúbravka',
      level: '*',
      frequency: '1-krát týždenne',
      schedule: [{ day: 'Pondelok', from: '16:30', to: '17:30' }],
      lessonsRaw: '2 lekcie',
      capacity: { available: true, status: 'last_two', raw: 'Posledné 2 miesta' },
    });
    expect(courses[0]?.url).toBe(
      'https://plaveckaakademia.sk/plavecky-kurz/plavanie-pre-deti-korytnacka/dubravka/1309868',
    );
    expect(courses[0]?.startDate.raw).toBe('20. júl');
    expect(courses[0]?.price).toEqual({ amount: 35.6, currency: 'EUR', raw: '35,6 €' });
  });

  it('maps the three known capacity classes to the correct status across the full 140-row fixture', () => {
    const html = readFixture('korytnacka-all.html');
    const courses = parseList(html);
    const byStatus = {
      free: courses.filter((c) => c.capacity.status === 'free'),
      last_one: courses.filter((c) => c.capacity.status === 'last_one'),
      last_two: courses.filter((c) => c.capacity.status === 'last_two'),
    };
    // Ground truth, cross-checked directly against the recorded fixture markup: 101
    // "greenc" rows, 16 "orangec" rows, 23 "redc" rows -- summing to the full 140.
    expect(byStatus.free).toHaveLength(101);
    expect(byStatus.last_one).toHaveLength(16);
    expect(byStatus.last_two).toHaveLength(23);
    // All three known classes mean "bookable" -- never silently treated as sold out.
    for (const course of [...byStatus.free, ...byStatus.last_one, ...byStatus.last_two]) {
      expect(course.capacity.available).toBe(true);
    }
  });

  it('every row yields a numeric id, at least one day/time slot, a centre, a price and an availability flag', () => {
    const html = readFixture('korytnacka-all.html');
    const courses = parseList(html);
    expect(courses.length).toBeGreaterThan(0);
    for (const course of courses) {
      expect(course.id).toMatch(/^\d+$/);
      expect(course.schedule.length).toBeGreaterThan(0);
      for (const slot of course.schedule) {
        expect(slot.day.length).toBeGreaterThan(0);
        expect(slot.from).toMatch(/^\d{1,2}:\d{2}$/);
        expect(slot.to).toMatch(/^\d{1,2}:\d{2}$/);
      }
      expect(course.centre.length).toBeGreaterThan(0);
      expect(typeof course.price.amount).toBe('number');
      expect(Number.isNaN(course.price.amount)).toBe(false);
      expect(typeof course.capacity.available).toBe('boolean');
    }
  });

  it('parses the Barónka-filtered response (27 rows), all at the Barónka centre', () => {
    const html = readFixture('korytnacka-baronka.html');
    const courses = parseList(html);
    expect(courses).toHaveLength(27);
    expect(courses.every((c) => c.centre === 'Barónka')).toBe(true);
  });

  it('parses the Devínska-filtered response (15 rows), all at the Devínska centre', () => {
    const html = readFixture('korytnacka-devinska.html');
    const courses = parseList(html);
    expect(courses).toHaveLength(15);
    expect(courses.every((c) => c.centre === 'Devínska')).toBe(true);
  });

  it('parses the uroven=0 (level "*") filtered response (71 rows), all mapped to level "*"', () => {
    const html = readFixture('korytnacka-level1.html');
    const courses = parseList(html);
    expect(courses).toHaveLength(71);
    expect(courses.every((c) => c.level === '*')).toBe(true);
  });

  it('parses the small Žralok listing (12 rows) field-by-field for the first row', () => {
    const html = readFixture('zralok-all.html');
    const courses = parseList(html);
    expect(courses).toHaveLength(12);
    expect(courses[0]).toMatchObject({
      id: '1313637',
      poolSlug: 'plavaren-baronka-raca',
      centre: 'Barónka',
      level: '*',
      frequency: '1-krát týždenne',
      schedule: [{ day: 'Streda', from: '17:30', to: '18:30' }],
      lessonsRaw: '2 lekcie',
      capacity: { available: true, status: 'free', raw: 'Voľné miesta' },
    });
    expect(courses[0]?.startDate.raw).toBe('22. júl');
    expect(courses[0]?.price).toEqual({ amount: 35.6, currency: 'EUR', raw: '35,6 €' });
  });

  it('parses the single-row Morský koník listing (a category with no sub-levels)', () => {
    const html = readFixture('morsky-konik.html');
    const courses = parseList(html);
    expect(courses).toHaveLength(1);
    expect(courses[0]).toMatchObject({
      id: '1315054',
      poolSlug: 'plavaren-baronka-raca',
      centre: 'Barónka',
      schedule: [{ day: 'Sobota', from: '12:30', to: '13:30' }],
      lessonsRaw: '1 lekcia',
      capacity: { available: true, status: 'last_one', raw: 'Posledné miesto' },
    });
    expect(courses[0]?.price).toEqual({ amount: 18.3, currency: 'EUR', raw: '18,3 €' });
  });

  it('returns [] for the structural empty-result sentinel (container present, no .view-content child)', () => {
    const html = readFixture('empty-result.html');
    expect(parseList(html)).toEqual([]);
  });

  it('throws when the listing container is missing entirely (selector drift must fail loudly)', () => {
    // Corrupt a real fixture's container class so the scoping selector can no longer
    // match anything, simulating "the site markup changed and our selector broke".
    const html = readFixture('korytnacka-baronka.html').replace(
      'view-id-22_zoznam_terminov_kurzov',
      'view-id-something-else-entirely',
    );
    expect(() => parseList(html)).toThrow(/Could not find the course listing container/);
  });

  it('resolves the year-less start date relative to the supplied reference date', () => {
    const html = readFixture('zralok-all.html');
    const courses = parseList(html, { referenceDate: new Date('2026-01-01T00:00:00Z') });
    expect(courses[0]?.startDate).toEqual({
      raw: '22. júl',
      iso: '2026-07-22',
      yearInferred: true,
    });
  });
});
