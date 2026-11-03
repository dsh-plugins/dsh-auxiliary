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
import type { HostAPI } from '@dsh-plugin/dsh-loader';
import { legacySubagentModels, officialModelIntegrations } from './compat.js';
import { installOfficialTranslationModel } from './translation-router.js';
import { registerConfig, runtimeConfig } from './config-template.js';
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

type DshLoaderApi = DshFacade & Pick<HostAPI, 'config' | 'patch' | 'dshVersion'>;

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

/** Services required by `inspect_image`, compaction routing, and compression. */
export const inject = ['dshLoader', 'llm', 'tools', 'systemPrompt', 'attachments', 'fs', 'credentials'];

/** Cordis plugin entry. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  // 先接住 loader 门面：其余模块经 ./dsh.js 取用 dsh 的模块级符号
  // （defineTool / deadline / credentialRef / BasicCompactionEngine ...），
  // 因此这一步必须早于任何注册。
  const loader = (ctx as Context & { dshLoader: DshLoaderApi }).dshLoader;
  setDshFacade(loader);
  ctx.effect(() => () => clearDshFacade());

  // 在任何 reconcile 之前捕获宿主的原始 resolveModelInfo：image-handoff 启用后
  // 会包装它，给所有纯文本模型虚报图片输入能力；视觉工具的「主模型支持图片时
  // 跳过注入」检查必须看到真实模态，否则会在 handoff 最需要 describe_image 的
  // 会话里反而把它隐藏掉。
  const resolveModelInfo = ctx.llm.resolveModelInfo.bind(ctx.llm);

  const handle = await registerConfig(loader.config, { effect: fn => ctx.effect(() => fn() ?? (() => {})) }, Config(config), loader.dshVersion);
  let snapshot = runtimeConfig(handle.get().value, loader.dshVersion);
  const current = () => snapshot;
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
      ctx.logger.error('dsh-auxiliary: keeping the last good configuration after an invalid configuration');
      ctx.logger.error(error);
      return lastGood;
    }
  };

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
        approveRouterDisposer = registerApproveRouter(ctx, resolved, officialModelIntegrations(loader.dshVersion).autoReview ? 'official' : 'legacy');
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
    if (legacySubagentModels(loader.dshVersion) && subagent.enabled && subagent.provider !== undefined && subagent.model !== undefined) {
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

  // The compression engine is installed lazily from config-api so a threshold
  // change in the unified form can enable it without a restart. Once
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

  handle.watch(({ value }) => {
    snapshot = runtimeConfig(value, loader.dshVersion);
    reconcileVisionTool();
    reconcileHandoff();
    reconcileApproveRouter();
    reconcileSubagentRouter();
    reconcileImagegenTool();
    reconcileCompressionEngine();
  });

  if (officialModelIntegrations(loader.dshVersion).translation) {
    ctx.inject(['translator'], scope => {
      const translator = scope.get('translator');
      scope.effect(() => installOfficialTranslationModel(translator, loader.patch, () => resolved().translation));
    });
  }

  reconcileVisionTool();
  reconcileHandoff();
  reconcileApproveRouter();
  reconcileSubagentRouter();
  reconcileImagegenTool();
  installCompactRouter(ctx, resolved);
  reconcileCompressionEngine();
}
