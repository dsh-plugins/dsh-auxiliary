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
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic';
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';
import { dsh, llm } from './dsh.js';
import { PLUGIN_NAME } from './config.js';
import { compactRoute } from './compact-router.js';
import { providerCompactionMode } from './provider-compaction.js';
import type { ResolvedPluginConfig } from './config.js';

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

/** 已安装的压缩引擎对调用方提供按需压缩入口。 */
export interface CompressEngine {
  compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>;
}

function hasCompactionEngine(ctx: Context): boolean {
  if (ctx.get('compaction', false) !== undefined) {
    ctx.logger.warn('dsh-auxiliary: compression engine skipped — ctx.compaction is already provided by dsh-compaction-basic; remove that plugin to enable the auxiliary compression engine');
    return true;
  }
  return false;
}

/** 通过 Cordis 挂载引擎，使宿主基类的服务依赖和异步初始化钩子随子插件生效。 */
export function installCompressionEngine(ctx: Context, get: () => ResolvedPluginConfig): (CompressEngine & Pick<Fiber, 'dispose'>) | undefined {
  if (hasCompactionEngine(ctx)) {
    return undefined;
  }
  const Base = dsh().compaction.BasicCompactionEngine;
  let activeEngine: CompressEngine | undefined;

  class CompressEngineImpl extends Base {
    private readonly compressPrompt: string;

    constructor(scope: Context) {
      const engine = get().engine;
      super(scope, {
        thresholdRatio: engine.thresholdRatio,
        retainRatio: engine.retainRatio,
        maxTokens: engine.maxTokens,
        compactionRetries: engine.compactionRetries,
        maxOverflowRetries: engine.maxOverflowRetries,
        auto: engine.auto,
      });
      this.compressPrompt = engine.compressPrompt;
    }

    private syncEngineConfig(): void {
      const engine = get().engine;
      // 宿主还会使用自身解析出的策略字段，例如计算压力阈值所需的 headroomTokens。
      const next: ResolvedConfig = {
        ...this.config,
        thresholdRatio: engine.thresholdRatio,
        retainRatio: engine.retainRatio,
        maxTokens: engine.maxTokens,
        compactionRetries: engine.compactionRetries,
        maxOverflowRetries: engine.maxOverflowRetries,
      };
      this.config = next;
    }

    compactIfNeeded(
      agent: Agent,
      trigger: CompactionTrigger,
      signal: AbortSignal,
    ): Promise<CompactionResult | null> {
      this.syncEngineConfig();
      return super.compactIfNeeded(agent, trigger, signal);
    }

    protected async summarize(input: CompressInput, agent: Agent, signal?: AbortSignal): Promise<CompressResult> {
      const provider = agent.session.requestHeader()?.config.provider ?? agent.options.provider;
      if (provider !== undefined && providerCompactionMode(this.ctx, provider) !== undefined) {
        return super.summarize(input, agent, signal);
      }
      const route = compactRoute(get);
      if (route === undefined) {
        // No auxiliary route: keep the stock behavior untouched.
        return super.summarize(input, agent, signal);
      }
      const messages = [
        ...input.messages,
        llm().createUserMessage({
          content: [{ type: 'text', text: this.compressPrompt }],
          source: { kind: 'plugin', plugin: PLUGIN_NAME }
        })
      ];
      const assembler = new (dsh().llm.BlockAssembler)();
      for await (const chunk of this.ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
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
      const summary = rawOutput.filter((block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text');
      if (!summary.some((block: Extract<ContentBlock, { type: 'text' }>) => block.text.trim().length > 0)) {
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

  const fiber = ctx.plugin(class AuxiliaryCompression {
    static inject = Base.inject;

    constructor(scope: Context) {
      // 等待依赖期间可能已有其他后端注册。Cordis 会对这里返回的实例执行宿主初始化钩子。
      if (hasCompactionEngine(scope)) {
        return;
      }
      activeEngine = new CompressEngineImpl(scope);
      scope.effect(() => () => { activeEngine = undefined; });
      return activeEngine;
    }
  });
  return {
    dispose: fiber.dispose,
    async compactIfNeeded(agent, trigger, signal) {
      await fiber.await();
      if (activeEngine === undefined) {
        throw new Error('dsh-auxiliary: compression engine is inactive');
      }
      return activeEngine.compactIfNeeded(agent, trigger, signal);
    },
  };
}
