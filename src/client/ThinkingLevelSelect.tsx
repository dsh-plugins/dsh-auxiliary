/**
 * Thinking-level selector reused by the model-catalog capacity fold.
 *
 * The popup and checkmark come from the platform `Menu` primitive so the
 * control stays visually and behaviorally consistent with other DSH pickers.
 *
 * @module dsh-auxiliary/client/ThinkingLevelSelect
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
// `Menu` 取自 dsh-loader 的包装层 `DshMenu`（单点吸收平台变化）；理由见 ModelPicker.tsx 顶部。
import { DshMenu as Menu } from '@dsh-plugin/dsh-loader/client';
import { Icon } from '@dsh-plugin/dsh-loader/client';
import { useMenuHeightLimit } from './useMenuHeightLimit.js';

/** Max menu height kept in sync with useMenuHeightLimit. */
const MENU_MAX_HEIGHT = 264;

/** Props for the thinking-level selector. */
interface ThinkingLevelSelectProps {
  /** Levels currently present in the thinking-level list. */
  levels: readonly string[];
  /** Selected level, or null for "not configured". */
  value: string | null;
  /** Called with the selected level, or null for "not configured". */
  onChange: (value: string | null) => void;
  /** Disables the trigger while the model row has no id or a save is pending. */
  disabled: boolean;
  /** Accessible name of the trigger. */
  label: string;
  /** Label of the "not configured" option. */
  emptyLabel: string;
}

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

/** A compact listbox-style dropdown for thinking levels. */
export function ThinkingLevelSelect({
  levels,
  value,
  onChange,
  disabled,
  label,
  emptyLabel,
}: ThinkingLevelSelectProps): JSX.Element {
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
  const items = useMemo(
    () => [
      { id: '', label: emptyLabel },
      ...levels.map((level) => ({ id: level, label: level })),
    ],
    [levels, emptyLabel],
  );

  return (
    <Menu
      open={open}
      anchor={(
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          style={{ ...triggerStyle, opacity: disabled ? 0.45 : 1 }}
          onClick={() => setOpen((previous) => !previous)}
        >
          <span style={triggerTextStyle}>{value ?? emptyLabel}</span>
          <span style={{ alignItems: 'center', color: 'var(--dsw-alias-label-tertiary)', display: 'inline-flex', flexShrink: 0 }}>
            <Icon name="ChevronDown" size={14} />
          </span>
        </button>
      )}
      items={items}
      selectedId={value ?? ''}
      onSelect={(id: string) => {
        onChange(id === '' ? null : id);
        setOpen(false);
      }}
      onClose={() => setOpen(false)}
      align="start"
      side={side}
      dense
    />
  );
}
