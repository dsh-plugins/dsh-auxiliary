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
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
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

/**
 * `ctx.dshLoader` 中本插件用到的部分。
 *
 * 在 {@link DshFacade}（模块级 dsh 符号）之外还要 `settings` 门面：
 * `installSettingsSection` 承载真实上游语义，由 loader 转发而非本插件重实现。
 */
interface DshLoaderApi extends DshFacade {
  settings: {
    installSection<T>(
      ctx: unknown,
      ns: unknown,
      schema: unknown,
      entry: T,
      hooks: { setSource(current: () => T): void; onChange(): void; validate(value: T): void },
    ): boolean;
  };
}

export { Config, PLUGIN_NAME, resolvePluginConfig } from './config.js';
export { registerVisionTool } from './vision-tool.js';
export { registerImageHandoff } from './image-handoff.js';
export { registerApproveRouter, registerApproveStateEndpoint, isApprovePluginInstalled, isApproveReviewCall } from './approve-router.js';
export { registerSubagentRouter } from './subagent-router.js';
export { installTitleRouter, titleRoute } from './title-router.js';
export { installCompactRouter, compactRoute } from './compact-router.js';
export { CompressEngine, installCompressionEngine } from './compress-engine.js';
export { registerImagegenTool } from './imagegen-tool.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = PLUGIN_NAME;

/** Services required by `inspect_image`, compaction routing, and compression. */
export const inject = ['dshLoader', 'llm', 'tools', 'systemPrompt', 'attachments', 'fs', 'settings', 'credentials'];

/**
 * User-settings namespace owning the whole plugin section. Deliberately the
 * short `PLUGIN_ID`, not the scoped `PLUGIN_NAME`: the namespace pattern only
 * accepts `[a-z0-9-]`, and keeping the old value preserves already-saved user
 * settings across the package rename.
 *
 * A bare literal rather than `settingsNamespace(PLUGIN_ID)` because this is
 * evaluated at MODULE scope, before `apply` has injected the loader facade.
 * dsh's `settingsNamespace` is pure validation returning its argument unchanged
 * (it only brands the string at the type level), so this is equivalent.
 */
const NS = PLUGIN_ID as unknown as SettingsNamespace;

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
  const loader = (ctx as Context & { dshLoader: DshLoaderApi }).dshLoader;
  setDshFacade(loader);
  ctx.effect(() => () => clearDshFacade());

  let current = () => config;
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
        visionToolDisposer = registerVisionTool(ctx, resolved);
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

  // 经 loader 门面转发到 dsh 的 installSettingsSection（不重实现其回退语义：
  // 以组合入口作 base 层注册、settings 服务在时把 source thunk 指向解析作用域、
  // 服务消失时回退到入口，全程挂在 scoped fiber 上）。
  loader.settings.installSection<PluginConfig>(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {
      reconcileVisionTool();
      reconcileHandoff();
      reconcileApproveRouter();
      reconcileImagegenTool();
      reconcileCompressionEngine();
    },
    validate: resolvePluginConfig
  });

  reconcileVisionTool();
  reconcileHandoff();
  reconcileApproveRouter();
  reconcileSubagentRouter();
  reconcileImagegenTool();
  installCompactRouter(ctx, resolved);
  reconcileCompressionEngine();
}
