import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installCatalogRemote } from '../remote.js';
const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-typert-protocol'));
const { Context } = require('@deepseek-ai/cordis');

test('catalog needs no commands service, returns the exact caller scan value, and disposes with fiber', async () => {
  const ctx = new Context();
  assert.equal(ctx.commands, undefined);
  const caller = {}; const signal = new AbortController().signal;
  const value = { cwd: '/workspace', agents: [{ id: 'claude:review', description: 'Review' }], warnings: [] };
  const calls = [];
  const fiber = await installCatalogRemote(ctx, { async execute(args, exec) {
    calls.push({ args, exec });
    return value;
  } });
  try {
    assert.equal(ctx.discoverAgents.typertRemote.namespace, 'discoverAgents');
    assert.equal(Object.hasOwn(ctx.discoverAgents.constructor, 'inject'), false);
    const catalog = await ctx.discoverAgents.catalog(caller, signal);
    assert.strictEqual(catalog, value);
    assert.equal(Object.hasOwn(catalog, 'commands'), false);
    assert.deepEqual(Object.keys(catalog), ['cwd', 'agents', 'warnings']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, {});
    assert.deepEqual(Object.keys(calls[0].exec), ['agent', 'signal']);
    assert.strictEqual(calls[0].exec.agent, caller);
    assert.strictEqual(calls[0].exec.signal, signal);
    assert.equal(ctx.commands, undefined);
  } finally { await fiber.dispose(); }
  assert.equal(ctx.discoverAgents, undefined);
});

for (const abortBeforeScan of [false, true]) {
  test(`catalog preserves cancellation ${abortBeforeScan ? 'before' : 'during'} the caller scan`, async () => {
    const ctx = new Context(); const caller = {};
    const controller = new AbortController();
    const reason = new Error('cancel workspace catalog');
    if (abortBeforeScan) controller.abort(reason);
    let calls = 0;
    const fiber = await installCatalogRemote(ctx, { async execute(args, exec) {
      calls++;
      assert.deepEqual(args, {});
      assert.strictEqual(exec.agent, caller);
      assert.strictEqual(exec.signal, controller.signal);
      if (!abortBeforeScan) controller.abort(reason);
      return { agents: [], warnings: [] };
    } });
    try {
      await assert.rejects(ctx.discoverAgents.catalog(caller, controller.signal), error => error === reason);
      assert.equal(calls, 1);
    } finally { await fiber.dispose(); }
    assert.equal(ctx.discoverAgents, undefined);
  });
}
