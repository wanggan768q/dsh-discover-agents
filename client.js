window.__ModuleLoader__.load({
  id: 'dsh-discover-agents',
  factory() {
    // Pure source logic is kept in this artifact so Git installs need no build step.
    const validId = id => typeof id === 'string' && /^(claude|codex):[^\0-\x1f]+$/u.test(id);
    function createSource({ load, execute, hint, enabled = () => true }) {
      let disposed = false;
      function rows(catalog) {
        return catalog.agents.map(role => {
          const base = role.id.slice(role.id.indexOf(':') + 1).split('/').pop();
          // Persist the exact role identity, never a short name that can change owners.
          const name = `local-agent:${encodeURIComponent(role.id)}`;
          return { name, label: base, description: role.description, value: role.id };
        });
      }
      async function refresh(session, signal) {
        signal?.throwIfAborted();
        const catalog = await load(session.sessionId, signal);
        signal?.throwIfAborted();
        return rows(catalog);
      }
      function parseToken(token) {
        const text = token.trim();
        if (!text.startsWith('@local-agent:')) return undefined;
        const encoded = text.slice('@local-agent:'.length);
        let id;
        try { id = decodeURIComponent(encoded); }
        catch { throw new Error('Invalid local agent token'); }
        if (!validId(id) || encoded !== encodeURIComponent(id)) throw new Error('Invalid local agent token');
        return { name: text.slice(1), value: id };
      }
      function claim(session, row) {
        return {
          name: row.name, token: `@${row.name} `, hint: hint(),
          async submit(args, _actx, attachments) {
            if (disposed || !enabled(session)) return { kind: 'error', text: 'Local agent source is no longer active' };
            // The Host operation re-scans and validates the role before dispatch.
            const main = /^\s*--main(?=\s|$)/.test(args);
            const task = main ? args.replace(/^\s*--main(?:\s+|$)/, '') : args;
            const id = /\s/.test(row.value) ? JSON.stringify(row.value) : row.value;
            return execute(session.sessionId, `/workspace-agent ${main ? '--main ' : ''}${id} ${task}`, attachments);
          },
        };
      }
      return {
        source: {
          trigger: '@', name: 'local-agents', order: 10,
          async candidates(session, req) {
            if (req.position !== 'leading' || disposed || !enabled(session)) return [];
            const result = await refresh(session, req.signal);
            if (disposed || !enabled(session)) return [];
            const query = req.query.trim().toLocaleLowerCase();
            return result.filter(row => !query || [row.name, row.label, row.description].some(value => {
              let cursor = 0;
              for (const char of value.toLocaleLowerCase()) if (char === query[cursor]) cursor++;
              return cursor === query.length;
            }));
          },
          onPick({ session, candidate, position }) {
            if (position !== 'leading' || disposed || !enabled(session)) return undefined;
            return { claim: claim(session, candidate) };
          },
          matchSpace(session, token) {
            if (disposed || !enabled(session)) return undefined;
            const row = parseToken(token);
            return row ? { claim: claim(session, row) } : undefined;
          },
          async matchClaim(session, token, signal) {
            if (disposed || !enabled(session)) return undefined;
            const row = parseToken(token);
            if (!row) return undefined;
            await refresh(session, signal);
            if (disposed || !enabled(session)) return undefined;
            // Keep removed roles claimed; Host then reports not-found instead of a model fallback.
            return claim(session, row);
          },
          async matchEnter(session, line, signal, envelope) {
            if (disposed || !enabled(session)) return undefined;
            // Only a leading reserved token is ours; other @ consumers never require our RPC.
            const row = parseToken(line.split(/\s/)[0]);
            if (!row) return undefined;
            await refresh(session, signal);
            if (disposed || !enabled(session)) return undefined;
            if (envelope.attachments) throw new Error('Local agent commands do not support attachments');
            return { claim: claim(session, row) };
          },
        },
        dispose() { disposed = true; },
      };
    }
    return {
      inject: ['inputTriggers', 'sessions', 'connection', 'remote', 'remote.commands'],
      createSource,
      apply(ctx) {
        const installed = createSource({
          enabled: session => ctx.sessions.subagentAddress(session.sessionId) === undefined,
          hint: () => '输入完整任务；默认创建子 agent；--main 由当前 agent 执行',
          async load(sessionId, signal) {
            const sessions = ctx.sessions;
            if (sessions.subagentAddress(sessionId) !== undefined) return { agents: [] };
            if (!sessions.binding(sessionId)) throw new Error(`Local agents require a retained session "${sessionId}"`);
            return sessions.using(sessionId, { source: 'workspaceAgentCatalog', signal }, async reference => {
              const state = reference.binding.session.getSnapshot();
              if (state.openState !== 'open') throw state.openError || new Error(`Session "${sessionId}" is not open`);
              const result = await ctx.connection.rpc.call('/api', 'discoverAgents/catalog', { args: { agentId: sessionId } }, signal);
              if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
              const catalog = result.value;
              if (!catalog || !Array.isArray(catalog.agents)
                || catalog.agents.some(role => !role || !validId(role.id) || typeof role.description !== 'string')) {
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
