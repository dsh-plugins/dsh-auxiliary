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
| 视觉理解 | `inspect_image` 工具：读取本地图片并询问视觉模型 | 「模型」页 → 辅助模型 → **视觉理解** |
| 图片转交 | 主模型为纯文本时，聊天图片经 `describe_image` 存活 | 视觉理解卡片 → **图片转交** |
| 上下文压缩 | 摘要调用（`purpose: 'compaction'`）使用独立模型 | 辅助模型 → **上下文压缩** |
| 压缩引擎（可选） | 用显式压缩提示词替换默认压缩后端 | 配置中的 `engine.enabled` |
| 审批模型 | @dsh-plugin/dsh-approve-for-me 的审查使用独立模型 | 辅助模型 → **审批模型** |
| 子代理模型 | 委派子代理使用独立模型 | 辅助模型 → **子代理模型** |
| 标题生成模型 | 会话标题（`purpose: 'session-title'`）使用独立模型 | 辅助模型 → **标题生成模型** |
| 生图辅助模型 | `generate_image` 工具：经 OpenAI 兼容 images API 生成图片 | 辅助模型 → **生图辅助模型** |
| 模型能力标记 | 自定义 `llm-pi-ai` 模型上的复选框：**允许图片输入** / **允许图片生成** | 「模型」页 → 提供商 → 自定义设置 → 模型目录 |

所有路由都在 **设置 → 辅助模型** 中配置（插件自带该设置分区），保存后立即生效——无需重启，无需重建会话。

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

安装完成后，在 Web 的 **设置 → 辅助模型** 中配置各路由，并在 **设置 → 模型** 中标记要使用的模型。

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

**图片转交**（`vision.handoff`，默认开启）启用且已选择视觉路由后，给纯文本主模型的会话附加图片不再失败：

1. 运行时包装 `ctx.llm.resolveModelInfo`，在转交启用期间为未声明图片输入的模型声称图片输入，图片受理预检因此放行（模型目录与按模型的能力复选框不受影响——它们直接读设置文档）。
2. 监听官方 `llm/stream` waterfall：在适配器看到图片之前，把图片块替换成文本引用 `[image: {"attachmentId":…,"mediaType":…}]`；纯文本主模型永远不会收到图片负载（`inspect_image` 等视觉路由调用不受影响）。
3. 系统提示引导主模型用引用中的 JSON 调用 `describe_image`；该工具读取已存储的附件字节、询问所选视觉模型并返回文字描述。

引用是纯文本，重启、fork 与历史重放后依然可用。两个挂接点都在插件内，核心包零修改。关闭 `vision.handoff` 可恢复原来的拒绝行为。

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

### 审批模型（@dsh-plugin/dsh-approve-for-me 联动）

