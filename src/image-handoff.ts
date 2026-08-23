/**
 * Image handoff: let a text-only main model work with chat images by letting
 * the selected vision model describe them.
 *
 * Two host seams make this possible without touching core packages:
 *
 * 1. The `llm/stream` waterfall — agent-loop's every generation call (plain or
 *    prepared) goes through `ctx.waterfall(this, 'llm/stream', ...)`. A plugin
 *    listener can veto the chain and dispatch a rewritten request instead.
 *    Because agent-loop deep-freezes its request, the listener rebuilds a fresh
 *    options object and re-enters the waterfall with a guard flag.
 *
 * 2. `ctx.llm.resolveModelInfo` — the host's image admission preflight
 *    (dsh-host-apiproxy `prompt` / `selectModel`) rejects a request when the
 *    current model's `inputModalities` omit `image`. The wrapper claims image
 *    input for such models while the handoff is enabled, so the image reaches
 *    the session; the stream listener then replaces the image block with a
 *    text reference the text-only model can act on via `describe_image`.
 *
 * Side effects of the claim are bounded: the model catalog builder only reads
 * `reasoning` from the resolved info, the catalog checkboxes read the settings
 * document directly, and the pi-ai downgrade path is bypassed because the
 * stream listener removes image blocks before adapter dispatch.
 *
 * @module dsh-auxiliary/image-handoff
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { deepFreeze } from './dsh.js';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { ResolvedPluginConfig } from './config.js';

/** Whether one request targets the configured vision route itself. */
function isVisionRoute(options: GenerateOptions, vision: ResolvedPluginConfig['vision']): boolean {
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
 * @param block - the block to rewrite.
 * @returns the rewritten block and whether it changed.
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
 * Install the image-handoff seams. Returns a disposer that removes the stream
 * listener and restores the original `resolveModelInfo`.
 *
 * @param ctx - the plugin context with the `llm` service.
 * @param get - current resolved plugin config snapshot.
 */
export function registerImageHandoff(ctx: Context, get: () => ResolvedPluginConfig): () => void {
  const enabled = (): boolean => {
    const resolved = get();
    const vision = resolved.vision;
    return resolved.tool.enabled && vision.handoff && vision.provider !== undefined && vision.model !== undefined;
  };

  // Re-entrancy guard: the rewritten dispatch re-enters this listener once.
  let active = false;
  const disposeListener = ctx.on('llm/stream', (options, next) => {
    if (active) return next();
    if (!enabled()) return next();
    const vision = get().vision;
    if (isVisionRoute(options, vision)) return next();
    const rewritten = rewriteImages(options);
    if (rewritten === undefined) return next();
    active = true;
    try {
      return ctx.llm.stream(rewritten);
    } finally {
      active = false;
    }
  });

  const originalResolve = ctx.llm.resolveModelInfo.bind(ctx.llm);
  ctx.llm.resolveModelInfo = async (provider, model, signal) => {
    const info = await originalResolve(provider, model, signal);
    if (enabled() && info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      return { ...info, inputModalities: [...info.inputModalities, 'image'] };
    }
    return info;
  };

  return () => {
    disposeListener();
    ctx.llm.resolveModelInfo = originalResolve;
  };
}

/** Re-export for tests: serialize one attachment ref into its chat reference. */
export { imageReference };
