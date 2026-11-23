import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installCatalogRemote } from '../remote.js';
const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-typert-protocol'));
const { Context } = require('@deepseek-ai/cordis');
test('catalog registers real Cordis remote service, shares caller scan, and is disposed with fiber', async () => {
  const ctx = new Context();
  ctx.provide('commands', { list: () => [{ name: 'review' }, { name: 'help' }] });
  const caller = {}; const signal = new AbortController().signal;
  const fiber = await installCatalogRemote(ctx, { async execute(args, exec) {
    assert.equal(exec.agent, caller); assert.equal(exec.signal, signal);
    return { agents: [{ id: 'claude:review', description: 'Review' }], warnings: [] };
  } });
  try {
    assert.equal(ctx.discoverAgents.typertRemote.namespace, 'discoverAgents');
    const catalog = await ctx.discoverAgents.catalog(caller, signal);
    assert.deepEqual(catalog.commands, ['review', 'help']); assert.equal(catalog.agents[0].id, 'claude:review');
  } finally { await fiber.dispose(); }
  assert.equal(ctx.discoverAgents, undefined);
});
