/**
 * Provider-grouped model picker used by the auxiliary feature cards.
 *
 * The trigger and popup reuse the platform `Menu` primitive so this picker
 * stays visually and behaviorally consistent with the thinking-level dropdown
 * and the rest of DSH. The component deliberately owns no model data or
 * persistence behavior.
 *
 * @module dsh-auxiliary/client/ModelPicker
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
// `Menu` / `MenuEntry` 取自 dsh-loader 的包装层 `DshMenu`：
// loader 手写类型并单点导入平台原语，dsh 改名/换包/改 props 时只需升级 loader。
// 此前直取官方包的说明已被该包装取代（见 dsh-loader docs/ui-kit.md 铁律三的修订）。
import { DshMenu as Menu, type MenuEntry } from '@dsh-plugin/dsh-loader/client';
import { Icon } from '@dsh-plugin/dsh-loader/client';
import type { AuxRoute, ModelProviderGroup } from './api.js';
import { useMenuHeightLimit } from './useMenuHeightLimit.js';

/** Max menu height kept in sync with useMenuHeightLimit. */
const MENU_MAX_HEIGHT = 264;

/** Props for the internal provider-grouped model picker. */
interface ModelPickerProps {
  /** Provider groups currently available from the Host catalog. */
  groups: readonly ModelProviderGroup[];
  /** Saved or drafted provider/model pair. */
  value: AuxRoute;
  /** Called with a complete provider/model pair after an option is chosen. */
  onChange: (value: AuxRoute) => void;
  /** Disables the trigger and all options while the owner is unavailable. */
  disabled?: boolean;
  /** Visible/accessibility label for this picker. */
  label: string;
  /** Placeholder shown when no route has been selected. */
  placeholder: string;
  /** Empty-state copy shown inside the listbox. */
  emptyLabel: string;
  /** Copy shown when the saved route is absent from the live catalog. */
  unavailableLabel: string;
  /** Accessible name for the listbox popup. */
  listLabel: string;
}

const rootStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
};

const triggerStyle: CSSProperties = {
  alignItems: 'center',
  appearance: 'none',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  boxSizing: 'border-box',
  color: 'var(--dsw-alias-label-primary)',
  cursor: 'pointer',
  display: 'flex',
  font: 'inherit',
  fontSize: 14,
  gap: 8,
  justifyContent: 'space-between',
  lineHeight: '20px',
  minHeight: 36,
  padding: '7px 10px',
  textAlign: 'left',
  width: '100%',
};

const triggerTextStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const triggerHintStyle: CSSProperties = {
  alignItems: 'center',
  color: 'var(--dsw-alias-label-tertiary)',
  display: 'inline-flex',
  flexShrink: 0,
};

const unavailableStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-warn-label)',
  fontSize: 12,
  lineHeight: '18px',
  margin: '6px 0 0',
};

const optionCopyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};

const optionNameStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const optionDescriptionStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: '18px',
  marginTop: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** Format a route for a trigger whose catalog entry is stale. */
function routeLabel(value: AuxRoute): string {
  return `${value.provider ?? ''} / ${value.model ?? ''}`;
}

/** The provider-grouped model picker. */
export function ModelPicker({
  groups,
  value,
  onChange,
  disabled = false,
  label,
  placeholder,
  emptyLabel,
  unavailableLabel,
}: ModelPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<'bottom' | 'top'>('bottom');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRoot = useCallback(() => triggerRef.current?.parentElement ?? null, []);
  useMenuHeightLimit(open, menuRoot);
  const updateSide = useCallback((): void => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    setSide(below >= Math.min(MENU_MAX_HEIGHT, above) ? 'bottom' : 'top');
  }, []);
  useEffect(() => {
    if (!open) return;
    updateSide();
    window.addEventListener('scroll', updateSide, true);
    window.addEventListener('resize', updateSide);
    return () => {
      window.removeEventListener('scroll', updateSide, true);
      window.removeEventListener('resize', updateSide);
    };
  }, [open, updateSide]);

  const selectedChoice = groups
    .flatMap((group) => group.models.map((model) => ({ group, model })))
    .find(
      (choice) => choice.group.id === value.provider && choice.model.id === value.model,
    );
  const hasSavedRoute = (value.provider !== undefined && value.provider !== '')
    || (value.model !== undefined && value.model !== '');
  const stale = hasSavedRoute && selectedChoice === undefined;
  const triggerText = selectedChoice === undefined
    ? stale ? routeLabel(value) : placeholder
    : `${selectedChoice.group.name} / ${selectedChoice.model.name}`;

  const items = useMemo<readonly MenuEntry[]>(() => {
    const entries: MenuEntry[] = [];
    for (const group of groups) {
      entries.push({ type: 'label', id: `group-${group.id}`, text: group.name });
      for (const model of group.models) {
        const labelNode: ReactNode = (
          <span style={optionCopyStyle}>
            <span style={optionNameStyle}>{model.name}</span>
            {model.description !== undefined ? (
              <span style={optionDescriptionStyle}>{model.description}</span>
            ) : null}
          </span>
        );
        entries.push({ id: `${group.id}\u0000${model.id}`, label: labelNode });
      }
    }
    return entries;
  }, [groups]);

  const selectedId = value.provider !== undefined && value.model !== undefined
    ? `${value.provider}\u0000${value.model}`
    : undefined;

  return (
    <div style={rootStyle}>
      <Menu
        open={open}
        anchor={(
          <button
            ref={triggerRef}
            type="button"
            style={{ ...triggerStyle, opacity: disabled ? 0.45 : 1 }}
            disabled={disabled}
            aria-label={`${label}: ${triggerText}`}
            aria-haspopup="menu"
            aria-expanded={open}
            title={triggerText}
            onClick={() => setOpen((previous) => !previous)}
          >
            <span style={triggerTextStyle}>{triggerText}</span>
            <span style={triggerHintStyle} aria-hidden="true">
              <Icon name="ChevronDown" size={14} />
            </span>
          </button>
        )}
        items={items}
        selectedId={selectedId}
        onSelect={(id: string) => {
          const separator = id.indexOf('\u0000');
          if (separator < 0) return;
          onChange({ provider: id.slice(0, separator), model: id.slice(separator + 1) });
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
        align="start"
        side={side}
        dense
      />
      {stale ? (
        <p role="status" style={unavailableStyle}>
          {unavailableLabel}: {routeLabel(value)}
        </p>
      ) : null}
    </div>
  );
}
