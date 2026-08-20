/**
 * Model-catalog capability injection.
 *
 * The DSH Models settings page (dsh-client-ui-settings-models) does not expose
 * a slot inside its model rows, so this module injects "Allow image input" and
 * "Allow image generation" checkboxes directly into each editable llm-pi-ai
 * model row. It never edits the core package: the page is React-rendered and
 * re-renders freely, so a MutationObserver re-applies the injection whenever
 * the DOM is rebuilt, and every write goes through the same `llm-pi-ai`
 * settings namespace the Models page itself writes.
 *
 * Provider/model identity is read from the settings document (data-driven),
 * not scraped from the DOM. A row's provider card is resolved for attribution
 * only; the checkbox read/write always targets the `llm-pi-ai` namespace.
 *
 * Rows are classified by their saved state:
 * - **saved** (in `namespace.user`) → checkboxes initialized from the saved
 *   document; a change is recorded as a pending mark and written after the
 *   provider card closes, so it cannot advance the namespace revision under
 *   the card's `openedAt` expectation and make the page's own Apply report a
 *   false "settings changed elsewhere" conflict;
 * - **new draft** (typed id, not saved, not a catalog row) → checkboxes that
 *   record a pending mark locally; the mark is written right after the model
 *   is saved by the page's Apply, so the user can set image capabilities
 *   while adding the model, not only after saving it;
 * - **catalog** (inherited from the composition base, not yet saved) → a
 *   notice to save the model first (the page does not persist catalog rows on
 *   Apply);
 * - **non-pi-ai** (e.g. the DeepSeek official adapter) → a notice that the
 *   marks are `llm-pi-ai`-only.
 *
 * Provider/model identity is resolved from the settings document and from the
 * editor card DOM: an existing provider's rows live inside its `li` card, the
 * add-provider flow wraps its editor in an `addCard` with a provider select,
 * and the custom-provider create card exposes the future route id through its
 * "Provider ID" input. All of those are `llm-pi-ai`-editable rows (or are
 * explained when they are not).
 *
 * The injected block is appended to the row itself, not to the page's
 * "capacities" disclosure, so the checkboxes are visible whether or not the
 * row is expanded.
 *
 * @module dsh-auxiliary/client/modelCatalogInject
 */
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import {
  loadModelGenerationCapability,
  loadModelImageCapability,
  saveModelGenerationCapability,
  saveModelImageCapability,
} from './api.js';

/** Marker attribute on an injected capability block (one per model row). */
const MARK_BLOCK = 'data-dsh-aux-capabilities';
/** Marker attribute on an injected "cannot be marked" notice. */
const MARK_NOTICE = 'data-dsh-aux-notice';
/** Marker attribute on an injected image-input checkbox. */
const MARK_IMAGE_INPUT = 'data-dsh-aux-image-input';
/** Marker attribute on an injected image-generation checkbox. */
const MARK_IMAGE_GEN = 'data-dsh-aux-image-gen';
/** Marker attribute marking a block built for a not-yet-saved draft row. */
const MARK_DRAFT = 'data-dsh-aux-draft';
/** aria-label prefixes of the model-id text input on both shipped languages. */
const MODEL_ID_LABELS = ['模型 ID ', 'Model ID '];
/** aria-label of the custom-provider create card's future route input. */
const PROVIDER_ROUTE_LABELS = ['Provider ID'];
/** aria-label of the add-provider flow's route select on both shipped languages. */
const PROVIDER_SELECT_LABELS = ['提供方', 'Provider'];

/** Copy keys one injected capability checkbox renders. */
type CapabilityCopyKey =
  | 'imageCapabilityToggle' | 'imageCapabilityDescription' | 'imageCapabilityLoading'
  | 'imageGenToggle' | 'imageGenDescription' | 'imageGenLoading';

/** One injected capability checkbox: marker, copy, and the row read pair. */
interface CapabilitySpec {
  mark: 'data-dsh-aux-image-input' | 'data-dsh-aux-image-gen';
  copy: {
    toggle: CapabilityCopyKey;
    description: CapabilityCopyKey;
    loading: CapabilityCopyKey;
  };
  load: (api: IApiClient, provider: string, model: string) => Promise<{ supported: boolean; writable: boolean }>;
}

