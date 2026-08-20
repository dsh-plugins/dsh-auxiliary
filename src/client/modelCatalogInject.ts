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
  IconEditOutline16,
  IconPlusOutline16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { ThinkingLevelSelect } from './ThinkingLevelSelect.js';
import {
  loadModelGenerationCapability,
  loadModelImageCapability,
  saveModelGenerationCapability,
  saveModelImageCapability,
  saveModelThinkingConfig,
} from './api.js';

/** Marker attribute on an injected capability block (one per model row). */
const MARK_BLOCK = 'data-dsh-aux-capabilities';
/** Marker attribute on an injected "cannot be marked" notice. */
const MARK_NOTICE = 'data-dsh-aux-notice';
/** Marker attribute on an injected image-input checkbox. */
const MARK_IMAGE_INPUT = 'data-dsh-aux-image-input';
/** Marker attribute on an injected image-generation checkbox. */
const MARK_IMAGE_GEN = 'data-dsh-aux-image-gen';
/** Marker attribute on the injected thinking-levels section. */
const MARK_THINKING_LEVELS = 'data-dsh-aux-thinking-levels';
/** Marker attribute on the injected default-thinking-level field. */
const MARK_DEFAULT_THINKING = 'data-dsh-aux-default-thinking';
/** Marker attribute marking a block built for a not-yet-saved draft row. */
const MARK_DRAFT = 'data-dsh-aux-draft';
/** Every thinking level a pi-ai profile may declare, in escalation order. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** aria-label prefixes of the model-id text input on both shipped languages. */
const MODEL_ID_LABELS = ['模型 ID ', 'Model ID '];
/** aria-label prefixes of the row capacity panel ("context window / max tokens"). */
const CAPACITY_LABEL_PREFIXES = ['上下文窗口 ', 'Context window ', '最大输出 token ', 'Max output tokens '];
/** aria-label of the custom-provider create card's future route input. */
const PROVIDER_ROUTE_LABELS = ['Provider ID'];
/** aria-label of the add-provider flow's route select on both shipped languages. */
const PROVIDER_SELECT_LABELS = ['提供方', 'Provider'];

/**
 * Last non-empty model id seen per model-id input. The capacity disclosure
 * removes the injected block while collapsed, so this survives id edits made
 * with the panel closed and lets the capability marks follow a renamed model.
 */
const lastRowKeyByInput = new WeakMap<Element, string>();

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
interface PendingFlags {
  'data-dsh-aux-image-input'?: boolean;
  'data-dsh-aux-image-gen'?: boolean;
  'data-dsh-aux-thinking-levels'?: readonly string[];
  'data-dsh-aux-default-thinking'?: string | null;
}

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

/** One saved llm-pi-ai model row plus its persisted capability marks. */
interface PiAiModelRow {
  provider: string;
  model: string;
  /** Effective image-input declaration (`input` array or provider default). */
  imageInput?: boolean;
  /** Persisted image-generation flag on the raw user row. */
  imageGen?: boolean;
  /** Persisted plugin-owned thinking-level list on the raw user row. */
  thinkingLevels?: readonly string[];
  /** Persisted plugin-owned default thinking level on the raw user row. */
  defaultThinkingLevel?: string | null;
}

/** Narrow an unknown settings value to a plain record. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Read a modality declaration without admitting arbitrary wire values. */
function modalityList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

