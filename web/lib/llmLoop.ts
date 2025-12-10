/**
 * LLM Loop Implementation
 * Orchestrates the conversation between the LLM and MCP tools
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ToolResultBlockParam, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import type { MCPToolWithServer, AppConfig, TaskEvent } from './types';
import {
  connectServers,
  disconnectAllServers,
  getToolsForServers,
  executeTool,
  findToolServer,
} from './mcpHost';
import {
  createTask,
  startTask,
  completeTask,
  incrementIteration,
  startToolCall,
  completeToolCall,
  recordModelCall,
} from './tracer';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `You are a helpful assistant with access to various tools through the Model Context Protocol (MCP).

When asked to perform tasks:
1. Think about which tools might be helpful
2. Use tools when needed to gather information or perform actions
3. Provide clear, concise answers based on the results

Always explain your reasoning and what tools you're using.`;

// ============================================================================
// Anthropic Client
// ============================================================================

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

// ============================================================================
// Tool Format Conversion
// ============================================================================

/**
 * Convert MCP tools to Anthropic tool format
 */
function convertToolsToAnthropic(tools: MCPToolWithServer[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || `Tool from ${tool.serverName}`,
    input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
  }));
}

// ============================================================================
// Main LLM Loop
// ============================================================================

export interface RunTaskOptions {
  userMessage: string;
  model?: string;
  serverIds: string[];
  config?: Partial<AppConfig>;
}

/**
 * Run a complete task with the LLM loop - Generator Version
 * Yields events for the UI to display progress
 */
export async function* runTaskGenerator(options: RunTaskOptions): AsyncGenerator<TaskEvent, void, unknown> {
  const {
    userMessage,
    model = DEFAULT_MODEL,
    serverIds,
    config = {},
  } = options;

  const maxIterations = config.maxIterations ?? 20;
  const taskTimeoutMs = config.taskTimeoutMs ?? 300000;
  const toolTimeoutMs = config.toolTimeoutMs ?? 30000;

  // Create task
  const task = createTask(userMessage, model, serverIds);
  yield { type: 'task-started', taskId: task.id, timestamp: new Date() };
  yield { type: 'log', message: `Starting task with ${serverIds.length} servers...` };

  try {
    // Connect to servers
    yield { type: 'log', message: 'Connecting to MCP servers...' };
    const connected = await connectServers(serverIds);

    if (connected.length === 0) {
      throw new Error('No MCP servers could be connected');
    }

    yield { type: 'log', message: `Connected to ${connected.length} servers: ${connected.map(s => s.server.name).join(', ')}` };

    // Get tools from connected servers
    const tools = getToolsForServers(serverIds);
    yield { type: 'log', message: `Available tools: ${tools.map((t) => t.name).join(', ')}` };

    if (tools.length === 0) {
      throw new Error('No tools available from connected servers');
    }

    // Start task
    startTask(task.id);

    // Run the loop
    const client = getAnthropicClient();
    const anthropicTools = convertToolsToAnthropic(tools);

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: task.userMessage,
      },
    ];

    let iteration = 0;
    let finalAnswer = '';

    while (iteration < maxIterations) {
      iteration = incrementIteration(task.id);
      yield { type: 'log', message: `Iteration ${iteration}/${maxIterations}` };

      // Call the model
      const startTime = Date.now();
      
      yield { type: 'log', message: 'Calling model...' };
      
      const response = await client.messages.create({
        model: task.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: anthropicTools,
        messages,
      });

      const durationMs = Date.now() - startTime;
      
      yield { 
        type: 'model-call', 
        inputTokens: response.usage.input_tokens, 
        outputTokens: response.usage.output_tokens, 
        durationMs 
      };

      // Record model call
      recordModelCall(
        task.id,
        iteration === 1 ? 'initial' : 'tool-result',
        response.usage.input_tokens,
        response.usage.output_tokens,
        durationMs,
        response.stop_reason || undefined
      );

      // Process response content
      const toolUses: ToolUseBlock[] = [];
      let textContent = '';

      for (const block of response.content) {
        if (block.type === 'text') {
          textContent += block.text;
          yield { type: 'log', message: `Assistant: ${block.text}` };
        } else if (block.type === 'tool_use') {
          toolUses.push(block);
        }
      }

      // Check if we have tool calls to process
      if (toolUses.length > 0) {
        yield { type: 'log', message: `Processing ${toolUses.length} tool call(s)...` };

        // Add assistant message with tool uses
        messages.push({
          role: 'assistant',
          content: response.content,
        });

        // Execute each tool and collect results
        const toolResults: ToolResultBlockParam[] = [];

        for (const toolUse of toolUses) {
          const toolName = toolUse.name;
          const toolArgs = toolUse.input as Record<string, unknown>;

          // Find which server provides this tool
          const server = findToolServer(toolName);
          const serverName = server?.server.name || 'unknown';

          yield { type: 'log', message: `Calling tool: ${toolName} on ${serverName}` };
          
          // Start tracking
          const toolCall = startToolCall(task.id, serverName, toolName, toolArgs);
          yield { type: 'tool-started', toolCallId: toolCall.id, serverName, toolName };

          // Execute tool
          const { result, isError } = await executeTool(toolName, toolArgs, toolTimeoutMs);

          // Complete tracking
          completeToolCall(
            toolCall.id,
            task.id,
            isError ? 'error' : 'success',
            result,
            isError ? result : undefined
          );

          yield { 
            type: 'tool-completed', 
            toolCallId: toolCall.id, 
            status: isError ? 'error' : 'success', 
            durationMs: 0, // We could calculate this better if needed
            result
          };

          // Add to results
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result,
            is_error: isError,
          });
        }

        // Add tool results to conversation
        messages.push({
          role: 'user',
          content: toolResults,
        });

        // Continue loop
        continue;
      }

      // No tool calls - check if we're done
      if (response.stop_reason === 'end_turn') {
        finalAnswer = textContent;
        completeTask(task.id, 'succeeded', finalAnswer);
        yield { type: 'task-completed', status: 'succeeded', finalAnswer };
        return;
      }
    }

    // Max iterations reached
    completeTask(task.id, 'timeout', undefined, 'Max iterations exceeded');
    yield { type: 'error', message: 'Max iterations exceeded', code: 'MAX_ITERATIONS' };

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    completeTask(task.id, 'failed', undefined, message);
    yield { type: 'error', message, code: 'UNKNOWN_ERROR' };
  }
}

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Cleanup function to disconnect all servers
 */
export async function cleanup(): Promise<void> {
  await disconnectAllServers();
}

