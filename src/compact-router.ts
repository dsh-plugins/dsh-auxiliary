/**
 * Auxiliary-model routing for compaction summaries.
 *
 * A `llm/stream` waterfall listener: every call classified with
 * `purpose: 'compaction'` (issued by the compaction backend for its summary
 * request) is rerouted to the configured auxiliary summarizer pair, while the
 * conversation's own model route stays untouched. This is what makes "compress
 * the context with a separate model" work without touching the compaction
 * backend's own configuration. When no auxiliary route is configured the
 * listener is a pure pass-through.
 *
 * @module dsh-auxiliary/compact-router
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { deepFreeze } from './dsh.js';
import type { ResolvedPluginConfig } from './config.js';

/** The configured auxiliary summarizer route, or undefined when routing is off. */
export function compactRoute(get: () => ResolvedPluginConfig): { provider: string; model: string } | undefined {
  const compact = get().compact;
  if (!compact.enabled || compact.provider.length === 0 || compact.model.length === 0) return undefined;
  return { provider: compact.provider, model: compact.model };
}

/**
 * Install the compaction rerouting middleware. The waterfall listener returns
 * its own stream when rerouting is needed (guarded against re-entry by the
 * route match check) and delegates via `next()` otherwise.
 */
export function installCompactRouter(ctx: Context, get: () => ResolvedPluginConfig): () => void {
  return ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    if (options.purpose !== 'compaction') return next();
    const route = compactRoute(get);
    if (route === undefined) return next();
    if (options.provider === route.provider && options.model === route.model) return next();
    const rerouted = deepFreeze({ ...options, provider: route.provider, model: route.model });
    return ctx.llm.stream(rerouted);
  });
}