/** Whether a model row's effective `input` declaration includes image input. */
function declaresImageInput(model: Record<string, unknown> | undefined, providerDefault: readonly string[] | undefined): boolean {
  const modelInput = modalityList(model?.input);
  const effective = modelInput !== undefined && modelInput.length > 0 ? modelInput : providerDefault;
  return effective?.includes('image') ?? false;
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
  const empty = model.length === 0;
  const state: CheckboxState = { provider, model, supported: false, writable: !empty, busy: !empty };

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
    hint.textContent = empty
      ? t('imageCapabilityNeedsModelId')
      : state.busy
        ? t(spec.copy.loading)
        : marked !== undefined
          ? t('imageCapabilityPending')
          : t(spec.copy.description);
  };

  if (empty) {
    // Row created without a model id yet: show the checkboxes disabled so the
    // user sees they exist, and enable them as soon as an id is typed.
    state.supported = false;
    state.busy = false;
    render();
  } else if (pendingValue() !== undefined) {
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
    if (empty || state.busy || !state.writable) return;
    state.supported = input.checked;
    pending.set(key, { ...pending.get(key), [spec.mark]: state.supported });
    render();
  });

  return box;
}

/** Whether one value is a pi-ai thinking level. */
function isThinkingLevel(value: string): boolean {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Deduplicate and validate thinking levels, preserving declaration order. */
function uniqueThinkingLevels(levels: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const level of levels) {
    if (isThinkingLevel(level) && !seen.has(level)) {
      seen.add(level);
      result.push(level);
    }
  }
  return result;
}

/**
 * Parse the bulk editor's free text. Accepts `[low, high, max]`, JSON string
 * arrays, and comma/space separated lists; returns undefined when any entry is
 * not a valid thinking level or the list is empty.
 */
