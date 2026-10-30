import { officialModelIntegrations } from './compat.js';
import { defineConfig, type ConfigField } from '@dsh-plugin/dsh-loader/config';
import { DEFAULT_COMPRESS_PROMPT, PLUGIN_ID, PLUGIN_NAME, type PluginConfig } from './config.js';

export function createConfigTemplate(base: PluginConfig, dshVersion?: string) {
  const route = (enabled = true): ConfigField[] => [
    ...(enabled ? [{ type: 'boolean' as const, key: 'enabled', label: '启用', default: false }] : []),
    { type: 'text', key: 'provider', label: '提供方 ID', default: '', description: '填写官方模型设置中已有的提供方路由 ID。' },
    { type: 'text', key: 'model', label: '模型 ID', default: '' },
  ];
  const object = (key: string, label: string, fields: ConfigField[]): ConfigField => ({ type: 'object', key, label, fields: fields.map(field => {
    const value = (base as any)[key]?.[field.key!];
    return value === undefined ? field : { ...field, default: value };
  }) });
  return defineConfig({ id: PLUGIN_ID, packageName: PLUGIN_NAME, title: '辅助模型', description: '填写已配置的提供方与模型 ID；保存后应用到后续请求。', fields: [
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
      { type: 'text', key: 'model', label: '官方 API 模型 ID', default: 'deepseek-flash', required: true, description: '仅作用于 DeepSeek Flash · 官方 API 翻译服务；填写该官方提供方模型目录中已有的 ID。保留关闭思考、会话记录及缓存隔离。' },
    ])] : []),
    object('subagent', '子智能体模型', route()), object('title', '标题模型', route()), object('imagegen', '图片生成模型', route()),
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
