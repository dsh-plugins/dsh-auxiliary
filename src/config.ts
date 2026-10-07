/**
 * Plugin configuration: schemastery schema, runtime validation, and the
 * resolved snapshot consumed by every feature. The same schema backs the
 * `cordis.yml` entry and the optional `dsh-auxiliary` user-settings section,
 * so a settings change reaches the very next request.
 *
 * @module dsh-auxiliary/config
 */
import z from '@deepseek-ai/schemastery';
import { isVolatile, type Volatile } from '@deepseek-ai/cosmokit';
import { MAX_TIMER_DELAY_MS, deepFreeze } from './dsh.js';

/**
 * Stable plugin id recorded with plugin-sourced messages and tool guidance.
 * This is the cordis plugin name / npm package name.
 */
export const PLUGIN_NAME = '@dsh-plugin/dsh-auxiliary';

/**
 * Short kebab-case id for identifiers that cannot carry a scoped npm name:
 * the settings namespace (`settingsNamespace` accepts only `[a-z0-9-]`) and
 * generated file-name prefixes. Keeping it stable preserves already-saved
 * user settings across the package rename.
 */
export const PLUGIN_ID = 'dsh-auxiliary';

export const DEFAULT_VISION_MAX_TOKENS = 4096;
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_VISION_TOOL_TIMEOUT_MS = 120000;
export const DEFAULT_ENGINE_MAX_TOKENS = 8192;

/** The default compression instruction used by the optional engine. */
export const DEFAULT_COMPRESS_PROMPT = [
  'You are a context-compression engine for an AI coding assistant. Condense the conversation above into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below, keeping every section in order with terse bullets:',
  '- ## Primary Request and Intent (quote verbatim where wording matters)',
  '- ## Key Technical Concepts',
  '- ## Files and Code (exact paths, key changes or snippets)',
  '- ## Errors and Fixes',
  '- ## Pending Jobs',
  '- ## Current Work',
  '- ## Next Step (the single next action, or (none))',
  '- ## Critical Context (decisions, constraints, user preferences, open questions)',
  '',
  'Rules: preserve exact paths, commands, identifiers, numbers, and syntax fragments; capture user corrections faithfully; do not mention this compression request; output only the checkpoint text.'
].join('\n');

/** Plugin entry / settings schema. Field defaults live here so the UI can render them.
 *
 * Every editable LEAF is `.volatile()`, which is what makes this entry's settings
 * form exist on DSH 0.2.0: `SettingsForms.describe()` surfaces an entry only when
 * `volatileForm(schema)` is non-undefined, and `SettingsForms.update()` throws
 * `Plugin entry "<ns>" has no volatile fields` otherwise. Volatile leaves are
 * exposed to `apply` as `Volatile<T>` references, so {@link resolvePluginConfig}
 * unwraps them with {@link readLeaf}.
 *
 * The grouping objects (vision/tool/compact/approve/subagent/title/imagegen/engine)
 * stay PLAIN: schemastery rejects a volatile node nested inside another volatile
 * node ("volatile fields require a fixed object path without an enclosing volatile
 * field").
 */
