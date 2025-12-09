# MCP Client MVP – Design Plan (Final Version)

## 1. MVP Definition

I want to build:

> A web app MCP client that:
> - Connects to your MCP servers  
> - Lets you run a "task" (chat with tools)  
> - Shows, for that task:
>   - List of tools used (per server)
>   - Time per tool call
>   - Tokens per tool call
>   - Real-time progress updates

Key constraint:

- The browser cannot spawn MCP servers or talk over stdio.
- Therefore, you need a **Node runtime** to act as the MCP host (spawning servers and maintaining sessions) and a **web UI** on top of it.

Resulting architecture:

- **Node MCP host + API**
- **React-based frontend** for visualization

---

## 2. Stack Decision: Next.js 

### Requirements

You need:

1. **Long-lived Node process** to:
   - Load MCP server configs.
   - Spawn stdio-based MCP servers or connect via HTTP/SSE.
   - Maintain MCP sessions with health checks and restart logic.
   - Run the LLM loop (LLM ↔ tools).
   - Record per-tool timings and token usage.

2. **API for the UI**:
   - `POST /api/tasks` to start a run.
   - `GET /api/tasks/:id` and `/api/tasks/:id/tool-calls` for querying results.
   - `POST /api/tasks/:id/cancel` to cancel running tasks.
   - `GET /api/tasks/:id/stream` for Server-Sent Events (SSE) live updates.

3. **React UI** to:
   - Start tasks.
   - Display tool usage, time, and tokens per tool in real-time.

### Next.js 

Use **Next.js (App Router)** to handle both frontend and backend:

- React components for the UI.
- Route handlers / API routes for MCP host logic.
- Single TypeScript codebase.

Pros:

- Unified project (TS end-to-end).
- Built-in routing and API handling.
- Native support for SSE via `ReadableStream` in route handlers.
- Easy to add auth, SSR, and streaming later.

**Deployment Requirements:**

- Deploy as a **long-lived Node app**, not serverless functions.
- MCP processes need to stay alive between requests.
- Recommended platforms:
  - Docker container on VPS
  - Railway.app, Render.com, or Fly.io
  - Next.js custom server with `next start`
- **Will NOT work** on Vercel/Netlify default deployments (serverless)

---

## 3. High-Level Architecture

### 3.1 Components

1. **MCP Host Core (Node / Next server side)**  
   Responsibilities:
   - Load MCP server configs (from `mcp-config.json` in project root).
   - Spawn/connect to MCP servers (stdio / HTTP).
   - Maintain MCP sessions with:
     - Health checks every 30s
     - Automatic restart on crash
     - Connection pooling for concurrent tasks
   - Implement the LLM loop:
     - Send user prompt + tool descriptions to the model.
     - Handle tool calls and feed results back.
     - Stop when final answer is produced or budget exceeded.
   - Safety limits:
     - Max 20 iterations per task
     - 5-minute timeout per task
     - 30-second timeout per tool call

2. **Tracer / Metrics Layer**
   - Wraps:
     - Every tool call.
     - Every model call.
   - Records:
     - `startTime`, `endTime`, `durationMs`.
     - `inputTokens`, `outputTokens` (from LLM provider usage).
     - `serverName`, `toolName`, `arguments`, `status`.
   - Token attribution:
     - Tracks tokens for the complete "round trip":
       - Model call that planned the tool use
       - Tool execution (no tokens)
       - Model call that processed tool result

3. **API Layer (Next.js Route Handlers)**
   - `POST /api/tasks`:
     - Starts a new task asynchronously.
     - Returns a `taskId` immediately.
     - Task runs in background.
   - `GET /api/tasks/:id`:
     - Returns task summary and status.
   - `GET /api/tasks/:id/tool-calls`:
     - Returns list of tool calls with metrics.
   - `GET /api/tasks/:id/stream`:
     - SSE endpoint for real-time progress updates.
     - Emits events: `tool-started`, `tool-completed`, `model-call`, `task-completed`.
   - `POST /api/tasks/:id/cancel`:
     - Cancels a running task gracefully.

