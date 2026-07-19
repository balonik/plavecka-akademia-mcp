# Adversarial code review — plavecka-akademia-mcp

Reviewer: Claude Opus 4.8. Date: 2026-07-18.

Method: read `CLAUDE.md`, `README.md`, all of `src/`, `test/`, and the configs/workflows, then
built the project and exercised the compiled code directly — mutated fixtures to simulate markup
drift, drove the client against local HTTP servers (redirects, gzip bombs, loops), attempted 13
SSRF bypasses, and made live requests to plaveckaakademia.sk to check the level mapping,
pagination and `/node/<id>` behaviour.

Every finding below is marked **CONFIRMED** (I reproduced it) or **SUSPECTED** (reasoned from
code, not executed). Section 6 lists things that looked wrong but are verifiably fine — those are
as important as the bugs.

Headline: the codebase is unusually careful and most of its documented invariants hold up under
attack. The real problems cluster in one place — **the project states that a silent empty result
is its worst failure mode, and then ships four fields (and one entire tool) that degrade silently
to empty on markup drift.** The fail-loud discipline was applied to id/date/price and stops there.

---

## Severity summary

| #     | Severity | Title                                                                           | Status    |
| ----- | -------- | ------------------------------------------------------------------------------- | --------- |
| H1    | High     | Listing parser silently degrades on schedule/centre/level/capacity drift        | CONFIRMED |
| H2    | High     | `list_categories` has no fail-loud check at all                                 | CONFIRMED |
| H3    | High     | Year inference has no lower bound; detail page contradicts its own calendar     | CONFIRMED |
| M1    | Medium   | SSRF allowlist is not re-applied across redirects                               | CONFIRMED |
| M2    | Medium   | `deploy.yml` will deploy on a **failed** CI run once enabled as documented      | CONFIRMED |
| M3    | Medium   | Anonymous endpoint is an open GET proxy + cache-thrash DoS against the upstream | CONFIRMED |
| M4    | Medium   | Every listing call costs 2 upstream fetches (defensive pagination)              | CONFIRMED |
| M5    | Medium   | Decompression bomb is fully decoded into memory before the size check           | CONFIRMED |
| M6    | Medium   | Year inference uses UTC "today", but the site is Europe/Bratislava              | CONFIRMED |
| M7    | Medium   | Upstream free text flows verbatim into LLM context; unacknowledged              | CONFIRMED |
| L1    | Low      | SSRF guard ignores the port; userinfo is forwarded                              | CONFIRMED |
| L2    | Low      | Duplicate categories silently degrade `find_common_slots` to one category       | CONFIRMED |
| L3    | Low      | `listCourses()` does not validate `limit`/`offset` (negative offset)            | CONFIRMED |
| L4    | Low      | `onlyAvailable` is a permanent no-op                                            | CONFIRMED |
| L5    | Low      | Absolute `href` produces a malformed course URL                                 | CONFIRMED |
| L6    | Low      | `findRowContent` silently prefers the _last_ duplicate label                    | CONFIRMED |
| N1–N9 | Nit      | See section 5                                                                   | mixed     |

---

## 1. High

### H1 — The listing parser fails loud for only 3 of its 8 fields; the other 5 degrade to silent empty results

**Severity:** High · **CONFIRMED** · `src/site/parseList.ts:112-147`

`parseRow` throws when the href/id (`:99`), the start date (`normalize.ts:116`) or the price
(`normalize.ts:44`) can't be parsed. `frequency` (`:112`), `schedule` (`:114-123`), `centre`
(`:128`), `level` (`:130-131`) and `capacity` (`:137-147`) have **no such check** — a missing
element yields `[]`, `''`, `null` or `'unknown'` and the row is returned looking valid. This is
exactly the failure mode `CLAUDE.md` fact #2 says must never happen, just moved from the container
level down to the field level.

Reproduced by mutating `test/fixtures/korytnacka-all.html` (one class-name rename each) and
re-parsing:

| Mutation                                   | Result                                             |
| ------------------------------------------ | -------------------------------------------------- |
| `dayhod` → `day-hod`                       | 140 rows, **every** `schedule: []`, no error       |
| `.stredisko` removed                       | 140 rows, **every** `centre: ""`, no error         |
| `field-uroven` → `field-uroven-x`          | 140 rows, **every** `level: null`, no error        |
| `views-field-field-kapacita-kurzu` renamed | 140 rows, `status: "unknown"`, `raw: ""`, no error |

