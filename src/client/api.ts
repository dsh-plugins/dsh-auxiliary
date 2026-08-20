/**
 * Browser-side Host data access for the dsh-auxiliary settings section. All
 * reads and writes use the connection's ApiProxy (`llm.*` / `settings.*`), so
 * the settings page shares the Host's provider directory and namespace writer.
 *
 * @module dsh-auxiliary/client/api
 */
import type {
  ConfigurableProviderView,
  IApiClient,
  ModelCatalogFailure,
  ModelCatalogModel,
  ModelProviderGroup as HostModelProviderGroup,
  RpcError,
  RpcResponse,
  SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client';

/** One configurable provider row returned by the live route directory. */
export interface ProviderOption {
  /** Provider route key (`anvilcraft-ai`, `deepseek-official`, …). */
  id: string;
  /** Human-readable provider name. */
  name: string;
  /** Whether the route is currently registered and requestable. */
  active: boolean;
}

/** One model entry retained inside a provider group. */
export type ModelOption = ModelCatalogModel;

/** One provider group retained from `llm.models`. */
export type ModelProviderGroup = HostModelProviderGroup;

/** Host model catalog, preserving provider groups and lookup diagnostics. */
export interface ModelCatalog {
  /** Successful groups in provider-directory order. */
  groups: readonly ModelProviderGroup[];
  /** Non-fatal lookup failures reported by the Host. */
  failures: readonly ModelCatalogFailure[];
}

/** A possibly stale provider/model route stored in the auxiliary namespace. */
export interface AuxRoute {
  provider?: string;
  model?: string;
}

/** One independently configurable auxiliary feature. */
export interface AuxFeatureSettings extends AuxRoute {
  enabled: boolean;
  /** Image handoff toggle; only meaningful for the vision feature. */
  handoff?: boolean;
}

/** Complete decoded auxiliary namespace state used by the settings page. */
export interface AuxSettings {
  /** `tool.enabled` plus the `vision` provider/model route. */
  vision: AuxFeatureSettings;
  /** `compact.enabled` plus the compact provider/model route. */
  compact: AuxFeatureSettings;
  /** `approve.enabled` plus the approval-reviewer provider/model route. */
  approve: AuxFeatureSettings;
  /** `subagent.enabled` plus the subagent provider/model route. */
  subagent: AuxFeatureSettings;
  /** `title.enabled` plus the session-title provider/model route. */
  title: AuxFeatureSettings;
  /** `imagegen.enabled` plus the auxiliary image-generation provider/model route. */
  imagegen: AuxFeatureSettings;
  /** Namespace revision for the next optimistic-concurrency write. */
  revision?: number;
  /** Whether the namespace is exposed by the current Host. */
  available: boolean;
  /** Whether the current settings provider accepts writes. */
  writable: boolean;
}

/** Complete settings snapshot returned after a successful feature write. */
export interface AuxSettingsSnapshot {
  vision: AuxFeatureSettings;
  compact: AuxFeatureSettings;
  approve: AuxFeatureSettings;
  subagent: AuxFeatureSettings;
  title: AuxFeatureSettings;
  imagegen: AuxFeatureSettings;
  revision: number;
}

/** Feature names accepted by the atomic auxiliary settings writer. */
export type AuxFeature = 'vision' | 'compact' | 'approve' | 'subagent' | 'title' | 'imagegen';

/** Draft shape submitted by one feature card. */
export interface AuxFeatureDraft extends AuxRoute {
  enabled: boolean;
  /** Image handoff toggle; only the vision card edits it. */
  handoff?: boolean;
}

/** Additional local validation code used before an RPC write. */
type LocalAuxiliaryErrorCode = 'invalid-route' | 'image-capability-unavailable';

/** Structured error raised by an auxiliary API operation. */
export class AuxiliaryApiError extends Error {
  /** Machine-readable RPC or local validation code. */
  readonly code: RpcError['code'] | LocalAuxiliaryErrorCode;
  /** Wire details when the Host supplied them. */
  readonly details: unknown;

  constructor(
    code: RpcError['code'] | LocalAuxiliaryErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'AuxiliaryApiError';
    this.code = code;
    this.details = details;
  }
}

/** Unwrap a unary RPC response without discarding its discriminant code. */
function valueOf<T>(response: RpcResponse<T>): T {
  if (!response.result.ok) {
    throw new AuxiliaryApiError(
      response.result.error.code,
      response.result.error.message,
      response.result.error.details,
    );
  }
  return response.result.value;
}

/** List every configurable provider from the live route registry. */
export async function loadProviders(api: IApiClient): Promise<ProviderOption[]> {
  const value = valueOf(await api.llm.providers({}));
  return value.providers.map((entry: ConfigurableProviderView) => ({
    id: entry.provider,
    name: entry.displayName,
    active: entry.active,
  }));
}

/** One user-editable llm-pi-ai provider route, with its catalog display name. */
export interface PiAiProviderRef {
  /** Provider route key (`lanqin-gpt`, `anvilcraft-ai`, …). */
  id: string;
  /** Display name shown by the Models catalog card header. */
  name: string;
}

/** Every provider route whose models live in the user-editable llm-pi-ai namespace. */
export async function loadPiAiProviders(api: IApiClient): Promise<PiAiProviderRef[]> {
  const value = valueOf(await api.llm.providers({}));
  return value.providers
    .filter((entry: ConfigurableProviderView) => entry.settingsNs === 'llm-pi-ai')
    .map((entry: ConfigurableProviderView) => ({ id: entry.provider, name: entry.displayName }));
}

/**
 * Load the model catalog while retaining its provider groups and failures.
 * Inactive provider routes remain out of the selectable groups even if their
 * last catalog response is still present.
 */
export async function loadModels(api: IApiClient): Promise<ModelCatalog> {
  const [providers, response] = await Promise.all([
    loadProviders(api),
    api.llm.models({}),
  ]);
  const value = valueOf(response);
  const activeProviders = new Set(providers.filter((provider) => provider.active).map((provider) => provider.id));
  return {
    groups: value.groups.filter((group: ModelProviderGroup) => activeProviders.has(group.id)),
    failures: value.failures,
  };
}

/** Image-input declaration of one editable llm-pi-ai model row. */
export interface ModelImageCapability {
  /** Whether the provider has a user-owned llm-pi-ai model row for this id. */
  available: boolean;
  /** Whether the model currently declares image input. */
  supported: boolean;
  /** Whether the Host settings provider accepts writes. */
  writable: boolean;
}

/** Narrow an unknown settings value to a plain record. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Read a modality declaration without admitting arbitrary wire values. */
function modalitiesOf(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

/** A located user-owned model row inside the llm-pi-ai namespace. */
interface PiAiModelLocation {
  namespace: SettingsNamespaceView;
  models: Array<Record<string, unknown>>;
  modelIndex: number;
}

/** Locate the user-owned model row for one provider/model pair. */
function locatePiAiModel(namespace: SettingsNamespaceView, provider: string, model: string): PiAiModelLocation | undefined {
  const providers = recordOf(recordOf(namespace.user)?.providers);
  const providerProfile = providers === undefined ? undefined : recordOf(providers[provider]);
  const rawModels = providerProfile?.models;
  if (!Array.isArray(rawModels)) return undefined;
  const models = rawModels.map(recordOf);
  if (models.some((entry) => entry === undefined)) return undefined;
  const typedModels = models as Array<Record<string, unknown>>;
  const modelIndex = typedModels.findIndex((entry) => entry.id === model);
  if (modelIndex < 0) return undefined;
  return { namespace, models: typedModels, modelIndex };
}

/** Read the effective image-input declaration of one editable llm-pi-ai model. */
export async function loadModelImageCapability(api: IApiClient, provider: string, model: string): Promise<ModelImageCapability> {
  const settings = valueOf(await api.settings.describe({}));
  const namespace = settings.namespaces.find((entry) => entry.ns === 'llm-pi-ai');
  const location = namespace === undefined ? undefined : locatePiAiModel(namespace, provider, model);
  if (location === undefined) return { available: false, supported: false, writable: settings.writable };

  const providers = recordOf(recordOf(location.namespace.value)?.providers);
  const resolvedProfile = providers === undefined ? undefined : recordOf(providers[provider]);
  const resolvedModels = Array.isArray(resolvedProfile?.models)
    ? resolvedProfile.models.map(recordOf).filter((entry): entry is Record<string, unknown> => entry !== undefined)
    : [];
  const resolvedModel = resolvedModels.find((entry) => entry.id === model) ?? location.models[location.modelIndex];
  const modelInput = modalitiesOf(resolvedModel?.input);
  const defaultInput = modalitiesOf(resolvedProfile?.defaultInput);
  const supported = (modelInput !== undefined && modelInput.length > 0 ? modelInput : defaultInput)?.includes('image') ?? false;
  return { available: true, supported, writable: settings.writable };
}

/** Write one editable llm-pi-ai model's image-input declaration, preserving sibling rows. */
export async function saveModelImageCapability(
  api: IApiClient,
  provider: string,
  model: string,
  supported: boolean,
): Promise<ModelImageCapability> {
  const settings = valueOf(await api.settings.describe({}));
  const namespace = settings.namespaces.find((entry) => entry.ns === 'llm-pi-ai');
  const location = namespace === undefined ? undefined : locatePiAiModel(namespace, provider, model);
  if (location === undefined || !settings.writable) {
    throw new AuxiliaryApiError(
      'image-capability-unavailable',
      'dsh-auxiliary: the selected model does not expose an editable llm-pi-ai model row',
    );
  }
  const models = location.models.map((entry, index) => index === location.modelIndex
    ? { ...entry, input: supported ? ['text', 'image'] : ['text'] }
    : entry);
  valueOf(await api.settings.update({
    ns: 'llm-pi-ai',
    patch: { providers: { [provider]: { models } } },
    expectedRevision: location.namespace.revision,
  }));
  return { available: true, supported, writable: true };
}

/**
 * Image-generation declaration of one editable llm-pi-ai model row.
 *
 * Unlike image input, pi-ai has no schema field for generation, so the flag
 * lives in the user-owned row as a plugin-owned `imageGeneration` boolean: the
 * settings service persists the raw user section (unknown keys survive), while
 * pi-ai's own schema resolution strips the key from every derived view. Reads
 * therefore go to the raw row directly — the resolved profile models would
 * never carry the flag.
 */
export interface ModelGenerationCapability {
  /** Whether the provider has a user-owned llm-pi-ai model row for this id. */
  available: boolean;
  /** Whether the model is currently marked as image-generating. */
  supported: boolean;
  /** Whether the Host settings provider accepts writes. */
  writable: boolean;
}

/** Read the image-generation flag of one editable llm-pi-ai model. */
export async function loadModelGenerationCapability(
  api: IApiClient,
  provider: string,
  model: string,
): Promise<ModelGenerationCapability> {
  const settings = valueOf(await api.settings.describe({}));
  const namespace = settings.namespaces.find((entry) => entry.ns === 'llm-pi-ai');
  const location = namespace === undefined ? undefined : locatePiAiModel(namespace, provider, model);
  if (location === undefined) return { available: false, supported: false, writable: settings.writable };
  const row = location.models[location.modelIndex];
  const supported = row.imageGeneration === true;
  return { available: true, supported, writable: settings.writable };
}

/** Write one editable llm-pi-ai model's image-generation flag, preserving sibling rows. */
export async function saveModelGenerationCapability(
  api: IApiClient,
  provider: string,
  model: string,
  supported: boolean,
): Promise<ModelGenerationCapability> {
  const settings = valueOf(await api.settings.describe({}));
  const namespace = settings.namespaces.find((entry) => entry.ns === 'llm-pi-ai');
  const location = namespace === undefined ? undefined : locatePiAiModel(namespace, provider, model);
  if (location === undefined || !settings.writable) {
    throw new AuxiliaryApiError(
      'image-capability-unavailable',
      'dsh-auxiliary: the selected model does not expose an editable llm-pi-ai model row',
    );
  }
  const models = location.models.map((entry, index) => index === location.modelIndex
    ? { ...entry, imageGeneration: supported }
    : entry);
  valueOf(await api.settings.update({
    ns: 'llm-pi-ai',
    patch: { providers: { [provider]: { models } } },
    expectedRevision: location.namespace.revision,
  }));
  return { available: true, supported, writable: true };
}

/**
 * Selectable thinking levels and the default level of one editable llm-pi-ai
 * model. pi-ai has no schema fields for them, so both live in the user-owned
 * raw row as plugin-owned `thinkingLevels` (string array) and
 * `defaultThinkingLevel` (string or null), mirroring `imageGeneration`.
 */
export interface ModelThinkingConfig {
  /** Whether the provider has a user-owned llm-pi-ai model row for this id. */
  available: boolean;
  /** Offered thinking levels (`low`, `high`, …), in declaration order. */
  levels: readonly string[];
  /** The default level, or null when unset. */
  defaultLevel: string | null;
  /** Whether the Host settings provider accepts writes. */
  writable: boolean;
}

/** Read the plugin-owned thinking-level configuration of one model row. */
export async function loadModelThinkingConfig(
  api: IApiClient,
  provider: string,
  model: string,
): Promise<ModelThinkingConfig> {
  const settings = valueOf(await api.settings.describe({}));
  const namespace = settings.namespaces.find((entry) => entry.ns === 'llm-pi-ai');
  const location = namespace === undefined ? undefined : locatePiAiModel(namespace, provider, model);
  if (location === undefined) return { available: false, levels: [], defaultLevel: null, writable: settings.writable };
  const row = location.models[location.modelIndex];
  const levels = Array.isArray(row.thinkingLevels)
    ? row.thinkingLevels.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const defaultLevel = typeof row.defaultThinkingLevel === 'string' ? row.defaultThinkingLevel : null;
  return { available: true, levels, defaultLevel, writable: settings.writable };
}

/** Write the plugin-owned thinking-level configuration, preserving sibling rows. */
export async function saveModelThinkingConfig(
  api: IApiClient,
  provider: string,
  model: string,
  levels: readonly string[],
  defaultLevel: string | null,
): Promise<ModelThinkingConfig> {
  const settings = valueOf(await api.settings.describe({}));
  const namespace = settings.namespaces.find((entry) => entry.ns === 'llm-pi-ai');
  const location = namespace === undefined ? undefined : locatePiAiModel(namespace, provider, model);
  if (location === undefined || !settings.writable) {
    throw new AuxiliaryApiError(
      'bad-request',
      'dsh-auxiliary: the selected model does not expose an editable llm-pi-ai model row',
    );
  }
  const models = location.models.map((entry, index) => index === location.modelIndex
    ? { ...entry, thinkingLevels: [...levels], defaultThinkingLevel: defaultLevel }
    : entry);
  valueOf(await api.settings.update({
    ns: 'llm-pi-ai',
    patch: { providers: { [provider]: { models } } },
    expectedRevision: location.namespace.revision,
  }));
  return { available: true, levels: [...levels], defaultLevel, writable: true };
}

/**
 * List every user-owned llm-pi-ai model marked for image generation
 * (`imageGeneration: true` in its raw row). The flag survives in the raw user
 * section but is stripped from resolved views, so this walks `namespace.user`
 * directly, mirroring `loadModelGenerationCapability`.
 * @returns `provider\u0000model` keys of the marked models.
 */
export async function loadImageGenModelKeys(api: IApiClient): Promise<ReadonlySet<string>> {
  const settings = valueOf(await api.settings.describe({}));
  const namespace = settings.namespaces.find((entry) => entry.ns === 'llm-pi-ai');
  if (namespace === undefined) return new Set();
  const providers = recordOf(recordOf(namespace.user)?.providers);
  if (providers === undefined) return new Set();
  const keys = new Set<string>();
  for (const [provider, profile] of Object.entries(providers)) {
    const models = recordOf(profile)?.models;
    if (!Array.isArray(models)) continue;
    for (const raw of models) {
      const row = recordOf(raw);
      if (row === undefined || row.imageGeneration !== true || typeof row.id !== 'string') continue;
      keys.add(`${provider}\u0000${row.id}`);
    }
  }
  return keys;
}

/**
 * Retain only the provider groups whose models are marked for image
 * generation, preserving group order and provider metadata. Groups left with
 * no marked models are dropped.
 */
export function filterImageGenGroups(
  groups: readonly ModelProviderGroup[],
  keys: ReadonlySet<string>,
): readonly ModelProviderGroup[] {
  const filtered: ModelProviderGroup[] = [];
  for (const group of groups) {
    const models = group.models.filter((model) => keys.has(`${group.id}\u0000${model.id}`));
    if (models.length === 0) continue;
    filtered.push({ ...group, models });
  }
  return filtered;
}

interface AuxNamespaceValue {
  vision?: {
    provider?: string;
    model?: string;
    handoff?: boolean;
  };
  tool?: {
    enabled?: boolean;
  };
  compact?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
  };
  approve?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
  };
  subagent?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
  };
  title?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
  };
  imagegen?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
  };
}