4. **Persistence**
   - MVP: in-memory store (Maps keyed by `taskId`).
   - Data structure:
     - `tasks: Map<string, Task>`
     - `toolCalls: Map<string, ToolCall[]>` (keyed by `taskId`)
     - `modelCalls: Map<string, ModelCall[]>` (keyed by `taskId`)
   - Later: upgrade to SQLite/Postgres with Prisma.

5. **React UI (Next.js app)**
   - **Task Runner** page:
     - Create and run a task.
   - **Task Detail** page:
     - Show tool usage and metrics.
     - Real-time updates via SSE.

---

## 4. Domain Model

### 4.1 Entities

**Server**

- `id: string`
- `name: string`
- `config: ServerConfig`  
  ```typescript
  {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    transport: 'stdio' | 'sse';
  }
  ```
- `status: 'connected' | 'disconnected' | 'error'`
- `lastHealthCheck?: Date`

**Task**

- `id: string`
- `createdAt: Date`
- `status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout'`
- `model: string` (e.g. `claude-3-5-sonnet-20241022`)
- `servers: string[]` (server IDs enabled for this task)
- `userMessage: string`
- `finalAnswer?: string`
- `totalInputTokens: number`
- `totalOutputTokens: number`
- `totalCost?: number` (calculated from token pricing)
- `startedAt?: Date`
- `finishedAt?: Date`
- `durationMs?: number`
- `errorMessage?: string` (if failed)
- `iterationCount: number` (tracks LLM loop iterations)

**ToolCall**

- `id: string`
- `taskId: string`
- `serverName: string`
- `toolName: string`
- `arguments: string` (stringified JSON, truncated if > 1000 chars)
- `result?: string` (truncated if > 1000 chars)
- `status: 'pending' | 'running' | 'success' | 'error' | 'timeout'`
- `errorMessage?: string`
- `startedAt: Date`
- `finishedAt?: Date`
- `durationMs?: number`
- `sequenceNumber: number` (order within task)

**ModelCall**

- `id: string`
- `taskId: string`
- `type: 'initial' | 'tool-use' | 'tool-result' | 'final'`
- `inputTokens: number`
- `outputTokens: number`
- `durationMs: number`
- `createdAt: Date`
- `stopReason?: string` (from API response)

---

## 5. Flow for a Single Task

1. **User Request (UI)**  
   User fills in:
   - Initial message.
   - Model (dropdown with Claude 3.5 Sonnet, GPT-4, etc.).
   - Enabled MCP servers (multi-select).

2. **Task Creation (`POST /api/tasks`)**
   - Create a `Task` with `status = pending`.
   - Validate requested servers exist and are healthy.
   - If any server is down, attempt restart.
   - Return `taskId` immediately.
   - Queue task for execution (or start if no other tasks running).

3. **Task Execution (Background Process)**

   a. **Pre-flight checks:**
      - Ensure all requested servers are connected.
      - Set task `status = running`.
      - Emit SSE event: `task-started`.

   b. **LLM + MCP Loop:**
      - Initialize conversation with:
        - System prompt
        - User message
        - Tool descriptions from MCP `listTools`
      - Iteration loop (max 20 iterations):
        ```
        1. Call model with current conversation
           - Record ModelCall with tokens/duration
           - Emit SSE: `model-call-completed`
        
        2. If model returns tool calls:
           - For each tool call:
             a. Create ToolCall record (status=running)
             b. Emit SSE: `tool-started`
             c. Execute tool with 30s timeout
             d. Record result/error
             e. Update ToolCall (status=success/error/timeout)
             f. Emit SSE: `tool-completed`
           - Append tool results to conversation
           - Continue loop
        
        3. If model returns final answer:
           - Store as task.finalAnswer
           - Break loop
        
        4. If max iterations reached:
           - Set task.status = 'timeout'
           - Break loop
        ```

   c. **Error Handling:**
      - Tool execution error:
        - Record error in ToolCall
        - Continue loop (let model handle error)
      - Model API error:
        - Retry 3 times with exponential backoff
        - If still failing: set task.status = 'failed'
      - Server disconnected:
        - Attempt reconnect once
        - If fails: set task.status = 'failed'
      - Task timeout (5 minutes total):
        - Set task.status = 'timeout'
        - Cleanup and exit

