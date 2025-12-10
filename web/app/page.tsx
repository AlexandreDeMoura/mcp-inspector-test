'use client';

import { useState, useRef, useEffect } from 'react';

const AVAILABLE_SERVERS = [
  { id: 'filesystem', name: 'Filesystem' },
  { id: 'brave-search', name: 'Brave Search' },
  { id: 'notion-mcp', name: 'Notion MCP' },
];

interface LogEntry {
  id: number;
  timestamp: string;
  type: 'info' | 'success' | 'error' | 'tool' | 'model' | 'answer';
  message: string;
}

export default function Home() {
  const [prompt, setPrompt] = useState('');
  const [selectedServers, setSelectedServers] = useState<string[]>(['filesystem']);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [finalAnswer, setFinalAnswer] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(0);

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const addLog = (type: LogEntry['type'], message: string) => {
    const entry: LogEntry = {
      id: logIdRef.current++,
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
    };
    setLogs(prev => [...prev, entry]);
  };

  const toggleServer = (serverId: string) => {
    setSelectedServers(prev => 
      prev.includes(serverId) 
        ? prev.filter(id => id !== serverId)
        : [...prev, serverId]
    );
  };

  const handleRun = async () => {
    if (!prompt.trim() || selectedServers.length === 0) return;
    
    setIsRunning(true);
    setLogs([]);
    setFinalAnswer(null);
    logIdRef.current = 0;
    
    addLog('info', `Starting task with ${selectedServers.length} server(s)...`);
    
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
              case 'log':
                addLog('info', event.message);
                break;
              case 'task-started':
                addLog('info', `Task started: ${event.taskId}`);
                break;
              case 'model-call':
                addLog('model', `Model: ${event.inputTokens} in / ${event.outputTokens} out (${event.durationMs}ms)`);
                break;
              case 'tool-started':
                addLog('tool', `Calling ${event.toolName} on ${event.serverName}...`);
                break;
              case 'tool-completed':
                addLog(event.status === 'success' ? 'success' : 'error', 
                  `Tool ${event.status}: ${event.result?.slice(0, 200) || 'No result'}${event.result?.length > 200 ? '...' : ''}`);
                break;
              case 'task-completed':
                addLog('success', `Task completed: ${event.status}`);
                if (event.finalAnswer) {
                  setFinalAnswer(event.finalAnswer);
                  addLog('answer', 'Final answer received');
                }
                break;
              case 'error':
                addLog('error', event.message);
                break;
            }
          } catch (e) {
            console.error('Error parsing JSON line:', line, e);
          }
        }
      }
    } catch (error) {
      console.error('Error running task:', error);
      addLog('error', error instanceof Error ? error.message : String(error));
    } finally {
      setIsRunning(false);
    }
  };

  const getLogStyles = (type: LogEntry['type']) => {
    switch (type) {
      case 'success':
        return 'text-emerald-700 bg-emerald-50 border-emerald-200';
      case 'error':
        return 'text-red-700 bg-red-50 border-red-200';
      case 'tool':
        return 'text-violet-700 bg-violet-50 border-violet-200';
      case 'model':
        return 'text-amber-700 bg-amber-50 border-amber-200';
      case 'answer':
        return 'text-blue-700 bg-blue-50 border-blue-200';
      default:
        return 'text-gray-700 bg-gray-50 border-gray-200';
    }
  };

  const getLogIcon = (type: LogEntry['type']) => {
    switch (type) {
      case 'success': return '✓';
      case 'error': return '✕';
      case 'tool': return '⚙';
      case 'model': return '◆';
      case 'answer': return '★';
      default: return '•';
    }
  };

  return (
    <main className="min-h-screen bg-slate-900 text-slate-100 p-6 font-sans">
      <div className="max-w-6xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="text-center space-y-1 py-4">
          <h1 className="text-2xl font-bold tracking-tight text-white">MCP Inspector</h1>
          <p className="text-slate-400 text-sm">Test and debug Model Context Protocol interactions</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Left Column: Configuration */}
          <div className="lg:col-span-1 space-y-4">
            
            {/* Server Selection */}
            <div className="bg-slate-800 p-5 rounded-lg border border-slate-700">
              <h2 className="text-sm font-semibold mb-3 text-slate-300 uppercase tracking-wide">Servers</h2>
              <div className="space-y-2">
                {AVAILABLE_SERVERS.map(server => (
                  <label 
                    key={server.id} 
                    className={`flex items-center space-x-3 cursor-pointer p-2.5 rounded-md transition-all border
                      ${selectedServers.includes(server.id) 
                        ? 'bg-slate-700 border-slate-600' 
                        : 'bg-slate-800 border-slate-700 hover:bg-slate-750'
                      }`}
                  >
                    <input 
                      type="checkbox" 
                      checked={selectedServers.includes(server.id)}
                      onChange={() => toggleServer(server.id)}
                      className="w-4 h-4 rounded border-slate-500 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-800"
                    />
                    <span className="text-sm font-medium text-slate-200">{server.name}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Prompt Input */}
            <div className="bg-slate-800 p-5 rounded-lg border border-slate-700">
              <h2 className="text-sm font-semibold mb-3 text-slate-300 uppercase tracking-wide">Task</h2>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe your task here..."
                className="w-full h-28 p-3 text-sm border border-slate-600 rounded-md bg-slate-900 text-slate-100 placeholder-slate-500 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
              />
              <button
                onClick={handleRun}
                disabled={isRunning || !prompt.trim() || selectedServers.length === 0}
                className={`w-full mt-3 py-2.5 px-4 rounded-md font-medium text-sm transition-all
                  ${isRunning || !prompt.trim() || selectedServers.length === 0
                    ? 'bg-slate-700 text-slate-500 cursor-not-allowed' 
                    : 'bg-blue-600 text-white hover:bg-blue-500 active:scale-[0.98]'
                  }`}
              >
                {isRunning ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                    Running...
                  </span>
                ) : 'Run Task'}
              </button>
            </div>
          </div>

          {/* Right Column: Output */}
          <div className="lg:col-span-2 flex flex-col gap-4">
            
            {/* Execution Log */}
            <div className="bg-slate-800 rounded-lg border border-slate-700 flex-1 flex flex-col min-h-[400px]">
              <div className="p-3 border-b border-slate-700 flex justify-between items-center">
                <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">Execution Log</h2>
                <button 
                  onClick={() => { setLogs([]); setFinalAnswer(null); }}
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Clear
                </button>
              </div>
              
              <div 
                ref={logContainerRef}
                className="flex-1 p-3 overflow-y-auto font-mono text-xs space-y-1.5"
              >
                {logs.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-2">
                    <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center">
                      <span className="text-lg">⚡</span>
                    </div>
                    <p className="text-sm">Ready to run tasks</p>
                  </div>
                ) : (
                  logs.map((log) => (
                    <div 
                      key={log.id} 
                      className={`px-2.5 py-1.5 rounded border ${getLogStyles(log.type)}`}
                    >
                      <span className="opacity-60 mr-2">{log.timestamp}</span>
                      <span className="mr-2">{getLogIcon(log.type)}</span>
                      <span className="wrap-break-word">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Final Answer */}
            {finalAnswer && (
              <div className="bg-slate-800 rounded-lg border border-slate-700">
                <div className="p-3 border-b border-slate-700">
                  <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">Final Answer</h2>
                </div>
                <div className="p-4 text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">
                  {finalAnswer}
                </div>
              </div>
            )}
          </div>
          
        </div>
      </div>
    </main>
  );
}
