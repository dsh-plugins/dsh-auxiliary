/**
 * Auxiliary compression engine: a {@link BasicCompactionEngine} subclass whose
 * sole customization hook (`summarize`) is overridden to (a) route the summary
 * call to the configured auxiliary model pair and (b) drive it with an explicit
 * context-compression instruction instead of the default summarization prompt.
 *
 * This is optional and mutually exclusive with the stock `dsh-compaction-basic`
 * backend: both provide `ctx.compaction`. When the auxiliary route is not
 * configured the override falls back to the base implementation, so the engine
 * degrades gracefully.
 *
 * @module dsh-auxiliary/compress-engine
 */
import type { Context } from '@deepseek-ai/cordis';
import {
  BasicCompactionEngine,
  type BasicCompactionConfig,
  type ResolvedConfig,
} from '@deepseek-ai/dsh-compaction-basic';
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { BlockAssembler, createUserMessage, type ContentBlock, type Message, type TokenUsage, type ToolSchema } from '@deepseek-ai/dsh-llm';
import { PLUGIN_NAME } from './config.js';
import { compactRoute } from './compact-router.js';
import type { ResolvedEngineConfig, ResolvedPluginConfig } from './config.js';

/** Structural mirror of the base hook's input type. */
interface CompressInput {
  readonly system?: string;
  readonly tools?: readonly ToolSchema[];
  readonly messages: readonly Message[];
}

/** Structural mirror of the base hook's result type. */
type CompressResult = {
  summary: ContentBlock[];
  provider: string;
  model: string;
  maxTokens?: number;
  usage?: TokenUsage;
} & (
  | { rawOutput: ContentBlock[]; llmStreamCall: true }
  | { rawOutput?: ContentBlock[]; llmStreamCall?: never }
);

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: { kind: string; failure?: { message: string; code: string } }): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined;
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? 'compression call failed');
      (error as Error & { code?: string }).code = finish.failure?.code;
      return error;
    }
    case 'max-tokens':
      return new Error('dsh-auxiliary: compression output reached maxTokens');
    case 'tool-calls':
      return new Error('dsh-auxiliary: compression model unexpectedly requested a tool');
    default:
      return new Error(`dsh-auxiliary: unsupported finish reason "${String(finish.kind)}"`);
  }
}

/** The auxiliary compression engine described at the module head. */
export class CompressEngine extends BasicCompactionEngine {
  private readonly compressPrompt: string;
  private readonly auxRoute: () => { provider: string; model: string } | undefined;
  private readonly getEngineConfig: () => ResolvedEngineConfig;

  constructor(
    ctx: Context,
    config: BasicCompactionConfig | undefined,
    compressPrompt: string,
    auxRoute: () => { provider: string; model: string } | undefined,
    getEngineConfig: () => ResolvedEngineConfig
  ) {
    super(ctx, config);
    this.compressPrompt = compressPrompt;
    this.auxRoute = auxRoute;
    this.getEngineConfig = getEngineConfig;
  }

  /**
   * Refresh the pressure policy right before a check so settings-page edits to
   * the compaction threshold apply without restarting or rebuilding listeners.
   */
  private syncEngineConfig(): void {
    const engine = this.getEngineConfig();
    const next: ResolvedConfig = {
      thresholdRatio: engine.thresholdRatio,
      retainRatio: engine.retainRatio,
      maxTokens: engine.maxTokens,
      compactionRetries: engine.compactionRetries,
      maxOverflowRetries: engine.maxOverflowRetries,
      summarizationProvider: '',
      summarizationModel: '',
      modelPolicies: [],
      auto: true,
    };
    (this as unknown as { config: ResolvedConfig }).config = next;
  }

  override compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    this.syncEngineConfig();
    return super.compactIfNeeded(agent, trigger, signal);
  }

  protected override async summarize(input: CompressInput, agent: Agent, signal?: AbortSignal): Promise<CompressResult> {
    const route = this.auxRoute();
    if (route === undefined) {
      // No auxiliary route: keep the stock behavior untouched.
      return super.summarize(input, agent, signal);
    }
    const messages = [
      ...input.messages,
      createUserMessage({
        content: [{ type: 'text', text: this.compressPrompt }],
        source: { kind: 'plugin', plugin: PLUGIN_NAME }
      })
    ];
    const assembler = new BlockAssembler();
    for await (const chunk of this.ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      ...(input.system !== undefined ? { system: input.system } : {}),
      ...(input.tools !== undefined ? { tools: [...input.tools] } : {}),
      maxTokens: this.config.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal !== undefined ? { signal } : {})
    })) {
      assembler.push(chunk);
    }
    const terminalError = finishError(assembler.finish);
    if (terminalError !== undefined) throw terminalError;
    const rawOutput = assembler.blocks();
    const summary = rawOutput.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text');
    if (!summary.some((block) => block.text.trim().length > 0)) {
      throw new Error('dsh-auxiliary: compression produced no text summary content');
    }
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: route.provider,
      model: route.model,
      maxTokens: this.config.maxTokens,
      ...(assembler.usage !== undefined ? { usage: assembler.usage } : {})
    };
  }
}

/** Install the engine unless `ctx.compaction` is already provided (the stock */
export function installCompressionEngine(ctx: Context, get: () => ResolvedPluginConfig): CompressEngine | undefined {
  if (ctx.get('compaction') !== undefined) {
    ctx.logger.warn('dsh-auxiliary: compression engine skipped — ctx.compaction is already provided by dsh-compaction-basic; remove that plugin to enable the auxiliary compression engine');
    return undefined;
  }
  const engine = get().engine;
  return new CompressEngine(
    ctx,
    {
      thresholdRatio: engine.thresholdRatio,
      retainRatio: engine.retainRatio,
      maxTokens: engine.maxTokens,
      compactionRetries: engine.compactionRetries,
      maxOverflowRetries: engine.maxOverflowRetries,
      auto: engine.auto
    },
    engine.compressPrompt,
    () => compactRoute(get),
    () => get().engine
  );
}
