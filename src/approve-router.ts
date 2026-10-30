/** Route legacy approve-for-me and official Auto reviewer requests without changing decisions. */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { deepFreeze } from './dsh.js';
import type { ResolvedPluginConfig } from './config.js';

/** The approve-for-me review prompt's fixed action marker. */
const APPROVAL_REQUEST_MARKER = '>>> APPROVAL REQUEST START';

/** The approve-for-me plugin's default permission-preset names. */
const APPROVE_PRESET_NAMES = ['approve-for-me', 'strict-review'] as const;

/** Read-only state payload served to the settings page. */
export interface ApproveHostState {
  /** Whether the approve-for-me plugin registered one of its review presets. */
  readonly approvePluginInstalled: boolean;
}

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
    if (options.provider === approve.provider && options.model === approve.model) return next();
    const rewritten = deepFreeze({ ...options, provider: approve.provider, model: approve.model });
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

/** Read the live permission-preset service without throwing when it is absent. */
function permissionPresetNames(ctx: Context): readonly string[] | undefined {
  // The permissionPresets service is fiber-isolated: plugins that do not inject
  // it get `cannot get property "permissionPresets" without inject` from their
  // own ctx. The root context sees the global service table, so it reaches the
  // instance without making permissionPresets a hard dependency. An absent
  // service (headless profiles without the preset registry) still reads as
  // undefined rather than throwing.
  try {
    const service = (ctx.root as Context & { permissionPresets?: { names: readonly string[] } }).permissionPresets;
    return service === undefined ? undefined : service.names;
  } catch {
    return undefined;
  }
}

/**
 * Detect whether the approve-for-me plugin is installed by its permission
 * presets. The plugin registers `approve-for-me` and `strict-review` into the
 * live preset table at apply time; a renamed preset (via its own config) is not
 * detectable this way.
 */
export function isApprovePluginInstalled(ctx: Context): boolean {
  try {
    const loader = ctx.root.get('loader') as { entries?(): Iterable<{ options: { name?: string }; fiber?: { state: number } }> } | undefined;
    if ([...(loader?.entries?.() ?? [])].some(entry => entry.options.name === '@deepseek-ai/dsh-experimental-auto-review' && entry.fiber?.state === 2)) return true;
  } catch { /* legacy profiles can still be detected through their presets */ }
  const names = permissionPresetNames(ctx);
  if (names === undefined) return false;
  return APPROVE_PRESET_NAMES.some((preset) => names.includes(preset));
}

/**
 * Serve the plugin's read-only state to the settings page via the optional
 * `webServer` service. The endpoint is exact-path `/dsh-auxiliary/state` and
 * returns JSON `{ approvePluginInstalled }`; without a web server (headless
 * profiles) it registers nothing. Returns a disposer.
 *
 * @param ctx - the plugin context.
 */
export function registerApproveStateEndpoint(ctx: Context): () => void {
  const disposers: Array<() => void> = [];
  let routeDisposer: (() => void) | undefined;

  const tryRegister = (): void => {
    if (routeDisposer !== undefined) return; // already registered.
    // The webServer service is fiber-isolated: only plugins that inject it may
    // read it from their own ctx. The root context sees the global service
    // table, so it reaches the instance without making webServer a hard
    // dependency (headless profiles have none).
    let webServer: import('@deepseek-ai/dsh-host-webserver').WebServer | undefined;
    try {
      webServer = (ctx.root as Context & { webServer?: import('@deepseek-ai/dsh-host-webserver').WebServer }).webServer;
    } catch {
      return; // webServer not available in this profile.
    }
    if (webServer === undefined) return;
    routeDisposer = webServer.register({
      kind: 'exact',
      path: '/dsh-auxiliary/state',
      handler: (_req, res) => {
        const state: ApproveHostState = {
          approvePluginInstalled: isApprovePluginInstalled(ctx),
        };
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(state));
      }
    });
    disposers.push(() => {
      routeDisposer?.();
      routeDisposer = undefined;
    });
  };

  // Register now if the service is already bound, and on any later binding
  // (the service re-notifies on updates; tryRegister is idempotent).
  tryRegister();
  disposers.push(ctx.root.on('internal/service', (name: string) => {
    if (name === 'webServer') tryRegister();
  }));

  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
