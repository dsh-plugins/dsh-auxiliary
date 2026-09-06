/**
 * Image handoff: let a text-only main model work with chat images by letting
 * the selected vision model describe them.
 *
 * The `llm/stream` waterfall sees every generation call. Its listener resolves
 * through the captured real `resolveModelInfo`: native image-capable routes pass
 * through, while text-only or undeclared routes receive immutable references.
 * A request-local guard permits concurrent rewritten dispatches. A scoped
 * resolver wrapper advertises handoff-backed image admission for text-only main
 * routes, but never inflates the selected auxiliary route used by `askVision`.
 *
 * @module dsh-auxiliary/image-handoff
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm';
import { deepFreeze } from './dsh.js';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { ResolvedPluginConfig } from './config.js';

/** Whether one request targets the configured auxiliary vision route itself. */
function isVisionRoute(
  options: Pick<GenerateOptions, 'provider' | 'model'>,
  vision: ResolvedPluginConfig['vision'],
): boolean {
  return options.provider === vision.provider && options.model === vision.model;
}

/** Serialize one image block into the text reference a text-only model can act on. */
function imageReference(attachment: ImageAttachmentRef): string {
  return `[image: ${JSON.stringify(attachment)}]`;
}

/**
 * Rewrite one content block. Image blocks become text references; tool-result
 * blocks are recursed so an image nested inside a tool result (exactly how the
 * core `read_image` tool renders its output) is rewritten too. The adapter
 * image walk (`contentHasImage`) recurses into tool-result content, so a
 * top-level-only rewrite would leave a nested image visible to text-only
 * adapters — the failure this recursion exists to prevent.
 */
function rewriteBlock(block: ContentBlock): { block: ContentBlock; changed: boolean } {
  if (block.type === 'image') {
    return { block: { type: 'text', text: imageReference(block.attachment) }, changed: true };
  }
  if (block.type === 'tool-result') {
    let changed = false;
    const content = block.content.map((child) => {
      const result = rewriteBlock(child);
      if (result.changed) changed = true;
      return result.block;
    });
    if (changed) return { block: { ...block, content }, changed: true };
  }
  return { block, changed: false };
}

/** Rewrite image blocks into text references; returns a fresh request when changed. */
function rewriteImages(options: GenerateOptions): GenerateOptions | undefined {
  let changed = false;
  const messages = options.messages.map((message) => {
    // Tool-result messages share the user role; both carry image blocks.
    if (message.role !== 'user') return message;
    const content = message.content;
    if (!Array.isArray(content)) return message;
    let contentChanged = false;
    const nextContent = content.map((block) => {
      const result = rewriteBlock(block);
      if (result.changed) contentChanged = true;
      return result.block;
    });
    if (!contentChanged) return message;
    changed = true;
    return { ...message, content: nextContent };
  });
  if (!changed) return undefined;
  return deepFreeze({ ...options, messages });
}

/**
 * Install capability-aware image-handoff stream and admission seams.
 *
 * Native image-capable routes retain their original `ImageBlock`s. Text-only
 * and undeclared routes are rewritten to durable `[image: ...]` references.
 * The returned disposer is idempotent and will not overwrite a resolver wrapper
 * installed by another plugin after this one.
 */
export function registerImageHandoff(ctx: Context, get: () => ResolvedPluginConfig): () => void {
  let live = true;
  const enabled = (): boolean => {
    if (!live) return false;
    const resolved = get();
    const vision = resolved.vision;
    return resolved.tool.enabled && vision.handoff && vision.provider !== undefined && vision.model !== undefined;
  };

  // Keep both forms: the bound resolver is the capability source used by the
  // stream seam, while the unbound function is restored by exact identity.
  const originalResolve = ctx.llm.resolveModelInfo;
  const resolveReal = originalResolve.bind(ctx.llm);

  // Request-local guard: rewritten dispatches re-enter the waterfall, while
  // unrelated concurrent requests must continue to receive capability checks.
  const rewrittenRequests = new WeakSet<GenerateOptions>();
  const disposeListener = ctx.on('llm/stream', (options, next) => {
    if (rewrittenRequests.has(options) || !enabled()) return next();
    const vision = get().vision;
    if (isVisionRoute(options, vision)) return next();
    const rewritten = rewriteImages(options);
    if (rewritten === undefined) return next();

    return (async function* () {
      // Iteration starts lazily, so re-check disposal before doing async work.
      if (!live) {
        yield* next();
        return;
      }
      const info = await resolveReal(options.provider, options.model, options.signal);
      // Capability lookup can outlive plugin teardown. Never begin a rewritten
      // dispatch once disposal has started; continue the already-entered chain.
      if (!live || info.inputModalities?.includes('image')) {
        yield* next();
        return;
      }
      rewrittenRequests.add(rewritten);
      try {
        yield* ctx.llm.stream(rewritten);
      } finally {
        rewrittenRequests.delete(rewritten);
      }
    })();
  });

  const resolveWithHandoff: Context['llm']['resolveModelInfo'] = async (provider, model, signal) => {
    const info = await resolveReal(provider, model, signal);
    const vision = get().vision;
    if (enabled() && !isVisionRoute({ provider, model }, vision)
      && info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      return { ...info, inputModalities: [...info.inputModalities, 'image'] };
    }
    return info;
  };
  ctx.llm.resolveModelInfo = resolveWithHandoff;

  return () => {
    if (!live) return;
    live = false;
    disposeListener();
    // Do not clobber a wrapper another plugin installed after registration.
    if (ctx.llm.resolveModelInfo === resolveWithHandoff) {
      ctx.llm.resolveModelInfo = originalResolve;
    }
  };
}

/** Re-export for tests: serialize one attachment ref into its chat reference. */
export { imageReference };