4. **Task Completion**
   - Aggregate metrics:
     - Sum all `ModelCall.inputTokens` → `task.totalInputTokens`
     - Sum all `ModelCall.outputTokens` → `task.totalOutputTokens`
     - Calculate cost (tokens × model pricing)
     - Calculate total duration
   - Set `task.status` to `succeeded` / `failed` / `timeout`.
   - Set `task.finishedAt`.
   - Emit SSE: `task-completed`.
   - Close SSE connection.

5. **UI Consumption**
   - UI subscribes to `/api/tasks/:id/stream` on page load.
   - Receives real-time updates and updates local state.
   - Fallback: poll `/api/tasks/:id` every 2s if SSE not supported.

---

## 6. Concurrency Model

### MVP Approach: Single Task Queue

- **One task runs at a time** to avoid MCP server concurrency issues.
- When `POST /api/tasks` is called:
  - If no task is running: start immediately.
  - If a task is running: add to queue (in-memory array).
- Task runner processes queue FIFO.

**Why this approach for MVP:**
- Stdio-based MCP servers aren't designed for concurrent requests.
- Simplifies debugging and tracing.
- Sufficient for developer tool use case.

### Future: Concurrent Tasks (Phase 4+)

Options:
1. **One server instance per task:**
   - Spawn new MCP server processes for each task.
   - Heavy but isolated.
2. **Server pooling:**
   - Maintain pool of server instances.
   - Route requests to available instance.
3. **Server capability detection:**
   - Query MCP servers if they support concurrent requests.
   - Route accordingly.

---

## 7. Model Integration

### Phase 1: Anthropic Claude Only

**Why Claude:**
- Native MCP alignment (from the same team).
- Excellent tool use capabilities.
- Straightforward SDK.

**SDK:** `@anthropic-ai/sdk`

**Implementation:**
```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Tool use format matches MCP tool descriptions closely
const response = await client.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 4096,
  messages: [...],
  tools: mcpTools, // Direct mapping from MCP listTools
});
```

**Token tracking:**
- Available in `response.usage`:
  ```typescript
  {
    input_tokens: 1234,
    output_tokens: 567
  }
  ```

### Phase 4: Multi-Provider Support

Abstract with provider interface:
```typescript
interface LLMProvider {
  callModel(messages, tools): Promise<ModelResponse>;
  getUsage(): TokenUsage;
}

class AnthropicProvider implements LLMProvider { ... }
class OpenAIProvider implements LLMProvider { ... }
```

---

## 8. MCP Configuration Management

### Phase 1: Hard-coded Servers

```typescript
// lib/mcp-servers.ts
export const MCP_SERVERS = [
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
];
```

### Phase 2: Configuration File

Create `mcp-config.json` in project root:
```json
{
  "servers": [
    {
      "id": "filesystem",
      "name": "Filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "transport": "stdio"
    }
  ]
}
```

Load with validation:
```typescript
import { readFileSync } from 'fs';
import { z } from 'zod';

const ServerConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  transport: z.enum(['stdio', 'sse']),
});

export function loadServerConfig() {
  const raw = readFileSync('./mcp-config.json', 'utf-8');
  const parsed = JSON.parse(raw);
  return z.object({ servers: z.array(ServerConfigSchema) }).parse(parsed);
}
```

### Phase 4: UI Configuration