const Config = z.object({
  vision: z.object({
    provider: z.string().description('Select an already-configured provider route for inspect_image.').volatile(),
    model: z.string().description('Select a model from the selected provider route for inspect_image.').volatile(),
    maxTokens: z.number().step(1).min(1).default(DEFAULT_VISION_MAX_TOKENS).volatile(),
    handoff: z.boolean().default(true).description('When the main model is text-only, allow chat images as references and let it fetch their content via describe_image.').volatile(),
    skipWhenMainModelSupportsImage: z.boolean().default(false).description('When the session\'s main model already supports image input, do not inject the inspect_image/describe_image tools or their prompt guidance into that session.').volatile()
  }),
  tool: z.object({
    enabled: z.boolean().default(true).volatile(),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES).volatile(),
    timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_VISION_TOOL_TIMEOUT_MS).volatile()
  }),
  compact: z.object({
    enabled: z.boolean().default(false).volatile(),
    provider: z.string().volatile(),
    model: z.string().volatile()
  }),
  approve: z.object({
    enabled: z.boolean().default(false).description('When @dsh-plugin/dsh-approve-for-me is installed, route its review-mode approval calls to a dedicated model.').volatile(),
    provider: z.string().volatile(),
    model: z.string().volatile()
  }),
  subagent: z.object({
    enabled: z.boolean().default(false).description('Route every delegated child agent (subagent) to a dedicated provider/model pair.').volatile(),
    provider: z.string().volatile(),
    model: z.string().volatile()
  }),
  title: z.object({
    enabled: z.boolean().default(false).description('Route the session-title generation call (purpose: session-title) to a dedicated provider/model pair.').volatile(),
    provider: z.string().volatile(),
    model: z.string().volatile()
  }),
  imagegen: z.object({
    enabled: z.boolean().default(false).description('Route auxiliary image-generation work to a dedicated provider/model pair marked for image generation.').volatile(),
    provider: z.string().volatile(),
    model: z.string().volatile()
  }),
  engine: z.object({
    enabled: z.boolean().default(false).volatile(),
    thresholdRatio: z.number().step(0.01).min(0.01).max(0.99).default(0.8).volatile(),
    retainRatio: z.number().step(0.01).min(0.01).max(0.99).default(0.16).volatile(),
    maxTokens: z.number().step(1).min(1).default(DEFAULT_ENGINE_MAX_TOKENS).volatile(),
    compactionRetries: z.number().step(1).min(0).default(1).volatile(),
    maxOverflowRetries: z.number().step(1).min(0).default(1).volatile(),
    auto: z.boolean().default(true).volatile(),
    compressPrompt: z.string().default(DEFAULT_COMPRESS_PROMPT).volatile()
  })
});

/** Inferred plugin configuration value (volatile leaves are `Volatile<T>` references).
 *
 * `ReturnType` reads the schema's call signature, which yields the validated
 * output type for the schema's mode — i.e. `Volatile<T>` for a `.volatile()`
 * leaf and the plain `T` for a non-volatile one. This replaces the old
 * `typeof Config extends z<infer T>` idiom, which the unscoped `schemastery`
 * package's global type made available and which no longer resolves.
 */
export type PluginConfig = ReturnType<typeof Config>;

/**
 * Read one config leaf as a plain value.
 *
 * A `.volatile()` field is delivered to `apply` as a stable `Volatile<T>`
 * reference (`{ get(): T }`), while non-volatile fields stay plain values. This
 * unwraps either form so the resolution/validation path below reads values, not
 * references, without changing its exported signature or semantics.
 *
 * @param value - the leaf as received from the validated plugin config.
 * @returns the leaf's current plain value.
 */
function readLeaf<T>(value: T | Volatile<T>): T {
  return isVolatile(value) ? (value.get() as T) : value;
}

/** Resolved selection for an existing vision-capable provider/model route. */
export interface ResolvedVisionConfig {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly maxTokens: number;
  /** Image handoff: text-only main models may reference chat images via describe_image. */
  readonly handoff: boolean;
  /**
   * Skip injecting the vision tools and their prompt guidance into sessions
   * whose main model already supports image input.
   */
  readonly skipWhenMainModelSupportsImage: boolean;
}

/** Resolved `inspect_image` tool policy. */
export interface ResolvedToolConfig {
  readonly enabled: boolean;
  readonly maxImageBytes: number;
  readonly timeoutMs: number;
}

/** Resolved compaction-routing policy (auxiliary summarizer route). */
export interface ResolvedCompactConfig {
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string;
}

/** Resolved approval-reviewer routing policy (@dsh-plugin/dsh-approve-for-me hookup). */
export interface ResolvedApproveConfig {
  readonly enabled: boolean;
  readonly provider: string | undefined;
  readonly model: string | undefined;
}

/** Resolved subagent routing policy (dedicated model for delegated children). */
export interface ResolvedSubagentConfig {
  readonly enabled: boolean;
  readonly provider: string | undefined;
  readonly model: string | undefined;
}

/** Resolved session-title routing policy (dedicated title model). */
export interface ResolvedTitleConfig {
  readonly enabled: boolean;
  readonly provider: string | undefined;
  readonly model: string | undefined;
}

