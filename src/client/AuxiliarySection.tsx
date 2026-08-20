/**
 * The Auxiliary Models settings page: configure vision understanding and
 * context compaction independently while reusing routes from the Models page.
 * Each card keeps its own draft; the parent owns the namespace snapshot,
 * revision, and serialized write queue.
 *
 * @module dsh-auxiliary/client/AuxiliarySection
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
import {
  AuxiliaryApiError,
  conflictRevision,
  filterImageGenGroups,
  loadApproveHostState,
  loadAuxSettings,
  loadImageGenModelKeys,
  loadModels,
  saveAuxFeature,
  type AuxFeature,
  type AuxFeatureDraft,
  type AuxFeatureSettings,
  type AuxSettings,
  type AuxSettingsSnapshot,
  type ModelCatalog,
} from './api.js';
import { ModelPicker } from './ModelPicker.js';

/** Composed props: settings section owner share plus this page's injected face. */
export interface AuxiliarySectionProps extends SettingsSectionOwnerProps {
  /** The connection's shared API client. */
  api: IApiClient;
  /** Namespace-bound translate. */
  t: TranslateNS<'dsh-auxiliary'>;
}

const sectionStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  maxWidth: 680,
};

const titleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 500,
  lineHeight: '24px',
  margin: 0,
};

const introStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 14,
  lineHeight: '22px',
  margin: 0,
};

const cardStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 16,
};

const cardTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 500,
  lineHeight: '22px',
  margin: 0,
};

const cardDescriptionStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 13,
  lineHeight: '20px',
  margin: 0,
};

const toggleStyle: CSSProperties = {
  alignItems: 'center',
  color: 'var(--dsw-alias-label-secondary)',
  display: 'flex',
  fontSize: 13,
  gap: 8,
  lineHeight: '20px',
};

const checkboxStyle: CSSProperties = {
  height: 16,
  margin: 0,
  width: 16,
};

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginTop: 2,
};

const labelStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  fontWeight: 500,
  lineHeight: '18px',
};

const usageStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: '18px',
  margin: 0,
};

const saveRowStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: 10,
  marginTop: 2,
};

const thresholdRowStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: 10,
};

const thresholdRangeStyle: CSSProperties = {
  flex: 1,
  margin: 0,
  minWidth: 0,
};

const thresholdInputStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  boxSizing: 'border-box',
  color: 'var(--dsw-alias-label-primary)',
  flexShrink: 0,
  font: 'inherit',
  fontSize: 13,
  height: 28,
  lineHeight: '18px',
  padding: '0 8px',
  textAlign: 'right',
  width: 58,
};

const thresholdPercentStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  flexShrink: 0,
  fontSize: 13,
  lineHeight: '20px',
};

const saveStyle: CSSProperties = {
  background: 'var(--dsw-alias-button-primary-fill)',
  border: 'none',
  borderRadius: 16,
  boxSizing: 'border-box',
  color: 'var(--dsw-alias-label-primary-foreground)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 14,
  height: 32,
  lineHeight: '22px',
  padding: '0 14px',
};

const statusStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-success-primary)',
  fontSize: 12,
  lineHeight: '18px',
  margin: 0,
};

const errorStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 12,
  lineHeight: '18px',
  margin: 0,
};

/** Convert an unknown thrown value to display text without using it as a code. */
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Lowest threshold the UI offers; the engine keeps 16% of context, so the
 * threshold must stay above that default retention ratio. */
const THRESHOLD_MIN_PERCENT = 17;
const THRESHOLD_MAX_PERCENT = 99;

/** A range slider plus a precise percentage input for the compaction threshold. */
function ThresholdControl({
  value,
  onChange,
  disabled,
  label,
  hint,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
  label: string;
  hint: string;
}): JSX.Element {
  const [text, setText] = useState<string>(String(Math.round(value * 100)));
  useEffect(() => {
    setText(String(Math.round(value * 100)));
  }, [value]);

  const commitText = (raw: string): void => {
    const digits = raw.replace(/\D/g, '').slice(0, 3);
    setText(digits);
    if (digits.length === 0) return;
    const percent = Number(digits);
    if (percent >= THRESHOLD_MIN_PERCENT && percent <= THRESHOLD_MAX_PERCENT) onChange(percent / 100);
  };

  const commitBlur = (): void => {
    const digits = text.replace(/\D/g, '');
    const percent = digits.length === 0
      ? Math.round(value * 100)
      : Math.min(THRESHOLD_MAX_PERCENT, Math.max(THRESHOLD_MIN_PERCENT, Number(digits)));
    setText(String(percent));
    onChange(percent / 100);
  };

  return (
    <label style={fieldStyle}>
      <span style={labelStyle}>{label}</span>
      <div style={thresholdRowStyle}>
        <input
          type="range"
          aria-label={label}
          min={THRESHOLD_MIN_PERCENT}
          max={THRESHOLD_MAX_PERCENT}
          step={1}
          value={Math.round(value * 100)}
          disabled={disabled}
          style={thresholdRangeStyle}
          onChange={(event) => { onChange(Number(event.target.value) / 100); }}
        />
        <input
          aria-label={`${label}数值`}
          inputMode="numeric"
          value={text}
          disabled={disabled}
          style={thresholdInputStyle}
          onChange={(event) => { commitText(event.target.value); }}
          onBlur={commitBlur}
        />
        <span style={thresholdPercentStyle}>%</span>
      </div>
      <p style={usageStyle}>{hint}</p>
    </label>
  );
}

