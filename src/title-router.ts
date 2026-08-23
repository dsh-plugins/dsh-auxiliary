/**
 * Auxiliary-model routing for session titles.
 *
 * DSH generates session titles through the `dsh-session-title-llm` provider,
 * which already supports its own `provider`/`model` deployment config — but
 * that config is loader-owned and not user-facing. A `llm/stream` waterfall
 * listener lets dsh-auxiliary provide a dedicated title model instead: every
 * call classified with `purpose: 'session-title'` (the provider's official
 * request marker) is rerouted to the configured pair, while the conversation's
 * own route stays untouched. When the title feature is off or the route is
 * incomplete the listener is a pure pass-through.
 *
 * The marker is an official `GenerateOptions.purpose` value (only `compaction`
 * and `session-title` exist), so recognition needs no heuristic and cannot
 * collide with agent-loop or approval calls. Rerouting deep-freezes a copy and
 * re-enters the waterfall; the provider/model equality check makes the
 * re-entrant call a pass-through, so no re-entry guard is needed.
 *
 * @module dsh-auxiliary/title-router
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { deepFreeze } from './dsh.js';
import type { ResolvedPluginConfig } from './config.js';

/** The configured title route, or undefined when routing is off. */
export function titleRoute(get: () => ResolvedPluginConfig): { provider: string; model: string } | undefined {
  const title = get().title;
  if (!title.enabled || title.provider === undefined || title.model === undefined) return undefined;
  return { provider: title.provider, model: title.model };
}

/**
 * Install the session-title rerouting middleware. The waterfall listener
 * returns its own stream when rerouting is needed and delegates via `next()`
 * otherwise.
 */
export function installTitleRouter(ctx: Context, get: () => ResolvedPluginConfig): () => void {
  return ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    if (options.purpose !== 'session-title') return next();
    const route = titleRoute(get);
    if (route === undefined) return next();
    if (options.provider === route.provider && options.model === route.model) return next();
    const rerouted = deepFreeze({ ...options, provider: route.provider, model: route.model });
    return ctx.llm.stream(rerouted);
  });
}