function parseThinkingLevelsText(raw: string): readonly string[] | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  let items: unknown;
  try {
    items = JSON.parse(trimmed);
  } catch {
    items = trimmed
      .replace(/^\[|\]$/g, '')
      .split(/[\s,，、;；]+/)
      .map((part) => part.trim().replace(/^["']|["']$/g, ''))
      .filter((part) => part.length > 0);
  }
  if (!Array.isArray(items) || !items.every((item) => typeof item === 'string')) return undefined;
  const strings = items as readonly string[];
  if (strings.some((item) => !isThinkingLevel(item))) return undefined;
  const levels = uniqueThinkingLevels(strings);
  return levels.length > 0 ? levels : undefined;
}

/** Mount a primitives icon into a native button host. */
function mountIcon(host: HTMLElement, node: React.ReactNode): void {
  createRoot(host).render(node);
}

/** A small inline-flex host that keeps icons visually centered. */
function createIconHost(): HTMLSpanElement {
  const host = document.createElement('span');
  host.style.alignItems = 'center';
  host.style.display = 'inline-flex';
  return host;
}

/** Default thinking-level dropdown mounted through the platform Menu primitive. */
function buildThinkingDropdown(
  t: TranslateNS<'dsh-auxiliary'>,
  disabled: boolean,
  onChange: (value: string | null) => void,
): { element: HTMLElement; update: (levels: readonly string[], value: string | null) => void } {
  const host = document.createElement('div');
  host.style.flex = '1';
  host.style.maxWidth = '240px';
  host.style.minWidth = '150px';
  const root = createRoot(host);
  let levels: readonly string[] = [];
  let value: string | null = null;
  const render = (): void => {
    root.render(React.createElement(ThinkingLevelSelect, {
      disabled,
      emptyLabel: t('thinkingLevelsEmpty'),
      label: t('thinkingLevelsDefault'),
      levels,
      onChange,
      value,
    }));
  };
  render();
  return {
    element: host,
    update: (nextLevels, nextValue) => {
      levels = nextLevels;
      value = nextValue;
      render();
    },
  };
}

/** Shared thinking-editor state of one injected block. */
interface ThinkingEditorState {
  levels: string[];
  defaultLevel: string | null;
  writable: boolean;
  busy: boolean;
  error: string | null;
}

/** Build the thinking-level editor appended to the model-row capability block. */
function buildThinkingSection(
  t: TranslateNS<'dsh-auxiliary'>,
  provider: string,
  model: string,
  pending: PendingMap,
  savedRow?: PiAiModelRow,
): HTMLElement {
  const key = rowKey(provider, model);
  const empty = model.length === 0;
  const pendingFlags = pending.get(key);
  const state: ThinkingEditorState = {
    levels: [...(pendingFlags?.[MARK_THINKING_LEVELS] ?? savedRow?.thinkingLevels ?? [])],
    defaultLevel: pendingFlags && MARK_DEFAULT_THINKING in pendingFlags
      ? pendingFlags[MARK_DEFAULT_THINKING] ?? null
      : savedRow?.defaultThinkingLevel ?? null,
    writable: !empty,
    busy: false,
    error: null,
  };

  const section = document.createElement('div');
  section.setAttribute(MARK_THINKING_LEVELS, '');
  section.style.display = 'flex';
  section.style.flexDirection = 'column';
  section.style.gap = '8px';
  section.style.marginTop = '4px';
  section.style.paddingTop = '4px';

  const divider = document.createElement('div');
  divider.style.borderTop = '1px solid var(--dsw-alias-border-l2)';
  section.append(divider);

  const titleRow = document.createElement('div');
  titleRow.style.alignItems = 'baseline';
  titleRow.style.display = 'flex';
  titleRow.style.gap = '8px';
  titleRow.style.justifyContent = 'space-between';

  const title = document.createElement('span');
  title.textContent = t('thinkingLevelsTitle');
  title.style.color = 'var(--dsw-alias-label-secondary)';
  title.style.fontSize = '12px';
  title.style.fontWeight = '500';
  title.style.lineHeight = '18px';
  titleRow.append(title);

  const hint = document.createElement('span');
  hint.textContent = t('thinkingLevelsHint');
  hint.style.color = 'var(--dsw-alias-label-tertiary)';
  hint.style.fontSize = '12px';
  hint.style.lineHeight = '18px';
  titleRow.append(hint);
  section.append(titleRow);

  const list = document.createElement('div');
  list.style.display = 'flex';
  list.style.flexDirection = 'column';
  list.style.gap = '6px';
  section.append(list);

  const styleInput = (input: HTMLInputElement): void => {
    input.style.background = 'var(--dsw-alias-bg-layer-1)';
    input.style.border = '1px solid var(--dsw-alias-border-l2)';
    input.style.borderRadius = '8px';
    input.style.boxSizing = 'border-box';
    input.style.color = 'var(--dsw-alias-label-primary)';
    input.style.font = 'inherit';
    input.style.fontSize = '14px';
    input.style.height = '32px';
    input.style.lineHeight = '22px';
    input.style.padding = '0 10px';
  };
  const styleButton = (button: HTMLButtonElement): void => {
    button.style.background = 'transparent';
    button.style.border = '1px solid var(--dsw-alias-border-l2)';
    button.style.borderRadius = '14px';
    button.style.boxSizing = 'border-box';
    button.style.color = 'var(--dsw-alias-label-primary)';
    button.style.cursor = 'pointer';
    button.style.font = 'inherit';
    button.style.fontSize = '12px';
    button.style.height = '28px';
    button.style.lineHeight = '18px';
    button.style.padding = '0 10px';
  };
  const styleIconButton = (button: HTMLButtonElement): void => {
    button.style.alignItems = 'center';
    button.style.background = 'transparent';
    button.style.border = '0';
    button.style.borderRadius = '6px';
    button.style.boxSizing = 'border-box';
    button.style.color = 'var(--dsw-alias-label-tertiary)';
    button.style.cursor = 'pointer';
    button.style.display = 'inline-flex';
    button.style.height = '28px';
    button.style.justifyContent = 'center';
    button.style.padding = '0';
    button.style.width = '28px';
  };

  const renderList = (): void => {
    list.textContent = '';
    if (state.levels.length === 0) {
      const emptyLabel = document.createElement('span');
      emptyLabel.textContent = t('thinkingLevelsEmpty');
      emptyLabel.style.color = 'var(--dsw-alias-label-tertiary)';
      emptyLabel.style.fontSize = '12px';
      emptyLabel.style.lineHeight = '18px';
      list.append(emptyLabel);
      return;
    }
    state.levels.forEach((level, index) => {
      const row = document.createElement('div');
      row.style.alignItems = 'center';
      row.style.border = '1px solid var(--dsw-alias-border-l2)';
      row.style.borderRadius = '8px';
      row.style.boxSizing = 'border-box';
      row.style.display = 'flex';
      row.style.gap = '6px';
      row.style.padding = '6px';
      row.style.width = '100%';

      const input = document.createElement('input');
      input.type = 'text';
      input.value = level;
      input.placeholder = t('thinkingLevelsItemPlaceholder');
      input.setAttribute('aria-label', `${t('thinkingLevelsItem')} ${index + 1}`);
      input.disabled = !state.writable || state.busy;
      styleInput(input);
      input.style.flex = '1';
      input.style.minWidth = '0';
      input.addEventListener('input', () => {
        const value = input.value.trim();
        state.levels[index] = value;
        if (value.length > 0 && !isThinkingLevel(value)) {
          state.error = t('thinkingLevelsInvalid');
          errorText.textContent = state.error;
          errorText.style.display = 'block';
          return;
        }
        state.error = null;
        errorText.style.display = 'none';
        commit();
      });
      row.append(input);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `${t('thinkingLevelsRemove')} ${index + 1}`);
      remove.title = t('thinkingLevelsRemove');
      remove.disabled = !state.writable || state.busy;
      styleIconButton(remove);
      const removeIconHost = createIconHost();
      removeIconHost.style.display = 'inline-flex';
      remove.append(removeIconHost);
      mountIcon(removeIconHost, React.createElement(IconTrashOutline16, { size: 14 }));
      remove.addEventListener('click', () => {
        state.levels.splice(index, 1);
        renderList();
        commit();
      });
      row.append(remove);
      list.append(row);
    });
  };

  const actionsRow = document.createElement('div');
  actionsRow.style.alignItems = 'center';
  actionsRow.style.display = 'flex';
  actionsRow.style.gap = '6px';

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.disabled = !state.writable || state.busy;
  styleButton(addButton);
  addButton.style.alignItems = 'center';
  addButton.style.display = 'inline-flex';
  addButton.style.gap = '4px';
  const plusHost = createIconHost();
  plusHost.style.display = 'inline-flex';
  mountIcon(plusHost, React.createElement(IconPlusOutline16, { size: 14 }));
  const addLabel = document.createElement('span');
  addLabel.textContent = t('thinkingLevelsAdd');
  addButton.append(plusHost, addLabel);
  addButton.addEventListener('click', () => {
    if (!state.writable || state.busy) return;
    state.levels = [...state.levels, ''];
    renderList();
  });
  actionsRow.append(addButton);

  const pencil = document.createElement('button');
  pencil.type = 'button';
  pencil.title = t('thinkingLevelsBulk');
  pencil.setAttribute('aria-label', t('thinkingLevelsBulk'));
  pencil.disabled = !state.writable || state.busy;
  styleIconButton(pencil);
  const pencilHost = createIconHost();
  pencilHost.style.display = 'inline-flex';
  pencil.append(pencilHost);
  mountIcon(pencilHost, React.createElement(IconEditOutline16, { size: 14 }));
  pencil.addEventListener('click', () => {
    const existing = uniqueThinkingLevels(state.levels.filter((level) => level.length > 0));
    const initial = existing.length > 0 ? `[${existing.join(', ')}]` : '';
    openThinkingBulkPopup(t, initial, (levels) => {
      state.levels = uniqueThinkingLevels([...state.levels.filter((level) => level.length > 0), ...levels]);
      renderList();
      commit();
    });
  });
  actionsRow.append(pencil);
  section.append(actionsRow);

  const defaultRow = document.createElement('div');
  defaultRow.style.alignItems = 'center';
  defaultRow.style.display = 'flex';
  defaultRow.style.gap = '8px';

  const defaultLabel = document.createElement('label');
  defaultLabel.textContent = t('thinkingLevelsDefault');
  defaultLabel.style.color = 'var(--dsw-alias-label-tertiary)';
  defaultLabel.style.fontSize = '12px';
  defaultLabel.style.lineHeight = '18px';
  defaultRow.append(defaultLabel);

  const defaultDropdown = buildThinkingDropdown(t, !state.writable || state.busy, (value) => {
    if (!state.writable || state.busy) return;
    state.defaultLevel = value;
    commit();
  });
  const renderDefaultOptions = (): void => {
    defaultDropdown.update(uniqueThinkingLevels(state.levels.filter((entry) => entry.length > 0)), state.defaultLevel);
  };
  defaultRow.append(defaultDropdown.element);
  section.append(defaultRow);

  const errorText = document.createElement('span');
  errorText.style.color = 'var(--dsw-alias-state-error-primary)';
  errorText.style.display = 'none';
  errorText.style.fontSize = '12px';
  errorText.style.lineHeight = '18px';
  section.append(errorText);

  const commit = (): void => {
    if (empty || state.busy) return;
    const valid = uniqueThinkingLevels(state.levels.filter((level) => level.length > 0));
    if (state.defaultLevel !== null && !valid.includes(state.defaultLevel)) state.defaultLevel = null;
    pending.set(key, {
      ...pending.get(key),
      [MARK_THINKING_LEVELS]: valid,
      [MARK_DEFAULT_THINKING]: state.defaultLevel,
    });
    hint.textContent = t('thinkingLevelsPending');
    renderDefaultOptions();
  };

  renderList();
  renderDefaultOptions();
  return section;
}

/** Open the free-text bulk editor for thinking levels. */
function openThinkingBulkPopup(
  t: TranslateNS<'dsh-auxiliary'>,
  initial: string,
  onConfirm: (levels: readonly string[]) => void,
): void {
  const overlay = document.createElement('div');
  overlay.style.alignItems = 'center';
  overlay.style.background = 'rgba(0, 0, 0, 0.35)';
  overlay.style.display = 'flex';
  overlay.style.inset = '0';
  overlay.style.justifyContent = 'center';
  overlay.style.position = 'fixed';
  overlay.style.zIndex = '2000';

  const dialog = document.createElement('div');
  dialog.style.background = 'var(--dsw-alias-bg-layer-1)';
  dialog.style.border = '1px solid var(--dsw-alias-border-l2)';
  dialog.style.borderRadius = '8px';
  dialog.style.boxShadow = '0 12px 32px rgba(0, 0, 0, 0.18)';
  dialog.style.boxSizing = 'border-box';
  dialog.style.display = 'flex';
  dialog.style.flexDirection = 'column';
  dialog.style.gap = '10px';
  dialog.style.padding = '16px';
  dialog.style.width = 'min(420px, calc(100vw - 32px))';

  const heading = document.createElement('span');
  heading.textContent = t('thinkingLevelsBulkTitle');
  heading.style.color = 'var(--dsw-alias-label-primary)';
  heading.style.fontSize = '14px';
  heading.style.fontWeight = '500';
  heading.style.lineHeight = '22px';
  dialog.append(heading);

  const input = document.createElement('input');
  input.type = 'text';
  input.value = initial;
  input.placeholder = '[low, high, max]';
  input.setAttribute('aria-label', t('thinkingLevelsBulkPlaceholder'));
  input.style.background = 'var(--dsw-alias-bg-layer-1)';
  input.style.border = '1px solid var(--dsw-alias-border-l2)';
  input.style.borderRadius = '8px';
  input.style.boxSizing = 'border-box';
  input.style.color = 'var(--dsw-alias-label-primary)';
  input.style.font = 'inherit';
  input.style.fontSize = '14px';
  input.style.height = '36px';
  input.style.padding = '0 10px';
  input.style.width = '100%';
  dialog.append(input);

  const error = document.createElement('span');
  error.style.color = 'var(--dsw-alias-state-error-primary)';
  error.style.display = 'none';
  error.style.fontSize = '12px';
  error.style.lineHeight = '18px';
  dialog.append(error);

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.justifyContent = 'flex-end';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = t('thinkingLevelsCancel');
  cancel.style.background = 'transparent';
  cancel.style.border = '1px solid var(--dsw-alias-border-l2)';
  cancel.style.borderRadius = '6px';
  cancel.style.color = 'var(--dsw-alias-label-primary)';
  cancel.style.cursor = 'pointer';
  cancel.style.font = 'inherit';
  cancel.style.fontSize = '13px';
  cancel.style.height = '30px';
  cancel.style.padding = '0 12px';
  cancel.addEventListener('click', () => overlay.remove());
  actions.append(cancel);

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.textContent = t('thinkingLevelsConfirm');
  confirm.style.background = 'var(--dsw-alias-button-primary-fill)';
  confirm.style.border = '0';
  confirm.style.borderRadius = '6px';
  confirm.style.color = 'var(--dsw-alias-label-primary-foreground)';
  confirm.style.cursor = 'pointer';
  confirm.style.font = 'inherit';
  confirm.style.fontSize = '13px';
  confirm.style.height = '30px';
  confirm.style.padding = '0 12px';
  const confirmBulk = (): void => {
    const levels = parseThinkingLevelsText(input.value);
    if (levels === undefined) {
      error.textContent = t('thinkingLevelsInvalid');
      error.style.display = 'block';
      return;
    }
    onConfirm(levels);
    overlay.remove();
  };
  confirm.addEventListener('click', confirmBulk);
  actions.append(confirm);
  dialog.append(actions);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') confirmBulk();
    if (event.key === 'Escape') overlay.remove();
  });

  overlay.append(dialog);
  document.body.append(overlay);
  input.focus();
}

