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

You need an Azure Function App (Node.js 24, **Windows, Consumption plan**) and its resource group. A
Terraform configuration for all of this exists in a companion ops repo; creating the resources by
hand via the Azure Portal or `az` CLI works too, but you'll need to replicate that same shape (see
the ops repo's `service_plan.tf`, `function_app.tf`, and `github_oidc.tf`).

`.github/workflows/deploy.yml` runs after a successful CI run on `main`, plus on-demand via
`workflow_dispatch`: checkout → `npm ci` → `npm run build` → `npm ci --omit=dev` (prune to
production deps) → zip the payload → `az functionapp deployment source config-zip`.

That's a single classic zip-push: on a **Windows Consumption plan** the app runs from a local
package (`WEBSITE_RUN_FROM_PACKAGE="1"`, set in the ops repo's Terraform), so the platform stores and
mounts the pushed zip itself. There's no deployment blob, no SAS, and no `/admin/host/synctriggers`
call — that whole handoff only existed to work around **Linux** Consumption's URL-only
`WEBSITE_RUN_FROM_PACKAGE`, which reliably wedged the container (site _and_ Kudu returning 503) after
every package swap, and which also caps Node at v22. Windows Consumption supports Node 24 and the
ordinary zip-push, so the mechanism collapses to one step.

The workflow authenticates to Azure **passwordlessly via OIDC**: `azure/login@v3` federates into a
user-assigned managed identity (ops repo's `github_oidc.tf`) scoped to `Website Contributor` on the
Function App. No long-lived deploy credential is stored in GitHub — only non-secret identifiers. Use
`v3`, not `v2`: `v2`'s `action.yml` is permanently pinned to the deprecated `node20` Actions runtime
(never patched — the bump shipped as a new major version, v3.0.0), so `v2` will keep printing a Node
20 deprecation warning indefinitely regardless of when you run it.

Several related settings exist for reasons that aren't obvious from the files themselves:

- **The Function App runs 64-bit** (`use_32_bit_worker = false` in the ops repo's `function_app.tf`,
  against the provider's own `true` default). Node.js 24 ships no 32-bit Windows build; left at the
  default, the platform can't run the requested runtime and silently falls back to an ancient bundled
  engine, which fails on modern syntax with `SyntaxError: Use of const in strict mode` — a startup
  crash that gives no hint it's actually a bitness mismatch.
- **The Portal shows "Your app is not configured for dynamic scaling."** — expected, left as-is.
  Full dynamic scale-out on Windows Consumption needs an Azure Files connection
  (`WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` + `WEBSITE_CONTENTSHARE`), but Azure Files has no
  managed-identity option — that setting can only be a real storage account connection string. Adding
  it would reintroduce the one class of secret this setup otherwise avoids everywhere else (OIDC for
  deploy, managed identity for `AzureWebJobsStorage`). For this app's traffic (personal/low-volume),
  a single warm instance is enough, so the tradeoff isn't worth it. See [Storage considerations for
  Azure Functions](https://learn.microsoft.com/azure/azure-functions/storage-considerations#storage-account-connection-setting)
  if that calculus ever changes.
- **`npm run build` uses `tsconfig.build.json`, not `tsconfig.json`.** The base config includes
  `test/**` so the tests are type-checked, but with `rootDir: "."` that also emitted `dist/test/`,
  which this workflow shipped to Azure (it zips `dist/` by hand, so `.funcignore` never applies).
  The build config narrows the emit to `src/`.
- **`host.json` sets `httpAutoCollectionOptions.enableHttpTriggerExtendedInfoCollection: false`.**
  The connector authenticates with `?code=<key>`, and Application Insights records request URLs
  [with all query string parameters](https://learn.microsoft.com/azure/azure-monitor/app/data-model-complete#request-telemetry)
  — so the function key would otherwise be retained in telemetry (and `excludedTypes: "Request"`
  exempts requests from sampling, so all of them). Disabling extended collection drops HTTP
  method/path/response from request telemetry. That costs little here because the app serves
  exactly one route: the path carries no diagnostic signal. Invocation traces, failures and
  durations are unaffected.

### 1. Configure the repository

Deployment auth is OIDC — there are **no secrets**, only non-secret variables. The ops repo's
`terraform apply` provisions the user-assigned identity and its federated credential, and its
outputs supply every value below. Set these under **Settings → Secrets and variables → Actions**
(all as **Variables**):

| Name                     | Value / source                                  |
| ------------------------ | ----------------------------------------------- |
| `AZURE_CLIENT_ID`        | `terraform output -raw github_deploy_client_id` |
| `AZURE_TENANT_ID`        | `terraform output -raw tenant_id`               |
| `AZURE_SUBSCRIPTION_ID`  | `terraform output -raw subscription_id`         |
| `AZURE_RESOURCE_GROUP`   | `terraform output -raw resource_group_name`     |
| `AZURE_FUNCTIONAPP_NAME` | `terraform output -raw function_app_name`       |

The federated credential trusts this repo's `production` environment
(`repo:<owner>/<name>:environment:production`), which is why the deploy job declares
`environment: production` — create that GitHub Environment (and add reviewers/wait timers there if
you want gated deploys). If you fork or rename the repo, update `github_repository` in the ops repo's
`variables.tf` so the subject still matches.

### 2. Push to `main`

Once CI succeeds on `main`, the deploy workflow runs automatically. You can also trigger it by hand
from the Actions tab (`workflow_dispatch`).

### 3. Get a function key and register the connector

See [README.md's "Add it to Claude"](./README.md#add-it-to-claude) — same steps whether you're
setting this up for the first time or pointing at a redeploy.