- Add `/servers` page for CRUD operations.
- Store in DB instead of file.
- Add validation and test connection buttons.

---

## 9. Error Handling Strategy

### Error Categories

1. **Server Connection Errors**
   - Spawn failure, crash, disconnect.
   - **Handling:** Auto-restart with exponential backoff (3 attempts). If fails, mark server as unavailable and fail task with clear error.

2. **Tool Execution Errors**
   - Tool not found, invalid arguments, execution timeout.
   - **Handling:** Record error in ToolCall, return error message to model, let model decide next step.

3. **Model API Errors**
   - Rate limit, auth failure, timeout.
   - **Handling:** Retry 3 times with backoff. If persistent, fail task with error message.

4. **Task Timeouts**
   - Iteration limit (20) or time limit (5 min) exceeded.
   - **Handling:** Set task status to `timeout`, store partial results, return best-effort answer if available.

### Circuit Breaker Pattern

For repeatedly failing tools:
```typescript
// Track failures per tool per task
if (toolFailureCount[toolName] >= 3) {
  return {
    status: 'error',
    message: 'Tool disabled due to repeated failures',
  };
}
```

### Health Checks

Background job runs every 30 seconds:
```typescript
setInterval(async () => {
  for (const server of mcpServers) {
    try {
      await server.listTools(); // Lightweight health check
      server.status = 'connected';
      server.lastHealthCheck = new Date();
    } catch (error) {
      server.status = 'error';
      // Attempt restart
      await restartServer(server);
    }
  }
}, 30000);
```

---

## 10. UI Design for MVP

### 10.1 Task Runner Screen

**Path:** `/`

**Layout:**

```
┌─────────────────────────────────────────┐
│  🔍 MCP Task Runner                     │
├─────────────────────────────────────────┤
│                                         │
│  Message                                │
│  ┌───────────────────────────────────┐ │
│  │ Analyze the files in /tmp and     │ │
│  │ summarize what you find...        │ │
│  │                                   │ │
│  └───────────────────────────────────┘ │
│                                         │
│  Model                                  │
│  ┌───────────────────────────────────┐ │
│  │ Claude 3.5 Sonnet          ▼      │ │
│  └───────────────────────────────────┘ │
│                                         │
│  MCP Servers                            │
│  ☑ Filesystem                           │
│  ☑ Brave Search                         │
│  ☐ GitHub                               │
│                                         │
│  [Run Task]                             │
│                                         │
└─────────────────────────────────────────┘
```

**Behavior:**

- On "Run Task":
  - `POST /api/tasks` with form data.
  - On success: redirect to `/tasks/:id`.
  - On error: show error toast.

### 10.2 Task Detail Screen

**Path:** `/tasks/:id`

**Header Section:**

```
┌──────────────────────────────────────────────┐
│  Task: abc123                 [Cancel Task]  │
│  Status: ● Running                           │
│  Model: claude-3-5-sonnet-20241022           │
│  Servers: Filesystem, Brave Search           │
│  Started: 2:34 PM                            │
│  Duration: 12.3s                             │
│  Tokens: 1,234 in / 567 out                  │
│  Cost: $0.012                                │
└──────────────────────────────────────────────┘
```

**Tool Calls Table:**

```
┌────┬────────────┬──────────────┬─────────┬──────────┬────────────┐
│ #  │ Server     │ Tool         │ Status  │ Duration │ Started At │
├────┼────────────┼──────────────┼─────────┼──────────┼────────────┤
│ 1  │ Filesystem │ read_file    │ ✓       │ 234ms    │ 2:34:01 PM │
│ 2  │ Filesystem │ list_dir     │ ✓       │ 156ms    │ 2:34:02 PM │
│ 3  │ Brave      │ search       │ ⏳      │ 1.2s...  │ 2:34:03 PM │
└────┴────────────┴──────────────┴─────────┴──────────┴────────────┘
```

**Expandable Row Detail:**

