import {
  COMPACTION_FIELD, PROVIDER_SETTINGS, THINKING_LEVELS, compactionMode, isResponsesProtocol, providerRow,
  type CompactionMode,
} from '../provider-options.js';
import { valueOf, type IApiClient, type SettingsNamespaceView, type SettingsPathOp } from './api.js';
import type { AuxiliaryKey } from './locales.js';

const API_LABELS = new Set(['API protocol', 'API 协议']);
const RETRY_LABELS = new Set(['Retry policy', '重试策略']);
const SAVE_LABELS = new Set(['Apply', 'Save', '保存', '应用', 'Create provider', '创建提供商', '创建提供方']);
const CANCEL_LABELS = new Set(['Cancel', '取消', 'Close', '关闭']);
const INJECTED = 'data-dsh-aux-provider-setting';
const ERROR = 'data-dsh-aux-provider-setting-error';
const modes: ReadonlyArray<[CompactionMode, AuxiliaryKey]> = [
  ['dsh', 'providerCompactionDsh'],
  ['kimi', 'providerCompactionKimi'],
  ['remote-v2', 'providerCompactionRemote'],
];

type Translate = (key: AuxiliaryKey) => string;
type Anchor = { protocol?: HTMLSelectElement; retry?: HTMLSelectElement };

interface Editor {
  container: HTMLElement;
  card: HTMLElement;
  anchor: Anchor;
  reasoning?: HTMLSelectElement;
  compaction?: HTMLSelectElement;
  reasoningDraft?: string;
  compactionDraft?: string;
  pending?: { provider: string; reasoning?: string; compaction?: CompactionMode };
}

function labelOf(select: HTMLSelectElement): string {
  const id = select.getAttribute('aria-labelledby');
  return select.getAttribute('aria-label') ?? (id === null ? '' : document.getElementById(id)?.textContent?.trim() ?? '');
}

function buttonText(button: HTMLButtonElement): string {
  return button.textContent?.trim() ?? '';
}

function editorOf(select: HTMLSelectElement): HTMLElement | undefined {
  for (let node = select.parentElement; node !== null && node !== document.body; node = node.parentElement) {
    if ([...node.querySelectorAll<HTMLButtonElement>('button')].some(button => SAVE_LABELS.has(buttonText(button)))) return node;
  }
  return undefined;
}

function catalogPicker(container: HTMLElement): HTMLSelectElement | null | undefined {
  return container.parentElement?.querySelector<HTMLSelectElement>('select[aria-label="Provider"], select[aria-label="提供方"]');
}

function selectedProvider(editor: Editor, byDisplay: Map<string, string>): string | undefined {
  const addInput = editor.container.querySelector<HTMLInputElement>('input[aria-label="Provider ID"]');
  if (addInput !== null) return addInput.value.trim() || undefined;
  const picker = catalogPicker(editor.container);
  if (picker) return byDisplay.has(picker.value) ? picker.value : undefined;
  const retryId = editor.anchor.retry?.getAttribute('aria-labelledby');
  const retryProvider = retryId?.endsWith('-retry-failure-label')
    ? retryId.slice(0, -'-retry-failure-label'.length) : undefined;
  if (retryProvider !== undefined) return byDisplay.has(retryProvider) ? retryProvider : undefined;
  for (const item of editor.card.querySelectorAll('span')) {
    const label = item.textContent?.trim();
    if (label !== undefined && byDisplay.has(label)) return byDisplay.get(label);
  }
  return undefined;
}

function addField(
  anchor: HTMLSelectElement,
  field: string,
  label: string,
  options: ReadonlyArray<readonly [string, string]>,
  initial: string,
  changed: (value: string) => void,
  position: 'before' | 'after' = 'after',
): HTMLSelectElement {
  const parent = anchor.parentElement!;
  const container = document.createElement('div');
  container.className = parent.className;
  container.setAttribute(INJECTED, field);
  const title = document.createElement('span');
  title.className = parent.querySelector('span')?.className ?? '';
  title.textContent = label;
  const select = document.createElement('select');
  select.className = anchor.className;
  select.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = initial;
  select.addEventListener('change', () => changed(select.value));
  container.append(title, select);
  parent[position](container);
  return select;
}

