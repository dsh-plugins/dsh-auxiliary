<div align="center">

![Banner](./docs/banner.png)

# dsh-auxiliary

**DeepSeek Harness 辅助模型插件：为视觉理解、上下文压缩、审批审查、子代理、会话标题与图片生成提供独立的模型路由、工具与系统提示，全程不触碰主对话模型。**

[English](README.md) | 简体中文

[![DSH Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f7cff)](https://github.com/topics/dsh-plugin)
<a href="https://github.com/dsh-plugins/dsh-auxiliary/actions/workflows/npm-publish.yml">
  <img src="https://github.com/dsh-plugins/dsh-auxiliary/actions/workflows/npm-publish.yml/badge.svg" alt="Build Status">
</a>
<a href="https://www.npmjs.com/package/@dsh-plugin/dsh-auxiliary">
  <img src="https://img.shields.io/npm/v/@dsh-plugin/dsh-auxiliary.svg?sanitize=true" alt="Version">
</a>
<a href="https://www.npmjs.com/package/@dsh-plugin/dsh-auxiliary">
  <img src="https://img.shields.io/npm/l/@dsh-plugin/dsh-auxiliary.svg?sanitize=true" alt="License">
</a>

</div>

`dsh-auxiliary` 是一个 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 插件，在 harness 的 LLM 抽象层（`ctx.llm`）之上叠加辅助模型能力。它从不替换主对话模型：每个功能都是独立、可选的模型路由，只在自己的那类调用上生效——把昂贵或专门的活儿（视觉、压缩摘要、审批审查、委派子代理、会话标题、图片生成）交给各自合适的模型。

## 功能总览

| 功能 | 作用 | 配置入口 |
| --- | --- | --- |
| 视觉理解 | `inspect_image` 工具：读取本地图片并询问视觉模型 | 「模型」页 → 插件配置 → **视觉理解** |
| 图片转交 | 主模型为纯文本时，聊天图片经 `describe_image` 存活 | 视觉理解卡片 → **图片转交** |
| 上下文压缩 | 摘要调用（`purpose: 'compaction'`）使用独立模型 | 插件配置 → **上下文压缩** |
| 压缩引擎（可选） | 用显式压缩提示词替换默认压缩后端 | 配置中的 `engine.enabled` |
| 审批模型 | @dsh-plugin/dsh-approve-for-me 的审查使用独立模型 | 插件配置 → **审批模型** |
| 子代理模型 | 委派子代理使用独立模型 | 插件配置 → **子代理模型** |
| 标题生成模型 | 会话标题（`purpose: 'session-title'`）使用独立模型 | 插件配置 → **标题生成模型** |
| 生图辅助模型 | `generate_image` 工具：经 OpenAI 兼容 images API 生成图片 | 插件配置 → **生图辅助模型** |
| 模型能力标记 | 自定义 `llm-pi-ai` 模型上的复选框：**允许图片输入** / **允许图片生成** | 「模型」页 → 提供商 → 自定义设置 → 模型目录 |

所有路由都在 **loader 统一插件配置** 中配置（由 loader 统一生成表单），保存后立即生效——无需重启，无需重建会话。

## 安装

复制下面的内容，粘贴给 DSH Agent（本 Web GUI 中的助手）。由 Agent 帮你完成安装与验证，无需手动执行 npm 或编辑 profile 配置：

```text
把 @dsh-plugin/dsh-auxiliary 插件安装到我指定的 profile（如果我没说，先问我）。npm 包名为 `@dsh-plugin/dsh-auxiliary`；使用 GitHub 源 `github:dsh-plugins/dsh-auxiliary`，本地开发可用 `file:<路径>`。

步骤：
1. 添加插件依赖：`dsh plugin --profile <PROFILE> add @dsh-plugin/dsh-auxiliary`（或我 profile 对应的插件管理器命令）。0.4.1 起该包是 bundle 插件（声明了 `dsh.bundle.patch`），`dsh plugin add` 会自动把它追加进 `dsh.profile.bundles`，无需再手动编辑 `cordis.patch.yml`。
2. 该包声明了 `prepack` 构建脚本。若 pnpm 报 `ERR_PNPM_IGNORED_BUILDS`，在 profile 的 `pnpm-workspace.yaml`（`allowBuilds`）中批准构建后重试。
3. 如果该 profile 之前是通过 `cordis.patch.yml` 里的手动 insert 行加载本插件（0.4.1 之前的做法），请**删除那一行**——bundle 层现在负责挂载，两者并存会导致插件被挂载两次。
4. 验证 `node_modules/@dsh-plugin/dsh-auxiliary` 存在已构建的 `lib/` 目录（至少 `lib/index.js` 与 `lib/client.js`）。若构建产物缺失，在插件目录运行 `npm run build` 后重新 add。
5. 不要启动 profile——只安装并验证，然后报告你改动了什么。
```

安装完成后，在 Web 的 **loader 统一插件配置** 中配置各路由，并在 **设置 → 模型** 中标记要使用的模型。

## 功能详解

### 视觉理解与 `inspect_image`

先在「模型」页配置提供商与模型，再到 **视觉理解** 选择这对路由（写入 `vision.provider` / `vision.model`）。`tool.enabled` 独立控制 `inspect_image` 工具是否注册。

```yaml
vision:
  provider: anvilcraft-ai     # 任意已注册的提供商路由
  model: mimo-v2.5            # 该提供商下支持视觉的模型
tool:
  enabled: true               # 注册 inspect_image 工具
  maxImageBytes: 10485760     # 单文件大小上限
  timeoutMs: 120000           # 协作式工具调用预算
```

启用后，让智能体对 Host 可读的路径调用 `inspect_image`：

> 请调用 inspect_image 分析 screenshots/error.png

工具通过 `ctx.attachments` 抽象提交文件，并询问所选视觉模型，返回文字答案（可按 `vision.maxTokens` 截断）。支持 PNG、JPEG、WebP、GIF。

**模型能力标记**：对用户配置的 `llm-pi-ai` 模型，模型设置中的 **允许图片输入** 复选框会写入其标准 `input` 声明（勾选时 `[text, image]`，取消时 `[text]`）；`inspect_image` 与主聊天附件校验读取同一份能力事实。该声明不能让纯文本模型获得视觉能力——仅在上游接口确实接受图片时勾选。

### 图片转交（主模型为纯文本时的聊天图片）

**图片转交**（`vision.handoff`，默认开启）启用且已选择视觉路由后，图片按“原生优先、无能力时安全回退”交付：

1. 运行时包装 `ctx.llm.resolveModelInfo`，在转交启用期间为纯文本主路由声称图片输入，图片受理预检因此放行（模型目录与按模型的能力复选框不受影响，因为它们直接读设置文档）。配置的辅助视觉路由绝不会被虚增能力，因此误选纯文本视觉模型时，`inspect_image`/`describe_image` 仍会正确拒绝。
2. 对每个含图片的请求，官方 `llm/stream` waterfall 监听器通过原始能力解析器检查该请求的精确 provider/model。支持图片的路由原样收到 `ImageBlock`；纯文本路由与未声明模态的路由收到 `[image: {"attachmentId":…,"mediaType":…}]` 这类持久文本引用，工具结果内嵌套的图片也会被转换。
3. 系统提示引导纯文本主模型用引用中的 JSON 调用 `describe_image`；该工具读取已存储的附件字节、询问所选视觉模型并返回文字描述。

转换是不可变且请求局部的，因此并发的原生流与回退流不会相互干扰；中止、错误、迭代器提前关闭与插件注销都保持宿主流语义。引用是纯文本，重启、fork 与历史重放后依然可用。两个挂接点都在插件内，核心包零修改。关闭 `vision.handoff` 可恢复原始受理与流行为。

### 主模型支持图片时跳过注入

勾选 **主模型支持图片输入时跳过注入**（`vision.skipWhenMainModelSupportsImage`，默认关闭）后，主模型已声明图片输入的会话不再注入 `inspect_image`/`describe_image` 工具描述和对应提示词——模型直接以原生能力读取聊天图片。这个已有选项使用公开的通用提示词装配上下文与宿主原始 `resolveModelInfo`（在转交包装之前捕获）；工具保持注册，进行中或历史重放的调用仍可执行。

它与图片转交基于精确 `llm/stream` 路由的判断刻意分离。若要按每次真实请求实现精确的 **Auto / Always / Disabled** 工具与提示词可见性，Harness 核心必须把准备后的请求路由/能力发布给提示词装配，并提供覆盖请求生命周期的工具限制契约。已发布的公开 API 尚无该契约，因此本次纯插件修改不会加入无法真正生效的设置，也不依赖私有 agent-loop 类型。

已发布的 `llm/stream` 契约还把 agent-loop 请求内容描述为只读。本版本因此保留插件原有的兼容性转交方式，但让它能识别真实能力并保证并发安全；要把图片转交变成完全正式的一等扩展点，后续仍需核心提供由会话日志记录的图片引用投影/受理挂接点，避免插件重新派发改写后的 loop 请求。

### 上下文压缩

每次摘要调用都携带官方标记 `GenerateOptions.purpose: 'compaction'`。插件安装 `llm/stream` waterfall 监听器，把这类调用改路由到配置的模型对：

```yaml
compact:
  enabled: true
  provider: deepseek-official  # 例如一个便宜快速的摘要模型
  model: deepseek-chat
```

监听器常驻安装、路由不完整时纯透传。只有 `purpose: 'compaction'` 的调用会被改路由，主会话与其它调用类别不受影响。

**压缩引擎**（可选）：`engine.enabled: true` 会用 `BasicCompactionEngine` 子类替换默认压缩后端，以显式的上下文压缩指令驱动摘要（见 `engine.compressPrompt`）。它复用 compact 路由，不增加第三条模型路由；与 `@deepseek-ai/dsh-compaction-basic` 互斥——插件检测到冲突会跳过引擎并告警。

**压缩阈值**：在统一表单中设置 `engine.enabled` 和 `engine.thresholdRatio`，上下文使用率达到该比例后自动触发压缩；阈值必须高于保留比例（`engine.retainRatio`，默认 16%）。引擎会在每次压缩检查前读取最新配置，因此保存后无需重启。

### 自动审查模型

在 `dsh < 0.1.7-rc.2` 时，`approve` 仍对接 approve-for-me 的 review 调用。从 `0.1.7-rc.2` 起改为对接官方 `@deepseek-ai/dsh-experimental-auto-review`，只替换审查请求的提供方/模型，保留官方的策略、输入、会话归属、取消及裁决流程。先启用官方插件并选择官方自动审查权限模式；辅助模型不会替用户启用自动授权。

```yaml
approve:
  enabled: true
  provider: my-provider
  model: my-review-model
```

### 思考过程机器翻译模型

从 `0.2.1-rc.1` 起，统一表单增加「思考过程机器翻译」分组：

```yaml
translation:
  enabled: true
  model: deepseek-flash  # 官方 deepseek-official 模型目录中已有的 ID
```

启用 `@deepseek-ai/dsh-experimental-cot-translation-bundle` 后，在官方翻译菜单选择「DeepSeek Flash · 官方 API」，再用本选项指定它实际调用的模型。此处固定使用官方 API 提供方，只修改模型 ID。Bing、Google、DeepSeek 账号翻译继续使用原实现。

保留原生凭据、模型目录和运行状态检查，以及关闭思考、超时、取消、输出校验和会话持久化。配置关闭时使用官方默认 Flash；模型变更后的缓存与原模型隔离，审计记录写入实际模型。需要已配置的官方 API 凭据，接口调用仍按所选模型计费。辅助模型或翻译服务卸载后会取消进行中的覆盖请求并释放补丁。

### 子代理模型

```yaml
subagent:
  enabled: true
  provider: anvilcraft-ai
  model: deepseek-chat
```

子代理默认继承父会话的模型路由。开启此功能且路由完整时，所有委派子代理——一次性 spawn/fork 委托、可续接子代理（含进程内冷恢复）——统一使用所选模型。插件监听 `agent/created`，对委派深度 > 0 的代理在其自身作用域上下文中安装 `agent/request` waterfall 监听；返回替换后的 `LlmCallConfig` 是 loop 官方的"切换"契约，变更的头快照与其他模型切换一样被记录。远程提供方（ACP）创建的子代理不经过本机代理注册，仍继承父会话。建议选择便宜快速的模型控制委派成本。此功能不需要任何外部插件。

### 标题生成模型

```yaml
title:
  enabled: true
  provider: anvilcraft-ai
  model: deepseek-chat
```

会话标题由 `dsh-session-title-llm` 提供方发起，其自带部署层 `provider`/`model` 配置。开启此功能后，所有 `purpose: 'session-title'` 调用统一改走所选模型，不动提供方自身的配置与主会话路由。识别使用官方的 `GenerateOptions.purpose` 标记，不会与 agent-loop、压缩或审批调用混淆。与压缩路由一样，监听器常驻安装、路由不完整时纯透传。

### 生图辅助模型与 `generate_image`

```yaml
imagegen:
  enabled: true
  provider: lanqin-gpt          # 一个 OpenAI 兼容的提供商路由
  model: gpt-image-2
```

harness 的 LLM 抽象只处理文本，因此生图直接对话提供商的 **OpenAI 兼容 images API**。功能开启且路由完整时：

1. 注册 `generate_image` 工具，并注入系统提示词，引导主模型在用户要求生成/绘制图片时调用它。
2. 工具从解析后的 `llm-pi-ai` 设置读取提供商的 `baseURL`，并通过 harness **凭据层**（`ctx.credentials.resolve`——env/file/user-env 层）解析 `apiKeyEnv`，随后调用 `POST {baseURL}/images/generations`，请求体 `{model, prompt, size, n}`。
3. 返回的图片（base64 或 URL）写入工作目录（`.dsh/generated/`），返回文件路径；主模型可用 `inspect_image` 复核。

**模型能力标记**：选择器只列出标记了 **允许图片生成** 的模型——在模型设置中勾选该框（向 `llm-pi-ai` 命名空间的原始 user 段写入 `imageGeneration: true`）。只标记上游端点确实支持生图的模型。

## 实现思路

插件通过 dsh-loader 2.x 的稳定门面访问宿主；config-api 统一生成表单并保存配置，模型目录增强按宿主启动描述中的版本启停。各功能在配置变更后重新解析快照，按需注册或释放工具与监听器。

### 1. 按 purpose 键控的模型路由

所有文本路由共用一个模式：**一次性安装** `llm/stream` waterfall 监听器（常驻），检查调用后要么原样放行，要么用冻结的替换配置重新进入 LLM 抽象：

- **识别**使用稳定、官方的标记——`GenerateOptions.purpose`（`'compaction'` / `'session-title'`）或审批调用的公开契约——每个路由只能命中自己的调用类别。
- **改路由**调用 `deepFreeze({...options, provider, model})` 后重新进入 `ctx.llm.stream()`；只替换 `provider`/`model`，超时、重试、回退仍归 harness 所有。
- **防环**：替换配置携带相同的路由标记，通过配置相等性检查阻止路由匹配自己的重入。
- **惰性**：路由不完整时监听器纯透传——之后启用功能无需重装，禁用也只需移除监听器。

### 2. 工具与系统提示

工具经 `ctx.tools.register(defineTool(...))` 注册，并通过 `ctx.systemPrompt.section(...)` 告知模型：

- `inspect_image`——视觉理解：文件路径 + 可选问题 → 附件层 → 视觉路由 → 文字答案。
- `describe_image`——转交：读取聊天中 `[image: …]` 引用里的 JSON，经视觉路由作答。
- `generate_image`——生图：提示词（+size/n）→ 提供商 images API（凭据层）→ `.dsh/generated/` 下的 PNG → 路径。

每个工具只在其功能启用且路由完整时注册（reconcile 模式），模型永远看不到用不了的工具。

### 3. 配置与模型目录

插件配置使用独立 config-api，不依赖宿主设置命名空间，也不需要 `exposeAllNamespaces`。模型目录增强仍通过 loader 规范化后的连接 API 编辑官方 `llm-pi-ai` 模型数据；对官方接管的字段不显示旧控件，也不执行继承或延迟写入。图片生成声明继续保留。

### 4. 凭据而非裸环境变量

`apiKeyEnv` 是 `credential-ref`，因此生图工具通过 `ctx.credentials.resolve(credentialRef(...))` 解析密钥——harness 凭据层覆盖 env/file/user-env 各层且**每次调用重新解析**（改了密钥无需重启即可生效）。绝不直接读 `process.env`。

### 5. 全部配置即时生效

每个功能由一个 `reconcile*()` + disposer 对管理：每次设置变更后插件重新解析配置，只注册或注销条件发生变化的部分。在 Web UI 保存路由立即生效。

## 配置

所有字段均可选，括号内为默认值。

```yaml
- name: '@dsh-plugin/dsh-auxiliary'
  config:
    vision:
      maxTokens: 2048                      # inspect_image 输出上限（provider/model 由设置页写入）
      handoff: true                        # 主模型不支持图片时，聊天图片以引用形式发送并由 describe_image 转交
      skipWhenMainModelSupportsImage: false # 主模型支持图片输入时，不注入视觉工具与提示词
    tool:
      enabled: true                        # 注册 inspect_image 工具
      maxImageBytes: 10485760              # 单文件大小上限
      timeoutMs: 120000                    # 协作式工具调用预算
    compact:
      enabled: false                       # 把压缩摘要改路由到辅助模型
      provider: ""                         # 示例：deepseek-official（已注册的提供商路由 id）
      model: ""                            # 示例：deepseek-chat（该提供商下的模型 id）
    approve:
      enabled: false                       # 为 @dsh-plugin/dsh-approve-for-me 的审查提供独立模型
      provider: ""                         # 示例：deepseek-official（已注册的提供商路由 id）
      model: ""                            # 示例：deepseek-chat（该提供商下的模型 id）
    subagent:
      enabled: false                       # 把委派子代理路由到独立模型
      provider: ""                         # 示例：deepseek-official
      model: ""                            # 示例：deepseek-chat
    title:
      enabled: false                       # 把会话标题调用路由到独立模型
      provider: ""                         # 示例：deepseek-official
      model: ""                            # 示例：deepseek-chat
    imagegen:
      enabled: false                       # 注册 generate_image，使用独立的生图模型
      provider: ""                         # 示例：lanqin-gpt（OpenAI 兼容的提供商路由）
      model: ""                            # 示例：gpt-image-2（已标记「允许图片生成」）
    engine:
      enabled: false                       # 可选压缩引擎（与 dsh-compaction-basic 互斥）
      thresholdRatio: 0.8
      retainRatio: 0.16
      maxTokens: 8192
      compactionRetries: 1
      maxOverflowRetries: 1
      auto: true
      compressPrompt: "..."                # 自定义压缩指令
```

### 统一配置表单与 1.x 迁移

需要 Node.js 24.9+ 和 dsh-loader 2.x，覆盖其明确支持的六个版本系列（`0.1.5`、`0.1.6`、`0.1.7`、`0.2.0`、`0.2.1`、`0.2.2`，含预发布版）。早于 `0.1.6-alpha.2` 使用「设置 → 插件配置」，之后使用插件详情页。

每个插件只有一个默认折叠的卡片。视觉、压缩、审批、子代理、标题、生图及压缩引擎作为分组；提供方和模型字段填写官方模型设置中已有的路由 ID。保存后应用到后续请求；隐藏字段保留原值。

配置保存到 `<profile>/config/dsh-auxiliary/config.json`，与官方模型设置隔离。1.x 的 `dsh-auxiliary` settings 命名空间不自动搬迁，请手动复制旧值。Cordis 行配置仍可作为首次注册的默认值；已有文件优先生效。停止 profile 后编辑文件，重新加载插件或重启生效。

模型路由的 provider/model 应成对填写，`engine.retainRatio` 应小于 `engine.thresholdRatio`。字段范围由 config-api 校验；跨字段约束仍由运行时校验，失败时日志报告错误并保留上一次有效运行配置。

### 模型目录增强的版本边界

| dsh 版本 | 输入类型插件控件 | 推理等级插件控件 | 图片生成声明 |
| --- | --- | --- | --- |
| `< 0.1.7-rc.1` | 提供 | 提供 | 提供 |
| `>= 0.1.7-rc.1` 且 `< 0.2.1-rc.1` | 使用官方实现 | 提供 | 提供 |
| `>= 0.2.1-rc.1` | 使用官方实现 | 使用官方实现 | 提供 |

断点包含指定版本本身。旧版增强位于模型目录的容量折叠区，改动待官方提供方保存完成后写入，避免修订冲突。重命名模型时只继承当前版本仍归插件负责的字段。卸载时停止观察与延迟写入，移除控件并卸载 React 根节点。

## 说明

- 各路由功能只改路由自己那一类调用（`purpose: 'compaction'` / `purpose: 'session-title'` / 审批审查契约），主会话路由永不被触碰。
- `engine.enabled: true` 会**替换**默认压缩后端；请勿同时加载 `@deepseek-ai/dsh-compaction-basic`。插件检测到冲突会跳过引擎并告警。
- 视觉工具参数：`path`（绝对路径或工作区相对路径）与可选的 `question`。支持格式：PNG、JPEG、WebP、GIF。
- `generate_image` 参数：`prompt`（必填）、可选的 `size` 与 `n`（多数提供商只接受 `n: 1`）。

## 开发

```bash
npm install          # 安装依赖（typescript、@deepseek-ai/* peers）
npm run typecheck    # tsc --noEmit
npm test             # 构建并运行 Node 回归测试
npm run build        # 产出 lib/
```

## 许可证

[LGPL-3.0](LICENSE)
