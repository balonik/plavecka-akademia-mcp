import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache, get, type FetchFn } from '../src/site/client.js';
import { urlOf } from './helpers.js';

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

beforeEach(() => {
  clearCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('client get()', () => {
  it('serves a repeat request within the TTL from cache, issuing exactly one fetch', async () => {
    const impl: FetchFn = async () => htmlResponse('<html>a</html>');
    const fetchFn = vi.fn(impl);
    const url = 'https://plaveckaakademia.sk/kurzy/plavanie-pre-deti/korytnacka';

    const first = await get(url, { fetchFn });
    const second = await get(url, { fetchFn });

    expect(first).toBe('<html>a</html>');
    expect(second).toBe('<html>a</html>');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the 10-minute TTL has expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const firstImpl: FetchFn = async () => htmlResponse('<html>first</html>');
    const fetchFn = vi.fn(firstImpl);
    const url = 'https://plaveckaakademia.sk/kurzy/plavanie-pre-deti/zralok';

    const first = await get(url, { fetchFn });
    expect(first).toBe('<html>first</html>');

    vi.setSystemTime(new Date('2026-01-01T00:09:59.000Z')); // still within the 10-minute TTL
    const withinTtl = await get(url, { fetchFn });
    expect(withinTtl).toBe('<html>first</html>');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    fetchFn.mockImplementation(async () => htmlResponse('<html>second</html>'));

    vi.setSystemTime(new Date('2026-01-01T00:10:01.000Z')); // just past the 10-minute TTL
    const afterTtl = await get(url, { fetchFn });
    expect(afterTtl).toBe('<html>second</html>');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates two concurrent identical requests into a single in-flight fetch', async () => {
    let resolvePending: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolvePending = resolve;
    });
    const impl: FetchFn = () => pending;
    const fetchFn = vi.fn(impl);
    const url = 'https://plaveckaakademia.sk/kurzy/plavanie-pre-deti/delfin';

    // Neither call is awaited before the other starts, so if the client didn't
    // de-duplicate, `fetchFn` would already have been invoked twice by this point.
    const first = get(url, { fetchFn });
    const second = get(url, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    resolvePending?.(htmlResponse('<html>shared</html>'));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe('<html>shared</html>');
    expect(secondResult).toBe('<html>shared</html>');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once on a 5xx response, then surfaces an error', async () => {
    const impl: FetchFn = async () => htmlResponse('internal error', 500);
    const fetchFn = vi.fn(impl);
    const url = 'https://plaveckaakademia.sk/kurzy/plavanie-pre-deti/korytnacka?scenario=5xx';

    await expect(get(url, { fetchFn })).rejects.toThrow(/Upstream server error 500/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('retries once on a network error (fetchFn itself rejects), then surfaces an error', async () => {
    const impl: FetchFn = async () => {
      throw new TypeError('fetch failed');
    };
    const fetchFn = vi.fn(impl);
    const url =
      'https://plaveckaakademia.sk/kurzy/plavanie-pre-deti/korytnacka?scenario=network-error';

    await expect(get(url, { fetchFn })).rejects.toThrow(/Network error fetching/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('does not retry on a 4xx response', async () => {
    const impl: FetchFn = async () => htmlResponse('not found', 404);
    const fetchFn = vi.fn(impl);
    const url = 'https://plaveckaakademia.sk/kurzy/plavanie-pre-deti/korytnacka?scenario=4xx';

    await expect(get(url, { fetchFn })).rejects.toThrow(/status 404/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects (without retrying) when the content-length header exceeds the response size cap', async () => {
    const impl: FetchFn = async () =>
      new Response('tiny body', { status: 200, headers: { 'content-length': '6000000' } });
    const fetchFn = vi.fn(impl);
    const url =
      'https://plaveckaakademia.sk/kurzy/plavanie-pre-deti/korytnacka?scenario=huge-content-length';

    await expect(get(url, { fetchFn })).rejects.toThrow(/Response too large/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects (without retrying) when the decoded body exceeds the cap even if the header understated it', async () => {
    const hugeBody = 'x'.repeat(5_000_001);
    const impl: FetchFn = async () =>
      // Deliberately understate content-length so only the post-decode length check can catch this.
      new Response(hugeBody, { status: 200, headers: { 'content-length': '10' } });
    const fetchFn = vi.fn(impl);
    const url = 'https://plaveckaakademia.sk/kurzy/plavanie-pre-deti/korytnacka?scenario=huge-body';

    await expect(get(url, { fetchFn })).rejects.toThrow(/exceeded the .* byte cap/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('bounds the cache size: the least-recently-used entry is evicted once the limit is exceeded', async () => {
    const callCounts = new Map<string, number>();
    const impl: FetchFn = async (input) => {
      const url = urlOf(input);
      callCounts.set(url, (callCounts.get(url) ?? 0) + 1);
      return htmlResponse(`<html>${url}</html>`);
    };
    const fetchFn = vi.fn(impl);

    // The internal cache cap is 50 entries; 51 distinct URLs must evict the oldest one.
    const urls = Array.from(
      { length: 51 },
      (_unused, i) => `https://plaveckaakademia.sk/page-${String(i)}`,
    );
    for (const url of urls) {
      // Deliberately sequential (not Promise.all) so LRU insertion order is deterministic.

      await get(url, { fetchFn });
    }

    const oldest = urls[0];
    const newest = urls[urls.length - 1];
    if (oldest === undefined || newest === undefined) {
      throw new Error('test setup error: expected at least one url');
    }

    // The oldest entry must have been evicted, forcing a second real fetch.
    await get(oldest, { fetchFn });
    expect(callCounts.get(oldest)).toBe(2);

    // The most recently inserted entry must still be cached (no re-fetch).
    await get(newest, { fetchFn });
    expect(callCounts.get(newest)).toBe(1);
  });
});