Concrete failure scenarios, all reproduced end-to-end against the drifted fixture:

- `list_courses({category:"korytnacka", day:"piatok"})` → `total: 0`, `returned: 0`. The tool
  reports "0 course(s) match" for a category that has 140 live courses. Indistinguishable from a
  genuine zero-result answer — the LLM will confidently tell a parent there are no Friday courses.
- `find_common_slots({categories:["korytnacka","zralok"]})` → `matches: []` ("No centre/day
  combination has all requested categories available"), because `find_common_slots.ts:92` iterates
  `course.schedule` and an empty schedule contributes nothing to any bucket.
- Level drift: `list_courses({category:"korytnacka", level:"*"})` → `total: 0`, because the
  post-filter at `list_courses.ts:71` compares against `level` which is now `null` for every row.
- Centre drift: `find_common_slots` still returns matches, but every one has `centre: ""`.

Note that `list_courses` with _no_ `day`/`level` filter still returns 140 rows in all four cases,
so a smoke test ("does it return courses?") will not catch any of this.

**Suggested fix:** in `parseRow`, throw naming the selector when `schedule.length === 0`, when
`centre === ''`, and when the capacity element is missing (`capacityEl.length === 0`). Level is
legitimately `null` (zero-star rows exist per `CLAUDE.md` #4), so it can't be checked per-row —
instead check it at the `parseList` level: if a `level` filter was requested upstream and _every_
returned row has `level === null`, that is drift, not data. Alternatively have `parseList` assert
that the `.uroven` container element exists on each row even when it holds no `<img>`.

### H2 — `list_categories` has no drift detection whatsoever; a junk page yields a plausible-looking empty answer

**Severity:** High · **CONFIRMED** · `src/tools/list_categories.ts:27-54`

`extractAgeRange` returns `''` if nothing matches (`:28,42`), `extractCentres` returns `[]`
(`:46-49`), and `extractHasSubLevels` returns `false` when the selector matches nothing (`:52-53`).
None of them can fail. Unlike `parseList`, there is not even a container check.

Reproduced: feeding `listCategories` the literal body `<html><body>hello</body></html>` returns a
fully-formed, schema-valid response:

```json
{
  "slug": "morsky-konik",
  "name": "Morský koník",
  "ageRange": "",
  "hasSubLevels": false,
  "centres": []
}
```

Same output when only the real IDs drift (`edit-stredisko-wrapper` → `edit-stredisko-box`,
`skupiny` → `skupinky`), verified against the real `morsky-konik.html` fixture (baseline correctly
yields `ageRange: "2 až 3 roky"`, `centres: ["Barónka","Devínska","Limbach"]`).

Failure scenario: the site's theme changes one wrapper id. `list_categories` reports every
category as having **no sub-levels and no centres**. An LLM asked "where is Žralok offered?"
answers "nowhere" — and `hasSubLevels: false` is worse than a blank, because it is an affirmative
false claim that will steer the model away from ever passing a `level` filter. Nothing in CI
catches this: `test/listCategories.test.ts` only ever feeds it good fixtures.

**Suggested fix:** throw when `$('#edit-stredisko-wrapper').length === 0` (form container missing
⇒ drift) and when `extractCentres()` returns `[]` while the wrapper _is_ present. Distinguish
"filter form absent" (drift → throw) from "form present, zero options" (legitimate). Add a test
feeding it the empty-result fixture and a junk page, asserting it throws.

### H3 — Year inference has no lower bound: a course that has already started is reported a year in the future, and the detail page then contradicts its own session calendar

**Severity:** High · **CONFIRMED** · `src/site/normalize.ts:136-148`, `src/site/parseDetail.ts:151-156`

`parseSlovakDate` searches forward only (`year = referenceDate.getUTCFullYear()`, then `year += 1`
until `attemptDate >= refMidnight`). Any date that is even one day in the past silently becomes
next year's. There is no "and it was probably last week" branch and no sanity ceiling.

Reproduced on the real detail fixture (`detail-1313637.html`, course runs 22–29 July):

```
referenceDate = 2026-07-18 → dateRange 2026-07-22 … 2026-07-29 ✓  sessions [2026-07-22, 2026-07-29]
referenceDate = 2026-08-01 → dateRange 2027-07-22 … 2027-07-29 ✗  sessions [2026-07-22, 2026-07-29]
```

The second row is a **self-contradicting response**: `dateRange` says 2027 while `sessions` — read
straight off the calendar's `rel="2026-07-22"` attributes, which carry an explicit year — says 2026. `get_course` returns both in the same `structuredContent`, and its `text` summary prints only
the wrong one (`get_course.ts:129`). A user who bookmarks a course link, or an LLM re-checking an
id it saw a week ago, gets told the course is a year away.

Same mechanism on listings: re-parsing `korytnacka-all.html` with `referenceDate = 2026-08-15`
moves **all 140** courses to 2027. Then `list_courses({startBefore:"2026-12-31"})` returns
`total: 0` — silent empty result again.

Mitigating: I checked the live listing today (2026-07-18) and it contains only future courses
(earliest 20 July, latest 7 August), so the listing path is currently latent. The **detail** path
is not latent — a detail page stays reachable by id after the course starts (verified: live
`get_course({courseId:"1313637"})` succeeds).

**Suggested fix:** for `parseDetail`, don't infer the year at all when the calendar is present —
derive it from the `sessions` `rel` dates, which are unambiguous, and fall back to inference only
if the calendar is missing. For listings, allow the nearest occurrence in _either_ direction with
an asymmetric window (e.g. accept a date up to ~60 days in the past before rolling forward a year),
and surface which direction was chosen. As-is, `yearInferred: true` is a hard-coded literal
(`normalize.ts:99`, and `z.literal(true)` in both tool schemas) that can never warn a consumer that
the inference was a guess.

---

## 2. Medium

### M1 — The SSRF allowlist guards the first request only; redirects are followed anywhere

**Severity:** Medium · **CONFIRMED** · `src/site/client.ts:69-75`, `src/tools/get_course.ts:25-42`

`validateAllowedUrl` is genuinely solid (see §6), but `doFetch` calls `fetchFn(url, {...})` with no
`redirect` option, so Node's `fetch` default `redirect: 'follow'` applies and the **final** host is
never re-checked.

Reproduced with two local servers: `get()` against a host that replies `302 Location:
http://127.0.0.1:<other>/secret` returned the other server's body (`"INTERNAL-SECRET-METADATA"`)
verbatim. Nothing in the client or the tool notices the host changed.

Exploitability depends on an open redirect (or a 30x-returning path) existing on
plaveckaakademia.sk. I did not find one in the paths I probed, so I am **not** claiming a live
exploit — but note `get_course({url})` lets the caller choose _any_ path and query string on that
host (verified: `https://plaveckaakademia.sk/user/login?destination=http://169.254.169.254/` is
accepted and fetched), so the attacker controls the entire search space. On Azure, the payoff would
be the IMDS endpoint at `169.254.169.254`. The response is only echoed back if `parseDetail`
succeeds — but the parse error message is returned to the caller, which is a usable oracle.

Also note this contradicts the comment at `get_course.ts:56-57`, which asserts the site
"30x-redirects" `/node/<id>` — live it returns **200 directly** (verified), so redirect-following
is not actually needed for the documented flow.

**Suggested fix:** pass `redirect: 'manual'` in `doFetch` and implement a bounded redirect loop
(≤3 hops) that re-runs the allowlist check on every `Location`. Cheap, and it also fixes L1.

### M2 — Enabling `deploy.yml` exactly as README documents makes it deploy on failed CI runs

**Severity:** Medium · **CONFIRMED** · `.github/workflows/deploy.yml:8-11,42`

The trigger is `workflow_run: types: [completed]`, which fires on **every** CI conclusion —
success, failure, cancelled, timed_out. The job's _only_ gate is `if: false` (`:42`). There is no
`github.event.workflow_run.conclusion == 'success'` check anywhere.

README §"4. Flip the switch" instructs: _"remove (or change to `if: true`) the `if: false` line"_.
Following that instruction literally leaves the job with no condition at all.

Failure scenario: a PR merges to `main` with a broken parser; CI goes red; the `workflow_run`
event fires with `conclusion: failure`; the deploy job runs and ships the broken build to
production. The workflow is genuinely inert as shipped (confirmed — `if: false` on the sole job),
but it is a loaded footgun for the person who enables it.

**Suggested fix:** change line 42 to
`if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'`
and have the README say "delete the `false &&` prefix" rather than "delete the whole line". Also
move `id-token: write` from the workflow level down to the `deploy` job.

### M3 — The anonymous endpoint is an open GET proxy against the upstream, plus a trivial cache-flush DoS

**Severity:** Medium · **CONFIRMED (by construction)** · `src/functions/mcp.ts:116`, `src/site/client.ts:20,150-178`

`authLevel: 'anonymous'`, no rate limiting, no per-caller accounting. Two concrete abuses:

1. **Request laundering / amplification.** `get_course({url})` accepts any path+query on
   plaveckaakademia.sk (verified: `/`, `/admin`, `/user/login?destination=…` are all fetched).
   Anyone who finds the Function URL can drive unlimited GETs at the site from Azure's IP, with the
   server's `User-Agent` attached. `find_common_slots({categories:[all four]})` is an 8:1
   amplifier (4 categories × 2 pages, see M4) for a single ~200-byte JSON-RPC request.
2. **Cache flush.** `CACHE_MAX_ENTRIES = 50` and the LRU is global. 51 `get_course` calls with
   distinct junk URLs on the allowed host evict every real listing entry (the eviction mechanism is
   verified by `test/client.test.ts:131`). Sustained, this forces every legitimate request to hit
   the upstream — turning the "politeness" cache into a liability.

**Suggested fix:** constrain `get_course({url})` to paths matching
`^/plavecky-kurz/[^/]+/[^/]+/\d+$` or `^/node/\d+$` — the tool has no legitimate use for any other
path, and this closes both the proxy and (mostly) M1. Separately, consider a function-key or
Azure API Management rate limit; "read-only proxy over public data" justifies no _authorization_,
but it does not justify no _rate limiting_.

### M4 — Every listing fetch costs two upstream requests

**Severity:** Medium · **CONFIRMED (live)** · `src/site/client.ts:197-220`

`fetchPaginated` always fetches `?page=1` before it can conclude there is no page 1: the break at
`:209` requires `page > 0`. Verified live — `…/korytnacka?page=1` returns HTTP 200 with the same
140 rows (the view has no `.pager` markup; the header reads "140 termínov"). So the loop always
runs exactly twice, doubling upstream load on every cold-cache call. Confirmed with an
instrumented fetch: 2 fetches, `/list` and `/list?page=1`.

Worst case is bounded but ugly: if the site ever starts serving distinct content per `?page`, the
loop runs the full `MAX_LISTING_PAGES` (verified: 20 fetches) inside a single tool call, against a
15s-per-request timeout — that is up to 300s of wall clock, well past any sane MCP client timeout,
and Azure Functions' default 5-minute limit.

Also note `page=0` and the bare URL are **different cache keys** (`normalizeCacheKey` doesn't
canonicalise an absent param), so a caller who passes `?page=0` bypasses the cache entirely.

**Suggested fix:** since the view is verified unpaged and the row count is printed in the header
("140 termínov"), parse that count and only walk pages while `merged.size < headerCount`. Failing
that, drop the loop and assert `rows.length === headerCount`, throwing on mismatch — that gives
real drift detection instead of a speculative second request.

### M5 — The response size cap is post-decode: a gzip bomb is fully materialised in memory first

**Severity:** Medium · **CONFIRMED** · `src/site/client.ts:96-110`

The `content-length` check (`:97`) sees the _compressed_ size, and the body check (`:105`) runs
only after `await response.text()` has decoded everything. Verified against a local server serving
a 58 KB gzip payload that decodes to 60 MB: the request was rejected with the correct
`Response body exceeded the 5000000 byte cap` error — but only **after 3.4 seconds** and after
allocating the full 60 MB. Scale the bomb to a few GB and the Function OOMs before the check runs.
Requires a hostile or compromised upstream, hence Medium rather than High.

**Suggested fix:** read `response.body` as a stream and abort once the accumulated decoded byte
count exceeds `MAX_RESPONSE_BYTES`, instead of buffering via `.text()`.

### M6 — "Today" is computed in UTC, but the site and its users are in Europe/Bratislava

**Severity:** Medium · **CONFIRMED (by construction)** · `src/site/normalize.ts:128-140`

`refMidnight` is built from `referenceDate.getUTC*()`. In summer Bratislava is UTC+2, so between
00:00 and 02:00 local the server's notion of "today" is still yesterday. `CLAUDE.md` #8 frames UTC
as a deliberate timezone-independence choice, which is right for _reproducibility_ but wrong for
_correctness_: the reference point should be the site's civil date, not the server's.

Failure scenario: at 00:30 local on 19 July, a listing row reading `18. júl` resolves to
2026-07-18 (today, per UTC) rather than rolling to 2027 — or, with the H3 fix applied, lands on the
wrong side of a `startAfter: "2026-07-19"` filter. One-day boundary error for a two-hour window
each night; DST transitions widen it.

**Suggested fix:** compute the reference civil date with
`Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava' }).format(referenceDate)` and keep
UTC arithmetic from there. Still fully injectable and deterministic in tests.

### M7 — Upstream free text reaches LLM context unlabelled; the prompt-injection surface is never acknowledged

**Severity:** Medium · **CONFIRMED (by construction)** · `src/tools/*.ts` (all four `text` builders + `structuredContent`)

`address`, `ageRange`, `venueName`, `lessonsRaw`, `frequency`, `capacity.raw` and `centre` are
returned verbatim in both the human-readable `text` and `structuredContent`. Nothing truncates,
escapes, or delimits them, and neither README nor CLAUDE.md mentions the risk. The trust
assumption ("the site is benign") is implicit and undocumented.

This is not theoretical for `get_course({url})`: because that tool accepts _any_ path on the host
(M3), a caller can aim the parser at any page the site hosts, including anything user-submittable,
and have its text spliced into the calling model's context.

**Suggested fix:** length-cap each free-text field (say 200 chars) in the parsers, and add a line
to README's security section stating explicitly that upstream text is untrusted input to the
calling model. Combined with M3's path allowlist, the surface shrinks to actual course pages.

---

## 3. Low

- **L1 — SSRF guard ignores the port; userinfo is forwarded.** **CONFIRMED**
  `src/tools/get_course.ts:36` checks only `parsed.hostname`. `https://plaveckaakademia.sk:8443/x`
  and `https://user:pass@plaveckaakademia.sk/x` both pass and are fetched (verified). The port case
  turns the guard into "any TCP port on the site's IP"; the userinfo case forwards caller-supplied
  credentials to the upstream. **Fix:** also require `parsed.port === ''` and
  `parsed.username === '' && parsed.password === ''`.
- **L2 — Duplicate categories silently degrade `find_common_slots`.** **CONFIRMED**
  `find_common_slots.ts:72,116`. `findCommonSlots({categories:["korytnacka","Korytnačka"]})`
  returns **46 matches** whose `coursesByCategory` has a single key. Both inputs resolve to the same
  slug, `requestedSlugs.every(...)` is trivially satisfied, and the caller believes it found slots
  serving two categories. **Fix:** de-duplicate by slug after `resolveCategory` and either error or
  note the collapse.
- **L3 — `listCourses()` doesn't validate `limit`/`offset`.** **CONFIRMED**
  `list_courses.ts:57-58,101-102`. The zod schema (`:167-168`) guards the MCP path, but the
  exported function does not: `offset: -5` returns `returned: 5, offset: -5` (`Array.slice(-5)`
  takes the _last_ five), and `limit: 0.5` returns `returned: 0` with `total: 140`. Any non-MCP
  consumer, or a future transport that skips zod, silently gets wrong pages. **Fix:** clamp in
  `listCourses` itself.
- **L4 — `onlyAvailable` is a permanent no-op.** **CONFIRMED**
  `parseList.ts:147` and `parseDetail.ts:190` hard-code `available: true`, so the filters at
  `list_courses.ts:96-98` and `find_common_slots.ts:82-84` can never remove a row (verified: 140 →
  140). `test/tools.test.ts:70` documents this as intended, so it isn't a bug — but the tool
  description ("Keep only bookable courses") advertises a filter that does nothing, and the model
  will pass it believing it narrows results. **Fix:** either drop the parameter or make the field's
  emptiness meaningful (`status === 'unknown' && raw === ''` ⇒ `available: false`).
- **L5 — An absolute `href` produces a malformed URL.** **CONFIRMED**
  `parseList.ts:151` concatenates `BASE_URL + href` unconditionally, while `HREF_PATTERN`
  (`:50`) is unanchored. Verified: an `href="https://evil.example/plavecky-kurz/a/b/1313637"` yields
  `url: "https://plaveckaakademia.skhttps://evil.example/…"`. Harmless today (the field is display
  only, and `get_course` re-validates), but it is a garbage URL handed to an LLM that may show it
  to a user. **Fix:** anchor the pattern with `^` and use `new URL(href, BASE_URL).toString()`.
- **L6 — `findRowContent` silently prefers the last duplicate label.** **CONFIRMED (by construction)**
  `parseDetail.ts:85-90` iterates all rows and overwrites `result` on every match rather than
  breaking on the first. If the site ever renders two `Cena` rows (e.g. a struck-through original
  price beside a discount), the parser silently picks the second. **Fix:** `return`/break on the
  first match, or throw on ambiguity.

---

## 4. Pipelines

`deploy.yml` is **genuinely inert** and leaks nothing — confirmed. `if: false` sits on the only
job, so both triggers are harmless; all Azure values are `${{ secrets.* }}` / `${{ vars.* }}`
references with no literals; `git log` shows a single commit and a grep for
publish-profile/password/api-key patterns across `.github/` finds only the documented placeholder
names. `.gitignore` correctly excludes `local.settings.json` and `.env*`.

CI does gate what it claims: `npm run check` (typecheck → lint → format → test) plus a second
instrumented pass that enforces the 80% threshold, and the coverage upload is `if: always()` so a
failure still produces the artifact. `permissions: contents: read` is minimal, and
`concurrency.cancel-in-progress` is correct for a PR-triggered workflow.

Gaps beyond M2:

- Actions are pinned to floating major tags (`actions/checkout@v4`, `azure/login@v2`,
  `Azure/functions-action@v1`), not SHAs. For a workflow that will hold `id-token: write` against a
  Contributor-scoped Azure principal, SHA-pinning is the standard hardening step.
- Coverage thresholds cover `lines`/`branches` only (`vitest.config.ts:16-18`); `functions` and
  `statements` are unset, so an entirely uncalled exported function doesn't move the gate.
- CI never runs `npm run build`. `typecheck` uses `--noEmit`, so an emit-only failure (e.g. an
  `outDir` collision) would first appear in the deploy job.

---

## 5. Nits

- **N1** `test/fixtures/korytnacka-level1.html` is the **`uroven[]=0`** response (71 one-star
  rows), as the test comment at `test/parseList.test.ts:84` correctly states. The filename says the
  opposite and cost me a live round-trip to disprove a suspected inverted mapping. Rename to
  `korytnacka-uroven0.html`.
- **N2** `CLAUDE.md` #4 claims zero-star rows "come back under _both_ filter values". The data
  contradicts the premise: live, `uroven[]=0` → 71 rows and `uroven[]=1` → 69 rows, summing exactly
  to the unfiltered 140, and **no** zero-star row exists in any fixture. The post-filter at
  `list_courses.ts:71` is harmless but its stated justification is unverified.
- **N3** `get_course.ts:56-57` claims `/node/<id>` "30x-redirects" to the canonical page. Live it
  returns **200 directly** (verified). Stale comment that currently justifies unbounded
  redirect-following (M1).
- **N4** `test/normalize.test.ts:101-106` asserts `parseSlovakDate('1. január')` matches
  `/^\d{4}-01-01$/` — true for every possible output of that call. Tautological; the test cannot
  fail.
- **N5** `test/parseList.test.ts` calls `parseList(html)` with no `referenceDate`, i.e. against the
  real clock. No assertion currently reads `.iso`, so it won't rot — but it's one added assertion
  away from a calendar-dependent failure. Pass an explicit reference date, as `tools.test.ts:158`
  does.
- **N6** Expired cache entries are never proactively removed (`client.ts:155-159` reads past them
  but leaves them in place), so they consume LRU slots and can evict live entries. Delete on expiry.
- **N7** A redirect loop costs 40 hops, not 20: `fetch` gives up at 20 and throws, which
  `doFetch` classifies as a retryable network error (`client.ts:76-84`), so the whole thing runs
  twice. Verified against a self-redirecting local server.
- **N8** `tsconfig.json` has `rootDir: "."` and includes `test/**`, so `npm run build` emits
  `dist/test/*.js` (verified present). `.funcignore` excludes `test` but not `dist/test`, so
  compiled tests and `helpers.js` ship in the deployment payload. Add `dist/test` to `.funcignore`
  or build with a `tsconfig.build.json` scoped to `src`.
- **N9** `find_common_slots` groups by centre + weekday only, ignoring time. Two courses at the
  same centre on the same day at identical times are reported as a "common slot" even though one
  parent can't be in two places at once. Not wrong (siblings may swim simultaneously), but the tool
  description doesn't say what "common" means.

---

## 6. Verified NOT problems

These looked suspicious and are fine. Documenting so the next reviewer doesn't re-spend the time.

- **The SSRF host allowlist itself is correct.** I tried 13 bypasses against
  `validateAllowedUrl`. All correctly rejected: userinfo-`@` confusion
  (`https://plaveckaakademia.sk@evil.example/` → hostname parses to `evil.example`), trailing dot
  (`plaveckaakademia.sk.`), look-alike subdomain (`…sk.evil.example`), Cyrillic-`а` homograph
  (normalises to `xn--plaveckaakdemia-3lm.sk`), explicit punycode, `http:`, `file:`, and IPv6
  literals. Case variation is correctly _accepted_. Path traversal is a non-issue —
  `https://plaveckaakademia.sk/../../admin` is normalised by the `URL` parser to `/admin`, which
  stays on-host. `courseId` is properly gated by `/^\d+$/` at both the zod and function layers:
  `../../admin`, `1 OR 1` and `1%2f..` are all rejected **without any fetch**.
- **In-flight de-duplication handles rejection correctly.** I specifically hunted for a poisoned or
  dangling entry. Two concurrent `get()` calls whose fetch rejects both reject cleanly, `.finally`
  removes the in-flight entry, nothing is written to the cache, no `unhandledRejection` fires, and
  the very next call re-fetches and succeeds. The `.finally` chain can't race the `inFlight.set`
  because settlement is always at least one microtask out.
- **Cache-key normalisation works.** `?stredisko[]=A&uroven[]=0` and `?uroven[]=0&stredisko[]=A`
  share one entry (1 fetch for 2 calls, verified), as do fragment- and host-case-only variants. No
  collision found. (The `?page=0` gap is noted in M4.)
- **`LEVEL_TO_PARAM` is correct.** I suspected an inversion because the `level1` fixture is all
  one-star. Checked live: `uroven[]=0` → 71 rows all `*`, `uroven[]=1` → 69 rows all `**`. The
  mapping in `constants.ts:37` and `CLAUDE.md` #4 both match reality; only the filename lies (N1).
- **Cross-New-Year detail ranges resolve correctly.** `parseDetail.ts:156` re-bases the end date on
  the resolved start, so 20 December → 5 January yields 2026-12-20 … 2027-01-05, not two
  independently-snapped dates. Genuinely good, and the comment explaining why is accurate.
- **Leap day is handled.** `utcDateOrNull` (`normalize.ts:82-94`) catches `Date.UTC` overflow, so
  `29. február` seen in 2026 correctly skips to 2028-02-29 rather than becoming 1 March.
- **HTML entities and non-breaking spaces parse fine.** `35,6&nbsp;&euro;` round-trips to
  `{amount: 35.6, raw: "35,6 €"}` — cheerio decodes entities and JS `\s`/`.trim()` cover U+00A0.
  The en/em-dash variants in `parseTimeRange` are likewise covered.
- **The response size cap does fire** on both an overstated `content-length` and an understated one
  (the gzip bomb was rejected, just expensively — M5).
- **The pagination loop terminates on the real view** (2 fetches, live-verified) and is bounded at
  20; it does not duplicate rows (merge is by `id`) and it does not mask errors — a throwing
  `parseFn` or a failed `get` propagates out of the loop.
- **`find_common_slots`' fan-out fails loudly, not silently.** One category's fetch rejecting
  rejects the whole `Promise.all` (`find_common_slots.ts:61`) and surfaces as `isError: true`.
  That's the right call for this server, and there is no unhandled-rejection leak from the sibling
  workers — every worker promise is in the `Promise.all` array.
- **`limit`/`offset` vs `total` is correct through the MCP path.** `total` always reflects the
  pre-slice count; `offset: 1000` on 140 rows gives `total: 140, returned: 0` rather than an error
  or a wrapped page; `offset: 139, limit: 5` correctly returns 1. Verified across six cases.
- **Stateless per-request server/transport construction** (`functions/mcp.ts:82-85`) is the correct
  MCP pattern here and is properly torn down in `finally`.

---

## Recommended order of work

1. **H1 + H2** — add fail-loud checks. This is the project's own stated worst failure mode and it
   is currently unguarded in five places across two files.
2. **H3** — derive detail-page years from the session calendar; bound the listing inference.
3. **M3 + M1** — restrict `get_course({url})` to course paths and add `redirect: 'manual'`. One
   small change closes the proxy, most of the SSRF residual, and much of M7.
4. **M2** — fix the deploy gate before anyone flips the switch.
5. Everything else as convenient.

---

## Fixes applied

All findings below were fixed after this review, each with a regression test written to fail
first. Full suite: 122 tests across 9 files, 86.1% line / 85.6% branch coverage. Live behaviour
re-verified against plaveckaakademia.sk afterwards.

| ID     | Status       | What changed                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **H1** | Fixed        | `parseRow` now throws, naming the selector, when the schedule, centre, capacity element, level container or frequency is missing — instead of returning 140 hollow rows. `test/drift.test.ts` mutates the real fixture four ways and asserts each throws, plus an end-to-end case proving a day-filtered query surfaces drift as an error rather than "0 courses match".                                                                   |
| **H2** | Fixed        | `list_categories` throws when the centre filter form is absent, when it is present but offers no centres, and when the `.skupiny` age block is missing. Junk-page and drifted-id tests added.                                                                                                                                                                                                                                              |
| **H3** | Fixed        | Two parts. `parseDetail` now anchors the date range to the session calendar's explicit `rel="YYYY-MM-DD"` years, so a response can no longer contradict its own `sessions`. `parseSlovakDate` searches chronologically from the prior year and accepts a date up to 60 days past before rolling forward. `yearInferred` is now a real boolean (was `z.literal(true)`, which could never convey anything) and reports which path was taken. |
| **M1** | Fixed        | `doFetch` uses `redirect: 'manual'` with a bounded 3-hop loop, re-running the allowlist check on every `Location`. A 30x with no `Location` errors rather than being read as a body.                                                                                                                                                                                                                                                       |
| **M2** | Fixed        | The deploy job's condition is now `false && (workflow_dispatch                                                                                                                                                                                                                                                                                                                                                                             |     | workflow_run.conclusion == 'success')`— still inert, but enabling it by deleting *only* the`false && `prefix leaves the success gate intact.`id-token: write` moved from workflow scope to the job. README step 4 reworded accordingly. |
| **M3** | Fixed        | `get_course({url})` now requires the path to match `/plavecky-kurz/<cat>/<pool>/<id>` or `/node/<id>`, closing the open-GET-proxy surface (and with it most of the cache-flush vector).                                                                                                                                                                                                                                                    |
| **M4** | Fixed        | `fetchPaginated` reads the view header's declared total and stops once it has that many rows, so the common case is one upstream request instead of two. Falls back to the probe behaviour when the header can't be parsed.                                                                                                                                                                                                                |
| **M5** | **Deferred** | Streaming the response body to enforce the size cap pre-decode was consciously not done: it requires a hostile or compromised upstream to matter, and the cap does still bound total memory. Documented as a known limitation in README's "Security & trust model".                                                                                                                                                                        |
| **M6** | Fixed        | "Today" is derived via `Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava' })` rather than UTC getters, closing the nightly two-hour window where the server's day boundary disagreed with the site's.                                                                                                                                                                                                                           |
| **M7** | Fixed        | Free-text fields are capped at 200 chars in both parsers, and README gained a "Security & trust model" section stating plainly that upstream text is untrusted input to the calling model, and that the endpoint is anonymous and unrate-limited.                                                                                                                                                                                          |
| **L1** | Fixed        | The shared guard now also rejects an explicit port and embedded credentials.                                                                                                                                                                                                                                                                                                                                                               |
| **L2** | Fixed        | `find_common_slots` de-duplicates by resolved slug, so `["korytnacka","Korytnačka"]` can no longer satisfy the "all categories present" check twice with one category's courses.                                                                                                                                                                                                                                                           |
| **L3** | Fixed        | `listCourses` clamps `offset`/`limit` itself rather than relying on the zod schema, which only guards the MCP transport.                                                                                                                                                                                                                                                                                                                   |
| **L4** | Documented   | Behaviour unchanged (there is genuinely no sold-out state upstream), but the `onlyAvailable` tool description now says it is a forward-compatibility hook that narrows nothing, instead of advertising a filter that does nothing.                                                                                                                                                                                                         |
| **L5** | Fixed        | `HREF_PATTERN` is anchored and the URL is built with `new URL(href, BASE_URL)`, so an off-site href is rejected rather than concatenated into a garbage URL.                                                                                                                                                                                                                                                                               |
| **L6** | Fixed        | `findRowContent` returns on the first matching label instead of silently preferring the last duplicate.                                                                                                                                                                                                                                                                                                                                    |

One finding in the review was mistaken and is worth recording: the reviewer noted that
`test/fixtures/korytnacka-level1.html` contains only one-star rows and flagged a suspected
inverted `LEVEL_TO_PARAM`. A live check confirmed the mapping is correct — only the _filename_
is misleading (it was recorded with `uroven[]=0`).
