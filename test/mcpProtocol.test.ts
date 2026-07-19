/**
 * End-to-end tests over the real MCP wire protocol: connects an SDK `Client` to `createServer()`
 * via `InMemoryTransport`, so `callTool` actually exercises each `registerXTool` callback --
 * including the success-formatting and `catch`/`isError` branches that the other test files never
 * touch (they call the underlying `listCourses`/`getCourse`/etc. functions directly, bypassing the
 * tool-registration wrapper entirely). No real network I/O: the tool callbacks call their
 * underlying functions with no injectable `fetchFn`, so they fall through to the global `fetch`,
 * which is stubbed here per `client.ts`'s own documented fallback (`options.fetchFn ?? fetch`).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache, type FetchFn } from '../src/site/client.js';
import { createServer } from '../src/server.js';
import { buildListingHtml, readFixture, urlOf } from './helpers.js';

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

async function connectedClient(): Promise<Client> {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

beforeEach(() => {
  clearCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MCP tool wrappers (real wire protocol, stubbed global fetch)', () => {
  it('list_categories: success shapes content and structuredContent', async () => {
    const morskyKonikHtml = readFixture('morsky-konik.html');
    const korytnackaHtml = readFixture('korytnacka-all.html');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<FetchFn>[0]) =>
        htmlResponse(urlOf(input).includes('/morsky-konik') ? morskyKonikHtml : korytnackaHtml),
      ),
    );

    const client = await connectedClient();
    const result = await client.callTool({ name: 'list_categories', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      categories: expect.arrayContaining([expect.objectContaining({ slug: 'zralok' })]) as unknown,
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('centres:');
  });

  it('list_categories: a drifted page (missing ".skupiny") is reported via isError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        htmlResponse('<html><body>markup drifted, nothing recognisable</body></html>'),
      ),
    );

    const client = await connectedClient();
    const result = await client.callTool({ name: 'list_categories', arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toMatch(/\.skupiny/);
  });

  it('list_courses: success shapes content and structuredContent', async () => {
    const listingHtml = buildListingHtml([{ id: '9999001' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse(listingHtml)),
    );

    const client = await connectedClient();
    const result = await client.callTool({
      name: 'list_courses',
      arguments: { category: 'korytnacka' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total: 1, returned: 1 });
  });

  it('list_courses: an unknown category is reported via isError, not a thrown protocol error', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'list_courses', arguments: { category: 'nemo' } });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toMatch(/Unknown category/);
  });

  it('get_course: success shapes content and structuredContent', async () => {
    const detailHtml = readFixture('detail-1313637.html');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const client = await connectedClient();
    const result = await client.callTool({
      name: 'get_course',
      arguments: { courseId: '1313637' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ id: '1313637' });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('Address:');
  });

  it('get_course: an invalid courseId is reported via isError before any fetch happens', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'get_course', arguments: { courseId: 'abc' } });

    expect(result.isError).toBe(true);
  });

  it('find_common_slots: success shapes content and structuredContent', async () => {
    const listingHtml = buildListingHtml([{ id: '9999002' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse(listingHtml)),
    );

    const client = await connectedClient();
    const result = await client.callTool({
      name: 'find_common_slots',
      arguments: { categories: [{ category: 'korytnacka' }] },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      matches: expect.arrayContaining([
        expect.objectContaining({ centre: 'Šustekova' }),
      ]) as unknown,
    });
  });

  it('find_common_slots: an unknown category is reported via isError', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'find_common_slots',
      arguments: { categories: [{ category: 'nemo' }] },
    });

    expect(result.isError).toBe(true);
  });
});