Click row to expand:
```
┌──────────────────────────────────────────────┐
│  Arguments:                                  │
│  { "path": "/tmp/data.json" }                │
│                                              │
│  Result:                                     │
│  { "content": "...", "size": 1024 }          │
│                                              │
│  Tokens: 45 in / 123 out                     │
└──────────────────────────────────────────────┘
```

**Aggregates Section:**

```
┌──────────────────────────────────────────────┐
│  Summary                                     │
├──────────────────────────────────────────────┤
│  Total Tool Calls: 15                        │
│  Average Duration: 287ms                     │
│  Success Rate: 93% (14/15)                   │
│                                              │
│  Top Tools by Time:                          │
│  1. brave_search: 3.4s (3 calls)             │
│  2. read_file: 1.2s (8 calls)                │
│  3. list_dir: 0.4s (4 calls)                 │
└──────────────────────────────────────────────┘
```

**Real-time Updates:**

- Connect to `/api/tasks/:id/stream` on mount.
- Update UI as SSE events arrive:
  - `tool-started`: Add row with spinner
  - `tool-completed`: Update row with result
  - `model-call`: Update token counts
  - `task-completed`: Show final answer, stop polling

**Final Answer Section:**

```
┌──────────────────────────────────────────────┐
│  Final Answer                                │
├──────────────────────────────────────────────┤
│  Based on my analysis of the files in /tmp,  │
│  I found 3 JSON files containing user data.  │
│  The total size is 45KB...                   │
└──────────────────────────────────────────────┘
```

---

## 11. Implementation Plan (Revised)

### Phase 1 – MCP Host Core (No UI)

**Timeline:** 2-3 days

**Tasks:**

1. Set up Node project with TypeScript.
2. Install dependencies:
   - `@modelcontextprotocol/sdk`
   - `@anthropic-ai/sdk`
3. Hard-code 2 MCP server configs (filesystem + brave-search).
4. Write `lib/mcpHost.ts`:
   - Function to spawn MCP servers.
   - Function to list tools from all servers.
   - Basic health check logic.
5. Write `lib/llmLoop.ts`:
   - Implement LLM + tools loop with Claude.
   - Add max iteration limit (20).
   - Add per-tool timeout (30s).
   - Add task timeout (5 min).
6. Write `lib/tracer.ts`:
   - Record tool calls with start/end times.
   - Record model calls with token usage.
7. Test with a sample prompt:
   - "List files in /tmp and search for Node.js on Brave"
   - Log all metrics to console.

**Success Criteria:**
- MCP servers spawn and connect successfully.
- LLM loop executes tools and returns final answer.
- All metrics (time, tokens) are logged accurately.
- Errors are caught and handled gracefully.

---

### Phase 2 – Integrate into Next.js

**Timeline:** 2-3 days

**Tasks:**

1. Create Next.js app:
   ```bash
   npx create-next-app@latest mcp-client --typescript --app --tailwind
   ```
2. Move Phase 1 code into `lib/` folder (server-side only).
3. Set up in-memory stores:
   ```typescript
   // lib/stores.ts
   export const tasks = new Map<string, Task>();
   export const toolCalls = new Map<string, ToolCall[]>();
   export const modelCalls = new Map<string, ModelCall[]>();
   ```
4. Implement API routes:
   - `app/api/tasks/route.ts`:
     - `POST`: Create task, start execution, return taskId.
   - `app/api/tasks/[id]/route.ts`:
     - `GET`: Return task details.
   - `app/api/tasks/[id]/tool-calls/route.ts`:
     - `GET`: Return all tool calls for task.
   - `app/api/tasks/[id]/cancel/route.ts`:
     - `POST`: Cancel running task.
   - `app/api/tasks/[id]/stream/route.ts`:
     - `GET`: SSE endpoint for real-time updates.
5. Implement task queue:
   - Single task runs at a time.
   - Queue stored in memory.
