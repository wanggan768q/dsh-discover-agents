import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWorkspaceIO } from '../filesystem.js';
import { discoverAgents } from '../discovery.js';

const cwd = path.resolve('/review-workspace');
const signal = () => new AbortController().signal;
function memoryFs(contents = {}) {
  const files = new Map(Object.entries(contents).map(([name, text]) => [path.resolve(cwd, name), text]));
  const listings = [], lstats = [];
  function info(input) {
    if (files.has(input)) return { type: 'file' };
    if (input === cwd || [...files.keys()].some(file => file.startsWith(input + path.sep))) return { type: 'directory' };
    return undefined;
  }
  const fs = {
    async resolve(input, options = {}) { return { displayPath: path.resolve(options.cwd || cwd, input) }; },
    contains(root, target) { const relative = path.relative(root.displayPath, target.displayPath); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); },
    async lstat(input) { lstats.push(input); return info(input); },
    async stat(target) { return info(target.displayPath); },
    async listDir(target) {
      listings.push(target.displayPath);
      const found = new Map();
      for (const file of files.keys()) {
        const relative = path.relative(target.displayPath, file);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
        const parts = relative.split(path.sep);
        found.set(parts[0], { name: parts[0], type: parts.length === 1 ? 'file' : 'directory' });
      }
      return [...found.values()];
    },
    async readBytes(target) { return new TextEncoder().encode(files.get(target.displayPath)); },
  };
  return { fs, listings, lstats };
}
const claude = '---\nname: healthy\ndescription: Valid Claude role\n---\nReview carefully.';
const codex = 'description="Valid Codex role"\ndeveloper_instructions="Review carefully."';

test('non-directory .claude does not hide healthy Codex definitions', async () => {
  const f = memoryFs({ '.claude': 'ordinary file', '.codex/agents/healthy.toml': codex });
  const io = await createWorkspaceIO(f.fs, cwd, signal());
  await assert.rejects(io.list('.claude'), { code: 'ENOTDIR' });
  const result = await discoverAgents(io, cwd);
  assert.deepEqual(result.agents.map(agent => agent.id), ['codex:healthy']);
  assert.deepEqual(result.warnings, []);
});

test('non-directory .codex does not discard healthy Claude definitions', async () => {
  const f = memoryFs({ '.codex': 'ordinary file', '.claude/agents/healthy.md': claude });
  const result = await discoverAgents(await createWorkspaceIO(f.fs, cwd, signal()), cwd);
  assert.deepEqual(result.agents.map(agent => agent.id), ['claude:healthy']);
  assert.deepEqual(result.warnings, []);
});

test('adapter limits metadata requests before lstat and reports truncation', async () => {
  const f = memoryFs({ '.codex/placeholder': '' });
  let active = 0, peak = 0, queries = 0;
  const original = f.fs.lstat;
  f.fs.listDir = async () => Array.from({ length: 20000 }, (_, index) => ({ name: `entry-${index}`, type: 'file' }));
  f.fs.lstat = async input => {
    if (input === path.join(cwd, '.codex')) return original(input);
    queries++; active++; peak = Math.max(peak, active);
    await Promise.resolve(); active--; return { type: 'file' };
  };
  const io = await createWorkspaceIO(f.fs, cwd, signal());
  const entries = await io.list('.codex', { maxEntries: 7 });
  assert.equal(entries.length, 7); assert.equal(entries.truncated, true);
  assert.equal(queries, 7); assert.equal(peak, 1);
  await io.list('.codex', { maxEntries: 0 });
  assert.equal(queries, 7);
  await assert.rejects(io.list('.codex', { maxEntries: -1 }), /maxEntries/);
});

test('global entry budget skips later roots rather than querying their metadata', async () => {
  const f = memoryFs({ '.claude/placeholder': '', '.codex/placeholder': '' });
  f.fs.listDir = async target => {
    f.listings.push(target.displayPath);
    return Array.from({ length: 20000 }, (_, index) => ({ name: `entry-${index}`, type: 'file' }));
  };
  const result = await discoverAgents(await createWorkspaceIO(f.fs, cwd, signal()), cwd, { maxFiles: 0 });
  assert.equal(f.lstats.length, 10001); // one root component plus 10000 direct entries
  assert.deepEqual(f.listings, [path.join(cwd, '.claude')]);
  assert.deepEqual(result.agents, []);
  assert.deepEqual(result.warnings, ['Discovery entry limit reached (10000)']);
});

test('remaining budget is passed across directories and exact exhaustion skips later listings', async () => {
  const calls = [];
  const io = {
    async list(input, options) {
      calls.push({ input, maxEntries: options.maxEntries });
      if (input === '.claude') return [{ name: 'agents', isDirectory: true }];
      if (input === '.claude/agents') return Array.from({ length: 9999 }, (_, index) => ({ name: `ignored-${index}.txt`, isFile: true }));
      throw new Error('Budget-exhausted source must not be queried');
    },
    async read() { throw new Error('No agent files'); },
  };
  const result = await discoverAgents(io, cwd);
  assert.deepEqual(calls, [{ input: '.claude', maxEntries: 10000 }, { input: '.claude/agents', maxEntries: 9999 }]);
  assert.deepEqual(result.warnings, ['Discovery entry limit reached (10000)']);
});

test('cancellation stops sequential metadata queries before starting the next entry', async () => {
  const f = memoryFs({ '.codex/placeholder': '' });
  const controller = new AbortController();
  let queries = 0;
  const original = f.fs.lstat;
  f.fs.listDir = async () => Array.from({ length: 100 }, (_, index) => ({ name: `entry-${index}`, type: 'file' }));
  f.fs.lstat = async input => {
    if (input === path.join(cwd, '.codex')) return original(input);
    queries++; controller.abort(); return { type: 'file' };
  };
  const io = await createWorkspaceIO(f.fs, cwd, controller.signal);
  await assert.rejects(io.list('.codex', { maxEntries: 100 }), /abort/i);
  assert.equal(queries, 1);
});

test('adapter still propagates permission failures instead of treating them as non-directory', async () => {
  const f = memoryFs({ '.claude/placeholder': '' });
  f.fs.stat = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  await assert.rejects(discoverAgents(await createWorkspaceIO(f.fs, cwd, signal()), cwd), { code: 'EACCES' });
});
