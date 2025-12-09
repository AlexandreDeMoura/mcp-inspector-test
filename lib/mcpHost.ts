/**
 * MCP Host Core
 * Manages MCP server connections, spawning, health checks, and tool execution
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Server, MCPTool, MCPToolWithServer, ServerConfig } from './types.js';
import {
  MCP_SERVERS,
  type ServerDefinition,
  createServerFromDefinition,
} from './mcp-servers.js';

// ============================================================================
// Types
// ============================================================================

interface ConnectedServer {
  server: Server;
  client: Client;
  transport: StdioClientTransport;
  tools: MCPTool[];
}

// ============================================================================
// State
// ============================================================================

const connectedServers = new Map<string, ConnectedServer>();
let healthCheckInterval: NodeJS.Timeout | null = null;

// ============================================================================
// Server Management
// ============================================================================

/**
 * Spawn and connect to an MCP server
 */
export async function connectServer(definition: ServerDefinition): Promise<ConnectedServer> {
  console.log(`[MCP Host] Connecting to server: ${definition.name}...`);

  const server = createServerFromDefinition(definition);

  // Create transport based on type
  if (definition.config.transport !== 'stdio') {
    throw new Error(`Unsupported transport: ${definition.config.transport}`);
  }

  // Merge process env with server-specific env
  const env = {
    ...process.env,
    ...definition.config.env,
  };

  const transport = new StdioClientTransport({
    command: definition.config.command,
    args: definition.config.args,
    env: env as Record<string, string>,
  });

  const client = new Client(
    {
      name: 'mcp-inspector',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  try {
    await client.connect(transport);

    // List available tools
    const toolsResponse = await client.listTools();
    const tools: MCPTool[] = toolsResponse.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as MCPTool['inputSchema'],
    }));

    server.status = 'connected';
    server.lastHealthCheck = new Date();

    const connectedServer: ConnectedServer = {
      server,
      client,
      transport,
      tools,
    };

    connectedServers.set(definition.id, connectedServer);

    console.log(
      `[MCP Host] Connected to ${definition.name} with ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`
    );

    return connectedServer;
  } catch (error) {
    server.status = 'error';
    throw new Error(
      `Failed to connect to ${definition.name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Disconnect from an MCP server
 */
export async function disconnectServer(serverId: string): Promise<void> {
  const connected = connectedServers.get(serverId);
  if (!connected) return;

  console.log(`[MCP Host] Disconnecting from server: ${connected.server.name}...`);

  try {
    await connected.client.close();
  } catch (error) {
    console.error(`[MCP Host] Error disconnecting: ${error}`);
  }

  connected.server.status = 'disconnected';
  connectedServers.delete(serverId);
}

/**
 * Connect to multiple servers by ID
 */
export async function connectServers(serverIds: string[]): Promise<ConnectedServer[]> {
  const results: ConnectedServer[] = [];

  for (const serverId of serverIds) {
    // Skip if already connected
    const existing = connectedServers.get(serverId);
    if (existing && existing.server.status === 'connected') {
      results.push(existing);
      continue;
    }

    const definition = MCP_SERVERS.find((s) => s.id === serverId);
    if (!definition) {
      console.warn(`[MCP Host] Server not found: ${serverId}`);
      continue;
    }

    try {
      const connected = await connectServer(definition);
      results.push(connected);
    } catch (error) {
      console.error(`[MCP Host] Failed to connect ${serverId}: ${error}`);
    }
  }

  return results;
}

/**
 * Disconnect from all servers
 */
export async function disconnectAllServers(): Promise<void> {
  console.log('[MCP Host] Disconnecting from all servers...');

  for (const serverId of connectedServers.keys()) {
    await disconnectServer(serverId);
  }
}

/**
 * Restart a server (disconnect and reconnect)
 */
export async function restartServer(serverId: string): Promise<ConnectedServer | null> {
  console.log(`[MCP Host] Restarting server: ${serverId}...`);

  await disconnectServer(serverId);

  const definition = MCP_SERVERS.find((s) => s.id === serverId);
  if (!definition) {
    console.error(`[MCP Host] Cannot restart - server not found: ${serverId}`);
    return null;
  }

  try {
    return await connectServer(definition);
  } catch (error) {
    console.error(`[MCP Host] Failed to restart ${serverId}: ${error}`);
    return null;
  }
}

// ============================================================================
// Tool Discovery
// ============================================================================

/**
 * Get all tools from all connected servers
 */
export function getAllTools(): MCPToolWithServer[] {
  const allTools: MCPToolWithServer[] = [];

  for (const [serverId, connected] of connectedServers) {
    for (const tool of connected.tools) {
      allTools.push({
        ...tool,
        serverName: connected.server.name,
        serverId,
      });
    }
  }

  return allTools;
}

/**
 * Get tools from specific servers
 */
export function getToolsForServers(serverIds: string[]): MCPToolWithServer[] {
  const tools: MCPToolWithServer[] = [];

  for (const serverId of serverIds) {
    const connected = connectedServers.get(serverId);
    if (!connected) continue;

    for (const tool of connected.tools) {
      tools.push({
        ...tool,
        serverName: connected.server.name,
        serverId,
      });
    }
  }

  return tools;
}

/**
 * Find which server provides a specific tool
 */
export function findToolServer(toolName: string): ConnectedServer | undefined {
  for (const connected of connectedServers.values()) {
    if (connected.tools.some((t) => t.name === toolName)) {
      return connected;
    }
  }
  return undefined;
}

// ============================================================================
// Tool Execution
// ============================================================================

/**
 * Execute a tool on the appropriate server
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = 30000
): Promise<{ result: string; isError: boolean }> {
  const connected = findToolServer(toolName);

  if (!connected) {
    return {
      result: `Tool not found: ${toolName}`,
      isError: true,
    };
  }

  console.log(`[MCP Host] Executing tool: ${toolName} on ${connected.server.name}`);

  try {
    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    // Execute tool with timeout
    const resultPromise = connected.client.callTool({
      name: toolName,
      arguments: args,
    });

    const result = await Promise.race([resultPromise, timeoutPromise]);

    // Extract text content from result
    const content = result.content;
    if (Array.isArray(content)) {
      const textContent = content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      return { result: textContent || JSON.stringify(content), isError: result.isError === true };
    }

    return { result: JSON.stringify(content), isError: result.isError === true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[MCP Host] Tool execution error: ${message}`);
    return {
      result: `Tool execution failed: ${message}`,
      isError: true,
    };
  }
}

