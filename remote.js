import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

export function installCatalogRemote(ctx, list) {
  const initializers = [];
  class WorkspaceAgentCatalog extends TypertRemoteService {
    constructor(ctx) {
      super(ctx, 'discoverAgents');
      for (const initialize of initializers) initialize.call(this);
    }
    async catalog(agent, signal) {
      const value = await list.execute({}, { agent, signal });
      signal.throwIfAborted();
      return value;
    }
  }
  Remote(WorkspaceAgentCatalog.prototype.catalog, {
    kind: 'method', name: 'catalog', private: false, static: false,
    addInitializer(initialize) { initializers.push(initialize); },
  });
  return ctx.plugin(WorkspaceAgentCatalog);
}
