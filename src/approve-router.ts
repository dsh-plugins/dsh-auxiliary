/** Route legacy approve-for-me and official Auto reviewer requests without changing decisions. */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { deepFreeze } from './dsh.js';
import type { ResolvedPluginConfig } from './config.js';

/** The approve-for-me review prompt's fixed action marker. */
const APPROVAL_REQUEST_MARKER = '>>> APPROVAL REQUEST START';

/**
 * Whether one `llm/stream` request is the approve-for-me plugin's review call.
 *
 * @param options - the request as observed at the waterfall.
 */
export function isApproveReviewCall(options: GenerateOptions): boolean {
  if (options.sessionId !== undefined) return false;
  if (options.temperature !== 0) return false;
  if (options.system === undefined) return false;
  return options.messages.some((message) =>
    message.role === 'user'
    && Array.isArray(message.content)
    && message.content.some((block) =>
      block.type === 'text'
      && block.text.includes(APPROVAL_REQUEST_MARKER)
    )
  );
}

/**
 * Install the approval-reviewer routing listener. Returns a disposer that
 * removes the listener.
 *
 * The routing only activates while `approve.enabled` is true and a full
 * provider/model route is selected; without the approve-for-me plugin there are
 * no review calls to match, so the listener is inert.
 *
 * @param ctx - the plugin context with the `llm` service.
 * @param get - current resolved plugin config snapshot.
 */
/** Official versions before purpose=auto-review use this policy and environment prefix. */
export function isOfficialAutoReviewCall(options: GenerateOptions): boolean {
  return options.temperature === 0 && typeof options.system === 'string'
    && options.system.startsWith('REVIEW_POLICY\n')
    && options.messages.some(message => message.role === 'user' && Array.isArray(message.content)
      && message.content.some(block => block.type === 'text' && block.text.startsWith('ENVIRONMENT\n')));
}

export function registerApproveRouter(ctx: Context, get: () => ResolvedPluginConfig, target: 'legacy' | 'official' = 'legacy'): () => void {
  const enabled = (): boolean => {
    const approve = get().approve;
    return approve.enabled && approve.provider !== undefined && approve.model !== undefined;
  };

  // Re-entrancy guard: the rerouted dispatch re-enters this listener once.
  let active = false;
  const disposeListener = ctx.on('llm/stream', (options, next) => {
    if (active) return next();
    if (!enabled()) return next();
    const approve = get().approve;
    if (approve.provider === undefined || approve.model === undefined) return next();
    if (!(target === 'official' ? isOfficialAutoReviewCall(options) : isApproveReviewCall(options))) return next();
    if (options.provider === approve.provider && options.model === approve.model && options.reasoningEffort === approve.reasoningEffort) { return next(); }
    const rewritten = deepFreeze({ ...options, provider: approve.provider, model: approve.model, reasoningEffort: approve.reasoningEffort });
    active = true;
    try {
      return ctx.llm.stream(rewritten);
    } finally {
      active = false;
    }
  });

  return () => {
    disposeListener();
  };
}
