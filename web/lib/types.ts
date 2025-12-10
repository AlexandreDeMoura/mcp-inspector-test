/**
 * Type definitions for the MCP Client MVP
 */

// ============================================================================
// Server Types
// ============================================================================

export interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport: 'stdio' | 'sse';
}

export interface Server {
  id: string;
  name: string;
  config: ServerConfig;
  status: 'connected' | 'disconnected' | 'error';
  lastHealthCheck?: Date;
}

// ============================================================================
// Task Types
// ============================================================================

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface Task {
  id: string;
  createdAt: Date;
  status: TaskStatus;
  model: string;
  servers: string[];
  userMessage: string;
  finalAnswer?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost?: number;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
  errorMessage?: string;
  iterationCount: number;
}

// ============================================================================
// Tool Call Types
// ============================================================================

export type ToolCallStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'timeout';

export interface ToolCall {
  id: string;
  taskId: string;
  serverName: string;
  toolName: string;
  arguments: string;
  result?: string;
  status: ToolCallStatus;
  errorMessage?: string;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  sequenceNumber: number;
}

// ============================================================================
// Model Call Types
// ============================================================================

export type ModelCallType = 'initial' | 'tool-use' | 'tool-result' | 'final';

export interface ModelCall {
  id: string;
  taskId: string;
  type: ModelCallType;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  createdAt: Date;
  stopReason?: string;
}

// ============================================================================
// MCP Tool Types
// ============================================================================

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPToolWithServer extends MCPTool {
  serverName: string;
  serverId: string;
}

// ============================================================================
// LLM Types
// ============================================================================

export interface LLMToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolUses: LLMToolUse[];
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}

// ============================================================================
// Event Types (for Canvas UI)
// ============================================================================

/**
 * LLM Response Event
 * Represents the AI reasoning/response between tool calls
 * Displayed as an "arrow" connecting elements in the UI
 */
export interface LLMResponseEvent {
  type: 'llm-response';
  content: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  hasToolCalls: boolean;
}

/**
 * Tool Call Event
 * Represents a tool being invoked
 * Displayed as a "block" in the UI
 */
export interface ToolCallEvent {
  type: 'tool-call';
  toolCallId: string;
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  result?: string;
  errorMessage?: string;
  durationMs?: number;
}

export type TaskEvent =
  | { type: 'task-started'; taskId: string; timestamp: Date }
  | LLMResponseEvent
  | ToolCallEvent
  | { type: 'task-completed'; status: TaskStatus; finalAnswer?: string; totalDurationMs: number; totalInputTokens: number; totalOutputTokens: number }
  | { type: 'error'; message: string; code?: string };

// ============================================================================
// Config Types
// ============================================================================

export interface AppConfig {
  taskTimeoutMs: number;
  toolTimeoutMs: number;
  maxIterations: number;
  healthCheckIntervalMs: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  taskTimeoutMs: 300000, // 5 minutes
  toolTimeoutMs: 30000, // 30 seconds
  maxIterations: 20,
  healthCheckIntervalMs: 30000, // 30 seconds
};

