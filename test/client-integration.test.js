import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
let plugin;
vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load(value) { plugin = value.factory(); } } } });
test('client apply uses scoped RPC, validates result, keeps failed drafts, and unregisters', async () => {
  assert.ok(plugin.inject.includes('remote')); assert.ok(plugin.inject.includes('remote.commands'));
  let source; let cleanup; let response = { ok: true, value: { result: { kind: 'success', text: 'already shown by command node' } } };
  const calls = [];
  const ctx = {
    inputTriggers: { registerSource(value) { source = value; return () => { source = undefined; }; } },
    sessions: { subagentAddress: () => undefined, binding: () => ({}), using: async (id, options, operation) => operation({ binding: { session: { getSnapshot: () => ({ openState: 'open' }) } } }) },
    connection: { rpc: { async call(...args) { calls.push(args); return { ok: true, value: { agents: [{ id: 'claude:review', description: 'Review' }], commands: [] } }; } } },
    remote: { commands: { async execute(...args) { calls.push(args); return response; } } },
    effect(fn) { cleanup = fn(); },
  };
  plugin.apply(ctx);
  const session = { sessionId: 'one' }; const signal = new AbortController().signal;
  const [candidate] = await source.candidates(session, { position: 'leading', query: '', signal });
  assert.equal(calls[0][1], 'discoverAgents/catalog'); assert.equal(calls[0][2].args.agentId, 'one');
  const { claim } = source.onPick({ session, candidate, position: 'leading' });
  assert.equal((await claim.submit('task', {}, [])).text, undefined);
  response = { ok: false, error: { code: 'FAIL', message: 'failed' } };
  assert.equal((await claim.submit('task', {}, [])).kind, 'error');
  assert.equal((await claim.submit('task', {}, [{}])).kind, 'error');
  cleanup(); assert.equal(source, undefined); assert.equal((await claim.submit('task', {}, [])).kind, 'error');
});
