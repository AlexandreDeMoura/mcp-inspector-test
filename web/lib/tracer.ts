/**
 * Tracer / Metrics Layer
 * Records tool calls and model calls with timing and token usage
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  Task,
  TaskStatus,
  ToolCall,
  ToolCallStatus,
  ModelCall,
  ModelCallType,
} from './types';

// ============================================================================
// In-Memory Stores (will be replaced with DB in Phase 4)
// ============================================================================

// Global singleton pattern for stores to survive hot-reloads in development
const globalStore = globalThis as unknown as {
  _mcp_tasks: Map<string, Task>;
  _mcp_toolCalls: Map<string, ToolCall[]>;
  _mcp_modelCalls: Map<string, ModelCall[]>;
};

if (!globalStore._mcp_tasks) globalStore._mcp_tasks = new Map<string, Task>();
if (!globalStore._mcp_toolCalls) globalStore._mcp_toolCalls = new Map<string, ToolCall[]>();
if (!globalStore._mcp_modelCalls) globalStore._mcp_modelCalls = new Map<string, ModelCall[]>();

const tasks = globalStore._mcp_tasks;
const toolCalls = globalStore._mcp_toolCalls;
const modelCalls = globalStore._mcp_modelCalls;

// ============================================================================
// Task Management
// ============================================================================

export function createTask(
  userMessage: string,
  model: string,
  servers: string[]
): Task {
  const task: Task = {
    id: `task_${uuidv4().slice(0, 8)}`,
    createdAt: new Date(),
    status: 'pending',
    model,
    servers,
    userMessage,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    iterationCount: 0,
  };

  tasks.set(task.id, task);
  toolCalls.set(task.id, []);
  modelCalls.set(task.id, []);

  return task;
}

export function getTask(taskId: string): Task | undefined {
  return tasks.get(taskId);
}

export function updateTask(taskId: string, updates: Partial<Task>): Task | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;

  const updatedTask = { ...task, ...updates };
  tasks.set(taskId, updatedTask);
  return updatedTask;
}

export function startTask(taskId: string): Task | undefined {
  return updateTask(taskId, {
    status: 'running',
    startedAt: new Date(),
  });
}

export function completeTask(
  taskId: string,
  status: TaskStatus,
  finalAnswer?: string,
  errorMessage?: string
): Task | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;

  const finishedAt = new Date();
  const durationMs = task.startedAt
    ? finishedAt.getTime() - task.startedAt.getTime()
    : undefined;

  // Aggregate token counts from model calls
  const taskModelCalls = modelCalls.get(taskId) || [];
  const totalInputTokens = taskModelCalls.reduce((sum, mc) => sum + mc.inputTokens, 0);
  const totalOutputTokens = taskModelCalls.reduce((sum, mc) => sum + mc.outputTokens, 0);

  // Calculate cost (Claude 3.5 Sonnet pricing: $3/$15 per 1M tokens)
  const totalCost =
    (totalInputTokens * 3) / 1_000_000 + (totalOutputTokens * 15) / 1_000_000;

  return updateTask(taskId, {
    status,
    finalAnswer,
    errorMessage,
    finishedAt,
    durationMs,
    totalInputTokens,
    totalOutputTokens,
    totalCost,
  });
}

export function incrementIteration(taskId: string): number {
  const task = tasks.get(taskId);
  if (!task) return 0;

  const newCount = task.iterationCount + 1;
  updateTask(taskId, { iterationCount: newCount });
  return newCount;
}

// ============================================================================
// Tool Call Tracking
// ============================================================================

export function startToolCall(
  taskId: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): ToolCall {
  const taskToolCalls = toolCalls.get(taskId) || [];

  const toolCall: ToolCall = {
    id: `tc_${uuidv4().slice(0, 8)}`,
    taskId,
    serverName,
    toolName,
    arguments: truncateString(JSON.stringify(args), 1000),
    status: 'running',
    startedAt: new Date(),
    sequenceNumber: taskToolCalls.length + 1,
  };

  taskToolCalls.push(toolCall);
  toolCalls.set(taskId, taskToolCalls);

  return toolCall;
}

export function completeToolCall(
  toolCallId: string,
  taskId: string,
  status: ToolCallStatus,
  result?: string,
  errorMessage?: string
): ToolCall | undefined {
  const taskToolCalls = toolCalls.get(taskId);
  if (!taskToolCalls) return undefined;

  const index = taskToolCalls.findIndex((tc) => tc.id === toolCallId);
  if (index === -1) return undefined;

  const toolCall = taskToolCalls[index];
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - toolCall.startedAt.getTime();

  const updatedToolCall: ToolCall = {
    ...toolCall,
    status,
    result: result ? truncateString(result, 1000) : undefined,
    errorMessage,
    finishedAt,
    durationMs,
  };

  taskToolCalls[index] = updatedToolCall;
  toolCalls.set(taskId, taskToolCalls);

  return updatedToolCall;
}

export function getToolCalls(taskId: string): ToolCall[] {
  return toolCalls.get(taskId) || [];
}

// ============================================================================
// Model Call Tracking
// ============================================================================

export function recordModelCall(
  taskId: string,
  type: ModelCallType,
  inputTokens: number,
  outputTokens: number,
  durationMs: number,
  stopReason?: string
): ModelCall {
  const modelCall: ModelCall = {
    id: `mc_${uuidv4().slice(0, 8)}`,
    taskId,
    type,
    inputTokens,
    outputTokens,
    durationMs,
    createdAt: new Date(),
    stopReason,
  };

  const taskModelCalls = modelCalls.get(taskId) || [];
  taskModelCalls.push(modelCall);
  modelCalls.set(taskId, taskModelCalls);

  return modelCall;
}

export function getModelCalls(taskId: string): ModelCall[] {
  return modelCalls.get(taskId) || [];
}

// ============================================================================
// Utilities
// ============================================================================

function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

// ============================================================================
// Store Access (for debugging)
// ============================================================================

export function getAllTasks(): Task[] {
  return Array.from(tasks.values());
}

export function clearStores(): void {
  tasks.clear();
  toolCalls.clear();
  modelCalls.clear();
}