/** Build the always-visible capability block for one model row. */
function buildCapabilityBlock(
  api: IApiClient,
  t: TranslateNS<'dsh-auxiliary'>,
  provider: string,
  model: string,
  draft: boolean,
  pending: PendingMap,
  savedRow?: PiAiModelRow,
): HTMLElement {
  const block = document.createElement('div');
  block.setAttribute(MARK_BLOCK, `${provider}\u0000${model}`);
  if (draft) block.setAttribute(MARK_DRAFT, '');
  block.style.borderTop = '1px solid var(--dsw-alias-border-l2)';
  block.style.display = 'flex';
  block.style.flexDirection = 'column';
  block.style.gap = '4px';
  block.style.gridColumn = '1 / -1';
  block.style.marginTop = '8px';
  block.style.padding = '8px 4px 2px';
  for (const spec of CAPABILITIES) block.append(buildCheckbox(api, t, provider, model, spec, draft, pending));
  block.append(buildThinkingSection(t, provider, model, pending, savedRow));
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

/**
 * The row's capacity panel holding the "context window / max output tokens"
 * fields. The page only renders it while that disclosure is expanded, so the
 * capability checkboxes collapse together with the capacity inputs.
 */
function capacityPanelOf(entry: Element): HTMLElement | undefined {
  for (const child of entry.children) {
    if (child.getAttribute(MARK_BLOCK) !== null) continue;
    const labels = [...child.querySelectorAll('input')]
      .map((input) => input.getAttribute('aria-label') ?? '')
      .filter((label) => CAPACITY_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix)));
    if (labels.length > 0) return child as HTMLElement;
  }
  return undefined;
}

