/**
 * Cap the platform `Menu` list at a few visible rows.
 *
 * The primitive sizes its scrollable list to the whole viewport by default;
 * pickers with a small option count should instead show a compact internal
 * scrollbar. Both pickers share this hook so the behavior stays consistent.
 *
 * @module dsh-auxiliary/client/useMenuHeightLimit
 */
import { useEffect } from 'react';

/**
 * Apply the height cap after the Menu has rendered its list.
 * `getRoot` resolves the Menu wrapper so the cap only touches this picker.
 */
export function useMenuHeightLimit(
  open: boolean,
  getRoot: () => HTMLElement | null,
  maxHeight = 264,
): void {
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const menu = getRoot()?.querySelector<HTMLElement>('[role="menu"]');
      if (menu === undefined || menu === null) return;
      menu.style.maxHeight = `${maxHeight}px`;
      menu.style.overflowY = 'auto';
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, getRoot, maxHeight]);
}
