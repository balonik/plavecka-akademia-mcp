/**
 * Shared test helpers: fixture loading and small HTML builders for synthetic scenarios
 * that would be awkward or fragile to carve out of the large recorded fixtures (e.g. "the
 * listing container is missing entirely").
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchFn } from '../src/site/client.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Reads a committed fixture from `test/fixtures/<name>` as UTF-8 text. */
export function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

/**
 * Extracts the URL string from whatever `fetch`'s first argument happens to be.
 *
 * `String(input)` is wrong here: `RequestInfo` includes `Request`, which has no meaningful
 * `toString()` and would stringify to "[object Object]", silently turning a URL assertion
 * into one that can never fail.
 */
export function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export interface SyntheticRow {
  categorySlug: string;
  poolSlug: string;
  id: string;
  day: string;
  hour: string;
  startRaw: string;
  centre: string;
  starCount: 0 | 1 | 2;
  priceRaw: string;
  lessonsRaw: string;
  capacityClass: 'greenc' | 'orangec' | 'redc' | 'unknown-class';
  capacityRaw: string;
}

const DEFAULT_ROW: SyntheticRow = {
  categorySlug: 'plavanie-pre-deti-korytnacka',
  poolSlug: 'testpool',
  id: '9999001',
  day: 'Pondelok',
  hour: '10:00-11:00',
  startRaw: '20. júl',
  centre: 'Šustekova',
  starCount: 0,
  priceRaw: '10 €',
  lessonsRaw: '1 lekcia',
  capacityClass: 'greenc',
  capacityRaw: 'Voľné miesta',
};

function renderStars(count: 0 | 1 | 2): string {
  const img =
    '<img src="/sites/all/themes/bygstudio/images/icons/star-orange.svg" alt="Star" width="15" height="15" />';
  return img.repeat(count);
}

function renderRow(row: SyntheticRow): string {
  return `
    <div class="views-row">
      <a href="/plavecky-kurz/${row.categorySlug}/${row.poolSlug}/${row.id}" class="termin-link">
        <div class="views-field views-field-field-den-cas-kurzu frekvencia">
          <div class="item-list"><ul><li class="first"><strong>1-krát týždenne</strong></li>
          <li class="last"> <div class="dayhod"><span class="day">${row.day}</span><span class="hour"> ${row.hour}</span></div> </li>
          </ul></div>
        </div>
        <div class="views-field views-field-field-presny-datum-cas zaciatok-kurzu">    <div class="views-label">Termín</div>    ${row.startRaw}  </div>
        <div class="views-field views-field-field-n-zov-v-tabulkach stredisko">    <div class="views-label">Stredisko</div>    ${row.centre}  </div>
        <div class="views-field views-field-field-uroven uroven">    <div class="views-label">Úroveň</div>    <div class="field-uroven">${renderStars(row.starCount)}</div>  </div>
        <div class="views-field views-field-field-cena-kurzu cena-kurzu">    <div class="cena-row"><span class="suma-span">${row.priceRaw}</span><span class="pocet-lekcii">${row.lessonsRaw}</span></div>  </div>
        <div class="views-field-field-kapacita-kurzu">        <span class="${row.capacityClass}">${row.capacityRaw}</span>  </div>
      </a>
    </div>`;
}

/**
 * Builds a minimal, structurally valid listing page containing only the real listing
 * view (no "other view blocks" noise) with the given rows, scoped exactly the way the
 * live site scopes it: `.view-id-22_zoznam_terminov_kurzov.view-display-id-block_3 >
 * .view-content > .views-row`.
 */
export function buildListingHtml(rows: readonly Partial<SyntheticRow>[]): string {
  const rendered = rows.map((partial) => renderRow({ ...DEFAULT_ROW, ...partial })).join('\n');
  return `<!doctype html>
<html><body>
<div class="view view-22-zoznam-terminov-kurzov view-id-22_zoznam_terminov_kurzov view-display-id-block_3 view-dom-id-test">
  <div class="view-header"><div class="pocet-terminov">${String(rows.length)} termínov</div></div>
  <div class="view-content">
    ${rendered}
  </div>
</div>
</body></html>`;
}
