/**
 * Browser-half entry for dsh-auxiliary — runs inside the dsh web GUI.
 *
 * Registers the "Auxiliary Models" settings section (`settings.section` slot):
 * a page with independent vision and compaction cards that pick provider/model
 * routes already configured in Models. Reads the live provider topology and
 * persists each feature through the connection's Host API; no custom Host routes.
 *
 * Export discipline (packages/client rule): the /client surface carries what
 * cordis loading needs plus types only — all value exports stay internal.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots';
// Type-only: pulls the settings.section SlotMap declaration and owner props.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import { AuxiliarySection, type AuxiliarySectionProps } from './AuxiliarySection.js';
import { en, zh, type AuxiliaryKey } from './locales.js';
import { startModelCatalogInjection } from './modelCatalogInject.js';

/** Locale namespace this plugin owns. */
const NS = 'dsh-auxiliary';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-auxiliary settings-page copy. */
    'dsh-auxiliary': AuxiliaryKey;
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
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-auxiliary: dictionaries');

  const connection = ctx.get('connection');
  const t = ctx.locale.bind(NS);
  const injected = (): { api: typeof connection.api; t: TranslateNS<'dsh-auxiliary'> } => ({
    api: connection.api,
    t,
  });

  // loader 的 UI 门面（只取本插件需要的一个原语）。
  const loaderUi = (ctx as unknown as {
    dshLoaderUi?: { onDomSettled(listener: () => void): () => void };
  }).dshLoaderUi;

  ctx.effect(
    // 把 loader 的 DOM-settled 原语交给注入器：它据此复用引擎那一个
    // MutationObserver + rAF 合流，不再自建（loader 缺席时自动降级）。
    () => startModelCatalogInjection(connection.api, t, loaderUi?.onDomSettled),
    'dsh-auxiliary: model catalog capability injection',
  );

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'auxiliary',
    order: 20,
    label: () => t('nav'),
    inject: injected,
  }, AuxiliarySection));
}
