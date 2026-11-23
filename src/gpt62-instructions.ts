import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { HostAPI } from '@dsh-plugin/dsh-loader';
import { isResponsesProtocol } from './provider-options.js';

interface Route { provider: string; model: string }
interface Request extends Route { purpose?: string; sessionId?: string }
interface Prepared { stream(request: Request): AsyncIterable<unknown> }
type Prepare = (config: Route, ...args: unknown[]) => Promise<Prepared>;
interface Descriptor { api?: string; compat?: Record<string, unknown> }
interface AdapterPrepared { model: { systemPromptUpdate?: string }; stream(request: Request): AsyncIterable<unknown> }
interface Adapter {
  prepareCall?: (provider: string, model: string, ...args: unknown[]) => Promise<AdapterPrepared>;
  modelOf?: (snapshot: unknown, provider: string, model: string) => Descriptor;
}
interface Runtime {
  prepareCall?: Prepare;
  registration?(provider: string): { adapter?: Adapter };
}

// These are the stock Host builds whose prepare/stream descriptor seam is tested.
export function supportsGpt62InstructionsHost(version?: string): boolean {
  return /^0\.2\.(?:2-rc\.5|3-alpha\.2)(?:\+[0-9A-Za-z.-]+)?$/.test(version ?? '');
}

export function isGpt62Model(model: string): boolean {
  return /^gpt-6\.2(?:$|[-_.:][a-z][a-z0-9._:-]*$|[-_:]\d[a-z0-9._:-]*$)/i.test(model);
}

export function preserveInstructionsPrefix<T extends Descriptor>(model: T, name: string): T {
  if (!isGpt62Model(name) || !isResponsesProtocol(model.api) || model.compat?.supportsMidConvoSystemMessages === true) return model;
  return { ...model, compat: { ...model.compat, supportsMidConvoSystemMessages: true } };
}

/** Run only model lookup for a genuine agent request; leave the stored transcript and SDK payload alone. */
export function installGpt62Instructions(ctx: Context, patch: HostAPI['patch']): () => void {
  const runtime = (Reflect.get(ctx.llm, Symbol.for('cordis.original')) ?? ctx.llm) as Runtime;
  if (typeof runtime.prepareCall !== 'function' || typeof runtime.registration !== 'function') return () => {};

  // Use object identity from the actual agent/request waterfall, not a user/model-provided flag.
  const marked = new WeakSet<Route>();
  type Lookup = { route: Route; phase: 'prepare' | 'stream'; consumed: boolean; changed?: boolean };
  const scope = new AsyncLocalStorage<Lookup>();
  const adapterHooks = new Map<Adapter, () => void>();
  const agentHooks = new Map<Agent, () => void>();
  let active = true;
  const hookAgent = (agent: Agent) => {
    if (agentHooks.has(agent)) return;
    agentHooks.set(agent, agent.ctx.on('agent/request', async (_payload, next) => {
      const config = await next();
      if (active && isGpt62Model(config.model)) marked.add(config);
      return config;
    }, { prepend: true }));
  };
  const hookAdapter = (adapter: Adapter) => {
    if (adapterHooks.has(adapter) || typeof adapter.modelOf !== 'function' || typeof adapter.prepareCall !== 'function') return;
    const handle = patch.method(adapter as Required<Adapter>, 'modelOf', original => function(this: Adapter, snapshot, provider, model) {
      const descriptor = original.call(this, snapshot, provider, model);
      const call = scope.getStore();
      if (!active || call === undefined || call.consumed || provider !== call.route.provider || model !== call.route.model) return descriptor;
      call.consumed = true;
      const adapted = preserveInstructionsPrefix(descriptor, model);
      call.changed = adapted !== descriptor;
      if (call.phase !== 'stream' || adapted === descriptor) return descriptor;
      // pi-ai couples additional_tools to the same capability. Leave its previous
      // effective tool layout intact; this clone is only for the current stream.
      return adapted.compat?.supportsAdditionalTools === true
        ? { ...adapted, compat: { ...adapted.compat, supportsAdditionalTools: false } }
        : adapted;
    }, { id: 'dsh-auxiliary:gpt-6.2-instructions-model' });
    try {
      const prepared = patch.method(adapter as Required<Adapter>, 'prepareCall', original => async function(this: Adapter, provider, model, ...args) {
        const call = scope.getStore();
        const result = await original.call(this, provider, model, ...args);
        if (!active || call?.phase !== 'prepare' || !call.changed || provider !== call.route.provider || model !== call.route.model) return result;
        // Do not enable unrelated tool-update capabilities from conversationUpdates.
        return { ...result, model: { ...result.model, systemPromptUpdate: 'in-history' } };
      }, { id: 'dsh-auxiliary:gpt-6.2-instructions-adapter-prepare' });
      adapterHooks.set(adapter, () => { prepared.dispose(); handle.dispose(); });
    } catch (error) {
      handle.dispose();
      throw error;
    }
  };
  const prepare = patch.method(runtime as Required<Runtime>, 'prepareCall', original => async function(this: Runtime, config, ...args) {
    if (!active || !marked.delete(config)) return original.call(this, config, ...args);
    let adapter: Adapter | undefined;
    try { adapter = this.registration?.(config.provider).adapter; }
    catch { return original.call(this, config, ...args); } // preserve host errors and fallback
    if (adapter === undefined || typeof adapter.modelOf !== 'function' || typeof adapter.prepareCall !== 'function') return original.call(this, config, ...args);
    hookAdapter(adapter);
    const lookup: Lookup = { route: config, phase: 'prepare', consumed: false };
    const result = await scope.run(lookup, () => original.call(this, config, ...args));
    if (!lookup.changed) return result;
    return Object.freeze({
      ...result,
      stream(this: Prepared, request: Request): AsyncIterable<unknown> {
        if (!active || request.purpose !== undefined || request.sessionId === undefined || request.provider !== config.provider || request.model !== config.model) {
          return result.stream(request);
        }
        // Preserve synchronous host errors, the original request identity, and async-iterator disposal.
        const call: Lookup = { route: config, phase: 'stream', consumed: false };
        const iterator = scope.run(call, () => result.stream(request)[Symbol.asyncIterator]());
        return {
          [Symbol.asyncIterator]() {
            return {
              next: value => scope.run(call, () => iterator.next(value)),
              return: value => scope.run(call, () => iterator.return?.(value) ?? Promise.resolve({ done: true, value })),
              throw: error => scope.run(call, () => iterator.throw?.(error) ?? Promise.reject(error)),
            };
          },
        };
      },
    });
  }, { id: 'dsh-auxiliary:gpt-6.2-instructions-prepare' });

  for (const agent of ctx.get('agents')?.list() ?? []) hookAgent(agent);
  const created = ctx.on('agent/created', ({ agent }) => { hookAgent(agent); });
  const disposed = ctx.on('agent/disposed', ({ agent }) => { agentHooks.get(agent)?.(); agentHooks.delete(agent); });
  return () => {
    active = false;
    created(); disposed(); prepare.dispose();
    for (const remove of agentHooks.values()) remove();
    for (const remove of adapterHooks.values()) remove();
    agentHooks.clear();
    adapterHooks.clear();
  };
}
