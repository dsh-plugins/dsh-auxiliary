/** Model-catalog enhancements only; loader owns the plugin configuration form. */
import type { IApiClient } from './api.js';
import { en, zh, type AuxiliaryKey } from './locales.js';
import { startModelCatalogInjection } from './modelCatalogInject.js';
import { legacyModelEditors } from '../compat.js';
export const inject = ['locale', 'connection', 'dshLoaderUi'];
interface ClientContext {
  effect(fn: () => void | (() => void)): void;
  locale: { register(id: string, dictionaries: unknown): () => void; bind(id: string): (key: AuxiliaryKey) => string };
  get(name: 'connection'): { api: IApiClient };
  dshLoaderUi?: { onDomSettled(listener: () => void): () => void };
}
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dsh-auxiliary', { zh, en }));
  const loader = (window as unknown as { __dshLoader__: { dshVersion: string } }).__dshLoader__;
  const editors = legacyModelEditors(loader?.dshVersion);
  const t = ctx.locale.bind('dsh-auxiliary');
  ctx.effect(() => startModelCatalogInjection(ctx.get('connection').api, t, ctx.dshLoaderUi?.onDomSettled, editors));
}