/** Read the schema-resolved auxiliary value from a wire namespace view. */
function namespaceValue(view: SettingsNamespaceView): AuxNamespaceValue {
  return view.value as AuxNamespaceValue;
}

/** Decode one namespace view into the complete feature snapshot. */
function snapshotOf(view: SettingsNamespaceView): AuxSettingsSnapshot {
  const value = namespaceValue(view);
  return {
    vision: {
      enabled: value.tool?.enabled ?? true,
      provider: value.vision?.provider,
      model: value.vision?.model,
      handoff: value.vision?.handoff ?? true,
    },
    compact: {
      enabled: value.compact?.enabled ?? false,
      provider: value.compact?.provider,
      model: value.compact?.model,
    },
    approve: {
      enabled: value.approve?.enabled ?? false,
      provider: value.approve?.provider,
      model: value.approve?.model,
    },
    subagent: {
      enabled: value.subagent?.enabled ?? false,
      provider: value.subagent?.provider,
      model: value.subagent?.model,
    },
    title: {
      enabled: value.title?.enabled ?? false,
      provider: value.title?.provider,
      model: value.title?.model,
    },
    imagegen: {
      enabled: value.imagegen?.enabled ?? false,
      provider: value.imagegen?.provider,
      model: value.imagegen?.model,
    },
    revision: view.revision,
  };
}

