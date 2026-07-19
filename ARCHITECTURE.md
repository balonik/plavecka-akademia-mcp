# Architecture

How this server is built, how it scrapes the site, and how it's deployed. Read
[README.md](./README.md) first for what it does and how to add it to Claude; this file is for
running your own copy or working on the scraping/deployment internals. If you're working on this
repo with Claude Code, also read [CLAUDE.md](./CLAUDE.md) — it carries the same site facts in a
terser, pinned-fact form plus environment-specific gotchas.

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

The dependency direction is strictly `functions -> server -> tools -> site`. `src/site/` has no MCP
concepts; `src/tools/` has no HTML.

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

## Security & trust model details

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

## Deploying

You need an Azure Function App (Node.js 24, Linux, Consumption plan) and its resource group, plus a
private blob container for deployment packages. A Terraform configuration for all of this exists in
a companion ops repo; creating the resources by hand via the Azure Portal or `az` CLI works too, but
you'll need to replicate that same shape (see the ops repo's `storage.tf`, `deploy_sas.tf` and
`function_app.tf`).

`.github/workflows/deploy.yml` runs after a successful CI run on `main`, plus on-demand via
`workflow_dispatch`: checkout → `npm ci` → `npm run build` → `npm ci --omit=dev` (prune to
production deps) → zip the payload → upload it to blob storage → ask the platform to pick up the
new package.

That last two-step handoff, instead of a more typical single zip-push action, exists because the
Function App runs on a **Linux Consumption plan**, which only supports deploying via
`WEBSITE_RUN_FROM_PACKAGE=<URL>` — the classic Kudu zip-push that `Azure/functions-action` and
`az functionapp deployment source config-zip` normally use reliably 503s on this plan type. So the
workflow instead:

1. Uploads `deploy.zip` to the storage account's `deployments` container using a container-scoped
   SAS token (data-plane only — no Azure AD login needed for this step).
2. Calls `POST /admin/host/synctriggers?code=<key>` using a dedicated host-level key, since the
   blob URL itself never changes between deploys (only its content does) and the platform doesn't
   notice a new package at the same URL on its own.

The Function App fetches that same fixed blob URL on startup via its own **managed identity** — no
storage key or SAS is ever needed on the read side.

### 1. Get the deploy SAS token

- **From Terraform:** the ops repo's `terraform apply` produces a `deploy_container_sas` output
  (marked sensitive) — `terraform output -raw deploy_container_sas`.
- **From the Portal:** the `deployments` container → **Shared access tokens**, with **Write** and
  **Create** permissions only (no **Read**/**List**/**Delete** — the workflow only ever writes one
  named blob), HTTPS only, and a long expiry.

Copy it verbatim (leading `?` included — the workflow strips it) into the GitHub secret below.

### 2. Get a host key for trigger syncing

Create a **dedicated named host key** for this one purpose, so it can be revoked independently of
the `claude-connector` function key used by the connector itself:

```bash
az functionapp keys set \
  --name <your-function-app-name> \
  --resource-group <your-resource-group> \
  --key-type host \
  --key-name ci-sync-triggers \
  --key-value "$(openssl rand -base64 32)"
```

### 3. Configure the repository

Set these under **Settings → Secrets and variables → Actions**:

| Name                         | Kind     | Value                                                                |
| ---------------------------- | -------- | -------------------------------------------------------------------- |
| `AZURE_FUNCTIONAPP_NAME`     | Variable | The Function App's name                                              |
| `AZURE_STORAGE_ACCOUNT_NAME` | Variable | The storage account's name (Terraform output `storage_account_name`) |
| `AZURE_STORAGE_DEPLOY_SAS`   | Secret   | The SAS token from step 1                                            |
| `AZURE_FUNCTIONAPP_SYNC_KEY` | Secret   | The host key from step 2                                             |

Optionally create a `production` GitHub Environment (matching `environment: production` in the
workflow) if you want required reviewers or a wait timer on deploys.

### 4. Push to `main`

Once CI succeeds on `main`, the deploy workflow runs automatically. You can also trigger it by hand
from the Actions tab (`workflow_dispatch`).

### 5. Get a function key and register the connector

See [README.md's "Add it to Claude"](./README.md#add-it-to-claude) — same steps whether you're
setting this up for the first time or pointing at a redeploy.
