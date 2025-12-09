/**
 * LLM Loop Implementation
 * Orchestrates the conversation between the LLM and MCP tools
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ToolResultBlockParam, ToolUseBlock, ContentBlock } from '@anthropic-ai/sdk/resources/messages';
import type { Task, MCPToolWithServer, AppConfig, DEFAULT_CONFIG } from './types.js';
import {
  connectServers,
  disconnectAllServers,
  getToolsForServers,
  executeTool,
  findToolServer,
} from './mcpHost.js';
import {
  createTask,
  startTask,
  completeTask,
  incrementIteration,
  startToolCall,
  completeToolCall,
  recordModelCall,
  printTaskSummary,
} from './tracer.js';

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

export interface RunTaskResult {
  task: Task;
  success: boolean;
  error?: string;
}

/**
 * Run a complete task with the LLM loop
 */
export async function runTask(options: RunTaskOptions): Promise<RunTaskResult> {
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
  console.log(`\n[LLM Loop] Starting task: ${task.id}`);
  console.log(`[LLM Loop] User message: ${userMessage}`);
  console.log(`[LLM Loop] Model: ${model}`);
  console.log(`[LLM Loop] Servers: ${serverIds.join(', ')}`);

  // Set up task timeout
  const taskTimeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Task timeout exceeded')), taskTimeoutMs);
  });

  try {
    // Connect to servers
    console.log(`\n[LLM Loop] Connecting to MCP servers...`);
    const connected = await connectServers(serverIds);

    if (connected.length === 0) {
      throw new Error('No MCP servers could be connected');
    }

    console.log(`[LLM Loop] Connected to ${connected.length} servers`);

    // Get tools from connected servers
    const tools = getToolsForServers(serverIds);
    console.log(`[LLM Loop] Available tools: ${tools.map((t) => t.name).join(', ')}`);

    if (tools.length === 0) {
      throw new Error('No tools available from connected servers');
    }

    // Start task
    startTask(task.id);

    // Run the loop with timeout
    const loopPromise = runLLMLoop(task, tools, maxIterations, toolTimeoutMs);
    await Promise.race([loopPromise, taskTimeoutPromise]);

    // Complete task
    const finalTask = completeTask(
      task.id,
      task.status === 'running' ? 'succeeded' : task.status,
      task.finalAnswer
    );

    printTaskSummary(task.id);

    return {
      task: finalTask || task,
      success: finalTask?.status === 'succeeded',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n[LLM Loop] Task failed: ${message}`);

    const isTimeout = message.includes('timeout');
    const finalTask = completeTask(
      task.id,
      isTimeout ? 'timeout' : 'failed',
      undefined,
      message
    );

    printTaskSummary(task.id);

    return {
      task: finalTask || task,
      success: false,
      error: message,
    };
  }
}

/**
 * The main LLM loop that handles tool calling
 */
async function runLLMLoop(
  task: Task,
  tools: MCPToolWithServer[],
  maxIterations: number,
  toolTimeoutMs: number
): Promise<void> {
  const client = getAnthropicClient();
  const anthropicTools = convertToolsToAnthropic(tools);

  // Initialize conversation
  const messages: MessageParam[] = [
    {
      role: 'user',
      content: task.userMessage,
    },
  ];

  let iteration = 0;

  while (iteration < maxIterations) {
    iteration = incrementIteration(task.id);
    console.log(`\n[LLM Loop] Iteration ${iteration}/${maxIterations}`);

    // Call the model
    const startTime = Date.now();

    try {
      const response = await client.messages.create({
        model: task.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: anthropicTools,
        messages,
      });

      const durationMs = Date.now() - startTime;

      // Record model call
      const modelCallType = iteration === 1 ? 'initial' : 'tool-result';
      recordModelCall(
        task.id,
        modelCallType,
        response.usage.input_tokens,
        response.usage.output_tokens,
        durationMs,
        response.stop_reason || undefined
      );

      console.log(
        `[LLM Loop] Model response: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out (${durationMs}ms)`
      );
      console.log(`[LLM Loop] Stop reason: ${response.stop_reason}`);

      // Process response content
      const toolUses: ToolUseBlock[] = [];
      let textContent = '';

      for (const block of response.content) {
        if (block.type === 'text') {
          textContent += block.text;
          console.log(`[LLM Loop] Assistant: ${block.text.slice(0, 200)}${block.text.length > 200 ? '...' : ''}`);
        } else if (block.type === 'tool_use') {
          toolUses.push(block);
        }
      }

      // Check if we have tool calls to process
      if (toolUses.length > 0) {
        console.log(`[LLM Loop] Processing ${toolUses.length} tool call(s)...`);

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

          console.log(`\n[LLM Loop] Calling tool: ${toolName} (${serverName})`);
          console.log(`[LLM Loop] Arguments: ${JSON.stringify(toolArgs).slice(0, 200)}`);

          // Start tracking
          const toolCall = startToolCall(task.id, serverName, toolName, toolArgs);

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

          console.log(
            `[LLM Loop] Tool result (${isError ? 'error' : 'success'}): ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`
          );

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
        console.log(`\n[LLM Loop] Task completed with final answer`);
        task.finalAnswer = textContent;
        task.status = 'succeeded';
        return;
      }

      // Unexpected stop reason
      console.log(`[LLM Loop] Unexpected stop reason: ${response.stop_reason}`);
      if (textContent) {
        task.finalAnswer = textContent;
        task.status = 'succeeded';
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Check for rate limiting
      if (message.includes('rate') || message.includes('429')) {
        console.log(`[LLM Loop] Rate limited, waiting 5 seconds...`);
        await sleep(5000);
        iteration--; // Retry this iteration
        continue;
      }

      throw error;
    }
  }

  // Max iterations reached
  console.log(`\n[LLM Loop] Max iterations (${maxIterations}) reached`);
  task.status = 'timeout';
  task.errorMessage = `Max iterations (${maxIterations}) exceeded`;
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
  console.log('\n[LLM Loop] Cleaning up...');
  await disconnectAllServers();
}

