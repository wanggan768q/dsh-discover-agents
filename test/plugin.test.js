import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { apply } from '../index.js';
import { createWorkspaceIO } from '../filesystem.js';

function fixture() {
  const cwd = path.resolve('/workspace');
  const files = new Map([[path.join(cwd, '.claude/agents/reviewer.md'), '---\nname: reviewer\ndescription: Review code\n---\nCheck correctness.']]);
  const fs = {
    async resolve(input, opts = {}) { return { displayPath: path.resolve(opts.cwd || cwd, input), targetKey: input }; },
    contains(root, target) { const rel = path.relative(root.displayPath, target.displayPath); return !rel.startsWith('..') && !path.isAbsolute(rel); },
    async lstat(input) { return files.has(input) ? { type: 'file' } : { type: 'directory' }; },
    async stat(target) { if (files.has(target.displayPath)) return { type: 'file' }; if (target.displayPath.includes('.codex')) return undefined; return { type: 'directory' }; },
    async listDir(target) {
      if (target.displayPath === path.join(cwd, '.claude')) return [{ name: 'agents', type: 'directory' }];
      if (target.displayPath === path.join(cwd, '.claude/agents')) return [{ name: 'reviewer.md', type: 'file' }];
      return [];
    },
    async readBytes(target, signal, maxBytes) { signal?.throwIfAborted(); const value = files.get(target.displayPath); if (!value) throw new Error('not found'); const bytes = new TextEncoder().encode(value); if (bytes.length > maxBytes) throw new Error('FS_TOO_LARGE'); return bytes; },
  };
  const registered = new Map(); const commands = new Map(); const effects = []; let context; let activation;
  const followups = [];
  const agent = { session: {}, ctx: { get: name => name === 'fs' ? fs : undefined }, followup: message => followups.push(message) };
  const ctx = {
    plugin() {},
    commands: { register(command) { assert.match(command.name, /^[a-z][a-z0-9_-]*$/); assert.equal(commands.has(command.name), false); commands.set(command.name, command); return () => commands.delete(command.name); } },
    tools: { register(tool, options) { registered.set(tool.name, { tool, options }); return () => registered.delete(tool.name); }, get: name => registered.get(name)?.tool },
    workingDirectory: { get: () => cwd },
    subagents: {
      getProvider: () => ({ prepareContinuable() {}, inheritsParentContext: false, capabilities: { agentPreset: true, depthLimit: true } }),
      resolveMaxDepth: () => 1,
      async startActivation(spec) { activation = spec; return { name: 'review-check' }; },
    },
    systemPrompt: { context(value) { context = value; return () => { context = undefined; }; } },
    effect(fn) { const cleanup = fn(); effects.push(cleanup); return cleanup; },
  };
  apply(ctx);
  return { cwd, fs, ctx, agent, followups, registered, commands, effects, getContext: () => context, getActivation: () => activation };
}

test('discovers for the exact caller and exposes bounded role catalog', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  await f.registered.get('run_workspace_agent').options.when({ agent: f.agent, signal });
  assert.match(f.getContext().text({ agent: f.agent }), /claude:reviewer/);
  const result = await f.registered.get('list_workspace_agents').tool.execute({}, { agent: f.agent, signal });
  assert.equal(result.agents.length, 1); assert.equal(result.agents[0].instructions, undefined);
  const detail = await f.registered.get('list_workspace_agents').tool.execute({ id: 'claude:reviewer' }, { agent: f.agent, signal });
  assert.match(detail.agents[0].instructions, /Check correctness/);
});
test('delegates a fresh standard child with DSH depth and no imported model overrides', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  const result = await f.registered.get('run_workspace_agent').tool.execute({ id: 'claude:reviewer', prompt: 'Review the diff', description: 'Review', name: 'check' }, { agent: f.agent, signal });
  assert.equal(result.name, 'review-check'); const request = f.getActivation();
  assert.equal(request.parent, f.agent); assert.equal(request.agentPreset, 'standard'); assert.equal(request.maxDepth, 1); assert.equal(request.delivery, 'parent'); assert.equal(request.agentOptions, undefined);
  assert.match(request.prompt[0].text, /Check correctness/); assert.match(request.prompt[0].text, /Review the diff/);
});
test('invalid and absent roles never start a child; effects unregister everything', async () => {
  const f = fixture(); const run = f.registered.get('run_workspace_agent').tool; const exec = { agent: f.agent, signal: new AbortController().signal };
  await assert.rejects(run.execute({ id: 'claude:no', prompt: 'test', description: 'test' }, exec), /not found/);
  await assert.rejects(run.execute({ id: 'claude:reviewer', prompt: 'test', description: 'test', name: 'lead' }, exec), /Invalid/);
  assert.equal(f.getActivation(), undefined);
  for (const dispose of f.effects.reverse()) dispose(); assert.equal(f.registered.size, 0); assert.equal(f.commands.size, 0); assert.equal(f.getContext(), undefined);
});
test('filesystem rejects escaping paths, symlink ancestors and oversized reads', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  let io = await createWorkspaceIO(f.fs, f.cwd, signal);
  await assert.rejects(io.read('../outside'), /inside/);
  f.fs.lstat = async () => ({ type: 'symlink' });
  await assert.rejects(io.read('.claude/agents/reviewer.md'), /Symbolic/);
  f.fs.lstat = async () => ({ type: 'file' }); io = await createWorkspaceIO(f.fs, f.cwd, signal, 2);
  await assert.rejects(io.read('.claude/agents/reviewer.md'), /FS_TOO_LARGE/);
});
test('directory listing detects symlinks even when provider reports their target type', async () => {
  const f = fixture(); const original = f.fs.lstat;
  f.fs.listDir = async () => [{ name: 'linked', type: 'directory' }, { name: 'plain.md', type: 'file' }];
  f.fs.lstat = async input => input.endsWith('linked') ? { type: 'symlink' } : original(input);
  const io = await createWorkspaceIO(f.fs, f.cwd, new AbortController().signal);
  const entries = await io.list('.claude/agents');
  assert.equal(entries[0].isSymbolicLink, true); assert.equal(entries[0].isDirectory, false);
});

