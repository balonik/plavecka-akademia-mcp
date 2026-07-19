/**
 * HTTP fetch layer: injectable fetch function, timeout, single retry with backoff on
 * 5xx/network errors, a descriptive User-Agent, an in-memory TTL cache with in-flight
 * request de-duplication and bounded LRU eviction, a response size cap, and a defensive
 * `?page=N` pagination loop for the (verified unpaged) listing view.
 */

import { ALLOWED_HOSTS, MAX_LISTING_PAGES } from './constants.js';

export type FetchFn = typeof fetch;

export interface ClientOptions {
  /** Injectable fetch implementation; defaults to the global `fetch`. */
  fetchFn?: FetchFn | undefined;
}

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = 500;
const TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
/** Hard cap on response size (bytes of decoded text) to bound memory use against a hostile/broken upstream. */
const MAX_RESPONSE_BYTES = 5_000_000;

export const USER_AGENT =
  'plavecka-akademia-mcp/1.0 (+https://github.com/balonik/plavecka-akademia-mcp; contact: see repo)';

class UpstreamError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UpstreamError';
    this.retryable = retryable;
  }
}

interface CacheEntry {
  expiresAt: number;
  value: string;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string>>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Normalises a URL for cache-key purposes: sorts query params so param-insertion order doesn't fragment the cache. */
function normalizeCacheKey(url: string): string {
  const parsed = new URL(url);
  const entries = [...parsed.searchParams.entries()].sort(([keyA, valueA], [keyB, valueB]) => {
    if (keyA !== keyB) return keyA < keyB ? -1 : 1;
    return valueA < valueB ? -1 : valueA > valueB ? 1 : 0;
  });
  const sortedParams = new URLSearchParams();
  for (const [key, value] of entries) {
    sortedParams.append(key, value);
  }
  const query = sortedParams.toString();
  return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ''}`;
}

/** Maximum 30x hops followed for a single request, each re-checked against the allowlist. */
const MAX_REDIRECTS = 3;

/**
 * The single choke point every outbound request passes through, including each redirect
 * hop. Rejects on:
 *  - non-https (an http URL on the right host is still a downgrade)
 *  - any host other than an exact allowlist match (never startsWith/includes/endsWith,
 *    which `plaveckaakademia.sk.evil.com` would defeat)
 *  - an explicit port (otherwise the guard degrades to "any TCP port on the site's IP")
 *  - embedded credentials (which would be forwarded upstream)
 */
export function assertAllowedHost(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UpstreamError(`Not a valid URL: "${rawUrl}"`, false);
  }
  if (parsed.protocol !== 'https:') {
    throw new UpstreamError(
      `Only https is permitted, got "${parsed.protocol}" for "${rawUrl}"`,
      false,
    );
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new UpstreamError(
      `Host "${parsed.hostname}" is not allowed; only plaveckaakademia.sk (or www.plaveckaakademia.sk) is permitted.`,
      false,
    );
  }
  if (parsed.port !== '') {
    throw new UpstreamError(`A non-default port is not permitted, got ":${parsed.port}"`, false);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new UpstreamError('Credentials embedded in the URL are not permitted.', false);
  }
  return parsed;
}

async function doFetch(url: string, fetchFn: FetchFn): Promise<string> {
  let response: Response;
  let currentUrl = url;

  // `redirect: 'manual'` rather than the default 'follow': with 'follow', only the FIRST
  // URL is ever checked against the host allowlist, so an open redirect on the upstream
  // would let a caller reach any host (on Azure, notably the IMDS endpoint) through us.
  // Every hop below is re-validated before it is followed.
  for (let hop = 0; ; hop++) {
    assertAllowedHost(currentUrl);
    try {
      response = await fetchFn(currentUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html',
        },
      });
    } catch (err) {
      throw new UpstreamError(
        `Network error fetching ${currentUrl}: ${err instanceof Error ? err.message : String(err)}`,
        true,
        {
          cause: err,
        },
      );
    }

    if (response.status < 300 || response.status >= 400) break;

    const location = response.headers.get('location');
    if (location === null) {
      throw new UpstreamError(
        `Upstream returned ${String(response.status)} with no Location header for ${currentUrl}`,
        false,
      );
    }
    if (hop >= MAX_REDIRECTS) {
      throw new UpstreamError(
        `Too many redirects (>${String(MAX_REDIRECTS)}) starting from ${url}`,
        false,
      );
    }
    // Resolve relative Location values against the URL that produced them.
    currentUrl = new URL(location, currentUrl).toString();
  }

  url = currentUrl;

  if (response.status >= 500) {
    throw new UpstreamError(`Upstream server error ${String(response.status)} for ${url}`, true);
  }
  if (!response.ok) {
    throw new UpstreamError(
      `Upstream request failed with status ${String(response.status)} for ${url}`,
      false,
    );
  }

  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null && Number(lengthHeader) > MAX_RESPONSE_BYTES) {
    throw new UpstreamError(
      `Response too large (${lengthHeader} bytes, cap is ${String(MAX_RESPONSE_BYTES)}) for ${url}`,
      false,
    );
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new UpstreamError(
      `Response body exceeded the ${String(MAX_RESPONSE_BYTES)} byte cap for ${url}`,
      false,
    );
  }
  return text;
}

async function fetchWithRetry(url: string, fetchFn: FetchFn): Promise<string> {
  try {
    return await doFetch(url, fetchFn);
  } catch (err) {
    if (err instanceof UpstreamError && err.retryable) {
      await delay(RETRY_BACKOFF_MS);
      try {
        return await doFetch(url, fetchFn);
      } catch (secondErr) {
        throw secondErr instanceof UpstreamError
          ? new Error(secondErr.message, { cause: secondErr.cause })
          : secondErr;
      }
    }
    throw err instanceof UpstreamError ? new Error(err.message, { cause: err.cause }) : err;
  }
}

function touchLru(key: string, entry: CacheEntry): void {
  // Map preserves insertion order; delete+re-insert moves this key to the "most recently used" end.
  cache.delete(key);
  cache.set(key, entry);
}

function enforceCacheLimit(): void {
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey: string | undefined = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

/**
 * Fetches a URL as text, serving from the 10-minute TTL cache when possible and
 * de-duplicating concurrent identical requests through an in-flight promise map.
 */
export async function get(url: string, options: ClientOptions = {}): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const key = normalizeCacheKey(url);
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    touchLru(key, cached);
    return cached.value;
  }

  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }

  const promise = fetchWithRetry(url, fetchFn)
    .then((text) => {
      cache.set(key, { expiresAt: Date.now() + TTL_MS, value: text });
      enforceCacheLimit();
      return text;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/** Clears the cache and in-flight map. Exposed for tests; not used by production code paths. */
export function clearCache(): void {
  cache.clear();
  inFlight.clear();
}

function withPageParam(url: string, page: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set('page', String(page));
  return parsed.toString();
}

/**
 * Fetches a (verified unpaged, but defensively paginated) listing URL page by page,
 * parsing each page with `parseFn` and merging results by `id`, stopping as soon as a
 * page contributes no new ids (or after `MAX_LISTING_PAGES`, whichever comes first).
 */
/**
 * Reads the row count the listing view prints in its header ("140 termínov"), or null if
 * it isn't present (including the no-results sentinel, which has text but no number).
 * Deliberately a cheap regex rather than a cheerio load: this runs on every page fetch and
 * only needs the leading integer.
 */
export function parseHeaderCount(html: string): number | null {
  const match = /<div class="pocet-terminov">\s*(\d+)\s/.exec(html);
  const raw = match?.[1];
  return raw === undefined ? null : Number(raw);
}

export async function fetchPaginated<T extends { id: string }>(
  baseUrl: string,
  parseFn: (html: string) => T[],
  options: ClientOptions = {},
): Promise<T[]> {
  const merged = new Map<string, T>();
  for (let page = 0; page < MAX_LISTING_PAGES; page++) {
    const pageUrl = page === 0 ? baseUrl : withPageParam(baseUrl, page);

    const html = await get(pageUrl, options);
    const items = parseFn(html);
    const newItems = items.filter((item) => !merged.has(item.id));
    if (page > 0 && newItems.length === 0) {
      break;
    }
    for (const item of items) {
      merged.set(item.id, item);
    }
    if (items.length === 0) {
      break;
    }

    // The view header states the total ("140 termínov"). The view is verified unpaged, so
    // this normally matches after page 0 and we stop without ever requesting `?page=1` --
    // otherwise every cold-cache listing call costs two upstream requests to discover
    // there was nothing more to fetch. If the header can't be read we fall back to the
    // probe-the-next-page behaviour.
    const declaredTotal = parseHeaderCount(html);
    if (declaredTotal !== null && merged.size >= declaredTotal) {
      break;
    }
  }
  return [...merged.values()];
}