/** The two injected capabilities, in display order. */
const CAPABILITIES: readonly CapabilitySpec[] = [
  {
    mark: MARK_IMAGE_INPUT,
    copy: {
      toggle: 'imageCapabilityToggle',
      description: 'imageCapabilityDescription',
      loading: 'imageCapabilityLoading',
    },
    load: loadModelImageCapability,
  },
  {
    mark: MARK_IMAGE_GEN,
    copy: {
      toggle: 'imageGenToggle',
      description: 'imageGenDescription',
      loading: 'imageGenLoading',
    },
    load: loadModelGenerationCapability,
  },
];

/** Capability state rendered by one injected checkbox. */
interface CheckboxState {
  provider: string;
  model: string;
  supported: boolean;
  writable: boolean;
  busy: boolean;
}

/** Pending (not-yet-saved) marks of one new model row, keyed by capability mark. */
type PendingFlags = Partial<Record<'data-dsh-aux-image-input' | 'data-dsh-aux-image-gen', boolean>>;

/** Pending marks for every draft row, keyed by `provider\0model`. */
type PendingMap = Map<string, PendingFlags>;

/** Provider-directory attribution of one model row. */
interface ProviderInfo {
  /** Provider route key (`anvilcraft-ai`, `deepseek-official`, …). */
  provider: string;
  /** Settings namespace of that route (`llm-pi-ai`, `llm-deepseek`, …). */
  settingsNs: string;
}

/** Provider lookup maps keyed by display name and by route id. */
interface ProviderDirectory {
  byDisplay: Map<string, ProviderInfo>;
  byRoute: Map<string, ProviderInfo>;
}

/** Match a model-row input's aria-label prefix. */
function isModelIdInput(element: Element): boolean {
  const label = element.getAttribute('aria-label');
  return label !== null && MODEL_ID_LABELS.some((prefix) => label.startsWith(prefix));
}

/** Key of one model row inside the pending map. */
function rowKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

/**
 * Build one injected control. Every change records a pending mark; the mark is
 * applied once the provider card is gone from the DOM (after the page's Apply
 * or after the card is closed). Writing immediately would advance the
 * `llm-pi-ai` namespace revision while the page's own card still holds its
 * opening revision, so the page's Apply would then fail with a settings
 * conflict that the user did not cause. Saved rows still load their current
 * declaration to initialize the checkbox; draft rows start from the pending
 * map.
 */
function buildCheckbox(
  api: IApiClient,
  t: TranslateNS<'dsh-auxiliary'>,
  provider: string,
  model: string,
  spec: CapabilitySpec,
  draft: boolean,
  pending: PendingMap,
): HTMLElement {
  const key = rowKey(provider, model);
  const state: CheckboxState = { provider, model, supported: false, writable: true, busy: true };

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = false;
  input.disabled = true;
  input.style.height = '16px';
  input.style.margin = '0';
  input.style.width = '16px';

  const label = document.createElement('span');
  label.textContent = t(spec.copy.toggle);

  const row = document.createElement('label');
  row.style.alignItems = 'center';
  row.style.display = 'flex';
  row.style.gap = '8px';
  row.style.minHeight = '36px';
  row.append(input, label);

  const hint = document.createElement('span');
  hint.style.color = 'var(--dsw-alias-label-tertiary)';
  hint.style.fontSize = '12px';
  hint.style.lineHeight = '18px';
  hint.textContent = t(spec.copy.description);

  const box = document.createElement('div');
  box.setAttribute(spec.mark, `${provider}\u0000${model}`);
  box.style.display = 'flex';
  box.style.flexDirection = 'column';
  box.style.gap = '4px';
  box.append(row, hint);

  const pendingValue = (): boolean | undefined => pending.get(key)?.[spec.mark];
  const render = (): void => {
    input.checked = state.supported;
    input.disabled = state.busy || !state.writable;
    const marked = pendingValue();
    hint.textContent = state.busy
      ? t(spec.copy.loading)
      : marked !== undefined
        ? t('imageCapabilityPending')
        : t(spec.copy.description);
  };

  if (pendingValue() !== undefined) {
    state.supported = pendingValue() === true;
    state.writable = true;
    state.busy = false;
    render();
  } else if (draft) {
    // New draft row: no saved declaration yet, only the pending mark.
    state.supported = false;
    state.writable = true;
    state.busy = false;
    render();
  } else {
    void spec.load(api, provider, model).then((capability) => {
      const marked = pendingValue();
      state.supported = marked === undefined ? capability.supported : marked;
      state.writable = capability.writable;
      state.busy = false;
      render();
    }).catch(() => {
      state.writable = false;
      state.busy = false;
      render();
    });
  }

  input.addEventListener('change', () => {
    if (state.busy || !state.writable) return;
    state.supported = input.checked;
    pending.set(key, { ...pending.get(key), [spec.mark]: state.supported });
    render();
  });

  return box;
}