test('slash list scans without a model step and displays roles and diagnostics', async () => {
  const f = fixture(); const invocation = { agent: f.agent, rawInput: '', signal: new AbortController().signal };
  assert.deepEqual([...f.commands.keys()].sort(), ['workspace-agent', 'workspace-agents']);
  const command = f.commands.get('workspace-agents');
  const result = await command.handler(invocation);
  assert.equal(result.kind, 'success'); assert.match(result.text, /claude:reviewer/); assert.match(result.text, /Review code/); assert.match(result.text, /workspace-agent/);
  assert.equal(f.getActivation(), undefined);
  assert.equal((await command.handler({ ...invocation, rawInput: ' unexpected' })).kind, 'error');
  f.fs.readBytes = async () => new TextEncoder().encode('not a valid agent');
  const invalid = await command.handler(invocation);
  assert.match(invalid.text, /未发现/); assert.match(invalid.text, /警告/);
});
test('slash run shares fresh standard delegation and preserves multiline tasks', async () => {
  const f = fixture(); const command = f.commands.get('workspace-agent');
  const invocation = { agent: f.agent, rawInput: ' claude:reviewer Review diff\nCheck tests', signal: new AbortController().signal };
  const result = await command.handler(invocation);
  assert.equal(result.kind, 'success'); assert.match(result.text, /review-check/);
  assert.equal(f.getActivation().parent, f.agent); assert.equal(f.getActivation().agentPreset, 'standard');
  assert.match(f.getActivation().prompt[0].text, /Review diff\nCheck tests/);
  assert.equal(f.followups.length, 0);
});
test('only explicit --main queues role instructions and task on the receiving agent', async () => {
  const f = fixture(); const command = f.commands.get('workspace-agent');
  const result = await command.handler({ agent: f.agent, rawInput: ' --main claude:reviewer Review diff\nCheck tests', signal: new AbortController().signal });
  assert.equal(result.kind, 'success'); assert.match(result.text, /未创建子 agent/);
  assert.equal(f.getActivation(), undefined); assert.equal(f.followups.length, 1);
  const message = f.followups[0];
  assert.equal(message.role, 'user'); assert.deepEqual(message.source, { kind: 'user' }); assert.ok(message.id);
  assert.match(message.content[0].text, /Check correctness/); assert.match(message.content[0].text, /Review diff\nCheck tests/);
  assert.match(message.content[0].text, /不要把本次任务转交给子 agent/);
});
test('default dispatch never falls back to current agent on spawn failure or task prose', async () => {
  const f = fixture(); const command = f.commands.get('workspace-agent');
  f.ctx.subagents.startActivation = async () => { throw new Error('spawn unavailable'); };
  await assert.rejects(command.handler({ agent: f.agent, rawInput: ' claude:reviewer 让当前主agent执行', signal: new AbortController().signal }), /spawn unavailable/);
  assert.equal(f.followups.length, 0);
});
test('--main rejects missing tasks, missing roles, oversize and cancellation without delivery', async () => {
  const f = fixture(); const command = f.commands.get('workspace-agent'); const signal = new AbortController().signal;
  assert.equal((await command.handler({ agent: f.agent, rawInput: ' --main claude:reviewer', signal })).kind, 'error');
  await assert.rejects(command.handler({ agent: f.agent, rawInput: ' --main claude:no task', signal }), /not found/);
  await assert.rejects(command.handler({ agent: f.agent, rawInput: ' --main claude:reviewer ' + 'x'.repeat(65537), signal }), /too long/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(command.handler({ agent: f.agent, rawInput: ' --main claude:reviewer task', signal: controller.signal }), /abort/i);
  assert.equal(f.followups.length, 0); assert.equal(f.getActivation(), undefined);
});
test('slash run rejects missing tasks, unknown roles, excessive tasks and cancellation', async () => {
  const f = fixture(); const command = f.commands.get('workspace-agent');
  const invocation = { agent: f.agent, rawInput: ' claude:reviewer', signal: new AbortController().signal };
  assert.equal((await command.handler(invocation)).kind, 'error');
  await assert.rejects(command.handler({ ...invocation, rawInput: ' claude:no task' }), /not found/);
  await assert.rejects(command.handler({ ...invocation, rawInput: ' claude:reviewer ' + 'x'.repeat(65537) }), /too long/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(command.handler({ ...invocation, rawInput: ' claude:reviewer task', signal: controller.signal }), /abort/i);
  assert.equal(f.getActivation(), undefined);
});
test('slash discovery uses the receiving agent filesystem, not a shared catalog', async () => {
  const f = fixture(); const command = f.commands.get('workspace-agents'); const signal = new AbortController().signal;
  await command.handler({ agent: f.agent, rawInput: '', signal });
  const otherFs = { ...f.fs, listDir: async () => [] };
  const other = { session: {}, ctx: { get: name => name === 'fs' ? otherFs : undefined } };
  const result = await command.handler({ agent: other, rawInput: '', signal });
  assert.match(result.text, /未发现/); assert.doesNotMatch(result.text, /claude:reviewer/);
});

test('cancellation propagates instead of becoming discovery diagnostics', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.registered.get('run_workspace_agent').options.when({ agent: f.agent, signal: controller.signal }), /abort/i);
});
