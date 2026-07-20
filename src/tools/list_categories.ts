/**
 * `list_categories` tool: the four skill categories with their age range, whether they
 * offer `*` / `**` sub-levels, and the centres each is offered at. Age range is scraped
 * from a shared "skupiny" info block present on every category listing page; sub-levels
 * and centres are scraped per-category from that category's own exposed filter form
 * (never hardcoded), per the plan's explicit "scrape it from the form" requirement.
 */

import * as cheerio from 'cheerio';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { get, type ClientOptions } from '../site/client.js';
import { BASE_URL, CATEGORIES } from '../site/constants.js';
import { truncateFreeText } from '../site/normalize.js';

export interface CategoryInfo {
  slug: string;
  name: string;
  ageRange: string;
  hasSubLevels: boolean;
  centres: string[];
}

export type ListCategoriesOutput = {
  categories: CategoryInfo[];
};

function extractAgeRange($: cheerio.CheerioAPI, categoryName: string, slug: string): string {
  if ($('.skupiny').length === 0) {
    throw new Error(
      `Could not find the ".skupiny" age-group block on the "${slug}" page; the site markup may have changed.`,
    );
  }
  let found = '';
  $('.skupiny .texty .row').each((_i, el) => {
    const $el = $(el);
    const paragraph = $el.find('p').first();
    const strongText = paragraph.find('strong').first().text().trim();
    if (strongText === categoryName) {
      // Paragraph text is "<Name> - <age range>"; strip the leading "<Name> -" prefix.
      found = paragraph
        .text()
        .replace(strongText, '')
        .replace(/^\s*-\s*/, '')
        .trim();
    }
  });
  // Same reasoning as extractCentres below: an empty age range is a plausible-looking answer
  // that reads as fact to the model, so a drifted block must fail loudly instead.
  if (found === '') {
    throw new Error(
      `Could not find the age range for "${categoryName}" in the ".skupiny" block on the "${slug}" page; the site markup may have changed.`,
    );
  }
  return truncateFreeText(found);
}

/**
 * Extracts the centres offered for a category from its exposed filter form.
 *
 * Both failure modes here throw rather than returning `[]`. An empty list would be a
 * plausible-looking answer meaning "offered nowhere", and `hasSubLevels: false` from a
 * drifted page is worse still -- an affirmative false claim that steers the model away
 * from ever passing a `level` filter. There is no legitimate page where the filter form
 * exists but offers no centre.
 */
function extractCentres($: cheerio.CheerioAPI, slug: string): string[] {
  const wrapper = $('#edit-stredisko-wrapper');
  if (wrapper.length === 0) {
    throw new Error(
      `Could not find the centre filter form ("#edit-stredisko-wrapper") on the "${slug}" page; the site markup may have changed.`,
    );
  }
  const centres = wrapper
    .find('input[name="stredisko[]"]')
    .map((_i, el) => $(el).attr('value') ?? '')
    .get()
    .filter((value) => value.length > 0);
  if (centres.length === 0) {
    throw new Error(
      `The centre filter form on the "${slug}" page offered no centres; the site markup may have changed.`,
    );
  }
  return centres;
}

function extractHasSubLevels($: cheerio.CheerioAPI): boolean {
  // Only meaningful once extractCentres() has confirmed the filter form itself is present;
  // otherwise "no uroven inputs" is indistinguishable from "the whole form moved".
  return $('#edit-uroven-wrapper input[name="uroven[]"]').length > 0;
}

export async function listCategories(options: ClientOptions = {}): Promise<ListCategoriesOutput> {
  const categories: CategoryInfo[] = [];
  for (const def of CATEGORIES) {
    const url = `${BASE_URL}/kurzy/plavanie-pre-deti/${def.slug}`;
    // Sequential on purpose: only 4 requests, each served from the shared 10-minute
    // cache on subsequent calls, and this keeps request ordering (hence log output)
    // predictable.

    const html = await get(url, options);
    const $ = cheerio.load(html);
    categories.push({
      slug: def.slug,
      name: def.name,
      ageRange: extractAgeRange($, def.name, def.slug),
      hasSubLevels: extractHasSubLevels($),
      centres: extractCentres($, def.slug),
    });
  }
  return { categories };
}

const categorySchema = z.object({
  slug: z.string(),
  name: z.string(),
  ageRange: z.string(),
  hasSubLevels: z.boolean(),
  centres: z.array(z.string()),
});

const outputSchema = { categories: z.array(categorySchema) };

export function registerListCategoriesTool(server: McpServer): void {
  server.registerTool(
    'list_categories',
    {
      title: 'List swimming course categories',
      description:
        'Lists the four children’s swimming course categories (Morský koník, Korytnačka, Delfín, Žralok) with their age range, whether they offer */** sub-levels, and the centres each is offered at.',
      outputSchema,
    },
    async () => {
      try {
        const result = await listCategories();
        const text = result.categories
          .map(
            (c) =>
              `${c.name} (${c.slug}) - ${c.ageRange}${c.hasSubLevels ? ', has */** sub-levels' : ', no sub-levels'}; centres: ${c.centres.join(', ')}`,
          )
          .join('\n');
        return { content: [{ type: 'text' as const, text }], structuredContent: result };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
          ],
          isError: true,
        };
      }
    },
  );
}
