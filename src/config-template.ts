import { legacySubagentModels, officialModelIntegrations } from './compat.js';
import { defineConfig, validateValues, type ConfigAPI, type ConfigField, type ConfigModelValue } from '@dsh-plugin/dsh-loader/config';
import { Config, DEFAULT_COMPRESS_PROMPT, PLUGIN_ID, PLUGIN_NAME, type PluginConfig } from './config.js';

const routeKeys = ['vision', 'compact', 'approve', 'subagent', 'title', 'imagegen'] as const;
type RouteKey = typeof routeKeys[number];

/** 配置表单保存完整模型选择，运行时仍使用各功能原有的路由结构。 */
export type FormConfig = Omit<PluginConfig, RouteKey | 'translation'> & {
  [Key in Exclude<RouteKey, 'subagent'>]: Omit<PluginConfig[Key], 'provider' | 'model' | 'reasoningEffort'> & { selection: ConfigModelValue | null };
} & {
  subagent?: Omit<PluginConfig['subagent'], 'provider' | 'model' | 'reasoningEffort'> & { selection: ConfigModelValue | null };
  translation: { enabled: boolean; selection: ConfigModelValue | null };
};

function selectionOf(route: { provider?: string; model?: string; reasoningEffort?: string }): ConfigModelValue | null {
  if (!route.provider && !route.model) { return null; }
  if (!route.provider || !route.model) { throw new Error('辅助模型的提供商与模型必须同时配置'); }
  return { provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) };
}

/** 将表单中的选择转换为功能调用使用的模型路由。 */
export function runtimeConfig(value: FormConfig, dshVersion?: string): PluginConfig {
  const config: any = { ...value };
  for (const key of routeKeys) {
    const route = key === 'subagent' && !legacySubagentModels(dshVersion) ? undefined : value[key];
    const { selection, ...options } = route ?? { enabled: false, selection: null };
    config[key] = { ...options, provider: selection?.provider ?? '', model: selection?.model ?? '',
      ...(selection?.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) };
  }
  const translation = value.translation?.selection;
  if (translation?.reasoningEffort !== undefined) {
    throw new Error('翻译模型的推理设置由翻译调用统一处理');
  }
  config.translation = { enabled: value.translation?.enabled ?? false, provider: translation?.provider ?? 'deepseek-official', model: translation?.model ?? 'deepseek-flash' };
  return Config(config);
}