/** Build the always-visible capability block for one model row. */
function buildCapabilityBlock(
  api: IApiClient,
  t: TranslateNS<'dsh-auxiliary'>,
  provider: string,
  model: string,
  draft: boolean,
  pending: PendingMap,
): HTMLElement {
  const block = document.createElement('div');
  block.setAttribute(MARK_BLOCK, `${provider}\u0000${model}`);
  if (draft) block.setAttribute(MARK_DRAFT, '');
  block.style.borderTop = '1px solid var(--dsw-alias-border-l2)';
  block.style.display = 'flex';
  block.style.flexDirection = 'column';
  block.style.gap = '4px';
  block.style.marginTop = '8px';
  block.style.padding = '8px 4px 2px';
  for (const spec of CAPABILITIES) block.append(buildCheckbox(api, t, provider, model, spec, draft, pending));
  return block;
}

/** Build the plain-text notice shown on rows that cannot carry the marks yet. */
function buildNotice(t: TranslateNS<'dsh-auxiliary'>, key: 'imageCapabilityUnsupported' | 'imageCapabilitySaveFirst'): HTMLElement {
  const notice = document.createElement('div');
  notice.setAttribute(MARK_NOTICE, '');
  notice.style.color = 'var(--dsw-alias-label-tertiary)';
  notice.style.fontSize = '12px';
  notice.style.lineHeight = '18px';
  notice.style.padding = '8px 4px 2px';
  notice.textContent = t(key);
  return notice;
}

/** The model row wrapper (one `modelEntry`), or null when the DOM moved. */
function entryOf(input: Element): HTMLElement | null {
  const entry = input.parentElement?.parentElement;
  return entry instanceof HTMLElement ? entry : null;
}

/** Move pending marks from an old row key to the row's current key. */
function migratePending(pending: PendingMap, from: string, to: string): void {
  const flags = pending.get(from);
  if (flags === undefined) return;
  pending.set(to, { ...pending.get(to), ...flags });
  pending.delete(from);
}

/**
 * Inject checkboxes into one model row. A stale block (different model id or a
 * draft block that has since been saved) is rebuilt; a fresh one is kept.
 */
function injectRow(
  api: IApiClient,
  t: TranslateNS<'dsh-auxiliary'>,
  input: Element,
  provider: string,
  model: string,
  draft: boolean,
  pending: PendingMap,
): void {
  const entry = entryOf(input);
  if (entry === null) return;
  const key = rowKey(provider, model);
  const existing = entry.querySelector(`[${MARK_BLOCK}]`);
  if (existing !== null) {
    const existingKey = existing.getAttribute(MARK_BLOCK);
    const fresh = existingKey === key
      && (existing.hasAttribute(MARK_DRAFT) === draft);
    if (fresh) return;
    // The row's model id changed while a mark was pending: carry the flags to
    // the current id so the page's Apply does not strand them.
    if (existingKey !== null && existingKey !== key && existingKey.slice(0, existingKey.indexOf('\u0000')) === provider) {
      migratePending(pending, existingKey, key);
    }
    existing.remove();
  }
  entry.querySelector(`[${MARK_NOTICE}]`)?.remove();
  entry.append(buildCapabilityBlock(api, t, provider, model, draft, pending));
}

