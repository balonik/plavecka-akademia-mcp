# CLAUDE.md

Context for working on this repo with Claude Code. Read this before changing anything under
`src/site/` — most of it encodes findings that were verified against the live site and are easy to
silently break.

## What this is

A remote MCP server that scrapes [plaveckaakademia.sk](https://plaveckaakademia.sk) children's
swimming course listings and exposes them as MCP tools, so an LLM can answer questions the site's
own UI can't:

- _"Give me available courses for Žralok on Friday in Devínska"_
- _"Give me dates and places where I can book Žralok, Delfín and Korytnačka at the same location"_

It deploys as an Azure Function App over HTTPS and is registered in Claude as a custom web
connector. **Gated by an Azure Functions key** (`authLevel: 'function'` in `src/functions/mcp.ts`,
requiring `?code=<key>`), not user authentication — it's a read-only proxy over public listings, so
there's no per-user login, but don't reintroduce `authLevel: 'anonymous'` without a deliberate
reason; see README's "Security & trust model".

## Why it exists

The site is Drupal 7 + Views. Its exposed filter form supports exactly two filters — centre
(`stredisko[]`) and sub-level (`uroven[]`). There is no API, no day/time/price filter, and no way
to ask a question spanning several categories. Everything else this server offers is applied
in-server over the full (unpaged) upstream result.

## Architecture

```
src/site/       Scraping core — pure and independently testable
  constants.ts    Category/centre/level tables, selectors, URL builder, host allowlist
  normalize.ts    Price, Slovak dates, time ranges, diacritic-insensitive resolution
  client.ts       fetch + timeout + retry + TTL cache + in-flight dedup + LRU bound
  parseList.ts    Listing HTML  -> CourseSummary[]
  parseDetail.ts  Detail HTML   -> CourseDetail
src/tools/      One MCP tool per file; zod input+output schemas, structuredContent
src/server.ts   McpServer construction + tool registration
src/functions/  Azure Functions v4 HTTP trigger; thin adapter, excluded from coverage
```

The dependency direction is strictly `functions -> server -> tools -> site`. Keep `src/site/`
free of MCP concepts and `src/tools/` free of HTML.

## Site facts that are load-bearing

These were each verified against the live site and are pinned by tests. Do not "simplify" them
away.

1. **Container scoping.** Category pages contain other Views blocks (`22_zoznam_centier`) that also
   render `.views-row` elements. Parsing must be scoped inside
   `div.view-id-22_zoznam_terminov_kurzov.view-display-id-block_3 > div.view-content`. An unscoped
   query returns 145 rows for Korytnačka instead of 140. `test/parseList.test.ts` asserts this
   exact number for that reason.

2. **Empty results are structural, not textual.** Zero matches renders the view container with
   **no `.view-content` child at all**. Detect that structurally. Do not string-match the Slovak
   sentinel ("Pre daný výber nie su dostupné žiadne voľné termíny" — note the site's own missing
   diacritic in "nie su"). Conversely, a _missing container_ means the selector drifted and must
   **throw**, never return `[]` — a silent empty list is indistinguishable from a legitimate
   zero-result answer, which is the worst possible failure mode for this server.

3. **All three capacity states mean bookable.** `greenc` = "Voľné miesta", `orangec` = "Posledné
   miesto", `redc` = "Posledné 2 miesta". A naive `greenc`-only availability check hides 39 of 140
   Korytnačka courses. No "sold out" state has ever been observed; an unknown class maps to
   `status: 'unknown'` with `available: true` rather than dropping the row.

4. **Sub-level mapping is counter-intuitive.** `uroven[]=0` → one star (`*`), `uroven[]=1` → two
   stars (`**`). Zero-star rows come back under _both_ filter values, so a level-specific request
   post-filters on the actual star count.

5. **Unknown filter values return empty, not an error.** The site happily accepts
   `stredisko[]=Atlantis` and renders zero results. So input must be validated against the known
   set _before_ the request — otherwise a typo looks like "no courses available". This is why
   `resolveCentre`/`resolveCategory`/`resolveDay` throw with the valid list.

6. **Centre names must match the site exactly.** It is `Podunajské Biskupice` (é), not
   `Podunajská`. That one bit us: the spellings differ _after_ diacritic stripping too, so the
   fuzzy matcher can't rescue it. `test/tools.test.ts` round-trips every centre through
   `stripDiacritics` → `resolveCentre` → outgoing URL to catch this class of bug.

7. **The view is unpaged.** Header count equals row count on every category; there is no `.pager`
   markup. The client still walks `?page=N` defensively and stops when a page yields no new ids.

8. **Listing dates have no year** (`22. júl`). The year is inferred as the nearest future
   occurrence relative to an injectable reference date, so a December date read in January rolls
   forward. Tests fake the clock; never write assertions that drift with the real calendar.

## Testing

`npm run check` = typecheck → lint → format check → tests. All 130 tests run offline: the HTTP
layer takes an injectable `fetchFn` (or, for `test/mcpProtocol.test.ts`'s real-wire-protocol tests
against `createServer()`, a stubbed global `fetch`) and parsers read committed fixtures in
`test/fixtures/`. Coverage threshold is 80% on `src/site/**` and `src/tools/**`.

**Re-recording fixtures**: the fixtures are a point-in-time snapshot (July 2026) with real course
data. If the site's markup changes, re-record them rather than loosening assertions — the whole
point of the pinned counts is to detect drift. See CONTRIBUTING.md for how.

Because fixtures are frozen, a passing test suite does **not** prove the server still works against
the live site. Those are two different signals:

- fixture tests pass, live fails → the site's markup drifted; update selectors and re-record.
- fixture tests fail after a code change → you broke the parser.

Run a live check before trusting a scraping change.

## Conventions

- ESM throughout, `NodeNext` resolution: relative imports use a `.js` specifier even for `.ts`
  files. This is why `n/no-missing-import` is disabled — `tsc` is the authority on resolution.
- Tool output types are declared as `type` aliases, **not** `interface`. The MCP SDK types
  `structuredContent` as `{ [x: string]: unknown }`, and TypeScript only grants an implicit index
  signature to type aliases. `@typescript-eslint/consistent-type-definitions` is disabled for this
  reason — switching them back to `interface` breaks the build.
- Parsers fail loudly. Prefer throwing with a message naming the selector over returning partial or
  defaulted data.

## Gotchas for the environment

- Node lives at `C:\Program Files\nodejs` and may not be on `PATH` in a fresh shell.
- The Bash tool mangles non-ASCII on this Windows box — Slovak accented strings passed through
  shell arguments can arrive corrupted. This originally produced a bogus "0 results" reading during
  analysis. Use Node/Python with explicit UTF-8, or the Read/Edit tools, for anything involving
  accented text; don't trust accented characters round-tripped through the shell.