/** Translate structured save failures while preserving ordinary diagnostics. */
function saveErrorMessage(cause: unknown, t: TranslateNS<'dsh-auxiliary'>): string {
  if (cause instanceof AuxiliaryApiError) {
    if (cause.code === 'settings-conflict') return t('settingsConflict');
    if (cause.code === 'invalid-route') return t('routeIncomplete');
  }
  return errorMessage(cause);
}

interface FeatureCardProps {
  feature: AuxFeature;
  title: string;
  description: string;
  toggleLabel: string;
  pickerLabel: string;
  usage: string;
  /** Optional second checkbox label; only the vision card passes it. */
  handoffLabel?: string;
  /** Extra feature-specific controls rendered above the usage note. */
  children?: ReactNode;
  initial: AuxFeatureSettings;
  groups: ModelCatalog['groups'];
  /** Optional restricted model list; the image-generation card passes models marked for generation. */
  groupsOverride?: ModelCatalog['groups'];
  disabled: boolean;
  t: TranslateNS<'dsh-auxiliary'>;
  onSave: (feature: AuxFeature, draft: AuxFeatureDraft) => Promise<void>;
}

/** One independently drafted auxiliary feature card. */
function FeatureCard({
  feature,
  title,
  description,
  toggleLabel,
  pickerLabel,
  usage,
  handoffLabel,
  children,
  initial,
  groups,
  groupsOverride,
  disabled,
  t,
  onSave,
}: FeatureCardProps): JSX.Element {
  const [draft, setDraft] = useState<AuxFeatureDraft>(() => ({ ...initial }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const locked = disabled || saving;
  const canSave = !locked;

  const updateEnabled = (enabled: boolean): void => {
    setDraft((previous) => ({ ...previous, enabled }));
    setSaved(false);
    setError(undefined);
  };

  const updateRoute = (route: { provider?: string; model?: string }): void => {
    setDraft((previous) => ({ ...previous, ...route }));
    setSaved(false);
    setError(undefined);
  };

  const updateHandoff = (handoff: boolean): void => {
    setDraft((previous) => ({ ...previous, handoff }));
    setSaved(false);
    setError(undefined);
  };

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      await onSave(feature, draft);
      setSaved(true);
    } catch (cause) {
      setError(saveErrorMessage(cause, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section style={cardStyle} aria-labelledby={`${feature}-title`}>
      <h3 id={`${feature}-title`} style={cardTitleStyle}>{title}</h3>
      <p style={cardDescriptionStyle}>{description}</p>
      <label style={toggleStyle}>
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={locked}
          style={checkboxStyle}
          onChange={(event) => { updateEnabled(event.target.checked); }}
        />
        <span>{toggleLabel}</span>
      </label>
      {handoffLabel !== undefined ? (
        <label style={toggleStyle}>
          <input
            type="checkbox"
            checked={draft.handoff ?? true}
            disabled={locked}
            style={checkboxStyle}
            onChange={(event) => { updateHandoff(event.target.checked); }}
          />
          <span>{handoffLabel}</span>
        </label>
      ) : null}
      <label style={fieldStyle}>
        <span style={labelStyle}>{pickerLabel}</span>
        <ModelPicker
          groups={groupsOverride ?? groups}
          value={draft}
          onChange={updateRoute}
          disabled={locked}
          label={pickerLabel}
          placeholder={t('pickerPlaceholder')}
          emptyLabel={t('pickerEmpty')}
          unavailableLabel={t('pickerUnavailable')}
          listLabel={t('pickerListLabel')}
        />
      </label>
      {children}
      <p style={usageStyle}>{usage}</p>
      <div style={saveRowStyle}>
        <button
          type="button"
          style={{ ...saveStyle, opacity: canSave ? 1 : 0.4 }}
          disabled={!canSave}
          onClick={() => { void save(); }}
        >
          {saving ? t('saving') : t('save')}
        </button>
        {saved ? <p style={statusStyle}>{t('saved')}</p> : null}
      </div>
      {error !== undefined ? <p role="alert" style={errorStyle}>{t('error')} {error}</p> : null}
    </section>
  );
}

/** The Auxiliary Models settings section. */
export function AuxiliarySection({ api, t }: AuxiliarySectionProps): JSX.Element {
  const [catalog, setCatalog] = useState<ModelCatalog | undefined>();
  const [settings, setSettings] = useState<AuxSettings | undefined>();
  const [revision, setRevision] = useState<number | undefined>();
  const [approveInstalled, setApproveInstalled] = useState<boolean | undefined>();
  const [imageGenKeys, setImageGenKeys] = useState<ReadonlySet<string> | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [writingFeature, setWritingFeature] = useState<AuxFeature | undefined>();
  const [threshold, setThreshold] = useState<number | undefined>();
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const revisionRef = useRef<number | undefined>();
  const thresholdRef = useRef<number | undefined>();

  const adoptSettings = useCallback((next: AuxSettings): void => {
    revisionRef.current = next.revision;
    thresholdRef.current = next.engine.thresholdRatio;
    setRevision(next.revision);
    setThreshold(next.engine.thresholdRatio);
    setSettings(next);
  }, []);

  const adoptSnapshot = useCallback((next: AuxSettingsSnapshot): void => {
    revisionRef.current = next.revision;
    thresholdRef.current = next.engine.thresholdRatio;
    setRevision(next.revision);
    setThreshold(next.engine.thresholdRatio);
    setSettings((previous) => previous === undefined
      ? previous
      : {
        ...previous,
        vision: next.vision,
        compact: next.compact,
        approve: next.approve,
        subagent: next.subagent,
        title: next.title,
        imagegen: next.imagegen,
        engine: next.engine,
        revision: next.revision,
      });
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(undefined);
    void Promise.allSettled([
      loadModels(api),
      loadAuxSettings(api),
      loadApproveHostState(),
      loadImageGenModelKeys(api),
    ]).then(([catalogResult, settingsResult, approveResult, imageGenResult]) => {
      if (!active) return;
      const errors: string[] = [];
      if (catalogResult.status === 'fulfilled') {
        setCatalog(catalogResult.value);
      } else {
        errors.push(errorMessage(catalogResult.reason));
      }
      if (settingsResult.status === 'fulfilled') {
        adoptSettings(settingsResult.value);
      } else {
        errors.push(errorMessage(settingsResult.reason));
      }
      if (approveResult.status === 'fulfilled') {
        setApproveInstalled(approveResult.value.approvePluginInstalled);
      } else {
        setApproveInstalled(false);
      }
      if (imageGenResult.status === 'fulfilled') {
        setImageGenKeys(imageGenResult.value);
      } else {
        setImageGenKeys(undefined);
      }
      setLoadError(errors.length === 0 ? undefined : errors.join('; '));
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [api, adoptSettings]);

  const saveFeature = useCallback(async (feature: AuxFeature, draft: AuxFeatureDraft): Promise<void> => {
    const previousWrite = writeQueue.current;
    let release!: () => void;
    writeQueue.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previousWrite;
    setWritingFeature(feature);
    try {
      const next = await saveAuxFeature(
        api,
        feature,
        draft,
        revisionRef.current,
        feature === 'compact' ? thresholdRef.current : undefined,
      );
      adoptSnapshot(next);
    } catch (cause) {
      const actualRevision = conflictRevision(cause);
      if (actualRevision !== undefined) {
        revisionRef.current = actualRevision;
        setRevision(actualRevision);
        setSettings((previous) => previous === undefined
          ? previous
          : { ...previous, revision: actualRevision });
      }
      throw cause;
    } finally {
      setWritingFeature(undefined);
      release();
    }
  }, [api, adoptSnapshot]);

  const catalogFailure = catalog === undefined || catalog.failures.length === 0
    ? undefined
    : catalog.failures.map((failure) => `${failure.name} (${failure.id}): ${failure.message}`).join('; ');
  // The image-generation card only offers models marked for image generation in
  // the Models page; undefined keys (load failure) render an empty list.
  const imageGenGroups = useMemo(
    () => catalog === undefined || imageGenKeys === undefined
      ? []
      : filterImageGenGroups(catalog.groups, imageGenKeys),
    [catalog, imageGenKeys],
  );
  const settingsReady = settings?.available === true;
  const settingsWritable = settings?.writable === true;
  const cardsDisabled = !settingsReady || !settingsWritable || writingFeature !== undefined;
  // Without the approve-for-me plugin the approval card is inert; show a notice
  // and disable editing until the plugin is installed.
  const approveDisabled = cardsDisabled || approveInstalled === false;

  return (
    <div style={sectionStyle}>
      <h2 style={titleStyle}>{t('nav')}</h2>
      <p style={introStyle}>{t('intro')}</p>
      {loading ? <p style={introStyle}>{t('loading')}</p> : null}
      {!loading && loadError !== undefined ? <p role="alert" style={errorStyle}>{t('error')} {loadError}</p> : null}
      {!loading && settings !== undefined && !settings.available
        ? <p role="alert" style={errorStyle}>{t('settingsUnavailable')}</p>
        : null}
      {!loading && settings?.available === true && !settings.writable
        ? <p role="alert" style={errorStyle}>{t('settingsReadOnly')}</p>
        : null}
      {!loading && catalogFailure !== undefined
        ? <p role="alert" style={errorStyle}>{t('catalogFailure')} {catalogFailure}</p>
        : null}
      {!loading && catalog !== undefined && catalog.groups.length === 0
        ? <p role="status" style={introStyle}>{t('noProvider')}</p>
        : null}
      {!loading && settingsReady && catalog !== undefined ? (
        <>
          <FeatureCard
            feature="vision"
            title={t('visionTitle')}
            description={t('visionDescription')}
            toggleLabel={t('visionToggle')}
            pickerLabel={t('visionPickerLabel')}
            usage={t('visionUsage')}
            handoffLabel={t('visionHandoff')}
            initial={settings.vision}
            groups={catalog.groups}
            disabled={cardsDisabled}
            t={t}
            onSave={saveFeature}
          />
          <FeatureCard
            feature="compact"
            title={t('compactTitle')}
            description={t('compactDescription')}
            toggleLabel={t('compactToggle')}
            pickerLabel={t('compactPickerLabel')}
            usage={t('compactUsage')}
            initial={settings.compact}
            groups={catalog.groups}
            disabled={cardsDisabled}
            t={t}
            onSave={saveFeature}
          >
            {threshold !== undefined ? (
              <ThresholdControl
                value={threshold}
                onChange={(value) => {
                  thresholdRef.current = value;
                  setThreshold(value);
                }}
                disabled={cardsDisabled}
                label={t('compactThresholdLabel')}
                hint={t('compactThresholdHint')}
              />
            ) : null}
          </FeatureCard>
          <FeatureCard
            feature="approve"
            title={t('approveTitle')}
            description={t('approveDescription')}
            toggleLabel={t('approveToggle')}
            pickerLabel={t('approvePickerLabel')}
            usage={approveInstalled === false ? t('approveNotInstalled') : t('approveUsage')}
            initial={settings.approve}
            groups={catalog.groups}
            disabled={approveDisabled}
            t={t}
            onSave={saveFeature}
          />
          <FeatureCard
            feature="subagent"
            title={t('subagentTitle')}
            description={t('subagentDescription')}
            toggleLabel={t('subagentToggle')}
            pickerLabel={t('subagentPickerLabel')}
            usage={t('subagentUsage')}
            initial={settings.subagent}
            groups={catalog.groups}
            disabled={cardsDisabled}
            t={t}
            onSave={saveFeature}
          />
          <FeatureCard
            feature="title"
            title={t('titleTitle')}
            description={t('titleDescription')}
            toggleLabel={t('titleToggle')}
            pickerLabel={t('titlePickerLabel')}
            usage={t('titleUsage')}
            initial={settings.title}
            groups={catalog.groups}
            disabled={cardsDisabled}
            t={t}
            onSave={saveFeature}
          />
          <FeatureCard
            feature="imagegen"
            title={t('imagegenTitle')}
            description={t('imagegenDescription')}
            toggleLabel={t('imagegenToggle')}
            pickerLabel={t('imagegenPickerLabel')}
            usage={imageGenGroups.length === 0 ? t('imagegenNoModels') : t('imagegenUsage')}
            initial={settings.imagegen}
            groups={catalog.groups}
            groupsOverride={imageGenGroups}
            disabled={cardsDisabled}
            t={t}
            onSave={saveFeature}
          />
        </>
      ) : null}
    </div>
  );
}
