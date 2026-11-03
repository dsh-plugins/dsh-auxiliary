/** Model-catalog enhancements only; loader owns the plugin configuration form. */
import type { DshLoaderUi } from '@dsh-plugin/dsh-loader/client';
import { registerTranslationModel } from './translation-model.js';
import type { IApiClient } from './api.js';
import { en, zh, type AuxiliaryKey } from './locales.js';
import { startModelCatalogInjection } from './modelCatalogInject.js';
import { legacyModelEditors, officialModelIntegrations } from '../compat.js';
export const inject = ['locale', 'connection', 'dshLoaderUi'];
interface ClientContext {
  effect(fn: () => void | (() => void)): void;
  locale: { register(id: string, dictionaries: unknown): () => void; bind(id: string): (key: AuxiliaryKey) => string };
  get(name: 'connection'): { api: IApiClient };
  dshLoaderUi: Pick<DshLoaderUi, 'config' | 'onDomSettled'>;
}
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dsh-auxiliary', { zh, en }));
  const loader = (window as unknown as { __dshLoader__: { dshVersion: string } }).__dshLoader__;
  const editors = legacyModelEditors(loader?.dshVersion);
  if (officialModelIntegrations(loader?.dshVersion).translation) { registerTranslationModel(ctx); }
  const t = ctx.locale.bind('dsh-auxiliary');
  ctx.effect(() => startModelCatalogInjection(ctx.get('connection').api, t, ctx.dshLoaderUi?.onDomSettled, editors));
}