/** Read the dsh-auxiliary namespace from the settings descriptor. */
export async function loadAuxSettings(api: IApiClient): Promise<AuxSettings> {
  const value = valueOf(await api.settings.describe({}));
  const namespace: SettingsNamespaceView | undefined = value.namespaces.find((ns) => ns.ns === 'dsh-auxiliary');
  if (namespace === undefined) {
    return {
      vision: { enabled: true },
      compact: { enabled: false },
      approve: { enabled: false },
      subagent: { enabled: false },
      title: { enabled: false },
      imagegen: { enabled: false },
      available: false,
      writable: value.writable,
    };
  }
  const snapshot = snapshotOf(namespace);
  return {
    ...snapshot,
    available: true,
    writable: value.writable,
  };
}

/** Return the non-empty route text, or an empty wire value when cleared. */
function routeText(value: string | undefined): string {
  return value?.trim() ?? '';
}

/** Normalize and validate a feature draft before constructing its patch. */
function normalizedDraft(draft: AuxFeatureDraft): { enabled: boolean; provider: string; model: string; handoff?: boolean } {
  const provider = routeText(draft.provider);
  const model = routeText(draft.model);
  if (Boolean(provider) !== Boolean(model)) {
    throw new AuxiliaryApiError(
      'invalid-route',
      'dsh-auxiliary: provider and model must be selected together',
    );
  }
  return {
    enabled: draft.enabled,
    provider,
    model,
    ...(draft.handoff === undefined ? {} : { handoff: draft.handoff }),
  };
}

