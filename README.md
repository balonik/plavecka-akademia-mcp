# plavecka-akademia-mcp

A remote MCP (Model Context Protocol) server that turns
[plaveckaakademia.sk](https://plaveckaakademia.sk)'s children's swimming course listings into
structured tools an LLM can call, so prompts like _"Žralok on Friday in Devínska"_ or _"a date and
place where I can book Žralok + Delfín + Korytnačka at the same location"_ are answerable in one or
two tool calls instead of manually paging through the site.

The site itself has no API: it's a Drupal 7 Views exposed-filter form supporting only a centre and
a sub-level filter, no day/time filter and no way to ask a cross-category question. This server
fetches and parses the site's own HTML and layers the richer filtering on top, server-side.

It deploys as an Azure Function App over HTTPS and is registered in Claude as a custom web
connector. **The endpoint is gated by an Azure Functions key** (`?code=<key>` in the URL) rather
than user authentication — it's a read-only proxy over public, already-published course listings,
so there's no login to build, but the key still keeps casual/automated traffic off it. See
"Security & trust model" below and "Register the deployed server in Claude" for how to obtain and
use the key.

## Tools

### `list_categories`

No arguments. Lists the four course categories (Morský koník, Korytnačka, Delfín, Žralok) with
their slug, age range, whether they offer `*`/`**` sub-levels, and the centres each is offered at.
Sub-levels and centres are scraped live from each category's own filter form rather than
hardcoded, so a new centre or category appearing on the site doesn't require a code change.

### `list_courses`

```
{
  category: string,        // slug or display name, diacritic/case-insensitive, e.g. "zralok" or "Žralok"
  location?: string,       // centre name, diacritic/case-insensitive, e.g. "devinska" -> "Devínska"
  level?: "*" | "**" | "any",
  day?: string,            // Slovak or English weekday, e.g. "piatok" or "friday"
  timeFrom?: string,       // "HH:MM"
  timeTo?: string,         // "HH:MM"
  startAfter?: string,     // ISO date
  startBefore?: string,    // ISO date
  maxPrice?: number,
  onlyAvailable?: boolean,
  limit?: number,
  offset?: number,
}
```

`category`/`location`/`level` are sent upstream as query filters; everything else (day, time
window, start-date range, price, availability, paging) is applied server-side over the full,
unpaged result. Returns `{ total, returned, offset, courses[] }`. An unknown `location`, `day` or
`category` is rejected with an error message listing the valid values — it never silently falls
through to an empty result.

### `get_course`

```
{ courseId?: string } | { url?: string }
```

Fetches the live detail page for one course (by numeric id, or by its full URL) and returns
address, date range, day/time, price, lesson counts (with the replaceable-lesson count), age
range, availability, booking URL and the per-session calendar. A supplied `url` is validated
against a host allowlist (`plaveckaakademia.sk` / `www.plaveckaakademia.sk`, `https` only, exact
match — never a prefix/substring check) before it is ever fetched, as a defense against SSRF.

### `find_common_slots`

```
{ categories: string[], location?: string, day?: string, onlyAvailable?: boolean }
```

Fetches each requested category's listing (cheaply, thanks to the shared cache), groups courses by
centre and weekday, and returns only the centre/day combinations where **every** requested
category has at least one matching course — with the concrete courses per category attached. This
is what answers "book Žralok + Delfín + Korytnačka at the same place" in one call. Returns `{
matches: [] }` when no combination satisfies all requested categories.

## How the site is scraped

- **Container scoping.** Every category listing page contains _other_, unrelated Views blocks
  (e.g. a "centres" list) that also render `views-row` elements. The listing parser scopes every
  selector inside `div.view-id-22_zoznam_terminov_kurzov.view-display-id-block_3 > div.view-content > div.views-row`
  — a naive whole-page `.views-row` query overcounts. This is the exact case guarded by the
  "140, not 145" fixture test in `test/parseList.test.ts`.
- **Structural empty-result detection.** A filter combination with no matches renders the listing
  container with **no `.view-content` child at all**. The parser treats "container present, no
  `.view-content`" as `[]`, and treats "container missing entirely" (the selector itself doesn't
  match anything) as a thrown error — a real selector drift must fail loudly, not silently return
  an empty list that looks like a legitimate zero-result answer.
- **Sub-level mapping.** The exposed filter's `uroven[]` value `0` corresponds to a single star
  (`*`) and `1` to two stars (`**`). Rows can also have zero stars (no sub-level); those rows are
  returned under _both_ filter values upstream, so `list_courses` post-filters to the exact star
  count when a specific `level` is requested.