async function saveOptions(api: IApiClient, pending: NonNullable<Editor['pending']>): Promise<void> {
  const path = ['providers', pending.provider];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const settings = valueOf(await api.settings.describe({}));
    const namespace = settings.namespaces.find(row => row.ns === PROVIDER_SETTINGS);
    const profile = providerRow(namespace?.value, pending.provider) ?? providerRow(namespace?.user, pending.provider);
    if (!settings.writable || namespace === undefined || profile === undefined) {
      throw new Error('Provider settings are unavailable');
    }
    const ops: SettingsPathOp[] = [];
    if (pending.reasoning !== undefined) {
      const reasoning = [...path, 'reasoning'];
      ops.push(pending.reasoning === ''
        ? { op: 'unset', path: reasoning }
        : { op: 'set', path: reasoning, value: pending.reasoning });
    }
    if (pending.compaction !== undefined && isResponsesProtocol(profile.api)) {
      ops.push({ op: 'set', path: [...path, COMPACTION_FIELD], value: pending.compaction });
    }
    if (ops.length === 0) return;
    const response = api.settings.mutate === undefined
      ? await api.settings.update({
        ns: namespace.ns,
        expectedRevision: namespace.revision,
        patch: { providers: { [pending.provider]: Object.fromEntries(ops.map(op => [op.path[2], op.op === 'set' ? op.value : null])) } },
      })
      : await api.settings.mutate({ ns: namespace.ns, ops, expectedRevision: namespace.revision });
    if (response.result.ok) return;
    if (!['settings/conflict', 'settings-conflict'].includes(response.result.error.code) || attempt === 2) valueOf(response);
  }
}

