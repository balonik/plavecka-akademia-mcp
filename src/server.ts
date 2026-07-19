/**
 * MCP server construction and tool registration. Kept transport-agnostic: the Azure
 * Functions HTTP trigger (`src/functions/mcp.ts`) creates a fresh server per request
 * (stateless mode) via `createServer()`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFindCommonSlotsTool } from './tools/find_common_slots.js';
import { registerGetCourseTool } from './tools/get_course.js';
import { registerListCategoriesTool } from './tools/list_categories.js';
import { registerListCoursesTool } from './tools/list_courses.js';

export const SERVER_NAME = 'plavecka-akademia-mcp';
export const SERVER_VERSION = '1.0.0';

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerListCategoriesTool(server);
  registerListCoursesTool(server);
  registerGetCourseTool(server);
  registerFindCommonSlotsTool(server);

  return server;
}
