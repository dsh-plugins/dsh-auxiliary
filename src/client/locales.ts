/**
 * Browser-half copy dictionaries for the dsh-auxiliary settings section.
 * zh is the key source, en mirrors every key (bilingual balance enforced at
 * registration). @module dsh-auxiliary/client/locales
 */

export const zh = {
  /** Settings nav label. */
  nav: '辅助模型',
  /** Intro explaining the independent feature cards. */
  intro: '分别配置视觉理解与上下文压缩。两项功能各自有启用开关和模型路由；这里的模型均复用「模型」页中已配置的提供商。',
  /** Loading state. */
  loading: '加载中…',
  /** Load/save failure prefix. */
  error: '失败：',
  /** The plugin namespace cannot be saved through the current settings seam. */
  settingsUnavailable: '当前无法访问此插件的设置，不能保存选择。',
  /** The Host settings provider is read-only. */
  settingsReadOnly: '当前设置为只读，不能保存选择。',
  /** One or more providers failed to return a model catalog. */
  catalogFailure: '以下提供商的模型目录加载失败：',
  /** No active provider group has a catalog model. */
  noProvider: '当前没有可用模型。请先在「模型」页添加并启用提供商，再回到这里选择；已保存但暂不可用的路由不会被自动替换。',
  /** Vision feature card heading. */
  visionTitle: '视觉理解',
  /** Vision feature card explanation. */
  visionDescription: '控制 `inspect_image` 工具及其视觉模型。开启但尚未选择模型仍是合法配置；调用工具时会明确提示缺少视觉路由。',
  /** Vision feature switch label. */
  visionToggle: '启用 inspect_image',
  /** Vision picker label. */
  visionPickerLabel: '视觉模型（需支持图片输入）',
  /** Image handoff switch label. */
  visionHandoff: '主模型不支持图片时，聊天图片以引用形式发送，由 describe_image 转交视觉模型获取内容',
  /** Injected model-catalog checkbox label. */
  imageCapabilityToggle: '允许图片输入',
  /** Injected model-catalog checkbox explanation. */
  imageCapabilityDescription: '仅在上游模型确实支持图片时启用。',
  /** Loading state of an injected model-catalog checkbox. */
  imageCapabilityLoading: '正在读取图片输入声明…',
  /** Shown while a changed model-catalog mark waits for the provider card's Apply. */
  imageCapabilityPending: '保存提供方设置后生效。',
  /** Shown on a newly added model row before a model id has been typed. */
  imageCapabilityNeedsModelId: '填写模型 ID 后可标记图片能力。',
  /** Injected model-catalog checkbox label for image generation. */
  imageGenToggle: '允许图片生成',
  /** Injected model-catalog checkbox explanation for image generation. */
  imageGenDescription: '标记该模型可生成图片，供辅助生图功能选择模型。',
  /** Loading state of an injected image-generation checkbox. */
  imageGenLoading: '正在读取图片生成声明…',
  /** Notice on model rows that can never carry the capability marks (non-pi-ai adapters). */
  imageCapabilityUnsupported: '此适配器不支持图片能力标记，仅用户配置的 llm-pi-ai 模型支持。',
  /** Notice on pi-ai catalog rows that are not yet saved into the user section. */
  imageCapabilitySaveFirst: '保存该模型为自定义模型后即可标记图片输入/生成能力。',
  /** Auxiliary image-generation feature card heading. */
  imagegenTitle: '生图辅助模型',
  /** Auxiliary image-generation feature card explanation. */
  imagegenDescription: '为辅助生图功能选择独立的模型路由，仅显示在模型设置页标记为「允许图片生成」的模型。',
  /** Auxiliary image-generation feature switch label. */
  imagegenToggle: '启用生图辅助模型',
  /** Auxiliary image-generation picker label. */
  imagegenPickerLabel: '生图模型',
  /** Auxiliary image-generation route explanation. */
  imagegenUsage: '开启后，辅助生图功能使用所选模型。选择器只列出在「设置 → 模型 → 提供商 → 自定义设置 → 模型目录」中勾选「允许图片生成」的模型。',
  /** Shown when no model is marked for image generation yet. */
  imagegenNoModels: '尚未标记任何生图模型：请先在「设置 → 模型 → 提供商 → 自定义设置 → 模型目录」中勾选「允许图片生成」。',
  /** Exact distinction between route selection and model capabilities. */
  visionUsage: '此路线供 inspect_image 与 describe_image 使用：前者读取 Host 上的本地图片，后者读取聊天中附加的图片（主模型不支持图片时以 [image: …] 引用呈现，主模型会主动调用 describe_image 获取内容并注入上下文）。图片输入能力请在「设置 → 模型 → 提供商 → 自定义设置 → 模型目录」中按模型声明；主聊天选择同一模型时也会使用该声明。',
  /** Compaction feature card heading. */
  compactTitle: '上下文压缩',
  /** Compaction feature card explanation. */
  compactDescription: '控制 `purpose: compaction` 摘要调用是否改用独立的 compact 模型路由。',
  /** Compaction feature switch label. */
  compactToggle: '启用压缩辅助路由',
  /** Compaction picker label. */
  compactPickerLabel: '压缩模型',
  /** Engine reuse explanation. */
  compactUsage: '开启但没有完整 provider/model route 时保持现有 pass-through 行为。`engine` 没有第三个模型选择器；启用压缩引擎时，它复用这里的 compact 路由。',
  /** Approval feature card heading. */
  approveTitle: '审批模型',
  /** Approval feature card explanation. */
  approveDescription: '联动 @dsh-plugin/dsh-approve-for-me 插件：安装该插件并启用 review 模式后，其审批审查调用改由这里选择的独立模型执行，不再继承会话主模型。',
  /** Approval feature switch label. */
  approveToggle: '启用审批模型路由',
  /** Approval picker label. */
  approvePickerLabel: '审批模型',
  /** Approval route explanation. */
  approveUsage: '开启但没有完整 provider/model route 时保持原行为（审查模型继续继承会话或使用插件自身的 reviewProvider/reviewModel 配置）。建议选择便宜快速的模型；审查裁决只用于审批，不写入会话历史。',
  /** Approval card notice when the approve-for-me plugin is not installed. */
  approveNotInstalled: '未检测到 @dsh-plugin/dsh-approve-for-me 插件：请先安装并启用该插件（review 模式），此设置才会生效；当前保存此配置不会产生任何影响。',
  /** Subagent routing card. */
  subagentTitle: '子代理模型',
  subagentDescription: '为委派出去的子代理设置独立模型路由。',
  subagentToggle: '启用子代理模型',
  subagentPickerLabel: '子代理模型',
  subagentUsage: '开启后，所有委派子代理（spawn/fork 一次性委托与可续接子代理）统一使用所选模型，不再继承父会话；进程内冷恢复的子代理同样生效。远程提供方（ACP）创建的子代理不经过本机代理注册，仍继承父会话。建议选择便宜快速的模型以控制委派成本。',
  /** Session-title routing card. */
  titleTitle: '标题生成模型',
  titleDescription: '为会话标题生成设置独立模型路由。',
  titleToggle: '启用标题生成模型',
  titlePickerLabel: '标题生成模型',
  titleUsage: '开启后，会话标题生成调用（purpose: session-title）统一使用所选模型，不随主会话路由变化。标题由 dsh-session-title-llm 提供方发起，此设置仅覆盖其模型路由，不影响其部署层配置。建议选择便宜快速的模型；标题生成频率较低，成本影响很小。',
  /** Model picker trigger placeholder. */
  pickerPlaceholder: '选择提供商和模型',
  /** Model picker empty state. */
  pickerEmpty: '当前没有可选择的模型。',
  /** Stale saved route notice. */
  pickerUnavailable: '已保存的路由当前不可用',
  /** Model picker accessible list label. */
  pickerListLabel: '按提供商分组的模型列表',
  /** Save button. */
  save: '保存',
  /** In-progress save label. */
  saving: '保存中…',
  /** Saved confirmation. */
  saved: '已保存',
  /** Structured settings conflict message. */
  settingsConflict: '设置已被其他窗口或进程修改。当前草稿已保留，请重新保存以应用它。',
  /** Local half-route validation message. */
  routeIncomplete: '提供商和模型必须同时选择，或同时留空。',
};

