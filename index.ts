/**
 * MCP Client MVP - Phase 1 Entry Point
 * 
 * This is a standalone Node.js script that demonstrates the MCP Host Core:
 * - Connects to MCP servers (filesystem, brave-search)
 * - Runs an LLM loop with Claude
 * - Tracks tool calls and model calls with metrics
 * 
 * Usage:
 *   1. Set ANTHROPIC_API_KEY in .env or environment
 *   2. Run: npm run dev
 */

import 'dotenv/config';
import { runTask, cleanup } from './lib/llmLoop.js';
import { MCP_SERVERS } from './lib/mcp-servers.js';

// ============================================================================
// Configuration
// ============================================================================

// Default test prompts
const TEST_PROMPTS = [
  {
    name: 'Simple filesystem task',
    message: 'List all files in /tmp directory and tell me how many there are.',
    servers: ['filesystem'],
  },
  {
    name: 'Filesystem analysis',
    message: 'Look at the files in /tmp. If there are any text files, read the first one and summarize its contents.',
    servers: ['filesystem'],
  },
];

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('=' .repeat(60));
  console.log('MCP Client MVP - Phase 1 Test');
  console.log('=' .repeat(60));

  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\n❌ Error: ANTHROPIC_API_KEY environment variable is required');
    console.error('   Set it in .env file or export it in your shell');
    process.exit(1);
  }

  // Show available servers
  console.log('\n📦 Available MCP Servers:');
  for (const server of MCP_SERVERS) {
    console.log(`   - ${server.name} (${server.id})`);
  }

  // Get test prompt from args or use default
  const promptArg = process.argv[2];
  let testConfig = TEST_PROMPTS[0];

  if (promptArg) {
    // Custom prompt from command line
    testConfig = {
      name: 'Custom prompt',
      message: promptArg,
      servers: process.argv[3]?.split(',') || MCP_SERVERS.map(s => s.id),
    };
  }

  console.log(`\n🎯 Running test: ${testConfig.name}`);
  console.log(`   Message: ${testConfig.message}`);
  console.log(`   Servers: ${testConfig.servers.join(', ')}`);

  try {
    // Run the task
    const result = await runTask({
      userMessage: testConfig.message,
      serverIds: testConfig.servers,
      config: {
        maxIterations: 10,
        taskTimeoutMs: 120000, // 2 minutes for testing
        toolTimeoutMs: 30000,
      },
    });

    // Show result
    console.log('\n' + '=' .repeat(60));
    console.log('RESULT');
    console.log('=' .repeat(60));
    console.log(`Status: ${result.success ? '✅ Success' : '❌ Failed'}`);
    
    if (result.error) {
      console.log(`Error: ${result.error}`);
    }

    if (result.task.finalAnswer) {
      console.log('\nFinal Answer:');
      console.log('-'.repeat(40));
      console.log(result.task.finalAnswer);
    }

  } catch (error) {
    console.error('\n❌ Unexpected error:', error);
  } finally {
    // Cleanup
    await cleanup();
  }

  console.log('\n✅ Test completed');
}

// ============================================================================
// Interactive Mode (Future)
// ============================================================================

async function interactiveMode() {
  const readline = await import('readline');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n🔄 Interactive Mode');
  console.log('Type your message and press Enter. Type "exit" to quit.\n');

  const prompt = () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();
      
      if (trimmed.toLowerCase() === 'exit') {
        console.log('\nGoodbye!');
        await cleanup();
        rl.close();
        process.exit(0);
      }

      if (!trimmed) {
        prompt();
        return;
      }

      try {
        const result = await runTask({
          userMessage: trimmed,
          serverIds: ['filesystem'],
        });

        if (result.task.finalAnswer) {
          console.log(`\nAssistant: ${result.task.finalAnswer}\n`);
        }
      } catch (error) {
        console.error(`\nError: ${error}\n`);
      }

      prompt();
    });
  };

  prompt();
}

// ============================================================================
// Entry Point
// ============================================================================

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  console.log('\n\nReceived SIGINT, shutting down...');
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n\nReceived SIGTERM, shutting down...');
  await cleanup();
  process.exit(0);
});

// Run main or interactive based on args
const mode = process.argv.find(arg => arg === '--interactive' || arg === '-i');

if (mode) {
  interactiveMode().catch(console.error);
} else {
  main().catch(console.error);
}