/** Inject the "cannot be marked yet" notice into one row, replacing any stale block. */
function injectNotice(
  input: Element,
  t: TranslateNS<'dsh-auxiliary'>,
  key: 'imageCapabilityUnsupported' | 'imageCapabilitySaveFirst',
): void {
  const entry = entryOf(input);
  if (entry === null) return;
  entry.querySelector(`[${MARK_BLOCK}]`)?.remove();
  if (entry.querySelector(`[${MARK_NOTICE}]`) !== null) return;
  entry.append(buildNotice(t, key));
}

/**
 * Resolve the provider card a model row belongs to.
 *
 * Existing providers render their editor inside an `li` row card, whose head
 * carries the display name and route; the add-provider flow wraps the editor
 * in a card with a provider select; the custom-provider create card is a bare
 * editor with a "Provider ID" input that names the route before it exists.
 * Identity is resolved semantically from aria-labels, so it does not depend on
 * the page's hashed CSS class names.
 *
 * @returns the provider route and its settings namespace, or undefined.
 */
function providerInfoOf(input: Element, directory: ProviderDirectory): ProviderInfo | undefined {
  // Walk ancestors so the create/add flows can be attributed: the
  // custom-provider create card contains the future route input, and the
  // add-provider flow contains a provider select.
  let node: Element | null = input.parentElement;
  while (node !== null && node !== document.body) {
    for (const candidate of node.querySelectorAll<HTMLInputElement>('input[aria-label]')) {
      const label = candidate.getAttribute('aria-label');
      if (label !== null && PROVIDER_ROUTE_LABELS.includes(label)) {
        const route = candidate.value.trim();
        if (route.length > 0) return { provider: route, settingsNs: 'llm-pi-ai' };
      }
    }
    for (const candidate of node.querySelectorAll<HTMLSelectElement>('select[aria-label]')) {
      const label = candidate.getAttribute('aria-label');
      if (label !== null && PROVIDER_SELECT_LABELS.includes(label)) {
        const route = candidate.value.trim();
        const info = route.length > 0 ? directory.byRoute.get(route) : undefined;
        if (info !== undefined) return info;
      }
    }
    node = node.parentElement;
  }

  // Existing provider editors render inside an `li` row card whose head
  // carries the display name and route.
  const card = input.closest('li');
  if (card === null) return undefined;
  for (const span of card.querySelectorAll('span')) {
    const text = span.textContent?.trim() ?? '';
    if (text.length === 0) continue;
    const info = directory.byDisplay.get(text) ?? directory.byRoute.get(text);
    if (info !== undefined) return info;
  }
  return undefined;
}

/**
 * Whether an injected capability block for a row key is still in the DOM.
 * Attribute values carry the provider/model separator as a NUL byte, which
 * cannot be addressed safely with CSS attribute selectors (CSS.escape turns it
 * into U+FFFD), so compare the attribute value directly instead.
 */
function rowBlockPresent(key: string): boolean {
  return [...document.querySelectorAll<HTMLElement>(`[${MARK_BLOCK}]`)].some((block) => block.getAttribute(MARK_BLOCK) === key);
}

/**
 * Write pending marks for rows that have since been saved by the page's Apply.
 * A pending mark is only applied once its model exists in the user section and
 * its injected block is gone from the DOM; the latter means the provider card
 * has closed, so the write no longer races the card's own `expectedRevision`.
 * @returns whether any pending mark was applied (callers may resweep).
 */