- **Capacity states.** The site renders three capacity CSS classes — `greenc` ("Voľné miesta"),
  `orangec` ("Posledné miesto"), `redc` ("Posledné 2 miesta") — and **all three mean the course is
  still bookable**. There is no observed "sold out" class on the live site; an unrecognised class
  defensively maps to `status: "unknown"` (still `available: true`) rather than being dropped.
- **Dates.** The listing gives a year-less date like `22. júl`. The year is inferred as the nearest
  occurrence in _either_ direction relative to "now" evaluated in `Europe/Bratislava` (or an
  injectable reference date, for tests): a date up to 60 days past is taken at face value, and only
  beyond that does it roll forward a year. A forward-only search reported a course that started
  last week as starting next year. On detail pages nothing is inferred at all — the session
  calendar carries explicit `rel="YYYY-MM-DD"` years, so the date range is anchored to those, and
  `yearInferred` reports which happened.
- **Caching & politeness.** An in-memory `Map` cache with a 10-minute TTL, keyed by a
  param-order-normalised URL, with an in-flight-promise map so concurrent identical requests share
  one fetch, and bounded (LRU-evicted) so a long-lived instance can't grow the cache unboundedly.
  Requests carry a descriptive `User-Agent`, a 15s timeout, and one retry with backoff on
  5xx/network errors (4xx is not retried).

## Security & trust model

This server is a read-only proxy over public course listings, so there is nothing to protect
behind a login. That is not the same as there being nothing to think about:

- **The endpoint is gated by a function key, not user authentication.** `authLevel` is
  `'function'` (`src/functions/mcp.ts`), so Azure itself rejects any request missing a valid
  `?code=<key>` (or `x-functions-key` header) before this code ever runs. That's a shared-secret
  gate against casual/automated abuse — it is not per-caller accounting or rate limiting. Anyone
  who has the key can still drive unlimited requests at plaveckaakademia.sk from your Azure IP, and
  the key is one shared secret, not scoped per user. If you need real rate limiting or multi-tenant
  access control, put Azure API Management or a WAF in front of it as well.
- **`get_course` is path-restricted, not just host-restricted.** A supplied `url` must be `https`,
  on an exactly-matching allowlisted host, with no port and no embedded credentials, _and_ its path
  must look like a course detail page (`/plavecky-kurz/<category>/<pool>/<id>` or `/node/<id>`).
  Without the path check the tool would be an open GET proxy for the whole site. Redirects are
  followed manually, at most 3 hops, and the allowlist is re-checked on every hop — following
  redirects blindly would let an open redirect upstream reach any host, including Azure's IMDS
  endpoint.
- **Upstream text is untrusted input to the calling model.** Fields like `address`, `ageRange`,
  `venueName` and `capacity.raw` are scraped verbatim from the site and flow into the LLM's
  context. They are length-capped (200 chars), but not otherwise sanitised: a compromised or
  user-editable upstream page is a prompt-injection surface. Treat tool output as data, not
  instructions.
- **Known limitation:** the response size cap is enforced after decoding, so a hostile upstream
  serving a decompression bomb would be rejected only after the decoded body is materialised in
  memory. Bounded by `MAX_RESPONSE_BYTES`, but not streamed. Acceptable given the upstream is a
  known, benign site; worth revisiting if that assumption changes.

## Local development

