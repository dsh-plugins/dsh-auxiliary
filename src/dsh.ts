/**
 * dsh-auxiliary-neo 的 dsh 符号接入点。
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
 * @module dsh-auxiliary-neo/dsh
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
}

/**
 * 本插件自有的消息来源。
 *
 * 0.2.0 的 `MessageSourceMap` 只有 `user | model | tool | system-prompt`（无
 * `plugin`），且没有随包发布的扩展。dsh 的约定是每个生产者自行声明自己的
 * `kind`（`dsh-tools` 的 `tool-registry`、`dsh-user-approval` 的 `user-approval`
 * 都这么做）。这里同样用模块增强声明一个具名的 `dsh-auxiliary-neo` 来源：消息仍是
 * `createUserMessage` 造出的 user-role 消息（插件消息就是 user-role），但归属
 * 保持真实，而不是伪装成用户消息。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-auxiliary-neo': {
      kind: 'dsh-auxiliary-neo';
    };
  }
}

/**
 * loader 的 volatile 配置刷新信号。
 *
 * 真实签名来自 `@deepseek-ai/cordis-plugin-loader` 的 `Events` 增强，但该包不是
 * 本插件的编译期依赖（它的 `dshLoader` 服务是运行期经 cordis 注入的），其类型
 * 因此不在可达的编译图里。这里按上游原样声明同一个事件，让 `ctx.on(...)` 有类型
 * 而不是被迫 `as never` 断言。重复声明是声明合并，若上游类型可见则二者一致。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** volatile 配置值已提交进运行中的 fiber，未重挂载；只派发给拥有它的 fiber。 */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
  }
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
    throw new Error('dsh-auxiliary-neo: ctx.dshLoader 尚未注入；dsh() 只能在 apply 之后调用');
  }
  return facade.dsh;
}

/** dsh 的 LLM 消息构造 helper。 */
export function llm(): LlmHelpers {
  if (facade === undefined) {
    throw new Error('dsh-auxiliary-neo: ctx.dshLoader 尚未注入；llm() 只能在 apply 之后调用');
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
 * **总是**使用本地实现，不再经 loader 门面转发：0.2.0 的 `@deepseek-ai/dsh-llm`
 * 不再导出 `deepFreeze`，loader 的 `llm` 门面因此静默退回**浅** `Object.freeze`
 * ——对本插件的 image-handoff / title-router / compact-router / approve-router 与
 * `resolvePluginConfig` 而言是真实的行为退化。`deepFreeze` 是平台无关的纯工具
 * 函数，不涉及任何 dsh 内部面，就地实现是等价且更可靠的。
 *
 * `resolvePluginConfig` 是导出的纯函数（也被测试直接调用），可能在门面注入之前
 * 运行；本地实现同时覆盖了这种情况。
 */
export function deepFreeze<T>(value: T): T {
  return localDeepFreeze(value);
}

/**
 * 本地递归冻结。
 *
 * 语义对齐 dsh 自己的 `@deepseek-ai/dsh-util-values` 实现（0.2.0 的
 * `deepFreeze` 真正所在），而不是简单逐层 `Object.freeze`：
 *
 *   - **跳过 `AbortSignal`**：本插件冻结的请求选项对象里带着活的 `signal`
 *     （image-handoff / title-router / compact-router / approve-router 都是
 *     `{ ...options }`）。冻结一个 `AbortSignal` 会破坏其内部状态，是真实缺陷；
 *   - **用 seen 集合防环**：`options` 图可能自引用，无防护会栈溢出。
 */
function localDeepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (node instanceof AbortSignal) return;
    if (seen.has(node)) return;
    seen.add(node);
    Object.freeze(node);
    for (const key of Object.keys(node)) visit((node as Record<string, unknown>)[key]);
  };
  visit(value);
  return value;
}
