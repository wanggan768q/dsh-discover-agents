import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const artifact = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
let plugin;
vm.runInNewContext(artifact, { window: { __ModuleLoader__: { load(value) { plugin = value.factory(); } } } });
const session = { sessionId: 'session-a' };
const signal = () => new AbortController().signal;
function fixture() {
  let catalog = { agents: [{ id: 'claude:review', name: 'Other name', description: '检查代码' }], commands: ['workspace-agent'] };
  const calls = [];
  const source = plugin.createSource({ load: async id => { calls.push(['load', id]); return catalog; }, execute: async (...args) => { calls.push(args); return { kind: 'success' }; }, hint: () => '任务' });
  return { ...source, calls, set(value) { catalog = value; } };
}
const req = query => ({ query, position: 'leading', signal: signal() });
test('slash source lists file stem and description under local-agents, with live refresh', async () => {
  const f = fixture(); assert.equal(f.source.name, 'local-agents');
  const rows = await f.source.candidates(session, req(''));
  assert.equal(rows[0].name, 'local-agent:claude%3Areview'); assert.equal(rows[0].alias, 'review'); assert.equal(rows[0].label, 'review'); assert.equal(rows[0].description, '检查代码');
  assert.equal((await f.source.candidates(session, req('rv'))).length, 1);
  assert.equal((await f.source.candidates(session, req('zzz'))).length, 0);
  f.set({ agents: [], commands: [] }); assert.equal((await f.source.candidates(session, req(''))).length, 0);
});
test('menu pick creates claim only; submitting routes exact role to default subagent or explicit main', async () => {
  const f = fixture(); const [candidate] = await f.source.candidates(session, req(''));
  const { claim } = f.source.onPick({ session, candidate, position: 'leading' });
  assert.equal(claim.token, '/local-agent:claude%3Areview '); assert.equal(f.calls.filter(x => x[0] === 'session-a').length, 0);
  await claim.submit('检查 diff\n检查测试', {}, []);
  assert.equal(f.calls.at(-1)[1], '/workspace-agent claude:review 检查 diff\n检查测试');
  await claim.submit('--main 检查 diff', {}, []);
  assert.equal(f.calls.at(-1)[1], '/workspace-agent --main claude:review 检查 diff');
});
test('duplicate stems, host command collisions and invalid names have deterministic qualified spellings', async () => {
  const f = fixture(); f.set({ agents: [{ id: 'claude:review', description: 'Claude' }, { id: 'codex:review', description: 'Codex' }, { id: 'claude:model', description: 'Model' }, { id: 'claude:中文', description: 'CN' }], commands: ['model'] });
  const rows = await f.source.candidates(session, req(''));
  assert.equal(new Set(rows.map(x => x.name)).size, 4);
  assert.equal(rows[0].label, 'review'); assert.equal(rows[0].value, 'claude:review');
  assert.equal(rows[0].name, 'local-agent:claude%3Areview'); assert.equal(rows[2].name, 'local-agent:claude%3Amodel');
});
test('space, enter and restore claims use receiving session; no inline or attachment dispatch', async () => {
  const f = fixture(); await f.source.candidates(session, req(''));
  assert.ok(f.source.matchSpace(session, '/review'));
  assert.equal(f.source.matchSpace({ sessionId: 'other' }, '/review'), undefined);
  assert.ok(await f.source.matchClaim(session, '/local-agent:claude%3Areview', signal()));
  assert.ok(await f.source.matchEnter(session, '/review task', signal(), { attachments: 0 }));
  await assert.rejects(f.source.matchEnter(session, '/review task', signal(), { attachments: 1 }), /attachments/);
  assert.equal((await f.source.candidates(session, { ...req(''), position: 'inline' })).length, 0);
});
test('persisted claims retain exact identity across role replacement or removal', async () => {
  const f = fixture(); const [candidate] = await f.source.candidates(session, req(''));
  const { claim } = f.source.onPick({ session, candidate, position: 'leading' });
  f.set({ agents: [{ id: 'codex:review', description: 'New' }], commands: [] });
  const restored = await f.source.matchClaim(session, claim.token, signal());
  await restored.submit('audit', {}, []);
  assert.equal(f.calls.at(-1)[1], '/workspace-agent claude:review audit');
  assert.equal(await f.source.matchClaim(session, '/review', signal()), undefined);
  await f.source.candidates(session, req(''));
  f.set({ agents: [], commands: [] });
  const outcome = await f.source.matchEnter(session, '/review task', signal(), { attachments: 0 });
  await outcome.claim.submit('task', {}, []);
  assert.equal(f.calls.at(-1)[1], '/workspace-agent codex:review task');
});
test('cancellation, load failures and disposed claims cannot silently submit a main task', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.source.candidates(session, { ...req(''), signal: controller.signal }), /abort/i);
  const [candidate] = await f.source.candidates(session, req(''));
  const { claim } = f.source.onPick({ session, candidate, position: 'leading' }); f.dispose();
  assert.equal((await claim.submit('task', {}, [])).kind, 'error');
  assert.equal(f.source.matchSpace(session, '/review'), undefined);
  const broken = plugin.createSource({ load: async () => { throw new Error('offline'); } });
  await assert.rejects(broken.source.matchClaim(session, '/local-agent:claude%3Areview', signal()), /offline/);
  assert.equal(await broken.source.matchEnter(session, '/help', signal(), { attachments: 0 }), undefined);
});
