import path from 'node:path';

// Use the caller's composed filesystem, never the Host's native filesystem.
export async function createWorkspaceIO(fs, cwd, signal, maxBytes = 262144) {
  const root = await fs.resolve(cwd, { signal });
  async function targetFor(input) {
    signal?.throwIfAborted();
    const relative = path.relative(cwd, path.resolve(cwd, input));
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('Agent path must stay inside the current workspace');
    }
    let current = cwd;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const info = await fs.lstat(current, { cwd }, signal);
      if (info?.type === 'symlink') throw new Error('Symbolic links in agent paths are not supported');
    }
    const target = await fs.resolve(input, { cwd, signal });
    if (!fs.contains(root, target)) throw new Error('Resolved agent path leaves the workspace');
    return target;
  }
  return {
    async list(input, { maxEntries = 10000 } = {}) {
      if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new TypeError('maxEntries must be a non-negative safe integer');
      signal?.throwIfAborted();
      if (maxEntries === 0) return [];
      const target = await targetFor(input);
      const info = await fs.stat(target, signal);
      if (!info) return [];
      if (info.type !== 'directory') {
        throw Object.assign(new Error(`Not an agent directory: ${input}`), { code: 'ENOTDIR' });
      }
      // listDir itself has no bounded/paged API. Bound our extra lstat calls
      // before starting them, and keep at most one metadata request in flight.
      const entries = await fs.listDir(target, signal);
      const result = [];
      for (let index = 0; index < Math.min(entries.length, maxEntries); index++) {
        signal?.throwIfAborted();
        const entry = entries[index];
        const info = await fs.lstat(path.join(cwd, input, entry.name), { cwd }, signal);
        result.push({
          name: entry.name, isFile: info?.type === 'file',
          isDirectory: info?.type === 'directory', isSymbolicLink: info?.type === 'symlink',
        });
      }
      signal?.throwIfAborted();
      // Discovery consumes this flag without including it in tool output.
      if (entries.length > maxEntries) result.truncated = true;
      return result;
    },
    async read(input) {
      const target = await targetFor(input);
      const bytes = await fs.readBytes(target, signal, maxBytes);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    },
  };
}