// ============================================================================
// Health Checks
// ============================================================================

/**
 * Check health of all connected servers
 */
export async function checkServerHealth(): Promise<void> {
  console.log('[MCP Host] Running health checks...');

  for (const [serverId, connected] of connectedServers) {
    try {
      // Simple health check - try to list tools
      await connected.client.listTools();
      connected.server.status = 'connected';
      connected.server.lastHealthCheck = new Date();
    } catch (error) {
      console.error(`[MCP Host] Health check failed for ${connected.server.name}: ${error}`);
      connected.server.status = 'error';

      // Attempt restart
      await restartServer(serverId);
    }
  }
}

/**
 * Start periodic health checks
 */
export function startHealthChecks(intervalMs: number = 30000): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }

  healthCheckInterval = setInterval(() => {
    checkServerHealth().catch(console.error);
  }, intervalMs);

  console.log(`[MCP Host] Health checks started (interval: ${intervalMs}ms)`);
}

/**
 * Stop periodic health checks
 */
export function stopHealthChecks(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    console.log('[MCP Host] Health checks stopped');
  }
}

// ============================================================================
// Status & Debugging
// ============================================================================

/**
 * Get status of all servers
 */
export function getServerStatuses(): Server[] {
  return Array.from(connectedServers.values()).map((c) => c.server);
}

/**
 * Check if a server is connected
 */
export function isServerConnected(serverId: string): boolean {
  const connected = connectedServers.get(serverId);
  return connected?.server.status === 'connected';
}

/**
 * Get a connected server by ID
 */
export function getConnectedServer(serverId: string): ConnectedServer | undefined {
  return connectedServers.get(serverId);
}

