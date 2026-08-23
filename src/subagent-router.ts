/**
 * Subagent model routing: a dedicated provider/model pair for delegated
 * children.
 *
 * Child agents (one-shot subagents and continuable descendants) inherit their
 * parent's model route by default (`resolveChildAgentOptions`). This module
 * lets dsh-auxiliary pin every child to its own route instead. It is a pure
 * dsh-auxiliary feature — no external plugin required.
 *
 * Mechanism: the plugin listens for `agent/created` (a scope-filtered emit
 * that untagged listeners — plain plugin contexts like this one — receive
 * globally). For each agent whose delegation depth is > 0 (a subagent, by
 * `delegationDepthOf`), and only while the subagent route is active, it
 * installs an `agent/request` waterfall listener on the agent's own scoped
 * context. That listener awaits the frozen call configuration the loop would
 * use and returns a replacement with the dedicated provider/model — the
 * official "return a replacement to switch" contract, so the loop logs the
 * changed header snapshot and the next request uses the new route.
 *
 * The agent-scoped listener is registered on `agent.ctx`, which unwinds on
 * disposal, so no manual cleanup is needed per agent; the module only owns the
 * single `agent/created` listener on the plugin context.
 *
 * Scope notes: the `agent/created` and `agent/request` events are
 * agent-scoped, but dsh-scope carriers admit untagged listeners globally, and
 * an agent-scoped listener registered on `agent.ctx` receives only that
 * agent's requests — the same pattern the agent runtime itself uses for model
 * selection (`installModelSelection`).
 *
 * Coverage: every in-process child that publishes an `agent/created` event —
 * one-shot spawns, forks, and cold-resumed continuable children. Remote
 * providers (ACP) never register a process-local agent and are unaffected;
 * their children keep inheriting the parent route.
 *
 * @module dsh-auxiliary/subagent-router
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { dsh } from './dsh.js';
import type { ResolvedPluginConfig } from './config.js';

/**
 * Install the subagent routing listener. Returns a disposer that removes the
 * single `agent/created` listener; per-agent `agent/request` listeners unwind
 * with their agent.
 *
 * @param ctx - the plugin context (untagged, so it observes every agent).
 * @param get - current resolved plugin config snapshot.
 */
export function registerSubagentRouter(ctx: Context, get: () => ResolvedPluginConfig): () => void {
  const installFor = (agent: Agent): void => {
    // Depth zero is a top-level agent; only delegated children are routed.
    if (dsh().subagent.delegationDepthOf(agent) <= 0) return;
    const subagent = get().subagent;
    if (!subagent.enabled || subagent.provider === undefined || subagent.model === undefined) return;
    const { provider, model } = subagent;
    agent.ctx.on('agent/request', async (_payload, next) => {
      const config = await next();
      if (config.provider === provider && config.model === model) return config;
      return { ...config, provider, model };
    });
  };

  const disposeListener = ctx.on('agent/created', (payload) => {
    installFor(payload.agent);
  });

  return () => {
    disposeListener();
  };
}
