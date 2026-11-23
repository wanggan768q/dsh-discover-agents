window.__ModuleLoader__.load({
  id: 'dsh-discover-agents',
  factory() {
    // Pure source logic is kept in this artifact so Git installs need no build step.
    function createSource({ load, execute, hint }) {
      const snapshots = new Map();
      let disposed = false;
      function rows(catalog) {
        const reserved = new Set(catalog.commands || []);
        const counts = new Map();
        for (const role of catalog.agents) {
          const base = role.id.slice(role.id.indexOf(':') + 1).split('/').pop();
          counts.set(base, (counts.get(base) || 0) + 1);
        }
        return catalog.agents.map(role => {
          const base = role.id.slice(role.id.indexOf(':') + 1).split('/').pop();
          const alias = /^[a-z][a-z0-9_-]*$/.test(base) && counts.get(base) === 1 && !reserved.has(base) ? base : undefined;
          // Persist the exact role identity, never a short alias that can change owners.
          const name = `local-agent:${encodeURIComponent(role.id)}`;
          return { name, label: base, description: role.description, value: role.id, alias };
        });
      }
      async function refresh(session, signal) {
        signal?.throwIfAborted();
        const catalog = await load(session.sessionId, signal);
        signal?.throwIfAborted();
        const result = rows(catalog);
        if (!disposed) snapshots.set(session.sessionId, result);
        return result;
      }
      function claim(session, row) {
        return {
          name: row.name, token: `/${row.name} `, hint: hint(),
          async submit(args, _actx, attachments) {
            if (disposed) return { kind: 'error', text: 'Local agent source is no longer active' };
            // The Host operation re-scans and validates the role before dispatch.
            const main = /^\s*--main(?=\s|$)/.test(args);
            const task = main ? args.replace(/^\s*--main(?:\s+|$)/, '') : args;
            return execute(session.sessionId, `/workspace-agent ${main ? '--main ' : ''}${row.value} ${task}`, attachments);
          },
        };
      }
      function find(session, token) {
        const name = token.trim().replace(/^\//, '');
        return snapshots.get(session.sessionId)?.find(row => row.name === name || row.alias === name);
      }
      return {
        source: {
          trigger: '/', name: 'local-agents', order: 10,
          async candidates(session, req) {
            if (req.position !== 'leading' || disposed) return [];
            const result = await refresh(session, req.signal);
            const query = req.query.trim().toLocaleLowerCase();
            return result.filter(row => !query || [row.name, row.label].some(value => {
              let cursor = 0;
              for (const char of value.toLocaleLowerCase()) if (char === query[cursor]) cursor++;
              return cursor === query.length;
            }));
          },
          onPick({ session, candidate, position }) {
            if (position !== 'leading' || disposed) return undefined;
            return { claim: claim(session, candidate) };
          },
          matchSpace(session, token) {
            const row = find(session, token);
            return row && !disposed ? { claim: claim(session, row) } : undefined;
          },
          async matchClaim(session, token, signal) {
            if (!token.trim().startsWith('/local-agent:') || disposed) return undefined;
            await refresh(session, signal);
            const name = token.trim().slice(1);
            const id = decodeURIComponent(name.slice('local-agent:'.length));
            if (!/^(claude|codex):\S+$/.test(id)) throw new Error('Invalid local agent token');
            // Keep removed roles claimed; Host then reports not-found instead of a model fallback.
            return claim(session, { name, value: id });
          },
          async matchEnter(session, line, signal, envelope) {
            if (disposed) return undefined;
            const token = line.split(/\s/)[0];
            const qualified = token.startsWith('/local-agent:');
            const hot = find(session, token);
            try { await refresh(session, signal); }
            catch (error) {
              signal.throwIfAborted();
              if (qualified || hot) throw error;
              return undefined;
            }
            let row = find(session, token) || hot;
            if (qualified && !row) {
              const name = token.slice(1);
              const id = decodeURIComponent(name.slice('local-agent:'.length));
              if (!/^(claude|codex):\S+$/.test(id)) throw new Error('Invalid local agent token');
              row = { name, value: id };
            }
            if (!row || disposed) return undefined;
            if (envelope.attachments) throw new Error('Local agent commands do not support attachments');
            return { claim: claim(session, row) };
          },
        },
        dispose() { disposed = true; snapshots.clear(); },
      };
    }
    return {
      inject: ['inputTriggers', 'sessions', 'connection', 'remote', 'remote.commands'],
      createSource,
      apply(ctx) {
        const installed = createSource({
          hint: () => '输入完整任务；默认创建子 agent；--main 由当前 agent 执行',
          async load(sessionId, signal) {
            const sessions = ctx.sessions;
            if (sessions.subagentAddress(sessionId) !== undefined) return { agents: [], commands: [] };
            if (!sessions.binding(sessionId)) throw new Error(`Local agents require a retained session "${sessionId}"`);
            return sessions.using(sessionId, { source: 'workspaceAgentCatalog', signal }, async reference => {
              const state = reference.binding.session.getSnapshot();
              if (state.openState !== 'open') throw state.openError || new Error(`Session "${sessionId}" is not open`);
              const result = await ctx.connection.rpc.call('/api', 'discoverAgents/catalog', { args: { agentId: sessionId } }, signal);
              if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
              const catalog = result.value;
              if (!catalog || !Array.isArray(catalog.agents) || !Array.isArray(catalog.commands)
                || catalog.commands.some(name => typeof name !== 'string')
                || catalog.agents.some(role => !role || typeof role.id !== 'string' || !/^(claude|codex):\S+$/.test(role.id) || typeof role.description !== 'string')) {
                throw new Error('Invalid local agent catalog');
              }
              return catalog;
            });
          },
          async execute(sessionId, line, attachments) {
            if (attachments.length) return { kind: 'error', text: 'Local agent commands do not support attachments' };
            try {
              const response = await ctx.remote.commands.execute(sessionId, line, []);
              if (!response.ok) return { kind: 'error', text: `${response.error.code}: ${response.error.message}` };
              const outcome = response.value?.result;
              if (!outcome) return { kind: 'error', text: 'Local agent dispatch command is unavailable' };
              return outcome.kind === 'error' ? outcome : { kind: 'success' };
            } catch (error) {
              return { kind: 'error', text: String(error.message || error) };
            }
          },
        });
        ctx.effect(() => {
          const unregister = ctx.inputTriggers.registerSource(installed.source);
          return () => { installed.dispose(); unregister(); };
        });
      },
    };
  },
});
