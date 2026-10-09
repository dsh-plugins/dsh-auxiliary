/**
 * Browser-half entry for dsh-auxiliary-neo — runs inside the dsh web GUI.
 *
 * Registers the "Auxiliary Models" settings section (`settings.section` slot):
 * a page with independent vision and compaction cards that pick provider/model
 * routes already configured in Models. Reads the live provider topology and
 * persists each feature through the connection's Host API; no custom Host routes.
 *
 * Export discipline (packages/client rule): the /client surface carries what
 * cordis loading needs plus types only — all value exports stay internal.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots';
// Type-only: pulls the `ctx.slots` renderer service merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
// Type-only: pulls the settings.section SlotMap declaration and owner props.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { IApiClient } from './api.js';
import { AuxiliarySection, type AuxiliarySectionProps } from './AuxiliarySection.js';
import { en, zh, type AuxiliaryKey } from './locales.js';
import { startModelCatalogInjection } from './modelCatalogInject.js';

/** Locale namespace this plugin owns. */
const NS = 'dsh-auxiliary-neo';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-auxiliary-neo settings-page copy. */
    'dsh-auxiliary-neo': AuxiliaryKey;
  }
}

/**
 * Required services (fiber inject waiting — the runtime must be up first).
 *
 * `dshLoaderUi` 由 @dsh-plugin/dsh-loader 的浏览器半区 `ctx.provide` 提供。声明它
 * 让 cordis 保证 loader 先激活：`dsh.client.immediately` 只保证工厂已注册，不保证
 * 其 `apply` 已跑完，所以直接读 `window.__dshLoader__.ui` 可能拿到 undefined。
 */
export const inject = ['slots', 'locale', 'connection', 'dshLoaderUi'];

/** Type-only surface (export discipline: no value exports beyond the plugin contract). */
export type { AuxiliarySectionProps } from './AuxiliarySection.js';
export type { AuxiliaryKey } from './locales.js';

/**
 * Register the Auxiliary Models settings section.
 * @param ctx - client root context (slots, locale, connection services).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-auxiliary-neo: dictionaries');

  const connection = ctx.get('connection');
  const t = ctx.locale.bind(NS);

  /**
   * Resolve the legacy `connection.api` proxy lazily.
   *
   * On 0.2.0 the loader bridge attaches `connection.api` from an ordered
   * `ctx.inject([...])` fiber (`@dsh-plugin/dsh-loader`
   * `dist/client-connection-api-compat.js:218-251`) once `ctx.remote` is up, so
   * reading the property at apply time can capture `undefined` and bind it into
   * the settings page forever. Every consumer therefore reads it through this
   * accessor — after `dshLoaderUi` has been provided, which is exactly when the
   * bridge has settled.
   */
  const api = (): IApiClient => {
    const face = (connection as unknown as { api?: IApiClient }).api;
    if (face === undefined) {
      throw new Error('dsh-auxiliary-neo: the client connection API is not available yet');
    }
    return face;
  };

  const injected = (): { api: IApiClient; t: TranslateNS<'dsh-auxiliary-neo'> } => ({
    api: api(),
    t,
  });

  // loader 的 UI 门面（只取本插件需要的一个原语）。
  const loaderUi = (ctx as unknown as {
    dshLoaderUi?: { onDomSettled(listener: () => void): () => void };
  }).dshLoaderUi;

  ctx.effect(
    // 把 loader 的 DOM-settled 原语交给注入器：它据此复用引擎那一个
    // MutationObserver + rAF 合流，不再自建（loader 缺席时自动降级）。
    // `api` 传访问器而非快照：注入器在 sweep/写入时才读取它，避免把
    // apply 时刻的 undefined 固化下来。
    () => startModelCatalogInjection(api, t, loaderUi?.onDomSettled),
    'dsh-auxiliary-neo: model catalog capability injection',
  );

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'auxiliary',
    order: 20,
    label: () => t('nav'),
    inject: injected,
  }, AuxiliarySection));
}
