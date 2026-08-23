/**
 * dsh-auxiliary 的 dsh 符号接入点。
 *
 * 本插件的宿主半区有 10 个文件需要 dsh 的**模块级**导出（`defineTool`、
 * `ToolArgsError`、`deadline`、`credentialRef`、`delegationDepthOf`、
 * `BasicCompactionEngine`、`BlockAssembler`、`createUserMessage`）。这些都不是
 * cordis 服务方法，`ctx.get(...)` 拿不到；而直接 `import` `@deepseek-ai/*` 会把
 * 插件重新绑死在 dsh 内部面上。
 *
 * 解法：dshloader 的 `ctx.dshLoader.{dsh,llm}` 门面在启动期解析这些符号，本模块
 * 在 `apply` 里接住它（{@link setDshFacade}），其余文件一律经 {@link dsh} /
 * {@link llm} 取用。这样：
 *
 *   - 各文件的 import 全部指向本地 `./dsh.js`，不再出现 `@deepseek-ai/*`；
 *   - 门面只在**运行期**被触达（函数体内），不在模块求值期，因此不受
 *     「apply 之前 ctx 不存在」的限制；
 *   - dsh 挪动内部面时只改 dshloader，本插件与其余附属插件一起受益。
 *
 * 唯一无法走门面的是**模块求值期**就需要的值。本插件只有两处，都已就地解决：
 *   - `MAX_TIMER_DELAY_MS`（config.ts 的 schema 上界）→ 见 {@link MAX_TIMER_DELAY_MS}；
 *   - `settingsNamespace('llm-pi-ai')`（imagegen-tool.ts 顶层）→ dsh 的实现是
 *     纯校验 + 原样返回（只在类型层加品牌），因此顶层直接用裸字符串等价。
 *
 * @module dsh-auxiliary/dsh
 */

/**
 * dsh 包的**类型**（不是值）。
 *
 * `import type` 在编译期被完全擦除，不进运行时 import 图，因此与「零
 * @deepseek-ai 运行时导入」并不冲突。这样做是必要的：门面若把签名放宽成
 * `<T>(d: T) => T`，`defineTool({ execute(args, exec) {...} })` 里的 `args`/`exec`
 * 就失去上下文类型而变成隐式 any。
 *
 * 原则：**门面负责运行时解耦，`import type` 负责编译期保真**，两者同时用。
 */
import type * as DshTools from '@deepseek-ai/dsh-tools';
import type * as DshTimeout from '@deepseek-ai/dsh-timeout';
import type * as DshCredentials from '@deepseek-ai/dsh-credentials';
import type * as DshSubagent from '@deepseek-ai/dsh-subagent';
import type * as DshLlm from '@deepseek-ai/dsh-llm';

/** dshloader 的 `dsh` 门面里本插件用到的部分，签名与 dsh 本体一致。 */
export interface DshSymbols {
  tools: {
    defineTool: typeof DshTools.defineTool;
    readonly ToolArgsError: typeof DshTools.ToolArgsError;
  };
  timeout: {
    deadline: typeof DshTimeout.deadline;
  };
  credentials: {
    credentialRef: typeof DshCredentials.credentialRef;
  };
  subagent: {
    delegationDepthOf: typeof DshSubagent.delegationDepthOf;
  };
  compaction: {
    /** 基类保持宽松：它只被 `extends`，收窄反而妨碍惰性子类化。 */
    readonly BasicCompactionEngine: new (...args: any[]) => any;
  };
  llm: {
    readonly BlockAssembler: typeof DshLlm.BlockAssembler;
  };
}

/** dshloader 的 `llm` 门面里本插件用到的部分。 */
export interface LlmHelpers {
  createUserMessage: typeof DshLlm.createUserMessage;
  deepFreeze: typeof DshLlm.deepFreeze;
}

/** `ctx.dshLoader` 中本插件依赖的两个门面。 */
export interface DshFacade {
  dsh: DshSymbols;
  llm: LlmHelpers;
}

let facade: DshFacade | undefined;

/**
 * 在 `apply` 最开始注入 `ctx.dshLoader`。
 *
 * @param value - loader 门面（只取 `dsh` 与 `llm` 两块）。
 */
export function setDshFacade(value: DshFacade): void {
  facade = value;
}

/** 清除注入（插件卸载 / 测试隔离用）。 */
export function clearDshFacade(): void {
  facade = undefined;
}

/**
 * dsh 的模块级符号。
 *
 * @throws 当 `apply` 尚未注入门面时——这表示调用发生在插件装配之前，是编程错误，
 *   响亮失败比返回一个半可用的对象好。
 */
export function dsh(): DshSymbols {
  if (facade === undefined) {
    throw new Error('dsh-auxiliary: ctx.dshLoader 尚未注入；dsh() 只能在 apply 之后调用');
  }
  return facade.dsh;
}

/** dsh 的 LLM 消息构造 helper。 */
export function llm(): LlmHelpers {
  if (facade === undefined) {
    throw new Error('dsh-auxiliary: ctx.dshLoader 尚未注入；llm() 只能在 apply 之后调用');
  }
  return facade.llm;
}

/**
 * Node 的 `setTimeout` 上限（2^31 - 1）。
 *
 * `config.ts` 在**模块求值期**就要用它做 schema 上界，那时门面还不存在。这个值
 * 是平台常量而非 dsh 版本相关值（dsh 的 `MAX_TIMER_DELAY_MS` 就等于它），所以就地
 * 定义是等价且安全的，而不是猜测。
 */
export const MAX_TIMER_DELAY_MS = 2147483647;

/**
 * 递归冻结。
 *
 * `resolvePluginConfig` 是导出的纯函数（既作为 `installSection` 的 `validate`，
 * 也被测试直接调用），可能在门面注入之前运行，因此这里自带实现：门面可用时用
 * dsh 自己的 `deepFreeze`（冻结语义与运行时一致），否则退回本地递归冻结。
 */
export function deepFreeze<T>(value: T): T {
  if (facade !== undefined) return facade.llm.deepFreeze(value);
  return localDeepFreeze(value);
}

/** 本地递归冻结：对象与数组逐层 Object.freeze，其余原样返回。 */
function localDeepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    localDeepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
