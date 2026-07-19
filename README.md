# plavecka-akademia-mcp

A remote MCP (Model Context Protocol) server that turns
[plaveckaakademia.sk](https://plaveckaakademia.sk)'s children's swimming course listings into
structured tools an LLM can call, so prompts like _"Žralok on Friday in Devínska"_ or _"a date and
place where I can book Žralok + Delfín + Korytnačka at the same location"_ are answerable in one or
two tool calls instead of manually paging through the site.

The site itself has no API: it's a Drupal 7 Views exposed-filter form supporting only a centre and
a sub-level filter, no day/time filter and no way to ask a cross-category question. This server
fetches and parses the site's own HTML and layers the richer filtering on top, server-side.

It runs as an Azure Function App and is meant to be added to Claude as a **custom connector** — see
[Add it to Claude](#add-it-to-claude) below.

## Tools

### `list_categories`

No arguments. Lists the four course categories (Morský koník, Korytnačka, Delfín, Žralok) with
their slug, age range, whether they offer `*`/`**` sub-levels, and the centres each is offered at.

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

Returns `{ total, returned, offset, courses[] }`. An unknown `location`, `day` or `category` is
rejected with an error message listing the valid values — it never silently falls through to an
empty result.

### `get_course`

```
{ courseId?: string } | { url?: string }
```

Fetches the live detail page for one course (by numeric id, or by its full URL) and returns
address, date range, day/time, price, lesson counts, age range, availability, booking URL and the
per-session calendar.

### `find_common_slots`

```
{
  categories: { category: string, level?: "*" | "**" | "any" }[],
  location?: string,
  day?: string,
  onlyAvailable?: boolean,
}
```

Returns only the centre/day combinations where **every** requested `{ category, level }` has at
least one matching course, with the concrete courses per requirement attached (`groups[]` on each
match). This is what answers "book Žralok\*\* + Delfín\* at the same place" in one call — the same
category can be requested twice at different levels (e.g. one child ready for Žralok\*\*, a sibling
still on Žralok\*). Omit `level` (or pass `"any"`) for no level restriction. Returns `{ matches: [] }`
when no combination satisfies every requirement.

## Add it to Claude

The endpoint is `https://<your-function-app-name>.azurewebsites.net/api/mcp?code=<key>` — gated by
an Azure Functions key rather than a login, since this is a read-only proxy over public listings
with no per-user data (see [Security & trust model](#security--trust-model)).

If you're pointing this at an already-deployed instance, ask whoever deployed it for the URL
(including the `?code=` part) and skip to step 2. If you're deploying your own copy, see
[ARCHITECTURE.md](./ARCHITECTURE.md) first, then come back here.

1. **Get a function key**, if you don't already have one. Create a dedicated named key rather than
   reusing the default/host master key, so it can be revoked independently later:

   ```bash
   az functionapp function keys set \
     --name <your-function-app-name> \
     --resource-group <your-resource-group> \
     --function-name mcp \
     --key-name claude-connector \
     --key-value "$(openssl rand -base64 32)"
   ```

   Or via the Portal: Function App → **Functions** → **mcp** → **Function Keys** → **+ New function
   key**.

2. **In Claude**, go to Settings → Connectors → Add custom connector, and point it at the full URL
   above, including the `?code=` query parameter.

3. Try a prompt like _"What Žralok courses are available on Friday in Devínska?"_ to confirm it's
   wired up.

Rotating or deleting the key immediately invalidates any URL using it — update the connector's URL
in Claude after rotating.

## Security & trust model

This server is a read-only proxy over public course listings, so there's nothing to protect behind
a login — but that's not the same as nothing to think about:

- **A function key, not user authentication, gates the endpoint.** It's a shared-secret gate
  against casual/automated abuse, not per-caller accounting or rate limiting. Anyone with the key
  can drive unlimited requests at plaveckaakademia.sk from the server's IP.
- **`get_course`'s `url` input is validated**, not just fetched — only an exactly-matching
  allowlisted host, `https`, and a course-detail-shaped path are accepted, so it can't be used as an
  open proxy for arbitrary URLs.
- **Upstream text is untrusted input to the calling model.** Fields like `address` and `venueName`
  are scraped verbatim from the site and flow into the LLM's context — treat tool output as data,
  not instructions.

See ARCHITECTURE.md's [Security & trust model](./ARCHITECTURE.md#security--trust-model-details) for
the full reasoning, including known limitations.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow, coding conventions, how to
re-record fixtures when the site changes, and what a pull request is expected to include.

For how the server is built, how the site is scraped, and how it's deployed, see
[ARCHITECTURE.md](./ARCHITECTURE.md). If you're working on this repo with Claude Code,
[CLAUDE.md](./CLAUDE.md) carries the project context and the non-obvious site-scraping gotchas that
are easy to reintroduce.

## License

GNU General Public License v3.0 — see [LICENSE](./LICENSE).
