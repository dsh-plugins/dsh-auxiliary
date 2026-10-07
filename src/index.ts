/**
 * dsh-auxiliary — auxiliary models for DeepSeek Harness.
 *
 * Exposes the `inspect_image` tool through an already-configured vision-capable
 * provider/model pair, reroutes compaction summaries to a dedicated auxiliary
 * pair, and optionally replaces the compaction backend with an explicit
 * compression engine.
 *
 * @module dsh-auxiliary
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config, PLUGIN_ID, PLUGIN_NAME, resolvePluginConfig, type PluginConfig, type ResolvedPluginConfig } from './config.js';
import { registerVisionTool } from './vision-tool.js';
import { registerImageHandoff } from './image-handoff.js';
import { registerApproveRouter, registerApproveStateEndpoint, isApprovePluginInstalled, isApproveReviewCall } from './approve-router.js';
import { registerSubagentRouter } from './subagent-router.js';
import { installTitleRouter, titleRoute } from './title-router.js';
import { installCompactRouter } from './compact-router.js';
import { CompressEngine, installCompressionEngine } from './compress-engine.js';
import { registerImagegenTool } from './imagegen-tool.js';
import { clearDshFacade, setDshFacade, type DshFacade } from './dsh.js';

export { Config, PLUGIN_NAME, resolvePluginConfig } from './config.js';
export { registerVisionTool, type VisionToolOptions } from './vision-tool.js';
export { registerImageHandoff } from './image-handoff.js';
export { registerApproveRouter, registerApproveStateEndpoint, isApprovePluginInstalled, isApproveReviewCall } from './approve-router.js';
export { registerSubagentRouter } from './subagent-router.js';
export { installTitleRouter, titleRoute } from './title-router.js';
export { installCompactRouter, compactRoute } from './compact-router.js';
export { CompressEngine, installCompressionEngine } from './compress-engine.js';
export { registerImagegenTool } from './imagegen-tool.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = PLUGIN_NAME;

/** Services required by `inspect_image`, compaction routing, and compression.
 *
 * `settings` stays required: `imagegen-tool.ts` reads the `llm-pi-ai` route
 * profile through `ctx.settings.describe(...)`, and a service read on the plugin
 * context without a matching `inject` entry throws
 * `cannot get property "settings" without inject`.
 */
export const inject = ['dshLoader', 'llm', 'tools', 'systemPrompt', 'attachments', 'fs', 'settings', 'credentials'];

/**
 * User-settings namespace owning the whole plugin section.
 *
 * On 0.2.0 the namespace is simply the profile entry id (`dsh-auxiliary`, from
 * this package's `cordis.patch.yml`), which is what `SettingsForms.describe()`
 * reports as `ns` and what the "Auxiliary Models" page writes back. No
 * registration call is involved: the entry id IS the namespace.
 */
const NS = PLUGIN_ID;

/**
 * Dormant directory entry that exposes this plugin's settings namespace to the
 * browser. It intentionally has no adapter registration and is never a model
 * route or custom endpoint; generic provider views expose it as inactive, and
 * the auxiliary selector filters it out.
 */
const SETTINGS_DIRECTORY_PROVIDER = 'dsh-auxiliary-settings';

