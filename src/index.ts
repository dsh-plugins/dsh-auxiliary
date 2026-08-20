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
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { Config, PLUGIN_ID, PLUGIN_NAME, resolvePluginConfig, type PluginConfig, type ResolvedPluginConfig } from './config.js';
import { registerVisionTool } from './vision-tool.js';
import { registerImageHandoff } from './image-handoff.js';
import { registerApproveRouter, registerApproveStateEndpoint, isApprovePluginInstalled, isApproveReviewCall } from './approve-router.js';
import { registerSubagentRouter } from './subagent-router.js';
import { installTitleRouter, titleRoute } from './title-router.js';
import { installCompactRouter } from './compact-router.js';
import { CompressEngine, installCompressionEngine } from './compress-engine.js';
import { registerImagegenTool } from './imagegen-tool.js';

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
export const inject = ['llm', 'tools', 'systemPrompt', 'attachments', 'fs', 'settings', 'credentials'];

/**
 * User-settings namespace owning the whole plugin section. Deliberately the
 * short `PLUGIN_ID`, not the scoped `PLUGIN_NAME`: `settingsNamespace` only
 * accepts `[a-z0-9-]`, and keeping the old value preserves already-saved user
 * settings across the package rename.
 */
const NS = settingsNamespace(PLUGIN_ID);

/**
 * Dormant directory entry that exposes this plugin's settings namespace to the
 * browser. It intentionally has no adapter registration and is never a model
 * route or custom endpoint; generic provider views expose it as inactive, and
 * the auxiliary selector filters it out.
 */
const SETTINGS_DIRECTORY_PROVIDER = 'dsh-auxiliary-settings';

/** Cordis plugin entry. */
export function apply(ctx: Context, config: PluginConfig): void {
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

  installSettingsSection(ctx, NS, Config, config, {
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