Requires Node.js 24 LTS (pinned in `.nvmrc`) and the
[Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

```bash
npm install
npm run check        # typecheck -> lint -> format check -> test
npm run test:coverage # same suite, instrumented; enforces the 80% threshold on src/site/** and src/tools/**
npm start             # builds, then runs the Function App locally via `func start`
```

The local server listens at `http://localhost:7071/api/mcp`. No test performs real network I/O —
the HTTP layer takes an injectable `fetchFn`, and parser tests read the committed fixtures under
`test/fixtures/`.

**Note on the function key locally:** Azure Functions Core Tools does not enforce `authLevel` by
default — `func start` serves every route anonymously regardless of the configured level, so a
plain local request needs no `?code=`. To actually exercise the gated behavior locally (e.g. before
trusting it in Azure), run `func start --enableAuth` instead and confirm a request without `?code=`
is rejected.

To exercise it live against the real site once running locally:

- `list_courses` for Žralok filtered to Friday + Devínska, cross-checked by hand against the live
  page.
- `get_course` on an id taken from that listing.
- `find_common_slots` for Žralok + Delfín + Korytnačka, spot-checked against the three category
  pages.
- A second identical call should be visibly served from cache.
- An invalid `location` should return a helpful error, not an empty list.

## Deploying

`.github/workflows/deploy.yml` is a **placeholder that ships inert**: the job carries `if: false`
so it can never actually deploy until it's deliberately wired up. It triggers on a successful CI
run against `main` plus `workflow_dispatch`, and (once enabled) will: checkout → `npm ci` → `npm
run build` → `npm ci --omit=dev` (prune to production deps for the deployment payload) →
`Azure/functions-action@v1` authenticated via a publish profile.

### 1. Create the Azure resources

You need an existing Azure Function App (Node.js 24, Linux, Consumption plan) and its resource
group. A Terraform configuration for this exists in a companion ops repo; creating the resources by
hand via the Azure Portal or `az` CLI works too.

### 2. Get the publish profile

The deploy job authenticates with the Function App's own publish profile rather than an Azure AD
app registration/OIDC — simpler to set up for a single-app, single-environment deployment, at the
cost of a long-lived credential (rotate it periodically) instead of a short-lived exchanged token.

- **From Terraform:** the ops repo's `terraform apply` produces a `publish_profile` output
  (marked sensitive) — `terraform output -raw publish_profile`.
- **From the Portal:** Function App → **Overview** → **Get publish profile**, which downloads the
  `.PublishSettings` XML directly.

Either way, copy the full XML content verbatim into the GitHub secret below.

### 3. Configure the repository

Set these under **Settings → Secrets and variables → Actions**:

| Name                              | Kind     | Value                                    |
| ---------------------------------- | -------- | ----------------------------------------- |
| `AZURE_FUNCTIONAPP_NAME`           | Variable | The Function App's name                  |
| `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` | Secret   | The full publish profile XML from step 2 |

Optionally create a `production` GitHub Environment (matching `environment: production` in the
workflow) if you want required reviewers or a wait timer on deploys — this is a manual-approval
gate only now, unrelated to how the job authenticates to Azure.

### 4. Flip the switch

Edit `.github/workflows/deploy.yml` and delete **only the `false && ` prefix** from the `deploy`
job's `if:` condition, once the steps above are done. Leave the rest of the condition intact — it
is what stops a failed CI run from deploying (`workflow_run` fires on _every_ CI conclusion,
including `failure` and `cancelled`, so a job with no condition would ship a red build).

Commit that as its own change so it's easy to spot in history when deploys became live.

### 5. Get a function key

The `mcp` function requires `authLevel: 'function'`, so requests need a `?code=<key>` query
parameter. Create a **dedicated named key for this connector** rather than reusing the default or
host master key, so it can be revoked independently later without breaking anything else:

```bash
az functionapp function keys set \
  --name <your-function-app-name> \
  --resource-group <your-resource-group> \
  --function-name mcp \
  --key-name claude-connector \
  --key-value "$(openssl rand -base64 32)"
```

Or via the Portal: Function App → **Functions** → **mcp** → **Function Keys** → **+ New function
key**. (The Function App's own **App keys** blade issues a host-level key that works for every
function in the app — fine too, but a function-scoped key limits the blast radius of a leak.)

To list existing keys instead of creating one:

```bash
az functionapp function keys list \
  --name <your-function-app-name> \
  --resource-group <your-resource-group> \
  --function-name mcp
```

Rotating or deleting a key immediately invalidates any URL using it — update the connector's URL
below after rotating.

### 6. Register the deployed server in Claude

Once deployed, the MCP endpoint, with the key from step 5, is:

```
https://<your-function-app-name>.azurewebsites.net/api/mcp?code=<key>
```

In Claude, add it as a **custom connector** (Settings → Connectors → Add custom connector) pointing
at that full URL, including the `?code=` query parameter.

## Project layout

```
src/
  functions/mcp.ts   Azure Functions v4 HTTP trigger (route "mcp", function-key auth, GET/POST/DELETE)
  server.ts          McpServer construction + tool registration
  site/              Scraping core: constants, HTTP client/cache, listing/detail parsers, normalisation
  tools/             One file per MCP tool
test/
  fixtures/          Recorded HTML snapshots (no network access needed to run the suite)
  *.test.ts          Vitest specs
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow, coding conventions, how to
re-record fixtures when the site changes, and what a pull request is expected to include.

If you are working on this repo with Claude Code, [CLAUDE.md](./CLAUDE.md) carries the project
context and the non-obvious site-scraping gotchas that are easy to reintroduce.

## License

GNU General Public License v3.0 — see [LICENSE](./LICENSE).
