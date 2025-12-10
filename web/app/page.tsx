'use client';

import { useState, useRef, useEffect } from 'react';

const AVAILABLE_SERVERS = [
  { id: 'filesystem', name: 'Filesystem' },
  { id: 'brave-search', name: 'Brave Search' },
  { id: 'notion-mcp', name: 'Notion MCP' },
  { id: 'notion-mcp-code-execution', name: 'Notion MCP Code Execution' },
];

// ============================================================================
// Types for the Canvas UI
// ============================================================================

interface LLMResponseBlock {
  type: 'llm-response';
  id: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  hasToolCalls: boolean;
}

interface ToolCallBlock {
  type: 'tool-call';
  id: string;
  toolCallId: string;
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  result?: string;
  errorMessage?: string;
  durationMs?: number;
  /** If true, this is a sub-tool call from a code-execution server */
  isSubToolCall?: boolean;
  /** Parent tool call ID if this is a sub-tool call */
  parentToolCallId?: string;
}

interface TaskSummary {
  status: 'succeeded' | 'failed' | 'timeout';
  finalAnswer?: string;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

type CanvasBlock = LLMResponseBlock | ToolCallBlock;

// ============================================================================
// Component: LLM Response Arrow
// ============================================================================

function LLMResponseArrow({ block, isExpanded, onToggle }: { 
  block: LLMResponseBlock; 
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const durationSec = (block.durationMs / 1000).toFixed(1);
  const totalTokens = block.inputTokens + block.outputTokens;
  
  return (
    <div className="flex flex-col items-center">
      {/* Vertical connector line */}
      <div className="w-0.5 h-4 bg-linear-to-b from-cyan-500/40 to-cyan-500" />
      
      {/* Arrow/reasoning block */}
      <div 
        className="relative bg-linear-to-r from-cyan-950/80 to-slate-900 border border-cyan-700/50 rounded-lg px-4 py-3 max-w-2xl cursor-pointer hover:border-cyan-500/70 transition-all group"
        onClick={onToggle}
      >
        {/* Decorative side arrow */}
        <div className="absolute -left-2 top-1/2 -translate-y-1/2 w-0 h-0 border-t-[6px] border-t-transparent border-r-8 border-r-cyan-700/50 border-b-[6px] border-b-transparent" />
        
        {/* Header with metrics */}
        <div className="flex items-center gap-3 text-xs text-cyan-400/80 mb-1">
          <span className="font-mono flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {durationSec}s
          </span>
          <span className="font-mono flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
            {totalTokens.toLocaleString()} tokens
          </span>
          <span className="ml-auto text-cyan-500/60 group-hover:text-cyan-400 transition-colors">
            {isExpanded ? '▼' : '▶'} details
          </span>
        </div>
        
        {/* Content preview or full */}
        <div className={`text-sm text-slate-300 leading-relaxed ${!isExpanded ? 'line-clamp-2' : ''}`}>
          {block.content || <span className="text-slate-500 italic">Planning next action...</span>}
        </div>
        
        {/* Expanded details */}
        {isExpanded && block.content && (
          <div className="mt-3 pt-3 border-t border-cyan-800/30 grid grid-cols-2 gap-2 text-xs">
            <div className="text-slate-500">Input tokens: <span className="text-cyan-400">{block.inputTokens.toLocaleString()}</span></div>
            <div className="text-slate-500">Output tokens: <span className="text-cyan-400">{block.outputTokens.toLocaleString()}</span></div>
          </div>
        )}
      </div>
      
      {/* Vertical connector line (if there are tool calls) */}
      {block.hasToolCalls && (
        <div className="w-0.5 h-4 bg-linear-to-b from-cyan-500 to-cyan-500/40" />
      )}
    </div>
  );
}

// ============================================================================
// Component: Tool Call Block
// ============================================================================

function ToolCallBlockComponent({ block, isExpanded, onToggle }: { 
  block: ToolCallBlock; 
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const isRunning = block.status === 'running';
  const isError = block.status === 'error';
  const isSubTool = block.isSubToolCall;
  const durationSec = block.durationMs ? (block.durationMs / 1000).toFixed(2) : '...';
  
  // Different styles for sub-tool calls
  const statusStyles = isSubTool ? {
    running: 'border-orange-400/50 bg-linear-to-br from-orange-950/40 to-slate-900/80 border-dashed',
    success: 'border-teal-400/50 bg-linear-to-br from-teal-950/40 to-slate-900/80 border-dashed',
    error: 'border-rose-400/50 bg-linear-to-br from-rose-950/40 to-slate-900/80 border-dashed',
  } : {
    running: 'border-amber-500/60 bg-linear-to-br from-amber-950/60 to-slate-900',
    success: 'border-emerald-500/60 bg-linear-to-br from-emerald-950/60 to-slate-900',
    error: 'border-red-500/60 bg-linear-to-br from-red-950/60 to-slate-900',
  };
  
  const statusColors = isSubTool ? {
    running: 'text-orange-300',
    success: 'text-teal-300',
    error: 'text-rose-300',
  } : {
    running: 'text-amber-400',
    success: 'text-emerald-400',
    error: 'text-red-400',
  };

  return (
    <div className={`flex flex-col items-center ${isSubTool ? 'ml-8' : ''}`}>
      {/* Sub-tool indicator line */}
      {isSubTool && (
        <div className="flex items-center self-start -ml-8 mb-1">
          <div className="w-6 h-0.5 bg-slate-600/50" />
          <div className="w-2 h-2 rounded-full bg-slate-600/50" />
        </div>
      )}
      
      {/* Tool block */}
      <div 
        className={`relative border-2 rounded-xl px-5 py-4 w-full cursor-pointer transition-all hover:scale-[1.01] ${statusStyles[block.status]} ${isSubTool ? 'max-w-xl' : 'max-w-2xl'}`}
        onClick={onToggle}
      >
        {/* Running indicator */}
        {isRunning && (
          <div className="absolute -top-1 -right-1 w-3 h-3">
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${isSubTool ? 'bg-orange-400' : 'bg-amber-400'} opacity-75`} />
            <span className={`relative inline-flex rounded-full h-3 w-3 ${isSubTool ? 'bg-orange-500' : 'bg-amber-500'}`} />
          </div>
        )}
        
        {/* Sub-tool badge */}
        {isSubTool && (
          <div className="absolute -top-2 -left-2 px-2 py-0.5 bg-slate-800 border border-slate-600/50 rounded text-[10px] text-slate-400 font-medium uppercase tracking-wider">
            sub-call
          </div>
        )}
        
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className={`p-1.5 rounded-lg ${isError ? (isSubTool ? 'bg-rose-500/20' : 'bg-red-500/20') : isRunning ? (isSubTool ? 'bg-orange-500/20' : 'bg-amber-500/20') : (isSubTool ? 'bg-teal-500/20' : 'bg-emerald-500/20')}`}>
              {isSubTool ? (
                <svg className={`w-4 h-4 ${statusColors[block.status]}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              ) : (
                <svg className={`w-4 h-4 ${statusColors[block.status]}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              )}
            </div>
            <div>
              <div className={`font-semibold ${isSubTool ? 'text-slate-200' : 'text-white'}`}>{block.toolName}</div>
              <div className="text-xs text-slate-400">{block.serverName}</div>
            </div>
          </div>
          
          <div className="flex items-center gap-3 text-xs">
            <span className={`font-mono ${statusColors[block.status]}`}>
              {isRunning ? (
                <span className="flex items-center gap-1">
                  <span className={`w-2 h-2 ${isSubTool ? 'bg-orange-500' : 'bg-amber-500'} rounded-full animate-pulse`} />
                  running
                </span>
              ) : (
                `${durationSec}s`
              )}
            </span>
            <span className="text-slate-500">
              {isExpanded ? '▼' : '▶'}
            </span>
          </div>
        </div>
        
        {/* Arguments preview */}
        <div className="text-xs text-slate-400 font-mono bg-slate-900/50 rounded-lg p-2 overflow-hidden">
          <div className={!isExpanded ? 'line-clamp-1' : ''}>
            {JSON.stringify(block.args, null, isExpanded ? 2 : 0)}
          </div>
        </div>
        
        {/* Expanded: Result */}
        {isExpanded && block.result && (
          <div className="mt-3 pt-3 border-t border-slate-700/50">
            <div className="text-xs text-slate-500 mb-1">Result:</div>
            <div className={`text-xs font-mono p-2 rounded-lg max-h-48 overflow-auto ${isError ? (isSubTool ? 'bg-rose-950/30 text-rose-300' : 'bg-red-950/30 text-red-300') : 'bg-slate-900/50 text-slate-300'}`}>
              <pre className="whitespace-pre-wrap">{block.result}</pre>
            </div>
          </div>
        )}
      </div>
      
      {/* Connector to next element */}
      <div className={`w-0.5 h-4 bg-linear-to-b from-slate-600 to-slate-600/40 ${isSubTool ? '-ml-8' : ''}`} />
    </div>
  );
}

// ============================================================================
// Component: User Request Block
// ============================================================================

function UserRequestBlock({ prompt }: { prompt: string }) {
  return (
    <div className="flex flex-col items-center">
      <div className="bg-linear-to-r from-violet-950/80 to-slate-900 border border-violet-500/50 rounded-xl px-5 py-4 max-w-2xl w-full">
        <div className="flex items-center gap-2 mb-2">
          <div className="p-1.5 rounded-lg bg-violet-500/20">
            <svg className="w-4 h-4 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-violet-300">User Request</span>
        </div>
        <div className="text-sm text-slate-200">{prompt}</div>
      </div>
      <div className="w-0.5 h-4 bg-linear-to-b from-violet-500 to-violet-500/40" />
    </div>
  );
}

// ============================================================================
// Component: Task Summary Block
// ============================================================================

function TaskSummaryBlock({ summary }: { summary: TaskSummary }) {
  const durationSec = (summary.totalDurationMs / 1000).toFixed(1);
  const isSuccess = summary.status === 'succeeded';
  
  return (
    <div className="flex flex-col items-center">
      {/* Top connector line from previous element */}
      <div className={`w-0.5 h-4 bg-linear-to-b ${isSuccess ? 'from-cyan-500/40 to-emerald-500' : 'from-cyan-500/40 to-red-500'}`} />
      
      <div className={`border-2 rounded-xl px-5 py-4 max-w-2xl w-full ${
        isSuccess 
          ? 'bg-linear-to-br from-emerald-950/60 to-slate-900 border-emerald-500/60' 
          : 'bg-linear-to-br from-red-950/60 to-slate-900 border-red-500/60'
      }`}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className={`p-1.5 rounded-lg ${isSuccess ? 'bg-emerald-500/20' : 'bg-red-500/20'}`}>
              {isSuccess ? (
                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
            </div>
            <span className={`font-semibold ${isSuccess ? 'text-emerald-300' : 'text-red-300'}`}>
              Task {isSuccess ? 'Completed' : 'Failed'}
            </span>
          </div>
          
          <div className="flex gap-4 text-xs">
            <span className="text-slate-400 font-mono">{durationSec}s total</span>
            <span className="text-slate-400 font-mono">{(summary.totalInputTokens + summary.totalOutputTokens).toLocaleString()} tokens</span>
          </div>
        </div>
        
        {summary.finalAnswer && (
          <div className="text-sm text-slate-200 bg-slate-900/40 rounded-lg p-3 whitespace-pre-wrap leading-relaxed">
            {summary.finalAnswer}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function Home() {
  const [prompt, setPrompt] = useState('');
  const [selectedServers, setSelectedServers] = useState<string[]>(['filesystem']);
  const [isRunning, setIsRunning] = useState(false);
  const [blocks, setBlocks] = useState<CanvasBlock[]>([]);
  const [taskSummary, setTaskSummary] = useState<TaskSummary | null>(null);
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());
  const [currentPrompt, setCurrentPrompt] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const blockIdRef = useRef(0);

  // Auto-scroll to bottom when blocks update
  useEffect(() => {
    if (canvasRef.current) {
      canvasRef.current.scrollTop = canvasRef.current.scrollHeight;
    }
  }, [blocks, taskSummary]);

  const toggleServer = (serverId: string) => {
    setSelectedServers(prev => 
      prev.includes(serverId) 
        ? prev.filter(id => id !== serverId)
        : [...prev, serverId]
    );
  };

  const toggleBlockExpanded = (id: string) => {
    setExpandedBlocks(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleRun = async () => {
    if (!prompt.trim() || selectedServers.length === 0) return;
    
    setIsRunning(true);
    setBlocks([]);
    setTaskSummary(null);
    setExpandedBlocks(new Set());
    setCurrentPrompt(prompt);
    setError(null);
    blockIdRef.current = 0;
    
    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          serverIds: selectedServers,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No reader available');

      const decoder = new TextDecoder();
      let buffer = '';

      // Map to track running tool calls
      const runningToolCalls = new Map<string, string>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const event = JSON.parse(line);

            switch (event.type) {
              case 'llm-response': {
                const id = `llm-${blockIdRef.current++}`;
                setBlocks(prev => [...prev, {
                  type: 'llm-response',
                  id,
                  content: event.content,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  durationMs: event.durationMs,
                  hasToolCalls: event.hasToolCalls,
                }]);
                break;
              }
              
              case 'tool-call': {
                if (event.status === 'running') {
                  // New tool call starting
                  const id = `tool-${blockIdRef.current++}`;
                  runningToolCalls.set(event.toolCallId, id);
                  setBlocks(prev => [...prev, {
                    type: 'tool-call',
                    id,
                    toolCallId: event.toolCallId,
                    serverName: event.serverName,
                    toolName: event.toolName,
                    args: event.args,
                    status: 'running',
                    isSubToolCall: event.isSubToolCall,
                    parentToolCallId: event.parentToolCallId,
                  }]);
                } else {
                  // Tool call completed - update existing block
                  const blockId = runningToolCalls.get(event.toolCallId);
                  if (blockId) {
                    setBlocks(prev => prev.map(block => 
                      block.type === 'tool-call' && block.id === blockId
                        ? {
                            ...block,
                            status: event.status,
                            result: event.result,
                            errorMessage: event.errorMessage,
                            durationMs: event.durationMs,
                          }
                        : block
                    ));
                    runningToolCalls.delete(event.toolCallId);
                  }
                }
                break;
              }
              
              case 'task-completed': {
                setTaskSummary({
                  status: event.status,
                  finalAnswer: event.finalAnswer,
                  totalDurationMs: event.totalDurationMs,
                  totalInputTokens: event.totalInputTokens,
                  totalOutputTokens: event.totalOutputTokens,
                });
                break;
              }
              
              case 'error': {
                setError(event.message);
                break;
              }
            }
          } catch (e) {
            console.error('Error parsing JSON line:', line, e);
          }
        }
      }
    } catch (err) {
      console.error('Error running task:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

  const clearCanvas = () => {
    setBlocks([]);
    setTaskSummary(null);
    setCurrentPrompt('');
    setError(null);
  };

  return (
    <main className="min-h-screen bg-[#0a0f1a] text-slate-100 font-['IBM_Plex_Sans',system-ui,sans-serif]">
      {/* Background pattern */}
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top,var(--tw-gradient-stops))] from-cyan-950/20 via-slate-950 to-slate-950 pointer-events-none" />
      <div className="fixed inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxjaXJjbGUgZmlsbD0iIzBmMTcyYSIgY3g9IjEiIGN5PSIxIiByPSIxIi8+PC9nPjwvc3ZnPg==')] opacity-40 pointer-events-none" />
      
      <div className="relative z-10 flex h-screen">
        
        {/* Sidebar */}
        <aside className="w-80 shrink-0 border-r border-slate-800/80 bg-slate-900/50 backdrop-blur-sm p-5 flex flex-col">
          
          {/* Logo */}
          <div className="mb-6">
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-linear-to-br from-cyan-500 to-violet-600 flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              MCP Inspector
            </h1>
            <p className="text-slate-500 text-xs mt-1">Debug Model Context Protocol flows</p>
          </div>
          
          {/* Server Selection */}
          <div className="mb-5">
            <h2 className="text-[10px] font-semibold mb-2 text-slate-500 uppercase tracking-widest">Servers</h2>
            <div className="space-y-1.5">
              {AVAILABLE_SERVERS.map(server => (
                <label 
                  key={server.id} 
                  className={`flex items-center gap-3 cursor-pointer p-2.5 rounded-lg transition-all border
                    ${selectedServers.includes(server.id) 
                      ? 'bg-slate-800/80 border-slate-600/50' 
                      : 'bg-transparent border-transparent hover:bg-slate-800/40'
                    }`}
                >
                  <input 
                    type="checkbox" 
                    checked={selectedServers.includes(server.id)}
                    onChange={() => toggleServer(server.id)}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-900 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-0"
                  />
                  <span className="text-sm text-slate-300">{server.name}</span>
                </label>
              ))}
            </div>
          </div>
          
          {/* Prompt Input */}
          <div className="flex-1 flex flex-col">
            <h2 className="text-[10px] font-semibold mb-2 text-slate-500 uppercase tracking-widest">Task</h2>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what you want to accomplish..."
              className="flex-1 min-h-[120px] p-3 text-sm border border-slate-700/50 rounded-lg bg-slate-900/50 text-slate-100 placeholder-slate-600 focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 outline-none resize-none"
            />
            <button
              onClick={handleRun}
              disabled={isRunning || !prompt.trim() || selectedServers.length === 0}
              className={`mt-3 py-2.5 px-4 rounded-lg font-medium text-sm transition-all
                ${isRunning || !prompt.trim() || selectedServers.length === 0
                  ? 'bg-slate-800 text-slate-600 cursor-not-allowed' 
                  : 'bg-linear-to-r from-cyan-600 to-violet-600 text-white hover:from-cyan-500 hover:to-violet-500 active:scale-[0.98] shadow-lg shadow-cyan-500/20'
                }`}
            >
              {isRunning ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Running...
                </span>
              ) : 'Run Task'}
            </button>
          </div>
        </aside>
        
        {/* Main Canvas Area */}
        <main className="flex-1 flex flex-col overflow-hidden">
          
          {/* Canvas Header */}
          <header className="shrink-0 border-b border-slate-800/80 bg-slate-900/30 backdrop-blur-sm px-6 py-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Execution Flow</h2>
            <button 
              onClick={clearCanvas}
              disabled={blocks.length === 0 && !taskSummary}
              className="text-xs text-slate-600 hover:text-slate-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Clear
            </button>
          </header>
          
          {/* Canvas Content */}
          <div 
            ref={canvasRef}
            className="flex-1 overflow-y-auto p-6"
          >
            {blocks.length === 0 && !currentPrompt ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-600">
                <div className="w-16 h-16 rounded-2xl bg-slate-800/50 flex items-center justify-center mb-4">
                  <svg className="w-8 h-8 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <p className="text-sm">Run a task to see the execution flow</p>
                <p className="text-xs text-slate-700 mt-1">AI reasoning and tool calls will appear here</p>
              </div>
            ) : (
              <div className="flex flex-col items-center space-y-0 pb-8">
                {/* User request */}
                {currentPrompt && <UserRequestBlock prompt={currentPrompt} />}
                
                {/* Blocks */}
                {blocks.map(block => {
                  if (block.type === 'llm-response') {
                    return (
                      <LLMResponseArrow 
                        key={block.id} 
                        block={block} 
                        isExpanded={expandedBlocks.has(block.id)}
                        onToggle={() => toggleBlockExpanded(block.id)}
                      />
                    );
                  } else {
                    return (
                      <ToolCallBlockComponent 
                        key={block.id} 
                        block={block}
                        isExpanded={expandedBlocks.has(block.id)}
                        onToggle={() => toggleBlockExpanded(block.id)}
                      />
                    );
                  }
                })}
                
                {/* Task Summary */}
                {taskSummary && <TaskSummaryBlock summary={taskSummary} />}
                
                {/* Error */}
                {error && !taskSummary && (
                  <div className="bg-red-950/40 border border-red-500/50 rounded-xl px-5 py-4 max-w-2xl w-full">
                    <div className="flex items-center gap-2 text-red-400">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span className="font-medium">Error</span>
                    </div>
                    <p className="text-sm text-red-300 mt-2">{error}</p>
                  </div>
                )}
                
                {/* Running indicator */}
                {isRunning && (
                  <div className="flex flex-col items-center">
                    <div className="w-0.5 h-4 bg-slate-700" />
                    <div className="flex items-center gap-2 text-slate-500 text-sm py-2">
                      <span className="w-2 h-2 bg-cyan-500 rounded-full animate-pulse" />
                      Processing...
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      </div>
    </main>
  );
}