/** Move pending marks from an old row key to the row's current key. */
function migratePending(pending: PendingMap, from: string, to: string): void {
  const flags = pending.get(from);
  if (flags === undefined) return;
  pending.set(to, { ...pending.get(to), ...flags });
  pending.delete(from);
}

/** Overlay a previous saved row's persisted capability/thinking marks. */
function inheritRowFlags(previous: PiAiModelRow, pending: PendingMap, key: string): void {
  const inherited: PendingFlags = {};
  if (previous.imageInput !== undefined) inherited[MARK_IMAGE_INPUT] = previous.imageInput;
  if (previous.imageGen !== undefined) inherited[MARK_IMAGE_GEN] = previous.imageGen;
  if (previous.thinkingLevels !== undefined) inherited[MARK_THINKING_LEVELS] = previous.thinkingLevels;
  if (previous.defaultThinkingLevel !== undefined) inherited[MARK_DEFAULT_THINKING] = previous.defaultThinkingLevel;
  pending.set(key, { ...inherited, ...pending.get(key) });
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
  entries: ReadonlyArray<PiAiModelRow>,
  pending: PendingMap,
): void {
  const entry = entryOf(input);
  if (entry === null) return;
  const panel = capacityPanelOf(entry);
  if (panel === undefined) {
    // The capacity disclosure is collapsed and its fields are not rendered;
    // keep the marks pending and drop any stale block until it is expanded.
    entry.querySelector(`[${MARK_BLOCK}]`)?.remove();
    return;
  }
  const key = rowKey(provider, model);
  const existing = entry.querySelector(`[${MARK_BLOCK}]`);
  if (existing !== null) {
    const existingKey = existing.getAttribute(MARK_BLOCK);
    const fresh = existingKey === key
      && (existing.hasAttribute(MARK_DRAFT) === draft);
    if (fresh) return;
    // The row's model id changed: carry the persisted capability marks of the
    // previous saved row to the new id, then overlay any marks the user toggled
    // in this session, so editing an id does not reset the two checkboxes.
    if (existingKey !== null && existingKey !== key && existingKey.slice(0, existingKey.indexOf('\u0000')) === provider) {
      const previous = entries.find((row) => rowKey(row.provider, row.model) === existingKey);
      if (previous !== undefined) inheritRowFlags(previous, pending, key);
      migratePending(pending, existingKey, key);
    }
    existing.remove();
  }
  entry.querySelector(`[${MARK_NOTICE}]`)?.remove();
  const savedRow = entries.find((row) => row.provider === provider && row.model === model);
  panel.append(buildCapabilityBlock(api, t, provider, model, draft, pending, savedRow));
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
  entries: ReadonlyArray<PiAiModelRow>,
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
      if (flags['data-dsh-aux-thinking-levels'] !== undefined || flags['data-dsh-aux-default-thinking'] !== undefined) {
        await saveModelThinkingConfig(
          api,
          provider,
          model,
          flags['data-dsh-aux-thinking-levels'] ?? [],
          flags['data-dsh-aux-default-thinking'] ?? null,
        );
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
  entries: ReadonlyArray<PiAiModelRow>,
  catalogKeys: ReadonlySet<string>,
  directory: ProviderDirectory,
  pending: PendingMap,
): void {
  const inputs = document.querySelectorAll('input[aria-label]');
  for (const input of inputs) {
    if (!isModelIdInput(input)) continue;
    const value = (input as HTMLInputElement).value.trim();
    const info = providerInfoOf(input, directory);
    if (info === undefined) continue;
    if (value.length === 0) {
      // Newly added row without an id: still show the two checkboxes so they
      // are discoverable, disabled until the user types a model id. Keep the
      // last non-empty id recorded so clearing and retyping does not lose marks.
      if (info.settingsNs === 'llm-pi-ai') {
        injectRow(api, t, input, info.provider, '', true, entries, pending);
      } else {
        injectNotice(input, t, 'imageCapabilityUnsupported');
      }
      continue;
    }
    const key = rowKey(info.provider, value);
    const previousKey = lastRowKeyByInput.get(input);
    if (previousKey !== undefined && previousKey !== key && previousKey.slice(0, previousKey.indexOf('\u0000')) === info.provider) {
      const previous = entries.find((row) => rowKey(row.provider, row.model) === previousKey);
      if (previous !== undefined) inheritRowFlags(previous, pending, key);
      migratePending(pending, previousKey, key);
    }
    lastRowKeyByInput.set(input, key);
    const saved = entries.some((entry) => entry.provider === info.provider && entry.model === value);
    if (saved || info.settingsNs === 'llm-pi-ai') {
      // Saved row → checkboxes initialized from the document, with changes
      // applied after the provider card closes. New draft row under a pi-ai
      // provider → draft checkboxes (marks land after Apply). A catalog row
      // that is not saved yet cannot be persisted by the page, so it keeps a
      // notice.
      const draft = !saved && info.settingsNs === 'llm-pi-ai' && !catalogKeys.has(key);
      if (saved || draft) {
        injectRow(api, t, input, info.provider, value, draft, entries, pending);
        continue;
      }
    }
    // Not a user-owned pi-ai model: explain instead of staying silent.
    injectNotice(input, t, info.settingsNs === 'llm-pi-ai' ? 'imageCapabilitySaveFirst' : 'imageCapabilityUnsupported');
  }
}

/** Read the user-owned rows, their capability marks, and the pi-ai catalog. */
async function piAiModelState(api: IApiClient): Promise<{
  entries: Array<PiAiModelRow>;
  catalogKeys: Set<string>;
}> {
  const response = await api.settings.describe({});
  if (!response.result.ok) return { entries: [], catalogKeys: new Set() };
  const namespace = response.result.value.namespaces.find((entry) => entry.ns === 'llm-pi-ai');
  if (namespace === undefined) return { entries: [], catalogKeys: new Set() };
  const user = recordOf(namespace.user);
  const resolved = recordOf(namespace.value);
  const userProviders = recordOf(user?.providers);
  const resolvedProviders = recordOf(resolved?.providers);
  const rows: Array<PiAiModelRow> = [];
  for (const [provider, profile] of Object.entries(userProviders ?? {})) {
    const rawModels = recordOf(profile)?.models;
    if (!Array.isArray(rawModels)) continue;
    const resolvedProfile = recordOf(resolvedProviders?.[provider]);
    const resolvedModels = Array.isArray(resolvedProfile?.models)
      ? resolvedProfile.models.map(recordOf)
      : [];
    const defaultInput = modalityList(resolvedProfile?.defaultInput);
    for (const model of rawModels) {
      const userRow = recordOf(model);
      if (userRow === undefined || typeof userRow.id !== 'string' || userRow.id.length === 0) continue;
      const resolvedModel = resolvedModels.find((entry) => entry?.id === userRow.id);
      rows.push({
        provider,
        model: userRow.id,
        imageInput: declaresImageInput(resolvedModel ?? userRow, defaultInput),
        imageGen: userRow.imageGeneration === true,
        thinkingLevels: Array.isArray(userRow.thinkingLevels)
          ? userRow.thinkingLevels.filter((entry): entry is string => typeof entry === 'string')
          : undefined,
        defaultThinkingLevel: typeof userRow.defaultThinkingLevel === 'string' ? userRow.defaultThinkingLevel : undefined,
      });
    }
  }
  const base = recordOf(namespace.base);
  const baseProviders = recordOf(base?.providers);
  const catalogKeys = new Set<string>();
  for (const [provider, profile] of Object.entries(baseProviders ?? {})) {
    const models = recordOf(profile)?.models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const row = recordOf(model);
      if (row !== undefined && typeof row.id === 'string' && row.id.length > 0) {
        catalogKeys.add(rowKey(provider, row.id));
      }
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
  let entries: Array<PiAiModelRow> = [];
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
