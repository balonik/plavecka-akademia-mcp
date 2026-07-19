# Contributing

Thanks for helping out. This project scrapes a live third-party website, which shapes most of the
conventions below — please skim the "Scraping changes" section before touching `src/site/`.

## Getting set up

Requires **Node.js 24 LTS** (pinned in `.nvmrc`) and, for running the Function App locally, the
[Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

```bash
git clone https://github.com/balonik/plavecka-akademia-mcp.git
cd plavecka-akademia-mcp
npm install
npm run check
```

If you use a version manager, `nvm use` / `fnm use` will pick up `.nvmrc`.

## Everyday commands

| Command                 | What it does                                                        |
| ----------------------- | ------------------------------------------------------------------- |
| `npm run check`         | typecheck → lint → format check → tests. Run this before pushing    |
| `npm test`              | Vitest once                                                         |
| `npm run test:coverage` | Vitest with coverage; enforces the 80% threshold                    |
| `npm run typecheck`     | `tsc --noEmit`                                                      |
| `npm run lint`          | ESLint                                                              |
| `npm run lint:fix`      | ESLint with `--fix`                                                 |
| `npm run format`        | Prettier write                                                      |
| `npm run build`         | Compile to `dist/`                                                  |
| `npm start`             | Build, then run the Function App at `http://localhost:7071/api/mcp` |

CI runs exactly `npm run check`, so a clean local run means a clean CI run.

## Project layout

See [ARCHITECTURE.md](./ARCHITECTURE.md) (or the "Architecture" section of [CLAUDE.md](./CLAUDE.md)
for the terser, AI-agent-facing version). In short: `src/site/` is the scraping core (no MCP
concepts), `src/tools/` is one file per MCP tool (no HTML), `src/functions/` is a thin Azure
adapter.

## Coding conventions

- **ESM + `NodeNext`.** Relative imports use a `.js` specifier even when the file on disk is
  `.ts`. That's correct, not a typo.
- **Tool output types are `type` aliases, never `interface`.** The MCP SDK types
  `structuredContent` as `{ [x: string]: unknown }`, and TypeScript only gives an implicit index
  signature to type aliases. Converting them to interfaces will fail the build.
- **Parsers fail loudly.** If a selector doesn't match, throw with a message naming it. Never
  return partial, defaulted, or empty data on a parse failure — see the next section for why.
- Formatting is Prettier's problem, not yours; ESLint is configured not to fight it.

## Scraping changes

The single most important rule in this codebase:

> **A missing selector must throw. It must never produce an empty result.**

This server's answers are consumed by an LLM that will relay them to a person. "No courses
available" and "the parser broke" look identical downstream unless the parser is loud about it, and
the first is a plausible-sounding wrong answer. Prefer a visible error every time.

[CLAUDE.md](./CLAUDE.md) and [ARCHITECTURE.md](./ARCHITECTURE.md#how-the-site-is-scraped) document
the verified site facts the parsers depend on (container scoping, structural empty detection, the
three bookable capacity states, the inverted sub-level mapping, and so on). Read those before
changing selectors — several are counter-intuitive and were each the result of a wrong first guess.

### Re-recording fixtures

Fixtures under `test/fixtures/` are a point-in-time snapshot of the live site with pinned row
counts (e.g. Korytnačka = exactly 140). They exist to detect markup drift, so **when a test that
asserts a fixture count fails, first work out whether you broke the parser or the site changed.**

If the site genuinely changed, re-record the affected fixture from the corresponding URL, update
the pinned counts in the same commit, and say so in the commit message. Don't relax an assertion to
make it pass — that discards the drift signal the fixture exists to provide.

Note that a green test suite does not prove the server works against the live site: the suite runs
entirely offline. Run a live check too when you change scraping code.

### Non-ASCII on Windows

Slovak centre names contain diacritics, and passing them through shell arguments on Windows can
corrupt them (this once produced a convincing but entirely bogus "0 results"). Use Node or Python
with explicit UTF-8 when scripting anything involving accented text.

## Tests

- **No test may perform network I/O.** The HTTP client takes an injectable `fetchFn`; stub it.
  Parser tests read committed fixtures.
- **No assertion may drift with the calendar.** Fixture data contains real dates. If a test depends
  on "now", fake the clock (`vi.useFakeTimers()` + `vi.setSystemTime()`); otherwise assert on
  parsing, not on relative-to-today outcomes.
- **Fix a bug, add a regression test.** Ideally write the failing test first so you've seen it fail
  for the right reason.
- Coverage must stay at or above 80% lines/branches for `src/site/**` and `src/tools/**`.

## Commits and pull requests

- Conventional-commit style subjects (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`).
- Branch off `main`; PRs target `main`.
- Keep unrelated changes in separate commits — especially anything touching
  `.github/workflows/deploy.yml`.
- A PR should state what changed, why, and how it was verified. If it touches scraping, say whether
  it was checked against the live site as well as the fixtures.
- `npm run check` must pass. CI will tell you, but locally is faster.

## Deployment

`.github/workflows/deploy.yml` runs automatically after CI succeeds on `main`, uploading a new
package to blob storage and asking the platform to pick it up (the Linux Consumption plan this app
runs on doesn't support classic zip-push deploys). See [ARCHITECTURE.md](./ARCHITECTURE.md#deploying)
for the full mechanism and the one-time repo setup (SAS token, host key, secrets/variables). Keep
any change to `deploy.yml` itself in its own commit, separate from unrelated PRs.

## License

By contributing you agree that your contributions are licensed under the
[GNU General Public License v3.0](./LICENSE).