async function applyPendingMarks(
  api: IApiClient,
  entries: ReadonlyArray<{ provider: string; model: string }>,
  pending: PendingMap,
): Promise<boolean> {
  let applied = false;
  for (const [key, flags] of pending) {
    const sep = key.indexOf('\u0000');
    const provider = key.slice(0, sep);
    const model = key.slice(sep + 1);
    if (!entries.some((entry) => entry.provider === provider && entry.model === model)) continue;
    // The card is still open (or the row is still rendered): leave the mark
    // pending until the page's Apply replaces/removes the editor DOM.
    if (rowBlockPresent(key)) continue;
    try {
      if (flags['data-dsh-aux-image-input'] !== undefined) {
        await saveModelImageCapability(api, provider, model, flags['data-dsh-aux-image-input']);
      }
      if (flags['data-dsh-aux-image-gen'] !== undefined) {
        await saveModelGenerationCapability(api, provider, model, flags['data-dsh-aux-image-gen']);
      }
    } catch {
      continue; // keep the pending mark; a later sweep retries.
    }
    pending.delete(key);
    applied = true;
  }
  return applied;
}

/** One sweep over the page: mark every pi-ai row, explain every other row. */
function sweep(
  api: IApiClient,
  t: TranslateNS<'dsh-auxiliary'>,
  entries: ReadonlyArray<{ provider: string; model: string }>,
  catalogKeys: ReadonlySet<string>,
  directory: ProviderDirectory,
  pending: PendingMap,
): void {
  const inputs = document.querySelectorAll('input[aria-label]');
  for (const input of inputs) {
    if (!isModelIdInput(input)) continue;
    const value = (input as HTMLInputElement).value.trim();
    // Empty rows are edits in progress; leave them alone until an id exists.
    if (value.length === 0) continue;
    const info = providerInfoOf(input, directory);
    if (info === undefined) continue;
    const saved = entries.some((entry) => entry.provider === info.provider && entry.model === value);
    if (saved || info.settingsNs === 'llm-pi-ai') {
      // Saved row → checkboxes initialized from the document, with changes
      // applied after the provider card closes. New draft row under a pi-ai
      // provider → draft checkboxes (marks land after Apply). A catalog row
      // that is not saved yet cannot be persisted by the page, so it keeps a
      // notice.
      const draft = !saved && info.settingsNs === 'llm-pi-ai' && !catalogKeys.has(rowKey(info.provider, value));
      if (saved || draft) {
        injectRow(api, t, input, info.provider, value, draft, pending);
        continue;
      }
    }
    // Not a user-owned pi-ai model: explain instead of staying silent.
    injectNotice(input, t, info.settingsNs === 'llm-pi-ai' ? 'imageCapabilitySaveFirst' : 'imageCapabilityUnsupported');
  }
}

/** Read the user-owned rows and the composition-base catalog of llm-pi-ai. */
async function piAiModelState(api: IApiClient): Promise<{
  entries: Array<{ provider: string; model: string }>;
  catalogKeys: Set<string>;
}> {
  const response = await api.settings.describe({});
  if (!response.result.ok) return { entries: [], catalogKeys: new Set() };
  const namespace = response.result.value.namespaces.find((entry) => entry.ns === 'llm-pi-ai');
  if (namespace === undefined) return { entries: [], catalogKeys: new Set() };
  const user = namespace.user as { providers?: Record<string, { models?: Array<{ id?: unknown }> }> } | undefined;
  const base = namespace.base as { providers?: Record<string, { models?: Array<{ id?: unknown }> }> } | undefined;
  const rows: Array<{ provider: string; model: string }> = [];
  const catalogKeys = new Set<string>();
  for (const [provider, profile] of Object.entries(user?.providers ?? {})) {
    for (const model of profile?.models ?? []) {
      if (typeof model?.id === 'string' && model.id.length > 0) rows.push({ provider, model: model.id });
    }
  }
  for (const [provider, profile] of Object.entries(base?.providers ?? {})) {
    for (const model of profile?.models ?? []) {
      if (typeof model?.id === 'string' && model.id.length > 0) catalogKeys.add(rowKey(provider, model.id));
    }
  }
  return { entries: rows, catalogKeys };
}

/** Map every provider display name and route id to its settings namespace. */
async function providerDirectory(api: IApiClient): Promise<ProviderDirectory> {
  const response = await api.llm.providers({});
  if (!response.result.ok) return { byDisplay: new Map(), byRoute: new Map() };
  const byDisplay = new Map<string, ProviderInfo>();
  const byRoute = new Map<string, ProviderInfo>();
  for (const provider of response.result.value.providers) {
    const info: ProviderInfo = { provider: provider.provider, settingsNs: provider.settingsNs };
    byRoute.set(provider.provider, info);
    if (typeof provider.displayName === 'string' && provider.displayName.length > 0) {
      byDisplay.set(provider.displayName, info);
    }
  }
  return { byDisplay, byRoute };
}