/**
 * Atomically save one feature while preserving the other feature's namespace
 * fields. The returned snapshot is the complete post-write namespace value.
 */
export async function saveAuxFeature(
  api: IApiClient,
  feature: AuxFeature,
  draft: AuxFeatureDraft,
  expectedRevision?: number,
): Promise<AuxSettingsSnapshot> {
  const normalized = normalizedDraft(draft);
  const patch = feature === 'vision'
    ? {
      vision: {
        provider: normalized.provider,
        model: normalized.model,
        ...(normalized.handoff === undefined ? {} : { handoff: normalized.handoff }),
      },
      tool: {
        enabled: normalized.enabled,
      },
    }
    : feature === 'approve'
      ? {
        approve: {
          enabled: normalized.enabled,
          provider: normalized.provider,
          model: normalized.model,
        },
      }
      : feature === 'subagent'
        ? {
          subagent: {
            enabled: normalized.enabled,
            provider: normalized.provider,
            model: normalized.model,
          },
        }
        : feature === 'title'
          ? {
            title: {
              enabled: normalized.enabled,
              provider: normalized.provider,
              model: normalized.model,
            },
          }
          : feature === 'imagegen'
            ? {
              imagegen: {
                enabled: normalized.enabled,
                provider: normalized.provider,
                model: normalized.model,
              },
            }
            : {
              compact: {
                enabled: normalized.enabled,
                provider: normalized.provider,
                model: normalized.model,
              },
            };
  const view = valueOf(await api.settings.update({
    ns: 'dsh-auxiliary',
    patch,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  }));
  return snapshotOf(view);
}

