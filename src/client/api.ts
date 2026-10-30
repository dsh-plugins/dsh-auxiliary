/** Model catalog metadata edits through the loader-normalized connection API. */
export interface SettingsNamespaceView { ns: string; value: unknown; user: unknown; base?: unknown; revision: number }
interface RpcError { code: string; message: string; details?: unknown }
interface RpcResponse<T> { result: { ok: true; value: T } | { ok: false; error: RpcError } }
export interface IApiClient {
  llm: { providers(input: object): Promise<RpcResponse<{ providers: Array<{ provider: string; displayName: string; settingsNs?: string }> }>> };
  settings: {
    describe(input: object): Promise<RpcResponse<{ namespaces: SettingsNamespaceView[]; writable: boolean }>>;
    update(input: { ns: string; patch: unknown; expectedRevision?: number }): Promise<RpcResponse<SettingsNamespaceView>>;
  };
}
type ConfigurableProviderView = { provider: string; displayName: string; settingsNs?: string };
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
 * Every pi-ai thinking level a profile may declare, in escalation order.
 * Mirrors `THINKING_LEVELS` in `@deepseek-ai/dsh-llm-pi-ai`.
 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** A model's official reasoning-efforts declaration. */
type ReasoningEfforts =
  | false
  | Readonly<Record<string, string | null>>;

/** Whether a level name is a pi-ai thinking level. */
function isThinkingLevel(value: string): boolean {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Read the declared thinking levels from a row's official `reasoningEfforts`.
 *
 * Levels come back in pi-ai's escalation order, independent of key order in
 * the profile. `false` (explicit non-reasoning) and `undefined` (inherit the
 * installed catalog) both yield an empty list.
 */
function levelsOfReasoningEfforts(value: unknown): readonly string[] {
  const efforts = recordOf(value);
  if (efforts === undefined) return [];
  return THINKING_LEVELS.filter(level => efforts[level] !== undefined);
}

/** Read the provider-level default reasoning effort of one llm-pi-ai route. */
function providerReasoningDefault(namespace: SettingsNamespaceView, provider: string): string | null {
  const providers = recordOf(recordOf(namespace.user)?.providers);
  const profile = providers === undefined ? undefined : recordOf(providers[provider]);
  return typeof profile?.reasoning === 'string' ? profile.reasoning : null;
}

/**
 * Read one row's declared reasoning levels, migrating the plugin's legacy
 * `thinkingLevels` private field when the official field is absent.
 */
export function readReasoningLevels(row: Readonly<Record<string, unknown>>): readonly string[] {
  const official = levelsOfReasoningEfforts(row.reasoningEfforts);
  if (official.length > 0) return official;
  if (Array.isArray(row.thinkingLevels)) {
    const legacy = row.thinkingLevels.filter((entry): entry is string => typeof entry === 'string' && isThinkingLevel(entry));
    return THINKING_LEVELS.filter(level => legacy.includes(level));
  }
  return [];
}

/**
 * Read one row's full official reasoning config: levels from `reasoningEfforts`
 * (with legacy migration) and the default from the provider-level `reasoning`
 * effort (with legacy migration).
 */
export function readModelThinkingRow(
  namespace: SettingsNamespaceView,
  provider: string,
  row: Readonly<Record<string, unknown>>,
): { levels: readonly string[]; defaultLevel: string | null } {
  const levels = readReasoningLevels(row);
  let defaultLevel = providerReasoningDefault(namespace, provider);
  if (defaultLevel === null && typeof row.defaultThinkingLevel === 'string' && isThinkingLevel(row.defaultThinkingLevel)) {
    defaultLevel = row.defaultThinkingLevel;
  }
  return { levels, defaultLevel };
}

/**
 * Selectable thinking levels and the default level of one editable llm-pi-ai
 * model.
 *
 * The levels are read directly from the model row's OFFICIAL `reasoningEfforts`
 * field (level → same-name wire token, `off` → `null`): pi-ai's model directory
 * advertises reasoning capability — and therefore the conversation's
 * reasoning-effort picker — from that single field, so the plugin's editor is
 * just an authoring surface for it. The default level is the provider-level
 * `reasoning` effort, the official pre-selection for the composer picker.
 *
 * Rows saved by older plugin versions carry the private `thinkingLevels`
 * / `defaultThinkingLevel` fields; they are honoured as a fallback on read and
 * stripped again on write, migrating the stored configuration to the official
 * fields in one save.
 */
export interface ModelThinkingConfig {
  /** Whether the provider has a user-owned llm-pi-ai model row for this id. */
  available: boolean;
  /** Offered thinking levels (`low`, `high`, …), in pi-ai escalation order. */
  levels: readonly string[];
  /** The default level, or null when unset. */
  defaultLevel: string | null;
  /** Whether the Host settings provider accepts writes. */
  writable: boolean;
}

/** Read the official reasoning configuration of one editable llm-pi-ai model. */
export async function loadModelThinkingConfig(
  api: IApiClient,
  provider: string,
  model: string,
): Promise<ModelThinkingConfig> {
  const settings = valueOf(await api.settings.describe({}));
  const namespace = settings.namespaces.find((entry) => entry.ns === 'llm-pi-ai');
  const location = namespace === undefined ? undefined : locatePiAiModel(namespace, provider, model);
  if (location === undefined) return { available: false, levels: [], defaultLevel: null, writable: settings.writable };
  const { levels, defaultLevel } = readModelThinkingRow(location.namespace, provider, location.models[location.modelIndex]);
  return { available: true, levels, defaultLevel, writable: settings.writable };
}

/** Write one model's official reasoning configuration, preserving sibling rows. */
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
  const hasThinking = levels.some((level) => level !== 'off');
  // The OFFICIAL `reasoningEfforts` declaration, unwrapped from the editor's
  // level list: each non-`off` level maps to its same-name wire token, `off`
  // maps to `null` ("supported, send nothing"). Schema rules (pi-ai):
  //  - an empty dict is invalid, so an empty list omits the field (inherit the
  //    installed catalog's capability);
  //  - only `off` is invalid as a dict, so that collapses to `false` (explicit
  //    non-reasoning);
  //  - a real declaration must keep at least one non-`off` level.
  const reasoningEfforts: false | Readonly<Record<string, string | null>> | undefined = hasThinking
    ? Object.fromEntries(
        levels.map((level) => [level, level === 'off' ? null : level]),
      )
    : levels.length > 0
      ? false
      : undefined;
  const models = location.models.map((entry, index) => {
    if (index !== location.modelIndex) return entry;
    const { thinkingLevels: _legacyLevels, defaultThinkingLevel: _legacyDefault, ...rest } = entry;
    return {
      ...rest,
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    };
  });
  // The provider-level `reasoning` default: the official pre-selection for the
  // conversation picker (see `describableReasoningLevel`). Only levels the
  // list offers may be defaulted; a null or absent default keeps the current
  // provider value untouched.
  const providerProfile = recordOf(
    recordOf(recordOf(location.namespace.user)?.providers)?.[provider],
  );
  const reasoningDefault = defaultLevel !== null && levels.includes(defaultLevel)
    ? defaultLevel
    : undefined;
  const patch: Record<string, unknown> = {
    ...(providerProfile === undefined ? {} : { ...providerProfile }),
    models,
    ...(reasoningDefault === undefined ? {} : { reasoning: reasoningDefault }),
  };
  valueOf(await api.settings.update({
    ns: 'llm-pi-ai',
    patch: { providers: { [provider]: patch } },
    expectedRevision: location.namespace.revision,
  }));
  return { available: true, levels: [...levels], defaultLevel, writable: true };
}