/**
 * Start watching the settings page and keeping the injected checkboxes fresh.
 * Returns a disposer that stops the observer and removes nothing else.
 */
export function startModelCatalogInjection(
  api: IApiClient,
  t: TranslateNS<'dsh-auxiliary'>,
): () => void {
  let entries: Array<{ provider: string; model: string }> = [];
  let catalogKeys: Set<string> = new Set();
  let directory: ProviderDirectory = { byDisplay: new Map(), byRoute: new Map() };
  const pending: PendingMap = new Map();
  let scheduled = false;
  let refreshTimer: number | undefined;
  let disposed = false;

  const run = async (): Promise<void> => {
    if (disposed) return;
    // Rows saved since the last sweep get their pending marks written first.
    const applied = await applyPendingMarks(api, entries, pending).catch(() => false);
    if (disposed) return;
    sweep(api, t, entries, catalogKeys, directory, pending);
    // The writes may have changed the document; let the debounced re-read
    // refresh entries so the next sweep rebuilds those rows as saved.
    if (applied) schedule();
  };

  const schedule = (): void => {
    if (disposed) return;
    // Sweep immediately with the current rows (cheap DOM pass)…
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (disposed) return;
        void run();
      });
    }
    // …and re-read the settings document after the DOM settles so rows saved
    // while the page stayed open (newly added models) get injected too. The
    // settings API has no change subscription, so a debounced re-read is the
    // cheapest reliable trigger.
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined;
      if (disposed) return;
      void Promise.all([piAiModelState(api), providerDirectory(api)]).then(([state, providers]) => {
        if (disposed) return;
        const directoryChanged = state.entries.length !== entries.length
          || state.catalogKeys.size !== catalogKeys.size
          || providers.byDisplay.size !== directory.byDisplay.size
          || providers.byRoute.size !== directory.byRoute.size
          || state.entries.some((entry, index) => {
            const current = entries[index];
            return current === undefined || current.provider !== entry.provider || current.model !== entry.model;
          })
          || [...state.catalogKeys].some((key) => !catalogKeys.has(key))
          || [...providers.byDisplay.entries()].some(([display, info]) => {
            const current = directory.byDisplay.get(display);
            return current === undefined || current.provider !== info.provider || current.settingsNs !== info.settingsNs;
          })
          || [...providers.byRoute.entries()].some(([route, info]) => {
            const current = directory.byRoute.get(route);
            return current === undefined || current.provider !== info.provider || current.settingsNs !== info.settingsNs;
          });
        if (directoryChanged) {
          entries = state.entries;
          catalogKeys = state.catalogKeys;
          directory = providers;
          run();
        }
      }).catch(() => { /* keep the last known rows */ });
    }, 150);
  };

  const refreshEntries = (): void => {
    void Promise.all([piAiModelState(api), providerDirectory(api)]).then(([state, providers]) => {
      if (disposed) return;
      entries = state.entries;
      catalogKeys = state.catalogKeys;
      directory = providers;
      schedule();
    }).catch(() => { /* keep the last known rows */ });
  };

  refreshEntries();
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  // The custom-provider create card keeps its route in a controlled input;
  // typing there does not change child nodes, so listen for the identity
  // fields explicitly and let the debounced refresh catch up.
  const onIdentityInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const label = target.getAttribute('aria-label');
    if (label !== null && (
      PROVIDER_ROUTE_LABELS.includes(label)
      || PROVIDER_SELECT_LABELS.includes(label)
      || isModelIdInput(target)
    )) schedule();
  };
  document.addEventListener('input', onIdentityInput, true);
  schedule();

  return () => {
    disposed = true;
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    observer.disconnect();
    document.removeEventListener('input', onIdentityInput, true);
  };
}
