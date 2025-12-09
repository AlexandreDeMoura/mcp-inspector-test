/**
 * Hard-coded MCP server configurations for Phase 1
 */

import type { Server, ServerConfig } from './types.js';

export interface ServerDefinition {
  id: string;
  name: string;
  config: ServerConfig;
}

/**
 * Default MCP servers for MVP testing
 * Add or modify servers here for Phase 1
 */
export const MCP_SERVERS: ServerDefinition[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      transport: 'stdio',
    },
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: {
        BRAVE_API_KEY: process.env.BRAVE_API_KEY || '',
      },
      transport: 'stdio',
    },
  },
  {
    id: 'notion-mcp',
    name: 'Notion MCP',
    config: {
      command: 'node',
      args: ['/Users/alexandredemoura/Desktop/mcp/notion-mcp/dist/server.js'],
      env: {
        NOTION_API_KEY: process.env.NOTION_API_KEY || '',
      },
      transport: 'stdio',
    },
  },
];

/**
 * Get a server definition by ID
 */
export function getServerDefinition(id: string): ServerDefinition | undefined {
  return MCP_SERVERS.find((s) => s.id === id);
}

/**
 * Get all server definitions
 */
export function getAllServerDefinitions(): ServerDefinition[] {
  return MCP_SERVERS;
}

/**
 * Create a Server instance from a definition
 */
export function createServerFromDefinition(def: ServerDefinition): Server {
  return {
    id: def.id,
    name: def.name,
    config: def.config,
    status: 'disconnected',
  };
}

