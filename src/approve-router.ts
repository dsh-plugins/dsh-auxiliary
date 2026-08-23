/**
 * Approval-reviewer routing: a hookup for @dsh-plugin/dsh-approve-for-me.
 *
 * When the approve-for-me plugin is installed and its `mode: review` is active,
 * it asks a reviewer model to decide each approval prompt. By default the
 * reviewer inherits the requesting session's model route, and the plugin offers
 * its own `reviewProvider` / `reviewModel` config — but both are owned by that
 * plugin. This module lets dsh-auxiliary provide a dedicated approval model
 * instead: a listener on the official `llm/stream` waterfall recognizes the
 * plugin's review call and reroutes it to `approve.provider` / `approve.model`.
 *
 * Recognition uses only the plugin's public output contract, so it stays
 * correct across versions: the review user prompt is the fixed marker
 * `>>> APPROVAL REQUEST START` (see the plugin's `renderReviewUserPrompt`), the
 * call carries no `sessionId` (it is not an agent-loop request), and it always
 * runs at `temperature: 0`. No other caller in the harness matches all three.
 *
 * Like the image-handoff listener, the reroute vetoes the chain and re-enters
 * the waterfall with a synchronous guard. The rewritten request intentionally
 * is NOT `markAgentLoopRequest`-marked, so the agent-loop invariant (which only
 * audits marked requests) skips it — matching the original call, which was
 * never marked either.
 *
 * A companion read-only HTTP endpoint (`/dsh-auxiliary/state`) tells the
 * settings page whether the approve-for-me plugin is installed, so the
 * "Approval model" card can show an informative notice instead of a dead
 * configuration. Both `webServer` and `permissionPresets` are optional
 * services: the endpoint simply stays unregistered where no web server exists,
 * and plugin detection degrades to "not installed" when the preset service is
 * absent.
 *
 * @module dsh-auxiliary/approve-router
 */
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
export function registerApproveRouter(ctx: Context, get: () => ResolvedPluginConfig): () => void {
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
    if (!isApproveReviewCall(options)) return next();
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
