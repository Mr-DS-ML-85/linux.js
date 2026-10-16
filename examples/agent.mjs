#!/usr/bin/env node

/**
 * linux.js — AI agent sandbox example.
 *
 * Shows the agent surface an LLM tool-call loop uses:
 *   - file tool definitions for OpenAI / Anthropic function calling
 *   - a dispatcher that executes the model's tool calls in the sandbox
 *   - workdir confinement (path traversal is refused)
 *
 * The "model" here is a scripted list of tool calls so the example runs
 * offline; swap it for your LLM client's tool_use blocks.
 *
 * Prerequisites:
 *   node scripts/build-lkl.mjs
 *   npm run build
 */

import Linux from '../dist/index.js';

async function main() {
  console.log('🐧 linux.js — AI agent sandbox example\n');

  const linux = await Linux.create({ memory: 128 });
  console.log(`✅ Kernel: ${linux.getKernelVersion()}\n`);

  const agent = linux.agent({ workdir: '/workspace', maxOutputBytes: 64 * 1024 });

  // 1. Hand these to the model in your `tools` array.
  const tools = agent.fileToolDefinitions();
  console.log('Tools offered to the model:', tools.map((t) => t.name).join(', '), '\n');

  // 2. Stage input data for the agent.
  await agent.putFile('data.csv', 'name,score\nalice,92\nbob,87\ncarol,95\n');

  // 3. Route each tool call the model makes through handleToolCall().
  const scriptedCalls = [
    { name: 'list_files', input: {} },
    { name: 'read_file', input: { path: 'data.csv' } },
    { name: 'write_file', input: { path: 'report/top.md', content: '# Top scorer\n\ncarol (95)\n' } },
    { name: 'list_files', input: { path: 'report' } },
    { name: 'read_file', input: { path: '../proc/version' } }, // refused: outside the workdir
  ];
  for (const call of scriptedCalls) {
    const result = await agent.handleToolCall(call.name, call.input);
    console.log(`▶ ${call.name}(${JSON.stringify(call.input)})`);
    for (const line of result.split('\n')) console.log(`    ${line}`);
  }

  // Shell tools are not available in this build (no guest userland).
  try {
    await agent.run('ls');
  } catch (err) {
    console.log(`\nagent.run → ${err.name}`);
  }

  await linux.shutdown();
  console.log('\n👋 Done.');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