/** Stage provider fields in the editor and commit after the host's Apply/Create has closed it. */
export function startProviderSettingsInjection(
  api: IApiClient,
  t: Translate,
  onDomSettled?: (listener: () => void) => () => void,
): () => void {
  const editors = new Map<HTMLElement, Editor>();
  const byDisplay = new Map<string, string>();
  let namespace: SettingsNamespaceView | undefined;
  let writable = false;
  let disposed = false;
  let frame: number | undefined;

  async function refresh(): Promise<void> {
    const [settings, directory] = await Promise.all([api.settings.describe({}), api.llm.providers({})]);
    if (disposed) return;
    const values = valueOf(settings);
    namespace = values.namespaces.find(row => row.ns === PROVIDER_SETTINGS);
    writable = values.writable;
    byDisplay.clear();
    for (const provider of valueOf(directory).providers) {
      if (provider.settingsNs !== PROVIDER_SETTINGS) continue;
      byDisplay.set(provider.provider, provider.provider);
      byDisplay.set(provider.displayName, provider.provider);
    }
    schedule();
  }

  function report(card: HTMLElement, error: unknown): void {
    if (disposed) return;
    const owner = card.isConnected ? card : document.body;
    owner.querySelector(`[${ERROR}]`)?.remove();
    const message = document.createElement('p');
    message.setAttribute(ERROR, '');
    message.role = 'alert';
    message.textContent = `${t('providerOptionSaveFailed')} ${error instanceof Error ? error.message : String(error)}`;
    owner.append(message);
  }

  function sweep(): void {
    if (disposed || namespace === undefined) return;
    for (const [container, editor] of editors) {
      if (container.isConnected) continue;
      editors.delete(container);
      if (editor.pending !== undefined) {
        void saveOptions(api, editor.pending).then(refresh).catch(error => report(editor.card, error));
      }
    }

    const anchors = new Map<HTMLElement, Anchor>();
    for (const select of document.querySelectorAll<HTMLSelectElement>('select')) {
      const label = labelOf(select);
      const key = API_LABELS.has(label) ? 'protocol' : RETRY_LABELS.has(label) ? 'retry' : undefined;
      if (key === undefined) continue;
      const container = editorOf(select);
      if (container === undefined) continue;
      const anchor = anchors.get(container) ?? {};
      anchor[key] = select;
      anchors.set(container, anchor);
    }
    for (const [container, anchor] of anchors) {
      const card = container.closest<HTMLElement>('li') ?? container.parentElement ?? container;
      const editor = editors.get(container) ?? { container, card, anchor };
      editors.set(container, editor);
      editor.anchor = anchor;
      const creating = container.querySelector('input[aria-label="Provider ID"]') !== null
        || catalogPicker(container) != null;
      const provider = selectedProvider(editor, byDisplay);
      const user = provider === undefined ? undefined : providerRow(namespace.user, provider);
      const value = provider === undefined ? undefined : providerRow(namespace.value, provider);
      const reasoningAnchor = anchor.protocol ?? anchor.retry;
      if (reasoningAnchor !== undefined && (creating || provider !== undefined) && !editor.reasoning?.isConnected) {
        const level = editor.reasoningDraft ?? user?.reasoning ?? value?.reasoning;
        const options = [['', t('providerReasoningInherit')], ...THINKING_LEVELS.map(level => [level, level] as const)] as const;
        editor.reasoning = addField(reasoningAnchor, 'reasoning', t('providerReasoning'), options, typeof level === 'string' ? level : '', choice => {
          editor.reasoningDraft = choice;
        }, anchor.protocol === undefined ? 'before' : 'after');
      }
      if (editor.reasoning !== undefined) editor.reasoning.disabled = !writable || (reasoningAnchor?.disabled ?? false);
      const protocol = anchor.protocol?.value ?? user?.api ?? value?.api;
      const showCompaction = !creating && provider !== undefined && anchor.retry !== undefined && isResponsesProtocol(protocol);
      if (!showCompaction) {
        editor.compaction?.closest(`[${INJECTED}]`)?.remove();
        continue;
      }
      if (!editor.compaction?.isConnected && anchor.retry !== undefined) {
        const mode = compactionMode(editor.compactionDraft ?? user?.[COMPACTION_FIELD]) ?? 'dsh';
        editor.compaction = addField(anchor.retry, 'compaction', t('providerCompaction'), modes.map(([key, copy]) => [key, t(copy)]), mode, choice => {
          editor.compactionDraft = choice;
        });
      }
      if (editor.compaction !== undefined) editor.compaction.disabled = !writable || (anchor.retry?.disabled ?? false);
    }
  }

  function schedule(): void {
    if (disposed || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      sweep();
    });
  }

  function onClick(event: Event): void {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (button === null || button.disabled) return;
    for (const editor of editors.values()) {
      if (!editor.container.contains(button)) continue;
      const label = buttonText(button);
      if (CANCEL_LABELS.has(label)) editor.pending = undefined;
      if (!SAVE_LABELS.has(label)) continue;
      const provider = selectedProvider(editor, byDisplay);
      const compaction = editor.compaction?.isConnected ? compactionMode(editor.compactionDraft) : undefined;
      if (provider !== undefined && (editor.reasoningDraft !== undefined || compaction !== undefined)) {
        editor.pending = { provider, reasoning: editor.reasoningDraft, compaction };
      }
    }
    schedule();
  }

  const observer = onDomSettled === undefined ? new MutationObserver(schedule) : undefined;
  observer?.observe(document.body, { childList: true, subtree: true });
  const stop = onDomSettled?.(schedule);
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', schedule, true);
  void refresh().catch(() => { /* No settings surface is available. */ });
  return () => {
    disposed = true;
    stop?.();
    observer?.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', schedule, true);
    editors.clear();
    document.querySelectorAll(`[${INJECTED}], [${ERROR}]`).forEach(node => node.remove());
  };
}