[@dsh-plugin/dsh-approve-for-me](https://github.com/dsh-plugins/dsh-approve-for-me) 提供类 Codex 的自动审批；在 `review` 模式下由轻量审查模型裁决每条审批提示。**审批模型** 卡片为审查提供独立模型：

```yaml
approve:
  enabled: true
  provider: anvilcraft-ai
  model: mimo-v2.5
```

1. 监听 `llm/stream` waterfall，按公开契约识别审查调用——用户消息中的固定标记 `>>> APPROVAL REQUEST START`、无 `sessionId`、`temperature: 0`——并改路由到 `approve.provider` / `approve.model`。
2. 调用其余部分（安全策略、转录、超时、重试、回退）仍归 approve-for-me 所有；只替换模型路由，裁决依旧不会写入会话历史。

路由仅在功能开启且路由完整时激活；未安装该插件时不存在审查调用，监听器自然闲置。生效前提：approve-for-me 处于 `mode: review` 且会话选中 `approve-for-me` 或 `strict-review` 权限预设。建议选择便宜快速的模型。

设置页会检测插件是否安装：插件通过可选的 `webServer` 服务提供只读 JSON 端点 `/dsh-auxiliary/state`（`{"approvePluginInstalled": true|false}`）；当插件的预设不在 `permissionPresets` 实时表中时，卡片显示"未检测到插件"并禁用编辑。端点仅监听本机回环、不返回敏感数据，headless profile 中不会注册。

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
3. 返回的图片（base64 或 URL）写入工作目录（`generated/`），返回文件路径；主模型可用 `inspect_image` 复核。

**模型能力标记**：选择器只列出标记了 **允许图片生成** 的模型——在模型设置中勾选该框（向 `llm-pi-ai` 命名空间的原始 user 段写入 `imageGeneration: true`）。只标记上游端点确实支持生图的模型。

## 实现思路

插件基于标准 DSH 扩展点构建（见[插件开发指南](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)），harness 核心零修改。

```
┌─────────────────────────── Web 设置层 ────────────────────────────┐
│ 设置 → 辅助模型（settings.section 插槽）                           │
│   └─ 功能卡片：视觉·压缩·审批·子代理·标题·生图                     │
│      → saveAuxFeature → 命名空间 user 段                           │
│ 设置 → 模型（MutationObserver DOM 注入）                           │
│   └─ 模型目录行：允许图片输入 / 允许图片生成 复选框                │
│      → llm-pi-ai 的原始 user 段                                    │
└────────────────────────────────────────────────────────────────────┘
                              │ 读取（namespace.user / settings.get）
                              ▼
┌─────────────────────────── Host 插件层 ────────────────────────────┐
│ config.ts：schemastery schema + resolvePluginConfig（成对校验）    │
│ reconcile*()：配置变更时按功能注册/注销                             │
│                                                                     │
│  llm/stream waterfall 监听器（按 purpose 键控改路由）               │
│    ├─ compact 路由  ← purpose: 'compaction'                        │
│    ├─ title 路由    ← purpose: 'session-title'                     │
│    └─ approve 路由  ← 契约标记（无 sessionId、temp 0）              │
│  子代理作用域 ctx 上的 agent/request waterfall（子代理路由）        │
│  工具：inspect_image（视觉）· describe_image（转交）               │
│        generate_image（生图）  + systemPrompt.section(...)          │
│  resolveModelInfo 包装 + 图片→文本引用替换（转交）                  │
│  /dsh-auxiliary/state 端点（审批插件检测）                          │
└────────────────────────────────────────────────────────────────────┘
```

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
- `generate_image`——生图：提示词（+size/n）→ 提供商 images API（凭据层）→ `generated/` 下的 PNG → 路径。

每个工具只在其功能启用且路由完整时注册（reconcile 模式），模型永远看不到用不了的工具。

### 3. 设置集成与模型目录

插件注册自己的设置命名空间（`dsh-auxiliary`，schemastery schema）；设置页通过 `settings.update(...)` 写入，`installSettingsSection` 保持插件解析视图同步。两个细节值得注意：

- **原始与解析视图**：`llm-pi-ai` 命名空间中的模型行由 `z.object` schema 校验，会从*解析后*视图剥离未知键但不会抛错——因此 `imageGeneration` 这类非 schema 字段能存活在**原始 user 段**中。需要看到这类字段的读取走 `namespace.user`（原始）；路由读取用 `settings.get()`（解析后）。
- **DOM 注入**：模型目录页归 harness 客户端所有，插件用 `MutationObserver` 观察 DOM，在每行用户自有模型的展开高级区追加 **允许图片输入** / **允许图片生成** 复选框。复选框从原始 user 段初始化；变更先暂存在浏览器，待该提供方卡片关闭（页面 Apply 后）再写回原始 user 段，避免与页面自身的 revision 校验冲突；生图选择器只列出被标记的模型。

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

### 设置页：辅助模型

![辅助模型设置页](docs/image.png)

插件自带一个 Web 设置分区（**设置 → 辅助模型**）。先在「模型」页配置好提供商与模型，再使用这里的各功能卡片：每张卡片都有自己的启用开关与提供商/模型选择器。选择器把所有当前可用模型集中列出并按提供商分组（生图卡片只列出标记了 **允许图片生成** 的模型）。已保存但暂时不在目录中的路由会保留，不会被自动替换。

### 在模型目录中标记模型

对用户配置的 `llm-pi-ai` 模型，打开 **设置 → 模型 → 提供商 → 自定义设置 → 模型目录 → 模型设置**：

- **允许图片输入**：写入标准 `input` 声明（勾选时 `[text, image]`，取消时 `[text]`）——供 `inspect_image` 与主聊天附件校验读取。仅在上游端点确实接受图片时启用。
- **允许图片生成**：写入 `imageGeneration: true`——这是模型进入 **生图辅助模型** 卡片选择器的标记。仅在上游端点确实支持生图时启用。

复选框注入到每个用户自有的 `llm-pi-ai` 模型行，且**始终可见**——无需展开行的容量区域；自定义提供方创建卡中**正在添加**的模型行同样会获得复选框；刚添加但尚未填写模型 ID 的行会显示禁用的复选框，填入 ID 后立即启用。修改已有模型的 ID 时，已保存的能力标记会随 ID 迁移到新 ID。勾选的标记先在浏览器中记录，待页面保存提供方设置（点 Apply）后写入该模型，因此可以一边修改其它模型字段一边设置图片能力，不会与页面自身的保存产生“设置已被其他地方改动”的 revision 冲突。无法携带标记的行会显示说明而非静默缺失：DeepSeek 官方（或其他非 pi-ai 适配器）行提示标记仅限 `llm-pi-ai`；尚未保存到用户区的 pi-ai 目录行提示先保存模型。

## 说明

- 各路由功能只改路由自己那一类调用（`purpose: 'compaction'` / `purpose: 'session-title'` / 审批审查契约），主会话路由永不被触碰。
- `engine.enabled: true` 会**替换**默认压缩后端；请勿同时加载 `@deepseek-ai/dsh-compaction-basic`。插件检测到冲突会跳过引擎并告警。
- 视觉工具参数：`path`（绝对路径或工作区相对路径）与可选的 `question`。支持格式：PNG、JPEG、WebP、GIF。
- `generate_image` 参数：`prompt`（必填）、可选的 `size` 与 `n`（多数提供商只接受 `n: 1`）。

## 开发

```bash
npm install          # 安装依赖（typescript、@deepseek-ai/* peers）
npm run typecheck    # tsc --noEmit
npm run build        # 产出 lib/
```

## 许可证

[LGPL-3.0](LICENSE)
