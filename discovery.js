import YAML from 'yaml';
import { parse as parseToml } from 'smol-toml';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const agentSettings = new Set([
  'max_threads', 'max_depth', 'job_max_runtime_seconds', 'enabled', 'interrupt_message',
  'max_concurrent_threads_per_session', 'default_subagent_model', 'default_subagent_reasoning_effort',
]);
const message = error => String(error?.message ?? error).slice(0, 500);
const validSegment = name => typeof name === 'string' && name.length > 0 &&
  name !== '.' && name !== '..' && !/[\\/:\0-\x1f]/u.test(name);

function yamlMetadata(text) {
  const doc = YAML.parseDocument(text, { schema: 'core', uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length) throw doc.errors[0];
  // Discovery intentionally does not resolve aliases, merge keys, or custom YAML tags.
  YAML.visit(doc, (_, node) => {
    if (YAML.isAlias(node)) throw new Error('Unsupported YAML alias');
    if (node?.tag && !node.tag.startsWith('tag:yaml.org,2002:')) {
      throw new Error(`Unsupported YAML tag: ${node.tag}`);
    }
  });
  if (doc.warnings.length) throw new Error(doc.warnings.map(message).join('; '));
  const value = doc.toJS({ maxAliasCount: 0 });
  function check(value, depth = 0) {
    if (depth > 64) throw new Error('YAML metadata nesting exceeds 64');
    if (!value || typeof value !== 'object') return;
    if (has(value, '<<')) throw new Error('Unsupported YAML merge key');
    for (const item of Object.values(value)) check(item, depth + 1);
  }
  check(value);
  if (!isRecord(value)) throw new Error('YAML frontmatter must be a mapping');
  return value;
}

/**
 * Discover only workspace Markdown beneath .claude/agents, .codex/config.toml and
 * .codex/agents/*.toml. io paths are cwd-relative, slash-separated strings.
 * io.list(path, { maxEntries }) must bound its extra per-entry metadata work;
 * an array with truncated=true indicates that more entries were omitted.
 * io MUST enforce cwd containment and lstat every path component (including
 * .claude/.codex), reject observed symlinks, and bound reads before allocation.
 * The DSH filesystem API does not guarantee race-free no-follow reads.
 * maxFiles counts unique attempted reads; maxBytes is a per-file UTF-8 limit.
 * Directory access failures propagate, except absent/non-directory roots.
 * File read/parse failures become diagnostics. No CLI or global config is used.
 */
export async function discoverAgents(io, cwd, options = {}) {
  if (!io || typeof io.list !== 'function' || typeof io.read !== 'function') {
    throw new TypeError('io must provide list(path) and read(path)');
  }
  if (typeof cwd !== 'string' || !cwd.trim()) throw new TypeError('cwd must be a non-empty string');
  const maxFiles = options.maxFiles ?? 200;
  const maxBytes = options.maxBytes ?? 262144;
  for (const [key, value] of Object.entries({ maxFiles, maxBytes })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${key} must be a non-negative safe integer`);
  }
  const agents = [], warnings = [], lists = new Map(), files = new Map();
  let directoryCount = 0, entryCount = 0;
  const maxDirectories = 256, maxEntries = 10000, maxDepth = 32;
  const warn = (path, text) => warnings.push(`${path}: ${text}`);
  function limit(text) {
    if (!warnings.includes(text)) warnings.push(text);
  }
  async function list(path) {
    if (lists.has(path)) return lists.get(path);
    if (directoryCount >= maxDirectories) {
      limit(`Discovery directory limit reached (${maxDirectories})`);
      return [];
    }
    if (entryCount >= maxEntries) {
      limit(`Discovery entry limit reached (${maxEntries})`);
      return [];
    }
    directoryCount++;
    let entries;
    try { entries = await io.list(path, { maxEntries: maxEntries - entryCount }); }
    catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      entries = [];
    }
    if (!Array.isArray(entries)) throw new TypeError(`io.list(${path}) must return an array`);
    if (entries.truncated) limit(`Discovery entry limit reached (${maxEntries})`);
    const safe = [];
    for (const entry of entries) {
      if (entryCount++ >= maxEntries) {
        limit(`Discovery entry limit reached (${maxEntries})`);
        break;
      }
      if (!entry || !validSegment(entry.name)) {
        warn(path, 'Rejected unsafe directory entry name');
        continue;
      }
      if (entry.isSymbolicLink) {
        warn(`${path}/${entry.name}`, 'Rejected symbolic link');
        continue;
      }
      safe.push(entry);
    }
    safe.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    lists.set(path, safe);
    return safe;
  }
  async function directory(parent, name) {
    return (await list(parent)).some(entry => entry.name === name && entry.isDirectory === true);
  }
  async function checkedFile(path) {
    const parts = path.split('/');
    let parent = parts.shift();
    for (let i = 0; i < parts.length; i++) {
      const entry = (await list(parent)).find(item => item.name === parts[i]);
      if (!entry || (i === parts.length - 1 ? entry.isFile !== true : entry.isDirectory !== true)) return false;
      parent += `/${parts[i]}`;
    }
    return true;
  }
  async function read(path) {
    if (files.has(path)) return files.get(path);
    if (files.size >= maxFiles) {
      limit(`Discovery file limit reached (${maxFiles})`);
      return null;
    }
    files.set(path, null);
    try {
      const text = await io.read(path);
      if (typeof text !== 'string') throw new TypeError('io.read must return a string');
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`File exceeds maxBytes (${maxBytes})`);
      files.set(path, text);
      return text;
    } catch (error) {
      warn(path, `Cannot read file: ${message(error)}`);
      return null;
    }
  }
  async function toml(path) {
    const text = await read(path);
    if (text === null) return null;
    try { return parseToml(text.replace(/^\uFEFF/u, '')); }
    catch (error) { warn(path, `Invalid or unsupported TOML: ${message(error)}`); return null; }
  }
  async function claude(path) {
    const text = await read(path);
    if (text === null) return;
    try {
      const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
      const match = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)([\s\S]*)$/u.exec(normalized);
      if (!match) throw new Error('Expected opening and closing YAML frontmatter delimiters');
      const metadata = yamlMetadata(match[1]);
      if (typeof metadata.name !== 'string' || !metadata.name.trim()) throw new Error('name must be a non-empty string');
      if (typeof metadata.description !== 'string' || !metadata.description.trim()) throw new Error('description must be a non-empty string');
      const localWarnings = [];
      const ignored = ['tools', 'disallowedTools', 'permissionMode', 'model', 'hooks', 'skills', 'memory', 'isolation'].filter(key => has(metadata, key));
      if (ignored.length) localWarnings.push(`DSH does not import runtime fields: ${ignored.join(', ')}`);
      const instructions = match[2].trim();
      if (!instructions) localWarnings.push('Markdown instructions are empty');
      agents.push({ id: `claude:${path.slice('.claude/agents/'.length, -3)}`, source: 'claude',
        name: metadata.name, description: metadata.description, instructions, path, metadata, warnings: localWarnings });
    } catch (error) { warn(path, `Invalid or unsupported Claude agent: ${message(error)}`); }
  }
  async function walkClaude(path, depth) {
    for (const entry of await list(path)) {
      if (files.size >= maxFiles) { limit(`Discovery file limit reached (${maxFiles})`); break; }
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory === true) {
        if (depth >= maxDepth) warn(child, `Discovery depth limit reached (${maxDepth})`);
        else await walkClaude(child, depth + 1);
      } else if (entry.isFile === true && entry.name.endsWith('.md')) await claude(child);
    }
  }
  if (await directory('.claude', 'agents')) await walkClaude('.claude/agents', 0);

  const consumedPaths = new Set(), registeredRoles = new Set();
  function addCodex(role, registration, config, path, compatibility = false) {
    if (!validSegment(role)) { warn(path, 'Rejected unsafe Codex role name'); return; }
    if (registration.description !== undefined && typeof registration.description !== 'string') {
      warn(path, `Codex role ${role}: description must be a string`); return;
    }
    if (config.description !== undefined && typeof config.description !== 'string') {
      warn(path, `Codex role ${role}: file description must be a string`); return;
    }
    if (config.developer_instructions !== undefined && typeof config.developer_instructions !== 'string') {
      warn(path, `Codex role ${role}: developer_instructions must be a string`); return;
    }
    const description = registration.description ?? config.description ?? '';
    const instructions = config.developer_instructions ?? '';
    const localWarnings = [];
    const ignored = Object.keys(config).filter(key => !['name', 'description', 'developer_instructions'].includes(key));
    if (ignored.length) localWarnings.push(`DSH does not import runtime fields: ${ignored.join(', ')}`);
    if (!description.trim()) localWarnings.push('Codex description is empty');
    if (!instructions.trim()) localWarnings.push('Codex developer_instructions are empty; built-in/global defaults are not imported');
    if (compatibility) localWarnings.push('Compatibility discovery of unregistered .codex/agents/*.toml');
    agents.push({ id: `codex:${role}`, source: 'codex', name: role, description, instructions,
      path, metadata: { ...config, registration: { ...registration } }, warnings: localWarnings });
  }
  const codexEntries = await list('.codex');
  if (codexEntries.some(entry => entry.name === 'config.toml' && entry.isFile === true)) {
    const config = await toml('.codex/config.toml');
    if (config && config.agents !== undefined) {
      if (!isRecord(config.agents)) warn('.codex/config.toml', 'agents must be a TOML table');
      else for (const role of Object.keys(config.agents).sort()) {
        if (agentSettings.has(role)) continue;
        const registration = config.agents[role];
        registeredRoles.add(role);
        if (!isRecord(registration)) { warn('.codex/config.toml', `Codex role ${role} must be a TOML table`); continue; }
        if (!has(registration, 'config_file')) {
          addCodex(role, registration, {}, '.codex/config.toml');
          continue;
        }
        const reference = registration.config_file;
        // Stricter than Codex itself: no absolute paths, parent traversal, or
        // files outside .codex, even when still inside the workspace.
        if (typeof reference !== 'string' || !reference || reference.startsWith('/') ||
          reference.startsWith('\\') || /^[A-Za-z]:/u.test(reference)) {
          warn('.codex/config.toml', `Codex role ${role}: rejected config_file path`); continue;
        }
        const parts = reference.replace(/\\/gu, '/').split('/').filter(part => part !== '.');
        if (!parts.length || parts.some(part => !validSegment(part)) || !parts.at(-1).endsWith('.toml')) {
          warn('.codex/config.toml', `Codex role ${role}: rejected config_file path`); continue;
        }
        const path = `.codex/${parts.join('/')}`;
        consumedPaths.add(path);
        if (!await checkedFile(path)) { warn(path, `Codex role ${role}: config_file is missing, not a file, or rejected`); continue; }
        const layer = await toml(path);
        if (layer) addCodex(role, registration, layer, path);
      }
    }
  }
  if (codexEntries.some(entry => entry.name === 'agents' && entry.isDirectory === true)) {
    for (const entry of await list('.codex/agents')) {
      if (entry.isFile !== true || !entry.name.endsWith('.toml')) continue;
      const path = `.codex/agents/${entry.name}`;
      if (consumedPaths.has(path)) continue;
      const layer = await toml(path);
      if (!layer) continue;
      if (layer.name !== undefined && (typeof layer.name !== 'string' || !layer.name.trim())) {
        warn(path, 'Compatibility Codex name must be a non-empty string'); continue;
      }
      const role = layer.name ?? entry.name.slice(0, -5);
      if (registeredRoles.has(role) || agents.some(agent => agent.id === `codex:${role}`)) {
        warn(path, `Duplicate Codex role ${role}; configured/earlier role takes precedence`); continue;
      }
      if (typeof layer.developer_instructions !== 'string') {
        warn(path, 'Compatibility Codex file requires string developer_instructions'); continue;
      }
      addCodex(role, {}, layer, path, true);
    }
  }
  agents.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { agents, warnings };
}