/** Read-only host state served by the dsh-auxiliary state endpoint. */
export interface ApproveHostState {
  /** Whether the approve-for-me plugin registered one of its review presets. */
  readonly approvePluginInstalled: boolean;
}

/**
 * Fetch the host-side approve-for-me detection state. The endpoint is a
 * same-origin read-only route registered by the plugin; any failure (older
 * host, headless profile, network) conservatively reports "not installed".
 */
export async function loadApproveHostState(): Promise<ApproveHostState> {
  try {
    const response = await fetch('/dsh-auxiliary/state', { headers: { accept: 'application/json' } });
    if (!response.ok) return { approvePluginInstalled: false };
    const state = await response.json() as Partial<ApproveHostState>;
    return { approvePluginInstalled: state.approvePluginInstalled === true };
  } catch {
    return { approvePluginInstalled: false };
  }
}

/** Return the Host revision from a structured settings conflict, if present. */
export function conflictRevision(error: unknown): number | undefined {
  if (!(error instanceof AuxiliaryApiError) || error.code !== 'settings-conflict') return undefined;
  const details = error.details;
  if (typeof details !== 'object' || details === null || !('actual' in details)) return undefined;
  const actual = (details as { actual?: unknown }).actual;
  return typeof actual === 'number' ? actual : undefined;
}