/** 为辅助功能声明模型选择器及其他配置字段。 */
export function createConfigTemplate(base: PluginConfig, dshVersion?: string) {
  const route = (enabled = true): ConfigField[] => [
    ...(enabled ? [{ type: 'boolean' as const, key: 'enabled', label: '启用', default: false }] : []),
    { type: 'model', key: 'selection', label: '模型', default: null },
  ];
  const object = (key: string, label: string, fields: ConfigField[]): ConfigField => ({ type: 'object', key, label, fields: fields.map(field => {
    const value = field.key === 'selection'
      ? selectionOf((base as any)[key])
      : (base as any)[key]?.[field.key!];
    return value === undefined ? field : { ...field, default: value };
  }) });
  return defineConfig({ id: PLUGIN_ID, packageName: PLUGIN_NAME, title: '辅助模型', description: '选择已配置的提供商、模型与推理等级，保存后应用到后续请求。', fields: [
    object('vision', '视觉模型', [...route(false),
      { type: 'number', key: 'maxTokens', label: '输出上限', default: 4096, min: 1 },
      { type: 'boolean', key: 'handoff', label: '图片转交', default: true },
      { type: 'boolean', key: 'skipWhenMainModelSupportsImage', label: '视觉主模型跳过', default: false },
    ]),
    object('tool', '视觉工具', [
      { type: 'boolean', key: 'enabled', label: '启用', default: true },
      { type: 'number', key: 'maxImageBytes', label: '图片大小上限', default: 10485760, min: 1 },
      { type: 'number', key: 'timeoutMs', label: '超时（毫秒）', default: 120000, min: 1, max: 2147483647 },
    ]),
    object('compact', '压缩模型', route()), object('approve', officialModelIntegrations(dshVersion).autoReview ? '官方自动审查模型' : '审查模型', route()),
    ...(officialModelIntegrations(dshVersion).translation ? [object('translation', '思考过程机器翻译', [
      { type: 'boolean', key: 'enabled', label: '替换翻译模型', default: false },
      { type: 'model', key: 'selection', label: '翻译模型', default: null, dialog: { id: 'translation-model', label: '选择翻译模型' }, description: '从已配置的提供商选择翻译模型，通过翻译菜单中的「DeepSeek Flash · 官方 API」入口使用。第三方模型使用默认推理设置；清除选择时使用官方默认模型。' },
    ])] : []),
    ...(legacySubagentModels(dshVersion) ? [object('subagent', '子智能体模型', route())] : []),
    object('title', '标题模型', route()), object('imagegen', '图片生成模型', route()),
    object('engine', '压缩引擎', [
      { type: 'boolean', key: 'enabled', label: '启用', default: false },
      { type: 'number', key: 'thresholdRatio', label: '触发比例', default: 0.8, min: 0.01, max: 0.99 },
      { type: 'number', key: 'retainRatio', label: '保留比例', default: 0.16, min: 0.01, max: 0.99, description: '必须小于触发比例。' },
      { type: 'number', key: 'maxTokens', label: '输出上限', default: 8192, min: 1 },
      { type: 'number', key: 'compactionRetries', label: '压缩重试', default: 1, min: 0 },
      { type: 'number', key: 'maxOverflowRetries', label: '溢出重试', default: 1, min: 0 },
      { type: 'boolean', key: 'auto', label: '自动压缩', default: true },
      { type: 'textarea', key: 'compressPrompt', label: '压缩指令', default: DEFAULT_COMPRESS_PROMPT },
    ]),
  ] });
}

/** 读取旧的提供商与模型字段，迁移后只保存模型选择器使用的 selection。 */
export async function registerConfig(api: ConfigAPI, owner: { effect(fn: () => (() => void) | void): unknown }, base: PluginConfig, dshVersion?: string) {
  const template = createConfigTemplate(base, dshVersion);
  const legacyFields: ConfigField[] = ['provider', 'model', 'reasoningEffort'].map(key => ({
    type: 'text', key, label: key, default: '', visibleWhen: { path: ['tool', 'enabled'], equals: null },
  }));
  const reader = await api.register<any>(owner, { ...template, fields: template.fields.map(field => {
    if (field.type !== 'object' || !field.fields?.some(child => child.type === 'model')) { return field; }
    return { ...field, fields: [
      ...field.fields.map(child => child.type === 'model' ? { ...child, default: null } : child),
      ...legacyFields,
    ] };
  }) });
  let snapshot;
  try { snapshot = reader.get(); } finally { reader.dispose(); }
  const migrated: Record<string, any> = {};
  for (const key of [...routeKeys, 'translation']) {
    if (key === 'subagent' && !legacySubagentModels(dshVersion)) { continue; }
    const route = snapshot.value[key];
    if (!route?.provider && !route?.model && !route?.reasoningEffort) { continue; }
    const old = key === 'translation' ? { provider: route.provider || 'deepseek-official', model: route.model } : route;
    if (!old.provider || !old.model) { throw new Error('辅助模型的提供商与模型必须同时配置'); }
    route.selection ??= selectionOf(old);
    migrated[key] = route;
  }
  const handle = await api.register<FormConfig>(owner, template);
  if (Object.keys(migrated).length > 0) {
    try {
      const value = validateValues(template.fields, { ...handle.get().value, ...migrated }) as unknown as FormConfig;
      runtimeConfig(value, dshVersion);
      await handle.update(value, snapshot.revision);
    } catch (error) { handle.dispose(); throw error; }
  }
  return handle;
}
