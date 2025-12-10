/**
 * LLM Loop Implementation
 * Orchestrates the conversation between the LLM and MCP tools
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ToolResultBlockParam, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import type { MCPToolWithServer, AppConfig, TaskEvent, CodeExecutionResult, SubToolCallResult } from './types';
import { isCodeExecutionResult } from './types';
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
 * Yields structured events for the canvas UI:
 * - llm-response: AI reasoning between tool calls (displayed as arrows)
 * - tool-call: Tool invocations (displayed as blocks)
 */
export async function* runTaskGenerator(options: RunTaskOptions): AsyncGenerator<TaskEvent, void, unknown> {
  const {
    userMessage,
    model = DEFAULT_MODEL,
    serverIds,
    config = {},
  } = options;

  const maxIterations = config.maxIterations ?? 20;
  const toolTimeoutMs = config.toolTimeoutMs ?? 30000;

  // Track totals for the task
  const taskStartTime = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Create task
  const task = createTask(userMessage, model, serverIds);
  yield { type: 'task-started', taskId: task.id, timestamp: new Date() };

  try {
    // Connect to servers
    const connected = await connectServers(serverIds);

    if (connected.length === 0) {
      throw new Error('No MCP servers could be connected');
    }

    // Get tools from connected servers
    const tools = getToolsForServers(serverIds);

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

      // Call the model
      const llmStartTime = Date.now();
      
      const response = await client.messages.create({
        model: task.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: anthropicTools,
        messages,
      });

      const llmDurationMs = Date.now() - llmStartTime;
      
      // Update totals
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      // Record model call for tracing
      recordModelCall(
        task.id,
        iteration === 1 ? 'initial' : 'tool-result',
        response.usage.input_tokens,
        response.usage.output_tokens,
        llmDurationMs,
        response.stop_reason || undefined
      );

      // Process response content
      const toolUses: ToolUseBlock[] = [];
      let textContent = '';

      for (const block of response.content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else if (block.type === 'tool_use') {
          toolUses.push(block);
        }
      }

      // Yield LLM response event (the AI reasoning)
      yield {
        type: 'llm-response',
        content: textContent,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        durationMs: llmDurationMs,
        hasToolCalls: toolUses.length > 0,
      };

      // Check if we have tool calls to process
      if (toolUses.length > 0) {
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

          // Start tracking
          const toolCall = startToolCall(task.id, serverName, toolName, toolArgs);
          
          // Yield tool-call event with running status
          yield {
            type: 'tool-call',
            toolCallId: toolCall.id,
            serverName,
            toolName,
            args: toolArgs,
            status: 'running',
          };

          // Execute tool
          const toolStartTime = Date.now();
          const { result, isError, parsedResult } = await executeTool(toolName, toolArgs, toolTimeoutMs);
          const toolDurationMs = Date.now() - toolStartTime;

          // Check if this is a structured code execution result with sub-tool calls
          if (parsedResult && isCodeExecutionResult(parsedResult)) {
            const codeExecResult = parsedResult as CodeExecutionResult;
            
            // Emit sub-tool call events for each internal operation
            for (const subToolCall of codeExecResult.toolCalls) {
              const subToolId = `${toolCall.id}-sub-${Math.random().toString(36).substr(2, 9)}`;
              
              // Emit running status for sub-tool
              yield {
                type: 'tool-call',
                toolCallId: subToolId,
                serverName,
                toolName: subToolCall.toolName,
                args: subToolCall.args,
                status: 'running',
                isSubToolCall: true,
                parentToolCallId: toolCall.id,
              };
              
              // Immediately emit completed status (since it already ran)
              yield {
                type: 'tool-call',
                toolCallId: subToolId,
                serverName,
                toolName: subToolCall.toolName,
                args: subToolCall.args,
                status: subToolCall.status,
                result: subToolCall.result,
                errorMessage: subToolCall.errorMessage,
                durationMs: subToolCall.durationMs,
                isSubToolCall: true,
                parentToolCallId: toolCall.id,
              };
            }

            // Complete tracking for parent tool
            completeToolCall(
              toolCall.id,
              task.id,
              isError ? 'error' : 'success',
              codeExecResult.finalResult,
              isError ? result : undefined
            );

            // Yield parent tool-call event with completed status
            yield {
              type: 'tool-call',
              toolCallId: toolCall.id,
              serverName,
              toolName,
              args: toolArgs,
              status: isError ? 'error' : 'success',
              result: codeExecResult.finalResult,
              errorMessage: isError ? result : undefined,
              durationMs: toolDurationMs,
            };

            // Use the final result for the conversation
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: codeExecResult.finalResult,
              is_error: isError,
            });
          } else {
            // Standard tool call - no sub-tool calls
            
            // Complete tracking
            completeToolCall(
              toolCall.id,
              task.id,
              isError ? 'error' : 'success',
              result,
              isError ? result : undefined
            );

            // Yield tool-call event with completed status
            yield {
              type: 'tool-call',
              toolCallId: toolCall.id,
              serverName,
              toolName,
              args: toolArgs,
              status: isError ? 'error' : 'success',
              result,
              errorMessage: isError ? result : undefined,
              durationMs: toolDurationMs,
            };

            // Add to results
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result,
              is_error: isError,
            });
          }
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
        const totalDurationMs = Date.now() - taskStartTime;
        completeTask(task.id, 'succeeded', finalAnswer);
        yield { 
          type: 'task-completed', 
          status: 'succeeded', 
          finalAnswer,
          totalDurationMs,
          totalInputTokens,
          totalOutputTokens,
        };
        return;
      }
    }

    // Max iterations reached
    const totalDurationMs = Date.now() - taskStartTime;
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