6. Add error handling to all routes.
7. Test with Postman/curl:
   - Create task, poll status, verify metrics.

**Success Criteria:**
- API endpoints work correctly.
- Tasks execute asynchronously.
- Metrics are stored and retrievable.
- SSE stream delivers real-time updates.

---

### Phase 3 – Build the UI

**Timeline:** 3-4 days

**Tasks:**

1. **Task Runner page (`app/page.tsx`):**
   - Form with textarea, model dropdown, server checkboxes.
   - Submit handler calls `POST /api/tasks`.
   - Redirect to `/tasks/:id` on success.
   - Error handling with toast notifications.

2. **Task Detail page (`app/tasks/[id]/page.tsx`):**
   - Fetch task data on mount.
   - Connect to SSE stream for live updates.
   - Display header with task metadata.
   - Display tool calls table with expandable rows.
   - Display aggregates section.
   - Display final answer when task completes.
   - Add "Cancel Task" button.

3. **Components:**
   - `TaskStatusBadge`: Color-coded status indicator.
   - `ToolCallRow`: Expandable table row for tool calls.
   - `MetricCard`: Display token/time/cost metrics.
   - `LoadingSpinner`: For pending states.

4. **Styling:**
   - Use Tailwind CSS for rapid development.
   - Responsive design (mobile-friendly).
   - Clean, developer-focused aesthetic.

5. **Testing:**
   - Test full flow: create task → view progress → see results.
   - Test error states: cancelled tasks, timeouts, failures.
   - Test multiple tasks in queue.

**Success Criteria:**
- UI is functional and intuitive.
- Real-time updates work smoothly.
- All metrics display correctly.
- Error states are handled gracefully.

---

### Phase 4 – Optional Hardening

**Timeline:** Ongoing

**Features to Add:**

1. **Persistent Storage:**
   - Replace in-memory stores with SQLite.
   - Use Prisma for ORM.
   - Schema matches domain model.
   - Add `/api/tasks` endpoint to list all tasks.

2. **Multi-Task Concurrency:**
   - Allow N concurrent tasks.
   - Implement server pooling or per-task server instances.
   - Add queue management UI.

3. **Server Configuration UI:**
   - `/servers` page to add/edit/delete servers.
   - Test connection button.
   - Validate configs before saving.

4. **Advanced Metrics:**
   - Cost tracking with model pricing table.
   - Server-level aggregates (avg latency, success rate).
   - Export traces to JSON/CSV.

5. **Authentication:**
   - Basic auth or API key to restrict access.
   - User management if multi-tenant.

6. **Observability Integration:**
   - Export traces to Langfuse/LangSmith.
   - Webhook notifications on task completion.

7. **Enhanced Error Handling:**
   - Retry policies per server.
   - Circuit breaker UI to disable failing tools.
   - Detailed error logs.

---

## 12. API Specification

### POST /api/tasks

**Request:**
```json
{
  "message": "List files in /tmp",
  "model": "claude-3-5-sonnet-20241022",
  "servers": ["filesystem", "brave-search"]
}
```

**Response:**
```json
{
  "taskId": "task_abc123",
  "status": "pending",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

---

### GET /api/tasks/:id

**Response:**
```json
{
  "id": "task_abc123",
  "status": "running",
  "model": "claude-3-5-sonnet-20241022",
  "servers": ["filesystem"],
  "userMessage": "List files in /tmp",
  "finalAnswer": null,
  "totalInputTokens": 1234,
  "totalOutputTokens": 567,
  "totalCost": 0.012,
  "startedAt": "2024-01-15T10:30:01Z",
  "finishedAt": null,
  "durationMs": null,
  "iterationCount": 3
}
```

---

### GET /api/tasks/:id/tool-calls

**Response:**
```json
{
  "toolCalls": [
    {
      "id": "tc_1",
      "taskId": "task_abc123",
      "serverName": "filesystem",
      "toolName": "list_dir",
      "arguments": "{\"path\":\"/tmp\"}",
      "result": "{\"files\":[...]}",
      "status": "success",
      "startedAt": "2024-01-15T10:30:02Z",
      "finishedAt": "2024-01-15T10:30:02.234Z",
      "durationMs": 234,
      "sequenceNumber": 1
    }
  ]
}
```

---

### GET /api/tasks/:id/stream

**Response:** Server-Sent Events stream

**Event Types:**

```
event: task-started
data: {"taskId": "task_abc123", "timestamp": "2024-01-15T10:30:01Z"}

