/**
 * Plugin configuration: schemastery schema, runtime validation, and the
 * resolved snapshot consumed by every feature. The same schema backs the
 * `cordis.yml` entry and the optional `dsh-auxiliary` user-settings section,
 * so a settings change reaches the very next request.
 *
 * @module dsh-auxiliary/config
 */
import z from 'schemastery';
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

/** Plugin entry / settings schema. Field defaults live here so the UI can render them. */
const Config = z.object({
  vision: z.object({
    provider: z.string().description('Select an already-configured provider route for inspect_image.'),
    model: z.string().description('Select a model from the selected provider route for inspect_image.'),
    maxTokens: z.number().step(1).min(1).default(DEFAULT_VISION_MAX_TOKENS),
    handoff: z.boolean().default(true).description('When the main model is text-only, allow chat images as references and let it fetch their content via describe_image.')
  }),
  tool: z.object({
    enabled: z.boolean().default(true),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_VISION_TOOL_TIMEOUT_MS)
  }),
  compact: z.object({
    enabled: z.boolean().default(false),
    provider: z.string(),
    model: z.string()
  }),
  approve: z.object({
    enabled: z.boolean().default(false).description('When @dsh-plugin/dsh-approve-for-me is installed, route its review-mode approval calls to a dedicated model.'),
    provider: z.string(),
    model: z.string()
  }),
  subagent: z.object({
    enabled: z.boolean().default(false).description('Route every delegated child agent (subagent) to a dedicated provider/model pair.'),
    provider: z.string(),
    model: z.string()
  }),
  title: z.object({
    enabled: z.boolean().default(false).description('Route the session-title generation call (purpose: session-title) to a dedicated provider/model pair.'),
    provider: z.string(),
    model: z.string()
  }),
  imagegen: z.object({
    enabled: z.boolean().default(false).description('Route auxiliary image-generation work to a dedicated provider/model pair marked for image generation.'),
    provider: z.string(),
    model: z.string()
  }),
  engine: z.object({
    enabled: z.boolean().default(false),
    thresholdRatio: z.number().step(0.01).min(0.01).max(0.99).default(0.8),
    retainRatio: z.number().step(0.01).min(0.01).max(0.99).default(0.16),
    maxTokens: z.number().step(1).min(1).default(DEFAULT_ENGINE_MAX_TOKENS),
    compactionRetries: z.number().step(1).min(0).default(1),
    maxOverflowRetries: z.number().step(1).min(0).default(1),
    auto: z.boolean().default(true),
    compressPrompt: z.string().default(DEFAULT_COMPRESS_PROMPT)
  })
});

/** Inferred plugin configuration value. */
export type PluginConfig = typeof Config extends z<infer T> ? T : never;

/** Resolved selection for an existing vision-capable provider/model route. */
export interface ResolvedVisionConfig {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly maxTokens: number;
  /** Image handoff: text-only main models may reference chat images via describe_image. */
  readonly handoff: boolean;
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

  const visionProvider = typeof vision.provider === 'string' && vision.provider.length > 0 ? vision.provider : undefined;
  const visionModel = typeof vision.model === 'string' && vision.model.length > 0 ? vision.model : undefined;
  if (Boolean(visionProvider) !== Boolean(visionModel)) {
    throw new Error('dsh-auxiliary: vision.provider and vision.model must be set together');
  }

  const compactProvider = typeof compact.provider === 'string' ? compact.provider : '';
  const compactModel = typeof compact.model === 'string' ? compact.model : '';
  if (Boolean(compactProvider) !== Boolean(compactModel)) {
    throw new Error('dsh-auxiliary: compact.provider and compact.model must be set together');
  }

  const approveProvider = typeof approve.provider === 'string' && approve.provider.length > 0 ? approve.provider : undefined;
  const approveModel = typeof approve.model === 'string' && approve.model.length > 0 ? approve.model : undefined;
  if (Boolean(approveProvider) !== Boolean(approveModel)) {
    throw new Error('dsh-auxiliary: approve.provider and approve.model must be set together');
  }

  const subagentProvider = typeof subagent.provider === 'string' && subagent.provider.length > 0 ? subagent.provider : undefined;
  const subagentModel = typeof subagent.model === 'string' && subagent.model.length > 0 ? subagent.model : undefined;
  if (Boolean(subagentProvider) !== Boolean(subagentModel)) {
    throw new Error('dsh-auxiliary: subagent.provider and subagent.model must be set together');
  }

  const titleProvider = typeof title.provider === 'string' && title.provider.length > 0 ? title.provider : undefined;
  const titleModel = typeof title.model === 'string' && title.model.length > 0 ? title.model : undefined;
  if (Boolean(titleProvider) !== Boolean(titleModel)) {
    throw new Error('dsh-auxiliary: title.provider and title.model must be set together');
  }

  const imagegenProvider = typeof imagegen.provider === 'string' && imagegen.provider.length > 0 ? imagegen.provider : undefined;
  const imagegenModel = typeof imagegen.model === 'string' && imagegen.model.length > 0 ? imagegen.model : undefined;
  if (Boolean(imagegenProvider) !== Boolean(imagegenModel)) {
    throw new Error('dsh-auxiliary: imagegen.provider and imagegen.model must be set together');
  }

  const thresholdRatio = engine.thresholdRatio ?? 0.8;
  const retainRatio = engine.retainRatio ?? 0.16;
  if (retainRatio >= thresholdRatio) {
    throw new Error('dsh-auxiliary: engine.retainRatio must be less than engine.thresholdRatio');
  }

  return deepFreeze({
    vision: {
      provider: visionProvider,
      model: visionModel,
      maxTokens: vision.maxTokens ?? DEFAULT_VISION_MAX_TOKENS,
      handoff: vision.handoff ?? true
    },
    tool: {
      enabled: tool.enabled ?? true,
      maxImageBytes: tool.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      timeoutMs: tool.timeoutMs ?? DEFAULT_VISION_TOOL_TIMEOUT_MS
    },
    compact: {
      enabled: compact.enabled ?? false,
      provider: compactProvider,
      model: compactModel
    },
    approve: {
      enabled: approve.enabled ?? false,
      provider: approveProvider,
      model: approveModel
    },
    subagent: {
      enabled: subagent.enabled ?? false,
      provider: subagentProvider,
      model: subagentModel
    },
    title: {
      enabled: title.enabled ?? false,
      provider: titleProvider,
      model: titleModel
    },
    imagegen: {
      enabled: imagegen.enabled ?? false,
      provider: imagegenProvider,
      model: imagegenModel
    },
    engine: {
      enabled: engine.enabled ?? false,
      thresholdRatio,
      retainRatio,
      maxTokens: engine.maxTokens ?? DEFAULT_ENGINE_MAX_TOKENS,
      compactionRetries: engine.compactionRetries ?? 1,
      maxOverflowRetries: engine.maxOverflowRetries ?? 1,
      auto: engine.auto ?? true,
      compressPrompt: typeof engine.compressPrompt === 'string' && engine.compressPrompt.length > 0 ? engine.compressPrompt : DEFAULT_COMPRESS_PROMPT
    }
  });
}

export { Config };
