/**
 * Azure Functions v4 HTTP trigger, route "mcp", function-key auth, GET/POST/DELETE.
 *
 * `authLevel: 'function'` means the Azure Functions host itself requires a valid
 * `?code=<key>` query parameter (or `x-functions-key` header) before this handler is ever
 * invoked -- there is no key-validation code here to write or get wrong. Keys are managed
 * entirely in Azure (Portal "App keys" / the function's own "Function Keys" blade, or
 * `az functionapp function keys`), independently of a deployment. See README's "Register
 * the deployed server in Claude" section for how to obtain one and build the URL.
 *
 * Bridges the Functions request/response model to the MCP SDK's
 * `WebStandardStreamableHTTPServerTransport` in stateless mode
 * (`sessionIdGenerator: undefined`). This transport variant works entirely in terms of
 * the standard `Request`/`Response` objects (not Node's `http.IncomingMessage` /
 * `ServerResponse`), which is a very close match for `@azure/functions` v4's own
 * `HttpRequest`/`HttpResponseInit` model -- no Node-http shimming required.
 *
 * A fresh `McpServer` + transport is created per request (matching the MCP SDK's own
 * documented stateless pattern): there is no session to share between requests, so
 * reusing either instance across concurrent requests would risk request-id collisions.
 * GET and DELETE return 405 directly without touching the transport, since SSE
 * notifications and session termination are both session-mode-only features.
 */

import { Buffer } from 'node:buffer';
import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from '../server.js';

const METHOD_NOT_ALLOWED_BODY = {
  jsonrpc: '2.0' as const,
  error: {
    code: -32000,
    message:
      'Method not allowed: stateless mode does not support SSE notifications or session termination.',
  },
  id: null,
};

const PARSE_ERROR_BODY = {
  jsonrpc: '2.0' as const,
  error: { code: -32700, message: 'Parse error: invalid JSON request body.' },
  id: null,
};

const INTERNAL_ERROR_BODY = {
  jsonrpc: '2.0' as const,
  error: { code: -32603, message: 'Internal server error.' },
  id: null,
};

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function handlePost(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (err) {
    context.error('Failed to read MCP request body', err);
    return { status: 400, jsonBody: PARSE_ERROR_BODY };
  }

  let parsedBody: unknown;
  try {
    parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
  } catch {
    return { status: 400, jsonBody: PARSE_ERROR_BODY };
  }

  // Stateless mode: a fresh transport (and server) per request avoids request-id
  // collisions between concurrent callers -- there is no session to keep them apart.
  // `sessionIdGenerator` is deliberately omitted (rather than set to `undefined`) so
  // this object literal type-checks under `exactOptionalPropertyTypes`; omitting the
  // key is exactly what "stateless mode" means to the transport.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = createServer();

  try {
    await server.connect(transport);

    const webRequest = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: rawBody,
    });

    const webResponse = await transport.handleRequest(webRequest, { parsedBody });
    const bodyBuffer = Buffer.from(await webResponse.arrayBuffer());

    return {
      status: webResponse.status,
      headers: responseHeadersToRecord(webResponse.headers),
      body: bodyBuffer,
    };
  } catch (err) {
    context.error('Error handling MCP request', err);
    return { status: 500, jsonBody: INTERNAL_ERROR_BODY };
  } finally {
    await transport.close();
    await server.close();
  }
}

app.http('mcp', {
  route: 'mcp',
  methods: ['GET', 'POST', 'DELETE'],
  authLevel: 'function',
  handler: (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    if (request.method === 'POST') {
      return handlePost(request, context);
    }
    return Promise.resolve({ status: 405, jsonBody: METHOD_NOT_ALLOWED_BODY });
  },
});
