import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverAgents } from '../discovery.js';

function memoryIO(contents = {}, extraEntries = {}, errors = {}) {
  const reads = [], listings = [];
  const io = {
    async list(path) {
      listings.push(path);
      if (errors[`list:${path}`]) throw errors[`list:${path}`];
      const found = new Map();
      for (const file of Object.keys(contents)) {
        if (!file.startsWith(`${path}/`)) continue;
        const rest = file.slice(path.length + 1), slash = rest.indexOf('/');
        const name = slash < 0 ? rest : rest.slice(0, slash);
        found.set(name, { name, isFile: slash < 0, isDirectory: slash >= 0 });
      }
      return [...found.values(), ...(extraEntries[path] ?? [])];
    },
    async read(path) {
      reads.push(path);
      if (errors[`read:${path}`]) throw errors[`read:${path}`];
      if (!Object.hasOwn(contents, path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return contents[path];
    },
  };
  return { io, reads, listings };
}
const md = (name = 'reviewer', description = 'Review code', body = 'You review code.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
const error = (message, code) => Object.assign(new Error(message), { code });

test('empty workspace, validates inputs, and only probes fixed config roots', async () => {
  const fixture = memoryIO({ 'unrelated/agent.md': md() });
  assert.deepEqual(await discoverAgents(fixture.io, '/workspace'), { agents: [], warnings: [] });
  assert.deepEqual(fixture.listings, ['.claude', '.codex']);
  assert.deepEqual(fixture.reads, []);
  await assert.rejects(discoverAgents({}, '/workspace'), /io must provide/);
  await assert.rejects(discoverAgents(fixture.io, ''), /cwd/);
  for (const maxFiles of [-1, NaN, 1.5, Infinity]) {
    await assert.rejects(discoverAgents(fixture.io, '/workspace', { maxFiles }), /maxFiles/);
  }
  await assert.rejects(discoverAgents(fixture.io, '/workspace', { maxBytes: -1 }), /maxBytes/);
});

test('Claude nested IDs, multiline and quoted YAML, BOM/CRLF, metadata and Markdown body', async () => {
  const fixture = memoryIO({
    '.claude/agents/team/review.md': '\uFEFF---\r\nname: "code-reviewer"\r\ndescription: >-\r\n  Review code:\r\n  including security.\r\ntools: [Read, Grep]\r\nmodel: inherit\r\ncustom:\r\n  enabled: true\r\n---\r\n\r\n# Review\r\nPreserve **Markdown**.\r\n',
    '.claude/agents/literal.md': md("'literal-agent'", '|\n  First line\n  Second line'),
    '.claude/agents/ignored.txt': 'ignore',
    '.claude/settings.json': '{}',
    '.claude/agents/z.md': md('same-name'),
  });
  const result = await discoverAgents(fixture.io, 'E:\\workspace');
  assert.deepEqual(result.agents.map(agent => agent.id), ['claude:literal', 'claude:team/review', 'claude:z']);
  const agent = result.agents[1];
  assert.equal(agent.source, 'claude');
  assert.equal(agent.path, '.claude/agents/team/review.md');
  assert.equal(agent.description, 'Review code: including security.');
  assert.equal(agent.instructions, '# Review\nPreserve **Markdown**.');
  assert.deepEqual(agent.metadata.tools, ['Read', 'Grep']);
  assert.equal(agent.metadata.custom.enabled, true);
  assert.equal(result.agents[0].description, 'First line\nSecond line\n');
  assert.deepEqual(result.warnings, []);
  assert.ok(!fixture.reads.includes('.claude/settings.json'));
});

test('Claude malformed/unsupported YAML and missing fields diagnose per file without hiding siblings', async () => {
  const fixture = memoryIO({
    '.claude/agents/a.md': 'not frontmatter',
    '.claude/agents/b.md': md('123'),
    '.claude/agents/c.md': md('okay', '[one, two]'),
    '.claude/agents/d.md': '---\nname: one\nname: two\ndescription: test\n---\nbody',
    '.claude/agents/e.md': '---\nname: alias\ndescription: &desc test\ncopy: *desc\n---\nbody',
    '.claude/agents/f.md': md('tagged', '!custom test'),
    '.claude/agents/g.md': '---\nname: merge\ndescription: test\n<<: {x: 1}\n---\nbody',
    '.claude/agents/h.md': md('healthy'),
    '.claude/agents/i.md': md('empty', 'test', ''),
  });
  const result = await discoverAgents(fixture.io, '/workspace');
  assert.deepEqual(result.agents.map(agent => agent.name), ['healthy', 'empty']);
  assert.equal(result.warnings.length, 7);
  assert.ok(result.warnings.some(warning => /alias/.test(warning)));
  assert.ok(result.warnings.some(warning => /tag/.test(warning)));
  assert.deepEqual(result.agents[1].warnings, ['Markdown instructions are empty']);
});

test('Codex config_file is relative to defining config, quoted roles, multiline TOML, metadata and shared reads', async () => {
  const fixture = memoryIO({
    '.codex/config.toml': `[agents]\nmax_threads = 6\nmax_depth = 1\n[agents."code-reviewer"]\ndescription = "Review: code # safely"\nconfig_file = "agents/reviewer.toml"\n[agents.explorer]\nconfig_file = './agents/reviewer.toml'\n[agents.default]\ndescription = "Built-in role"\n`,
    '.codex/agents/reviewer.toml': `description = 'File description'\nmodel = "gpt-5"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nReview carefully.\nKeep \\"quotes\\".\n"""\n[mcp_servers.example]\ncommand = "never-execute"\n`,
  });
  const result = await discoverAgents(fixture.io, '/workspace');
  assert.deepEqual(result.agents.map(agent => agent.id), ['codex:code-reviewer', 'codex:default', 'codex:explorer']);
  const agent = result.agents[0];
  assert.equal(agent.path, '.codex/agents/reviewer.toml');
  assert.equal(agent.description, 'Review: code # safely');
  assert.equal(agent.instructions, 'Review carefully.\nKeep "quotes".\n');
  assert.equal(agent.metadata.model, 'gpt-5');
  assert.equal(agent.metadata.registration.config_file, 'agents/reviewer.toml');
  assert.equal(result.agents[2].description, 'File description');
  assert.equal(fixture.reads.filter(path => path.endsWith('reviewer.toml')).length, 1);
  assert.equal(result.agents[1].instructions, '');
  assert.ok(result.agents[1].warnings[0].includes('defaults are not imported'));
  assert.deepEqual(result.warnings, []);
});

test('Codex direct TOML compatibility, literal multiline, collision precedence, no recursive fallback', async () => {
  const fixture = memoryIO({
    '.codex/config.toml': '[agents.reviewer]\ndescription="Configured"\n',
    '.codex/agents/a.toml': "name='reviewer'\ndeveloper_instructions='ignored'\n",
    '.codex/agents/b.toml': "name='custom-role'\ndescription='Compatible'\ndeveloper_instructions='''\nRaw \\ paths and \"quotes\".\n'''\n",
    '.codex/agents/c.toml': 'model="not an agent"',
    '.codex/agents/d.toml': 'name=123\ndeveloper_instructions="bad"',
    '.codex/agents/deep/hidden.toml': 'developer_instructions="do not recurse"',
  });
  const result = await discoverAgents(fixture.io, '/workspace');
  assert.deepEqual(result.agents.map(agent => agent.id), ['codex:custom-role', 'codex:reviewer']);
  assert.equal(result.agents[0].instructions, 'Raw \\ paths and "quotes".\n');
  assert.ok(result.agents[0].warnings[0].includes('Compatibility'));
  assert.equal(result.warnings.length, 3);
  assert.ok(!fixture.listings.includes('.codex/agents/deep'));
});

test('Codex unsafe paths, directory/file symlinks and malicious io names never get read', async () => {
  const fixture = memoryIO({
    '.codex/config.toml': ['../outside.toml', '/outside.toml', 'C:\\outside.toml', 'agents/../outside.toml', 'agents/link.toml', 'linked/file.toml', 'agents/not-md.md', 'agents/missing.toml']
      .map((path, index) => `[agents.role${index}]\nconfig_file=${JSON.stringify(path)}\n`).join('\n'),
    '.claude/agents/good.md': md('good'),
  }, {
    '.claude/agents': [
      { name: '../escape.md', isFile: true }, { name: 'dir/escape.md', isDirectory: true },
      { name: 'link.md', isFile: true, isSymbolicLink: true },
      { name: 'linked', isDirectory: true, isSymbolicLink: true },
    ],
    '.codex': [{ name: 'agents', isDirectory: true }, { name: 'linked', isDirectory: true, isSymbolicLink: true }],
    '.codex/agents': [{ name: 'link.toml', isFile: true, isSymbolicLink: true }],
  });
  const result = await discoverAgents(fixture.io, '/workspace');
  assert.deepEqual(fixture.reads, ['.claude/agents/good.md', '.codex/config.toml']);
  assert.equal(result.agents.length, 1);
  assert.ok(result.warnings.some(warning => warning.includes('symbolic link')));
  assert.ok(result.warnings.some(warning => warning.includes('unsafe directory entry')));
});

test('file read and parse failures diagnose; overall access and malformed io failures propagate', async () => {
  const fixture = memoryIO({
    '.claude/agents/a.md': md(), '.claude/agents/b.md': md('healthy'),
    '.codex/config.toml': '[agents.broken]\nconfig_file="agents/broken.toml"',
    '.codex/agents/broken.toml': 'developer_instructions = "unterminated',
    '.codex/agents/healthy.toml': 'developer_instructions="healthy"',
  }, {}, { 'read:.claude/agents/a.md': error('permission denied', 'EACCES') });
  const result = await discoverAgents(fixture.io, '/workspace');
  assert.equal(result.agents.length, 2);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /permission denied/);
  const denied = memoryIO({}, {}, { 'list:.claude': error('workspace denied', 'EACCES') });
  await assert.rejects(discoverAgents(denied.io, '/workspace'), /workspace denied/);
  const nestedDenied = memoryIO({ '.claude/agents/sub/a.md': md() }, {}, {
    'list:.claude/agents/sub': error('nested denied', 'EPERM'),
  });
  await assert.rejects(discoverAgents(nestedDenied.io, '/workspace'), /nested denied/);
  const absent = memoryIO({}, {}, { 'list:.claude': error('missing', 'ENOENT'), 'list:.codex': error('not dir', 'ENOTDIR') });
  assert.deepEqual(await discoverAgents(absent.io, '/workspace'), { agents: [], warnings: [] });
  await assert.rejects(discoverAgents({ list: () => null, read: () => '' }, '/workspace'), /must return an array/);
});

test('maxFiles counts unique attempted reads and maxBytes measures UTF-8 per file', async () => {
  const fixture = memoryIO({ '.claude/agents/a.md': md('a'), '.claude/agents/b.md': md('b') });
  const limited = await discoverAgents(fixture.io, '/workspace', { maxFiles: 1 });
  assert.equal(limited.agents.length, 1);
  assert.deepEqual(fixture.reads, ['.claude/agents/a.md']);
  assert.ok(limited.warnings.some(warning => /file limit/.test(warning)));
  const zero = memoryIO({ '.claude/agents/a.md': md() });
  assert.equal((await discoverAgents(zero.io, '/workspace', { maxFiles: 0 })).agents.length, 0);
  assert.deepEqual(zero.reads, []);
  const unicode = memoryIO({ '.claude/agents/a.md': md('a', '中文') });
  const text = md('a', '中文');
  assert.equal((await discoverAgents(unicode.io, '/workspace', { maxBytes: text.length })).agents.length, 0);
  assert.equal((await discoverAgents(unicode.io, '/workspace', { maxBytes: Buffer.byteLength(text) })).agents.length, 1);
});

test('untrusted directory fanout and depth have explicit fixed limits', async () => {
  const deepPath = `.claude/agents/${'deep/'.repeat(34)}agent.md`;
  const fixture = memoryIO({ [deepPath]: md() });
  const result = await discoverAgents(fixture.io, '/workspace');
  assert.equal(result.agents.length, 0);
  assert.ok(result.warnings.some(warning => /depth limit/.test(warning)));
  assert.ok(fixture.listings.length < 40);
  const many = memoryIO({}, { '.codex': Array.from({ length: 10002 }, (_, index) => ({ name: `entry${index}`, isFile: true })) });
  assert.ok((await discoverAgents(many.io, '/workspace')).warnings.some(warning => /entry limit/.test(warning)));
});

test('invalid Codex field shapes diagnose rather than silently coercing', async () => {
  const fixture = memoryIO({
    '.codex/config.toml': '[agents]\nscalar=1\n[agents.bad-description]\ndescription=2\n[agents.bad-instructions]\nconfig_file="agents/bad.toml"\n',
    '.codex/agents/bad.toml': 'developer_instructions=["not", "string"]',
  });
  const result = await discoverAgents(fixture.io, '/workspace');
  assert.deepEqual(result.agents, []);
  assert.equal(result.warnings.length, 3);
});
