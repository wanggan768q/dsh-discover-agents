import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
let plugin;
vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load(value) { plugin = value.factory(); } } } });
const session = { sessionId: 'session-a' };
const signal = () => new AbortController().signal;
const req = query => ({ query, position: 'leading', signal: signal() });
const token = id => `@local-agent:${encodeURIComponent(id)}`;
function fixture() {
  const catalogs = new Map([[session.sessionId, { agents: [{ id: 'claude:review', name: 'Other name', description: '检查代码' }] }]]);
  const calls = [];
  const installed = plugin.createSource({ load: async id => { calls.push(['load', id]); return catalogs.get(id) || { agents: [] }; }, execute: async (...args) => { calls.push(args); return { kind: 'success' }; }, hint: () => '任务' });
  return { ...installed, calls, set(value, receiving = session) { catalogs.set(receiving.sessionId, value); } };
}
test('@ source lists file stems and descriptions with fuzzy search and live session-scoped refresh', async () => {
  const f = fixture(); assert.equal(f.source.name, 'local-agents'); assert.equal(f.source.trigger, '@');
  const [row] = await f.source.candidates(session, req(''));
  assert.equal(row.name, 'local-agent:claude%3Areview'); assert.equal(row.label, 'review'); assert.equal(row.description, '检查代码'); assert.equal('alias' in row, false);
  assert.equal((await f.source.candidates(session, req('rv'))).length, 1);
  assert.equal((await f.source.candidates(session, req('检查'))).length, 1);
  assert.equal((await f.source.candidates(session, req('检码'))).length, 1);
  assert.equal((await f.source.candidates(session, req('zzz'))).length, 0);
  const other = { sessionId: 'other' };
  f.set({ agents: [{ id: 'codex:review', description: 'Other directory' }] }, other);
  assert.equal((await f.source.candidates(other, req('')))[0].value, 'codex:review');
  assert.equal((await f.source.candidates(session, req('')))[0].value, 'claude:review');
  f.set({ agents: [] }); assert.equal((await f.source.candidates(session, req(''))).length, 0);
});
test('pick only claims; submit uses exact default/main routing and preserves multiline or empty tasks', async () => {
  const f = fixture(); const [candidate] = await f.source.candidates(session, req(''));
  const { claim } = f.source.onPick({ session, candidate, position: 'leading' });
  assert.equal(claim.token, token('claude:review') + ' '); assert.equal(f.calls.filter(x => x[0] === session.sessionId).length, 0);
  for (const [args, expected] of [['检查 diff\n检查测试', 'claude:review 检查 diff\n检查测试'], ['--main 检查 diff', '--main claude:review 检查 diff'], ['', 'claude:review '], ['--main', '--main claude:review ']]) {
    await claim.submit(args, {}, []); assert.equal(f.calls.at(-1)[1], '/workspace-agent ' + expected);
  }
});
test('same stems, nested roles and Chinese names always pick deterministic exact identities', async () => {
  const f = fixture(); const ids = ['claude:review', 'codex:review', 'claude:nested/review', 'claude:中文'];
  f.set({ agents: ids.map(id => ({ id, description: id })) });
  const rows = await f.source.candidates(session, req('')); assert.equal(new Set(rows.map(x => x.name)).size, ids.length);
  for (const row of rows) {
    assert.equal('alias' in row, false);
    const { claim } = f.source.onPick({ session, candidate: row, position: 'leading' });
    await claim.submit('audit', {}, []); assert.equal(f.calls.at(-1)[1], `/workspace-agent ${row.value} audit`);
  }
  assert.equal((await f.source.candidates(session, req('中文')))[0].value, 'claude:中文');
});
test('bare names, old slash tokens and existing @ references are never claimed or loaded', async () => {
  const f = fixture(); await f.source.candidates(session, req(''));
  const before = f.calls.length;
  for (const text of ['@review', '@src/review.js', '@src/code review.js', '@session:abc', '@directory/', '@local-agentish:review', '/review', '/local-agent:claude%3Areview', '/workspace-agent', 'text @local-agent:claude%3Areview', ' @local-agent:claude%3Areview']) {
    assert.equal(await f.source.matchEnter(session, text + ' task', signal(), { attachments: 0 }), undefined, text);
  }
  for (const text of ['@review', '@src/code review.js', '@session:abc', '/review', '/local-agent:claude%3Areview']) {
    assert.equal(f.source.matchSpace(session, text), undefined);
    assert.equal(await f.source.matchClaim(session, text, signal()), undefined);
  }
  assert.equal(f.calls.length, before);
  const [candidate] = await f.source.candidates(session, req(''));
  for (const position of ['inline', 'claimed']) {
    assert.equal((await f.source.candidates(session, { ...req(''), position })).length, 0);
    assert.equal(f.source.onPick({ session, candidate, position }), undefined);
  }
});
test('space/manual enter/restore preserve deleted identities instead of remapping same names', async () => {
  const f = fixture(); const [candidate] = await f.source.candidates(session, req(''));
  const picked = f.source.onPick({ session, candidate, position: 'leading' }).claim;
  f.set({ agents: [{ id: 'codex:review', description: 'Replacement' }] });
  const restored = await f.source.matchClaim(session, picked.token, signal());
  await restored.submit('audit', {}, []); assert.equal(f.calls.at(-1)[1], '/workspace-agent claude:review audit');
  f.set({ agents: [] });
  const other = { sessionId: 'other' };
  for (const claim of [f.source.matchSpace(other, token('claude:review')).claim, (await f.source.matchEnter(other, token('claude:review') + ' task', signal(), { attachments: 0 })).claim]) {
    await claim.submit('audit', {}, []); assert.equal(f.calls.at(-1)[0], 'other'); assert.equal(f.calls.at(-1)[1], '/workspace-agent claude:review audit');
  }
});
test('whitespace IDs retain encoded identity and JSON-quoted fixed-command dispatch', async () => {
  for (const id of ['claude:code review', 'codex:code\u3000review', 'claude:code "review"']) {
    const f = fixture(); f.set({ agents: [{ id, description: 'Review' }] });
    const [candidate] = await f.source.candidates(session, req(''));
    const picked = f.source.onPick({ session, candidate, position: 'leading' }).claim;
    assert.equal(picked.token, token(id) + ' ');
    await picked.submit('audit\ncheck tests', {}, []); assert.equal(f.calls.at(-1)[1], `/workspace-agent ${JSON.stringify(id)} audit\ncheck tests`);
    f.set({ agents: [] });
    const restored = await f.source.matchClaim(session, token(id), signal());
    await restored.submit('--main audit', {}, []); assert.equal(f.calls.at(-1)[1], `/workspace-agent --main ${JSON.stringify(id)} audit`);
  }
});
test('reserved malformed tokens fail explicitly at every matching hook', async () => {
  const f = fixture();
  for (const text of ['@local-agent:', '@local-agent:%', '@local-agent:%E0%A4', '@local-agent:other%3Areview', '@local-agent:claude%3A', '@local-agent:claude%3Acode%0Areview', '@local-agent:claude:review', '@local-agent:claude%3areview', '@local-agent:claude%3Anested/review', '@local-agent:claude%3A中文', '@local-agent:%63laude%3Areview']) {
    assert.throws(() => f.source.matchSpace(session, text), /Invalid local agent token/);
    await assert.rejects(f.source.matchClaim(session, text, signal()), /Invalid local agent token/);
    await assert.rejects(f.source.matchEnter(session, text + ' task', signal(), { attachments: 0 }), /Invalid local agent token/);
  }
  assert.throws(() => f.source.matchSpace(session, '@local-agent:claude%3Acode review'), /Invalid local agent token/);
});
test('in-flight catalog work honors cancellation and disposal before returning claims or candidates', async () => {
  for (const operation of ['candidates', 'matchClaim', 'matchEnter']) {
    for (const stop of ['abort', 'dispose']) {
      let release;
      const installed = plugin.createSource({
        load: () => new Promise(resolve => { release = resolve; }),
        hint: () => 'task', execute: () => assert.fail('query must not dispatch'),
      });
      const controller = new AbortController(); const reason = new Error('cancel pending catalog');
      const pending = operation === 'candidates'
        ? installed.source.candidates(session, { ...req(''), signal: controller.signal })
        : operation === 'matchClaim'
          ? installed.source.matchClaim(session, token('claude:review'), controller.signal)
          : installed.source.matchEnter(session, token('claude:review') + ' task', controller.signal, { attachments: 0 });
      if (stop === 'abort') controller.abort(reason); else installed.dispose();
      release({ agents: [{ id: 'claude:review', description: 'Review' }] });
      if (stop === 'abort') await assert.rejects(pending, error => error === reason);
      else if (operation === 'candidates') assert.equal((await pending).length, 0);
      else assert.equal(await pending, undefined);
    }
  }
});
test('cancellation, failed loads, attachments and uninstall never fall back or submit', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.source.candidates(session, { ...req(''), signal: controller.signal }), /abort/i);
  await assert.rejects(f.source.matchClaim(session, token('claude:review'), controller.signal), /abort/i);
  await assert.rejects(f.source.matchEnter(session, token('claude:review') + ' task', controller.signal, { attachments: 0 }), /abort/i);
  await assert.rejects(f.source.matchEnter(session, token('claude:review') + ' task', signal(), { attachments: 1 }), /attachments/);
  const [candidate] = await f.source.candidates(session, req('')); const claim = f.source.onPick({ session, candidate, position: 'leading' }).claim;
  f.dispose(); assert.equal((await claim.submit('task', {}, [])).kind, 'error');
  assert.equal(f.source.matchSpace(session, token('claude:review')), undefined);
  assert.equal(await f.source.matchClaim(session, token('claude:review'), signal()), undefined);
  assert.equal(await f.source.matchEnter(session, token('claude:review') + ' task', signal(), { attachments: 0 }), undefined);
  const broken = plugin.createSource({ load: async () => { throw new Error('offline'); } });
  await assert.rejects(broken.source.matchClaim(session, token('claude:review'), signal()), /offline/);
  await assert.rejects(broken.source.matchEnter(session, token('claude:review') + ' task', signal(), { attachments: 0 }), /offline/);
  assert.equal(await broken.source.matchEnter(session, '@review task', signal(), { attachments: 0 }), undefined);
});