/** Keys of the dsh-auxiliary surface copy. */
export type AuxiliaryKey = keyof typeof zh;

export const en: Record<AuxiliaryKey, string> = {
  nav: 'Auxiliary Models',
  intro: 'Configure vision understanding and context compaction independently. Each feature has its own switch and model route, reusing providers configured on the Models page.',
  loading: 'Loading…',
  error: 'Failed:',
  settingsUnavailable: 'This plugin’s settings are unavailable, so the selection cannot be saved.',
  settingsReadOnly: 'Settings are read-only, so the selection cannot be saved.',
  catalogFailure: 'Model catalog lookup failed for:',
  noProvider: 'No models are currently available. Add and enable a provider on the Models page first; a saved route that is temporarily unavailable is never replaced automatically.',
  visionTitle: 'Vision understanding',
  visionDescription: 'Controls the `inspect_image` tool and its vision model. Enabling it without a selected model remains valid; a tool call reports that the vision route is missing.',
  visionToggle: 'Enable inspect_image',
  visionPickerLabel: 'Vision model (must support image input)',
  visionHandoff: 'When the main model is text-only, chat images are sent as references and describe_image hands them to the vision model for their content',
  imageCapabilityToggle: 'Allow image input',
  imageCapabilityDescription: 'Enable only if the upstream model accepts images.',
  imageCapabilityLoading: 'Reading the image-input declaration…',
  imageCapabilityPending: 'Applies after you save the provider settings.',
  imageCapabilityNeedsModelId: 'Enter a model ID to mark image capabilities.',
  imageGenToggle: 'Allow image generation',
  imageGenDescription: 'Marks the model as able to generate images, for auxiliary image-generation features to pick from.',
  imageGenLoading: 'Reading the image-generation declaration…',
  imageCapabilityUnsupported: 'This adapter does not support image capability marks; only user-configured llm-pi-ai models can be marked.',
  imageCapabilitySaveFirst: 'Save this model as a custom model to mark image input/generation capabilities.',
  imagegenTitle: 'Image-generation model',
  imagegenDescription: 'Pick a dedicated model route for auxiliary image generation; only models marked "Allow image generation" on the Models page are offered.',
  imagegenToggle: 'Enable auxiliary image generation',
  imagegenPickerLabel: 'Image-generation model',
  imagegenUsage: 'When enabled, auxiliary image-generation work uses the selected model. The picker only lists models marked "Allow image generation" under Settings → Models → Provider → Customized settings → Models.',
  imagegenNoModels: 'No image-generation model marked yet: check "Allow image generation" under Settings → Models → Provider → Customized settings → Models first.',
  visionUsage: 'This route serves inspect_image and describe_image: the former reads local images on the Host, the latter reads images attached to the chat (when the main model is text-only they appear as [image: …] references, and the main model calls describe_image to fetch their content into the context). Declare image input per model under Settings → Models → Provider → Customized settings → Models; main chat uses the same declaration when that model is selected.',
  compactTitle: 'Context compaction',
  compactDescription: 'Controls whether `purpose: compaction` summaries use the independent compact model route.',
  compactToggle: 'Enable auxiliary compaction route',
  compactPickerLabel: 'Compaction model',
  compactUsage: 'An enabled feature without a complete provider/model route keeps the existing pass-through behavior. `engine` has no third model picker; when enabled, the compression engine reuses this compact route.',
  approveTitle: 'Approval model',
  approveDescription: 'Hookup for the @dsh-plugin/dsh-approve-for-me plugin: once that plugin is installed and review mode is active, its approval reviews run on the dedicated model selected here instead of inheriting the session\'s main model.',
  approveToggle: 'Enable approval-model routing',
  approvePickerLabel: 'Approval model',
  approveUsage: 'An enabled feature without a complete provider/model route keeps the original behavior (the reviewer keeps inheriting the session or the plugin\'s own reviewProvider/reviewModel config). Prefer a cheap, fast model; the review verdict only decides approval and never enters the session history.',
  approveNotInstalled: 'The @dsh-plugin/dsh-approve-for-me plugin was not detected: install and enable it (review mode) first — until then, saving this configuration has no effect.',
  subagentTitle: 'Subagent model',
  subagentDescription: 'Set a dedicated model route for delegated child agents.',
  subagentToggle: 'Enable subagent model',
  subagentPickerLabel: 'Subagent model',
  subagentUsage: 'When enabled, every delegated child (one-shot spawn/fork runs and continuable children) uses the selected model instead of inheriting the parent session; in-process cold-resumed children are covered too. Remote providers (ACP) never register a process-local agent and their children keep inheriting the parent route. Prefer a cheap, fast model to control delegation cost.',
  titleTitle: 'Title model',
  titleDescription: 'Set a dedicated model route for session-title generation.',
  titleToggle: 'Enable title model',
  titlePickerLabel: 'Title model',
  titleUsage: 'When enabled, session-title generation calls (purpose: session-title) use the selected model instead of following the main session route. Titles are issued by the dsh-session-title-llm provider; this setting only overrides its model route and leaves its deployment-level config untouched. Prefer a cheap, fast model; titles are generated infrequently, so the cost impact is minimal.',
  pickerPlaceholder: 'Choose a provider and model',
  pickerEmpty: 'No selectable models are available.',
  pickerUnavailable: 'Saved route is currently unavailable',
  pickerListLabel: 'Models grouped by provider',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  settingsConflict: 'Settings changed in another window or process. Your draft was kept; save again to apply it.',
  routeIncomplete: 'Provider and model must both be selected, or both be left empty.',
};
