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
  const registered = new Map(); const effects = []; let context; let activation;
  const agent = { session: {}, ctx: { get: name => name === 'fs' ? fs : undefined } };
  const ctx = {
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
  return { cwd, fs, ctx, agent, registered, effects, getContext: () => context, getActivation: () => activation };
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
  for (const dispose of f.effects.reverse()) dispose(); assert.equal(f.registered.size, 0); assert.equal(f.getContext(), undefined);
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

test('cancellation propagates instead of becoming discovery diagnostics', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.registered.get('run_workspace_agent').options.when({ agent: f.agent, signal: controller.signal }), /abort/i);
});