/** Resolved auxiliary image-generation routing policy (dedicated generation model). */
export interface ResolvedImagegenConfig {
  readonly enabled: boolean;
  readonly provider: string | undefined;
  readonly model: string | undefined;
}

/** Resolved auxiliary compression-engine policy. */
export interface ResolvedEngineConfig {
  readonly enabled: boolean;
  readonly thresholdRatio: number;
  readonly retainRatio: number;
  readonly maxTokens: number;
  readonly compactionRetries: number;
  readonly maxOverflowRetries: number;
  readonly auto: boolean;
  readonly compressPrompt: string;
}

/** The complete resolved, frozen plugin snapshot. */
export interface ResolvedPluginConfig {
  readonly vision: ResolvedVisionConfig;
  readonly tool: ResolvedToolConfig;
  readonly compact: ResolvedCompactConfig;
  readonly approve: ResolvedApproveConfig;
  readonly subagent: ResolvedSubagentConfig;
  readonly title: ResolvedTitleConfig;
  readonly imagegen: ResolvedImagegenConfig;
  readonly engine: ResolvedEngineConfig;
}

/** Resolve and validate one untrusted plugin-config snapshot into the frozen runtime shape. */
export function resolvePluginConfig(config: PluginConfig): ResolvedPluginConfig {
  const vision = config.vision ?? {};
  const tool = config.tool ?? {};
  const compact = config.compact ?? {};
  const approve = config.approve ?? {};
  const subagent = config.subagent ?? {};
  const title = config.title ?? {};
  const imagegen = config.imagegen ?? {};
  const engine = config.engine ?? {};

  // Every editable leaf is `.volatile()`, so it arrives as a `Volatile<T>`
  // reference rather than a plain value: unwrap each read exactly once here.
  const visionProviderRaw = readLeaf(vision.provider);
  const visionModelRaw = readLeaf(vision.model);
  const visionMaxTokens = readLeaf(vision.maxTokens);
  const visionHandoff = readLeaf(vision.handoff);
  const visionSkip = readLeaf(vision.skipWhenMainModelSupportsImage);
  const toolEnabled = readLeaf(tool.enabled);
  const toolMaxImageBytes = readLeaf(tool.maxImageBytes);
  const toolTimeoutMs = readLeaf(tool.timeoutMs);
  const compactEnabled = readLeaf(compact.enabled);
  const compactProviderRaw = readLeaf(compact.provider);
  const compactModelRaw = readLeaf(compact.model);
  const approveEnabled = readLeaf(approve.enabled);
  const approveProviderRaw = readLeaf(approve.provider);
  const approveModelRaw = readLeaf(approve.model);
  const subagentEnabled = readLeaf(subagent.enabled);
  const subagentProviderRaw = readLeaf(subagent.provider);
  const subagentModelRaw = readLeaf(subagent.model);
  const titleEnabled = readLeaf(title.enabled);
  const titleProviderRaw = readLeaf(title.provider);
  const titleModelRaw = readLeaf(title.model);
  const imagegenEnabled = readLeaf(imagegen.enabled);
  const imagegenProviderRaw = readLeaf(imagegen.provider);
  const imagegenModelRaw = readLeaf(imagegen.model);
  const engineEnabled = readLeaf(engine.enabled);
  const engineThresholdRatio = readLeaf(engine.thresholdRatio);
  const engineRetainRatio = readLeaf(engine.retainRatio);
  const engineMaxTokens = readLeaf(engine.maxTokens);
  const engineCompactionRetries = readLeaf(engine.compactionRetries);
  const engineMaxOverflowRetries = readLeaf(engine.maxOverflowRetries);
  const engineAuto = readLeaf(engine.auto);
  const engineCompressPrompt = readLeaf(engine.compressPrompt);

  const visionProvider = typeof visionProviderRaw === 'string' && visionProviderRaw.length > 0 ? visionProviderRaw : undefined;
  const visionModel = typeof visionModelRaw === 'string' && visionModelRaw.length > 0 ? visionModelRaw : undefined;
  if (Boolean(visionProvider) !== Boolean(visionModel)) {
    throw new Error('dsh-auxiliary: vision.provider and vision.model must be set together');
  }

  const compactProvider = typeof compactProviderRaw === 'string' ? compactProviderRaw : '';
  const compactModel = typeof compactModelRaw === 'string' ? compactModelRaw : '';
  if (Boolean(compactProvider) !== Boolean(compactModel)) {
    throw new Error('dsh-auxiliary: compact.provider and compact.model must be set together');
  }

  const approveProvider = typeof approveProviderRaw === 'string' && approveProviderRaw.length > 0 ? approveProviderRaw : undefined;
  const approveModel = typeof approveModelRaw === 'string' && approveModelRaw.length > 0 ? approveModelRaw : undefined;
  if (Boolean(approveProvider) !== Boolean(approveModel)) {
    throw new Error('dsh-auxiliary: approve.provider and approve.model must be set together');
  }

  const subagentProvider = typeof subagentProviderRaw === 'string' && subagentProviderRaw.length > 0 ? subagentProviderRaw : undefined;
  const subagentModel = typeof subagentModelRaw === 'string' && subagentModelRaw.length > 0 ? subagentModelRaw : undefined;
  if (Boolean(subagentProvider) !== Boolean(subagentModel)) {
    throw new Error('dsh-auxiliary: subagent.provider and subagent.model must be set together');
  }

  const titleProvider = typeof titleProviderRaw === 'string' && titleProviderRaw.length > 0 ? titleProviderRaw : undefined;
  const titleModel = typeof titleModelRaw === 'string' && titleModelRaw.length > 0 ? titleModelRaw : undefined;
  if (Boolean(titleProvider) !== Boolean(titleModel)) {
    throw new Error('dsh-auxiliary: title.provider and title.model must be set together');
  }

  const imagegenProvider = typeof imagegenProviderRaw === 'string' && imagegenProviderRaw.length > 0 ? imagegenProviderRaw : undefined;
  const imagegenModel = typeof imagegenModelRaw === 'string' && imagegenModelRaw.length > 0 ? imagegenModelRaw : undefined;
  if (Boolean(imagegenProvider) !== Boolean(imagegenModel)) {
    throw new Error('dsh-auxiliary: imagegen.provider and imagegen.model must be set together');
  }

  const thresholdRatio = engineThresholdRatio ?? 0.8;
  const retainRatio = engineRetainRatio ?? 0.16;
  if (retainRatio >= thresholdRatio) {
    throw new Error('dsh-auxiliary: engine.retainRatio must be less than engine.thresholdRatio');
  }

  return deepFreeze({
    vision: {
      provider: visionProvider,
      model: visionModel,
      maxTokens: visionMaxTokens ?? DEFAULT_VISION_MAX_TOKENS,
      handoff: visionHandoff ?? true,
      skipWhenMainModelSupportsImage: visionSkip ?? false
    },
    tool: {
      enabled: toolEnabled ?? true,
      maxImageBytes: toolMaxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      timeoutMs: toolTimeoutMs ?? DEFAULT_VISION_TOOL_TIMEOUT_MS
    },
    compact: {
      enabled: compactEnabled ?? false,
      provider: compactProvider,
      model: compactModel
    },
    approve: {
      enabled: approveEnabled ?? false,
      provider: approveProvider,
      model: approveModel
    },
    subagent: {
      enabled: subagentEnabled ?? false,
      provider: subagentProvider,
      model: subagentModel
    },
    title: {
      enabled: titleEnabled ?? false,
      provider: titleProvider,
      model: titleModel
    },
    imagegen: {
      enabled: imagegenEnabled ?? false,
      provider: imagegenProvider,
      model: imagegenModel
    },
    engine: {
      enabled: engineEnabled ?? false,
      thresholdRatio,
      retainRatio,
      maxTokens: engineMaxTokens ?? DEFAULT_ENGINE_MAX_TOKENS,
      compactionRetries: engineCompactionRetries ?? 1,
      maxOverflowRetries: engineMaxOverflowRetries ?? 1,
      auto: engineAuto ?? true,
      compressPrompt: typeof engineCompressPrompt === 'string' && engineCompressPrompt.length > 0 ? engineCompressPrompt : DEFAULT_COMPRESS_PROMPT
    }
  });
}

export { Config };
