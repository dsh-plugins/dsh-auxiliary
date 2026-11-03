import * as React from 'react';
import {
  ModelSelect,
  type ConfigDialogProps,
  type ConfigModelList,
  type DshLoaderUi
} from '@dsh-plugin/dsh-loader/client';
import type { ConfigModelValue } from '@dsh-plugin/dsh-loader/config';
import type { IApiClient } from './api.js';

/** 官方翻译服务固定提供商并关闭思考，选择器只提供该服务实际支持的模型。 */
export function registerTranslationModel(ctx: {
  effect(fn: () => (() => void) | void): unknown;
  get(name: 'connection'): { api: IApiClient };
  dshLoaderUi: Pick<DshLoaderUi, 'config'>;
}): void {
  const loadModels = async (signal: AbortSignal): Promise<ConfigModelList> => {
    signal.throwIfAborted();
    const response = await ctx.get('connection').api.llm.models({});
    signal.throwIfAborted();
    if (!response.result.ok) {
      throw new Error(response.result.error.message);
    }
    return {
      groups: response.result.value.groups
        .filter((group) => group.id === 'deepseek-official')
        .map((group) => ({
          ...group,
          models: group.models.map((model) => ({
            id: model.id,
            name: model.name,
            description: model.description
          }))
        })),
      failures: response.result.value.failures.filter(
        (group) => group.id === 'deepseek-official'
      )
    };
  };
  const Editor = ({
    value,
    setValue,
    saving,
    errors
  }: ConfigDialogProps<ConfigModelValue | null>) => (
    <ModelSelect
      value={value}
      onChange={setValue}
      loadModels={loadModels}
      disabled={saving}
      invalid={Boolean(errors['translation.selection'])}
      label="官方 API 翻译模型"
    />
  );
  ctx.dshLoaderUi.config.registerDialog(ctx, {
    id: 'translation-model',
    configId: 'dsh-auxiliary',
    field: ['translation', 'selection'],
    title: '选择官方 API 翻译模型',
    component: Editor
  });
}