/** Cordis plugin entry. */
export function apply(ctx: Context, config: PluginConfig): void {
  // 先接住 loader 门面：其余模块经 ./dsh.js 取用 dsh 的模块级符号
  // （defineTool / deadline / credentialRef / BasicCompactionEngine ...），
  // 因此这一步必须早于任何注册。
  const loader = (ctx as Context & { dshLoader: DshFacade }).dshLoader;
  setDshFacade(loader);
  ctx.effect(() => () => clearDshFacade());

  // 0.2.0 把 settings 搬进了插件自己的 Cordis Config：本插件的 `Config`（见
  // ./config.ts，每个可编辑叶子都标了 `.volatile()`）就是设置页的数据源，profile
  // 条目 id（`dsh-auxiliary`）就是命名空间。`configure({ auto: false })` 关掉
  // 自动生成的页面，保留本插件自定义的 Auxiliary Models 页；它必须挂在**本插件
  // 自己的 fiber** 上（`ctx.fiber`），并作为 effect 注册以便随卸载撤销。
  //
  // 不再调用 loader 的 `installSection` / settings 服务的 `register`：0.2.0 的
  // `dsh-settings` 已移除这两个 API，而 dsh-loader 1.3.5 仍会转发到它们（这正是
  // 用户报的 `sctx.settings.register is not a function` 崩溃帧）。
  ctx.inject(['settings'], (child) => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)));

  // 在任何 reconcile 之前捕获宿主的原始 resolveModelInfo：image-handoff 启用后
  // 会包装它，给所有纯文本模型虚报图片输入能力；视觉工具的「主模型支持图片时
  // 跳过注入」检查必须看到真实模态，否则会在 handoff 最需要 describe_image 的
  // 会话里反而把它隐藏掉。
  const resolveModelInfo = ctx.llm.resolveModelInfo.bind(ctx.llm);

  // The validated Config `apply` received IS the live source: on 0.2.0 the loader
  // commits a volatile-only change by mutating the references inside this very
  // object (no remount), so the thunk is constant and `resolved()` re-reads the
  // leaves on demand.
  const current = (): PluginConfig => config;
  let lastRaw: PluginConfig | undefined;
  let lastGood: ResolvedPluginConfig | undefined;
  const resolved = (): ResolvedPluginConfig => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolvePluginConfig(raw);
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger.error('dsh-auxiliary: keeping the last good configuration after an invalid settings section');
      ctx.logger.error(error);
      return lastGood;
    }
  };

  ctx.llm.registerConfigurableProviders([{
    provider: SETTINGS_DIRECTORY_PROVIDER,
    displayName: 'dsh-auxiliary settings',
    settingsNs: NS,
    settingsPath: ['vision']
  }]);
  let visionToolDisposer: (() => void) | undefined;
  const disposeVisionTool = (): void => {
    const disposer = visionToolDisposer;
    visionToolDisposer = undefined;
    disposer?.();
  };
  const reconcileVisionTool = (): void => {
    if (resolved().tool.enabled) {
      if (visionToolDisposer === undefined) {
        visionToolDisposer = registerVisionTool(ctx, resolved, { resolveModelInfo });
      }
      return;
    }
    disposeVisionTool();
  };

  let handoffDisposer: (() => void) | undefined;
  const disposeHandoff = (): void => {
    const disposer = handoffDisposer;
    handoffDisposer = undefined;
    disposer?.();
  };
  const reconcileHandoff = (): void => {
    const resolvedConfig = resolved();
    if (resolvedConfig.tool.enabled && resolvedConfig.vision.provider !== undefined && resolvedConfig.vision.model !== undefined) {
      if (handoffDisposer === undefined) {
        handoffDisposer = registerImageHandoff(ctx, resolved);
      }
      return;
    }
    disposeHandoff();
  };

  let approveRouterDisposer: (() => void) | undefined;
  const disposeApproveRouter = (): void => {
    const disposer = approveRouterDisposer;
    approveRouterDisposer = undefined;
    disposer?.();
  };
  const reconcileApproveRouter = (): void => {
    const approve = resolved().approve;
    if (approve.enabled && approve.provider !== undefined && approve.model !== undefined) {
      if (approveRouterDisposer === undefined) {
        approveRouterDisposer = registerApproveRouter(ctx, resolved);
      }
      return;
    }
    disposeApproveRouter();
  };

  let subagentRouterDisposer: (() => void) | undefined;
  const disposeSubagentRouter = (): void => {
    const disposer = subagentRouterDisposer;
    subagentRouterDisposer = undefined;
    disposer?.();
  };
  const reconcileSubagentRouter = (): void => {
    const subagent = resolved().subagent;
    if (subagent.enabled && subagent.provider !== undefined && subagent.model !== undefined) {
      if (subagentRouterDisposer === undefined) {
        subagentRouterDisposer = registerSubagentRouter(ctx, resolved);
      }
      return;
    }
    disposeSubagentRouter();
  };

  let imagegenToolDisposer: (() => void) | undefined;
  const disposeImagegenTool = (): void => {
    const disposer = imagegenToolDisposer;
    imagegenToolDisposer = undefined;
    disposer?.();
  };
  const reconcileImagegenTool = (): void => {
    const imagegen = resolved().imagegen;
    if (imagegen.enabled && imagegen.provider !== undefined && imagegen.model !== undefined) {
      if (imagegenToolDisposer === undefined) {
        imagegenToolDisposer = registerImagegenTool(ctx, resolved);
      }
      return;
    }
    disposeImagegenTool();
  };

  // The compression engine is installed lazily from settings so a threshold
  // change on the Auxiliary Models page can enable it without a restart. Once
  // installed it re-reads the policy before every pressure check.
  let compressionEngine: CompressEngine | undefined;
  const reconcileCompressionEngine = (): void => {
    if (!resolved().engine.enabled || compressionEngine !== undefined) return;
    compressionEngine = installCompressionEngine(ctx, resolved);
  };

  // The title router mirrors the compaction router: always installed, but a
  // pure pass-through until a complete route is configured.
  const disposeTitleRouter = installTitleRouter(ctx, resolved);

  // Read-only state endpoint for the settings page; independent of the routing
  // feature because the card must render its "plugin not installed" notice even
  // when `approve.enabled` is off.
  const approveStateDisposer = registerApproveStateEndpoint(ctx);

  ctx.effect(() => () => {
    disposeVisionTool();
    disposeHandoff();
    disposeApproveRouter();
    disposeSubagentRouter();
    disposeImagegenTool();
    disposeTitleRouter();
    approveStateDisposer();
    compressionEngine = undefined;
  }, 'dsh-auxiliary: vision tool, handoff, and approval-router lifecycle');

  // Re-reconcile whenever the loader commits a volatile-only config change into
  // this entry's live references. `loader/volatile-update` is the canonical
  // refresh signal (shipped `dsh-llm-pi-ai` uses exactly this). Its real
  // declaration lives in `@deepseek-ai/cordis-plugin-loader`, which is not a
  // compile-time dependency of this package, so `./dsh.js` declares the same
  // event locally.
  //
  // The memo in `resolved()` keys on the raw config object's identity, but a
  // volatile update mutates a reference's inner value while that identity stays
  // stable — so this event must not rely on the memo alone. Dropping the memo
  // forces the next `resolved()` call to re-read every reference.
  const reconcileAll = (): void => {
    lastRaw = undefined;
    reconcileVisionTool();
    reconcileHandoff();
    reconcileApproveRouter();
    reconcileSubagentRouter();
    reconcileImagegenTool();
    reconcileCompressionEngine();
  };
  ctx.effect(() => ctx.on('loader/volatile-update', () => reconcileAll()));

  // Initial pass: the validated Config `apply` received already carries the
  // composition entry values plus any persisted profile patch, with volatile
  // leaves delivered as references (unwrapped by `resolvePluginConfig`).
  reconcileVisionTool();
  reconcileHandoff();
  reconcileApproveRouter();
  reconcileSubagentRouter();
  reconcileImagegenTool();
  installCompactRouter(ctx, resolved);
  reconcileCompressionEngine();
}