event: model-call
data: {"inputTokens": 123, "outputTokens": 45, "durationMs": 1200}

event: tool-started
data: {"toolCallId": "tc_1", "serverName": "filesystem", "toolName": "list_dir"}

event: tool-completed
data: {"toolCallId": "tc_1", "status": "success", "durationMs": 234}

event: task-completed
data: {"status": "succeeded", "finalAnswer": "I found 3 files..."}

event: error
data: {"message": "Server disconnected", "code": "SERVER_ERROR"}
```

---

### POST /api/tasks/:id/cancel

**Response:**
```json
{
  "taskId": "task_abc123",
  "status": "cancelled",
  "message": "Task cancelled successfully"
}
```

---

## 13. Environment Variables

Create `.env.local`:

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Optional (for specific MCP servers)
BRAVE_API_KEY=...
GITHUB_TOKEN=...

# App Config
NODE_ENV=development
PORT=3000
MAX_CONCURRENT_TASKS=1
TASK_TIMEOUT_MS=300000
TOOL_TIMEOUT_MS=30000
MAX_ITERATIONS=20
```

---

## 14. Deployment Guide

### Local Development

```bash
npm install
npm run dev
# Visit http://localhost:3000
```

### Production Deployment

**Option 1: Docker**

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
```

```bash
docker build -t mcp-client .
docker run -p 3000:3000 --env-file .env.local mcp-client
```

**Option 2: VPS (Ubuntu)**

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and setup
git clone <repo>
cd mcp-client
npm ci --production
npm run build

# Run with PM2
npm install -g pm2
pm2 start npm --name "mcp-client" -- start
pm2 save
pm2 startup
```

**Option 3: Railway.app / Render.com**

- Connect GitHub repo.
- Set build command: `npm run build`
- Set start command: `npm start`
- Add environment variables in dashboard.
- Deploy.

---

## 15. Testing Strategy

### Unit Tests

- `lib/mcpHost.ts`: Server spawning, health checks.
- `lib/llmLoop.ts`: Loop logic, iteration limits, timeouts.
- `lib/tracer.ts`: Metric recording accuracy.

### Integration Tests

- API routes: Create task → retrieve results.
- SSE streaming: Verify event emission.
- Error handling: Simulate failures, verify recovery.

### End-to-End Tests

- Full task flow: UI → API → MCP → LLM → results.
- Use Playwright for browser automation.

### Manual Testing Checklist

- [ ] Create task with valid inputs.
- [ ] Create task with invalid server.
- [ ] Cancel running task.
- [ ] Task completes successfully.
- [ ] Task fails due to server error.
- [ ] Task times out after 5 minutes.
- [ ] Tool call times out after 30 seconds.
- [ ] Real-time updates display correctly.
- [ ] Metrics are accurate (tokens, time, cost).
- [ ] Multiple tasks queue correctly.

---

## 16. Strategic Positioning

Your MVP is focused on:

- **Visibility into MCP tool usage:**
  - Which tools are used for a given task.
  - How long each call takes.
  - How many tokens are consumed (with cost estimation).
  - Real-time progress tracking.

It acts as a **developer-focused MCP microscope**, not full observability:

- You're not replacing Langfuse or other LLM observability tools.
- You're providing a **local-first, MCP-specific client** for:
  - Debugging tool usage.
  - Profiling latency and identifying bottlenecks.
  - Understanding token cost across tools.
  - Rapid prototyping of MCP workflows.

### Differentiation

**vs. Claude Desktop / Cline:**
- They're production MCP clients with chat UX.
- You're a **development/debugging tool** with metrics focus.

**vs. Langfuse / LangSmith:**
- They're enterprise observability platforms (complex, multi-tenant).
- You're **local-first, simple, MCP-native**.

### Next Natural Extensions

After MVP, consider:

1. **Comparative Analysis:**
   - Run same prompt with different models.
   - Compare token usage, latency, accuracy.

2. **Server Benchmarking:**
   - Per-server metrics dashboard.
   - Average latency, success rates, error patterns.

3. **Prompt Templates:**
   - Save common prompts as templates.
   - Track performance over time.

4. **Cost Optimization:**
   - Suggest cheaper models for similar results.
   - Identify expensive tool calls.

5. **Export & Integration:**
   - Export traces to Langfuse/LangSmith.
   - Webhook notifications for CI/CD.

6. **Collaborative Features:**
   - Share task results with team.
   - Comment on tool calls.
   - Tag and organize tasks.

---

## 17. Risk Mitigation

### Risk 1: MCP Server Instability

**Mitigation:**
- Health checks every 30s.
- Auto-restart with backoff.
- Graceful degradation (continue task with remaining servers).

### Risk 2: Infinite LLM Loops

**Mitigation:**
- Hard limit: 20 iterations.
- Timeout: 5 minutes per task.
- Circuit breaker for repeatedly failing tools.

### Risk 3: Concurrent Task Complexity

**Mitigation:**
- MVP: Single task queue (simple, reliable).
- Clearly document limitation.
- Phase 4: Add concurrency with proper testing.

### Risk 4: Token Cost Runaway

**Mitigation:**
- Display running cost in real-time.
- Add per-task budget limit (optional setting).
- Alert if cost exceeds threshold.

### Risk 5: Deployment Complexity

**Mitigation:**
- Provide Docker image (easiest deployment).
- Document Railway/Render deployment (one-click).
- Clear warning about serverless incompatibility.

---

## 18. Success Metrics

After MVP launch, track:

1. **Functionality:**
   - % of tasks that complete successfully.
   - Average task duration.
   - Most used MCP servers/tools.

2. **Performance:**
   - API response times (p50, p95, p99).
   - SSE connection stability.
   - MCP server uptime.

3. **User Engagement:**
   - Tasks created per week.
   - Average tools per task.
   - Repeat usage rate.

4. **Developer Experience:**
   - Time to first successful task.
   - Clarity of error messages.
   - Documentation completeness.

---

## 19. Open Questions

- [ ] Should we support custom system prompts per task?
- [ ] How to handle very large tool results (MB+ of data)?
- [ ] Should we record full conversation history or just summaries?
- [ ] Do we need user authentication for MVP, or assume single-user?
- [ ] Should we support both Anthropic and OpenAI in Phase 1, or defer OpenAI to Phase 4?
- [ ] How to handle MCP servers that require interactive setup (OAuth, etc.)?

---

## 20. Conclusion

This plan provides a **realistic, phased approach** to building an MCP-native development tool with strong observability features.

**Key Strengths:**
- Clear scope and constraints.
- Solid technical foundation (Next.js + Anthropic + MCP SDK).
- Comprehensive error handling and safety limits.
- Real-time updates for better UX.
- Incremental delivery (validate core before building full UI).

**Next Steps:**
1. Set up project structure.
2. Implement Phase 1 (standalone MCP host).
3. Validate metrics and tracing accuracy.
4. Integrate into Next.js (Phase 2).
5. Build UI (Phase 3).
6. Iterate based on real usage.

This MVP positions you to deliver real value to MCP developers while maintaining a manageable scope. The phased approach lets you learn and adapt as you build.

