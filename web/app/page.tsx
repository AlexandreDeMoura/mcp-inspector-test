'use client';

import { useState } from 'react';

// Mock data - eventually this will come from the API
const AVAILABLE_SERVERS = [
  { id: 'filesystem', name: 'Filesystem' },
  { id: 'brave-search', name: 'Brave Search' },
  { id: 'notion-mcp', name: 'Notion MCP' },
];

export default function Home() {
  const [prompt, setPrompt] = useState('');
  const [selectedServers, setSelectedServers] = useState<string[]>(['filesystem']);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const toggleServer = (serverId: string) => {
    setSelectedServers(prev => 
      prev.includes(serverId) 
        ? prev.filter(id => id !== serverId)
        : [...prev, serverId]
    );
  };

  const handleRun = async () => {
    if (!prompt.trim()) return;
    
    setIsRunning(true);
    setLogs(prev => [...prev, `Starting task with prompt: "${prompt}"...`]);
    setLogs(prev => [...prev, `Selected servers: ${selectedServers.join(', ')}`]);
    
    // Simulate some activity for now
    setTimeout(() => {
      setLogs(prev => [...prev, 'Simulated: Connecting to servers...']);
      setTimeout(() => {
        setLogs(prev => [...prev, 'Simulated: Task completed successfully.']);
        setIsRunning(false);
      }, 1000);
    }, 500);
  };

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900 p-8 font-sans">
      <div className="max-w-4xl mx-auto space-y-8">
        
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">MCP Client Inspector</h1>
          <p className="text-gray-500">Test and inspect Model Context Protocol interactions</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Left Column: Configuration */}
          <div className="lg:col-span-1 space-y-6">
            
            {/* Server Selection */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
              <h2 className="text-lg font-semibold mb-4">Available Servers</h2>
              <div className="space-y-3">
                {AVAILABLE_SERVERS.map(server => (
                  <label key={server.id} className="flex items-center space-x-3 cursor-pointer hover:bg-gray-50 p-2 rounded-lg -mx-2 transition-colors">
                    <input 
                      type="checkbox" 
                      checked={selectedServers.includes(server.id)}
                      onChange={() => toggleServer(server.id)}
                      className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                    />
                    <span className="text-sm font-medium">{server.name}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Prompt Input */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
              <h2 className="text-lg font-semibold mb-4">Task</h2>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe your task here..."
                className="w-full h-32 p-3 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none bg-gray-50"
              />
              <button
                onClick={handleRun}
                disabled={isRunning || !prompt.trim()}
                className={`w-full mt-4 py-2.5 px-4 rounded-lg font-medium text-white transition-all
                  ${isRunning || !prompt.trim() 
                    ? 'bg-gray-300 cursor-not-allowed' 
                    : 'bg-blue-600 hover:bg-blue-700 shadow-sm active:transform active:scale-[0.98]'
                  }`}
              >
                {isRunning ? 'Running...' : 'Run Task'}
              </button>
            </div>
          </div>

          {/* Right Column: Output/Logs */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 h-[600px] flex flex-col">
              <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50 rounded-t-xl">
                <h2 className="font-semibold text-gray-700">Execution Log</h2>
                <button 
                  onClick={() => setLogs([])}
                  className="text-xs text-gray-500 hover:text-gray-700 hover:underline"
                >
                  Clear
                </button>
              </div>
              
              <div className="flex-1 p-4 overflow-y-auto font-mono text-sm space-y-2 bg-white">
                {logs.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-2">
                    <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                      <span className="text-xl">⚡️</span>
                    </div>
                    <p>Ready to run tasks</p>
                  </div>
                ) : (
                  logs.map((log, i) => (
                    <div key={i} className="wrap-break-word border-b border-gray-50 last:border-0 pb-1 last:pb-0">
                      <span className="text-gray-400 mr-2">[{new Date().toLocaleTimeString()}]</span>
                      <span className="text-gray-800">{log}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
          
        </div>
      </div>
    </main>
  );
}
