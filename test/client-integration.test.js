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
    connection: { rpc: { async call(...args) { calls.push(args); return { ok: true, value: { agents: [{ id: 'claude:review', description: 'Review' }] } }; } } },
    remote: { commands: { async execute(...args) { calls.push(args); return response; } } },
    effect(fn) { cleanup = fn(); },
  };
  plugin.apply(ctx);
  const session = { sessionId: 'one' }; const signal = new AbortController().signal;
  const [candidate] = await source.candidates(session, { position: 'leading', query: '', signal });
  assert.equal(calls[0][1], 'discoverAgents/catalog'); assert.equal(calls[0][2].args.agentId, 'one');
  assert.equal(source.trigger, '@');
  const { claim } = source.onPick({ session, candidate, position: 'leading' });
  assert.equal(claim.token, '@local-agent:claude%3Areview ');
  assert.equal((await claim.submit('task', {}, [])).text, undefined);
  response = { ok: false, error: { code: 'FAIL', message: 'failed' } };
  const failed = await claim.submit('task', {}, []);
  assert.equal(failed.kind, 'error'); assert.match(failed.text, /FAIL: failed/);
  response = { ok: true, value: { result: { kind: 'error', text: 'Workspace agent not found' } } };
  assert.equal((await claim.submit('task', {}, [])).text, 'Workspace agent not found');
  response = { ok: true, value: {} };
  assert.equal((await claim.submit('task', {}, [])).kind, 'error');
  const before = calls.length;
  assert.equal((await claim.submit('task', {}, [{}])).kind, 'error');
  assert.equal(calls.length, before);
  assert.equal(claim.token, '@local-agent:claude%3Areview ');
  cleanup(); assert.equal(source, undefined); assert.equal((await claim.submit('task', {}, [])).kind, 'error');
});
test('non-agent references avoid RPC; remote child inputs are disabled; catalog errors stay explicit', async () => {
  let source; let isChild = false; let rpcCalls = 0;
  const ctx = {
    inputTriggers: { registerSource(value) { source = value; return () => {}; } },
    sessions: { subagentAddress: () => isChild ? {} : undefined, binding: () => ({}), using: async (_id, _options, operation) => operation({ binding: { session: { getSnapshot: () => ({ openState: 'open' }) } } }) },
    connection: { rpc: { call: async () => { rpcCalls++; return { ok: false, error: { code: 'OFFLINE', message: 'catalog failed' } }; } } },
    remote: { commands: { execute: async () => { assert.fail('no dispatch expected'); } } }, effect(fn) { fn(); },
  };
  plugin.apply(ctx);
  const session = { sessionId: 'one' }; const signal = new AbortController().signal;
  for (const text of ['@review', '@src/code review.js', '@session:one', '/review', '/local-agent:claude%3Areview']) {
    assert.equal(await source.matchEnter(session, text + ' task', signal, { attachments: 0 }), undefined);
    assert.equal(await source.matchClaim(session, text, signal), undefined);
    assert.equal(source.matchSpace(session, text), undefined);
  }
  assert.equal(rpcCalls, 0);
  await assert.rejects(source.matchEnter(session, '@local-agent:claude%3Areview task', signal, { attachments: 0 }), /OFFLINE: catalog failed/);
  await assert.rejects(source.matchClaim(session, '@local-agent:claude%3Areview', signal), /OFFLINE: catalog failed/);
  isChild = true; const before = rpcCalls;
  assert.equal((await source.candidates(session, { position: 'leading', query: '', signal })).length, 0);
  assert.equal(source.matchSpace(session, '@local-agent:claude%3Areview'), undefined);
  assert.equal(await source.matchClaim(session, '@local-agent:claude%3Areview', signal), undefined);
  assert.equal(await source.matchEnter(session, '@local-agent:claude%3Areview task', signal, { attachments: 0 }), undefined);
  assert.equal(rpcCalls, before);
});
test('RPC catalog accepts whitespace IDs without hiding normal roles and still rejects malformed IDs', async () => {
  let source;
  let catalog = { agents: [
    { id: 'claude:review', description: 'Normal' },
    { id: 'claude:code review', description: 'Space' },
    { id: 'codex:code\u3000review', description: 'Unicode space' },
  ] };
  const dispatched = [];
  plugin.apply({
    inputTriggers: { registerSource(value) { source = value; return () => {}; } },
    sessions: { subagentAddress: () => undefined, binding: () => ({}), using: async (_id, _options, operation) => operation({ binding: { session: { getSnapshot: () => ({ openState: 'open' }) } } }) },
    connection: { rpc: { call: async () => ({ ok: true, value: catalog }) } },
    remote: { commands: { execute: async (...args) => { dispatched.push(args); return { ok: true, value: { result: { kind: 'success' } } }; } } },
    effect(fn) { fn(); },
  });
  const session = { sessionId: 'one' };
  const request = { position: 'leading', query: '', signal: new AbortController().signal };
  const candidates = await source.candidates(session, request);
  assert.equal(candidates.length, 3);
  for (const candidate of candidates) {
    const { claim } = source.onPick({ session, candidate, position: 'leading' });
    assert.equal((await claim.submit('audit', {}, [])).kind, 'success');
    const id = /\s/.test(candidate.value) ? JSON.stringify(candidate.value) : candidate.value;
    assert.equal(dispatched.at(-1)[1], `/workspace-agent ${id} audit`);
  }
  for (const id of ['claude:', 'other:review', 'claude:code\nreview']) {
    catalog = { agents: [{ id, description: 'Invalid' }] };
    await assert.rejects(source.candidates(session, request), /Invalid local agent catalog/);
  }
});
