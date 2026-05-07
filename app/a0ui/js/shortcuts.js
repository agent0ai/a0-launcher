// Minimal shortcuts helper for the launcher.
//
// The Agent Zero WebUI version of this file provides many app-specific convenience
// wrappers (chat context, notifications, API helpers). The launcher intentionally
// keeps this minimal to preserve portability without dragging in A0-only stores.

import * as modals from "./modals.js";

export function openModal(modalPath) {
  return modals.openModal(modalPath);
}

export function closeModal(modalPath = null) {
  return modals.closeModal(modalPath);
}

/**
 * Register a keyboard shortcut handler.
 * Returns a disposer function to remove the listener.
 *
 * @param {{ key: string, ctrl?: boolean, alt?: boolean, shift?: boolean, meta?: boolean, ctrlOrMeta?: boolean }} combo
 * @param {(event: KeyboardEvent) => void} handler
 * @param {{ target?: Document|Window }} [options]
 * @returns {() => void}
 */
export function registerShortcut(combo, handler, options = {}) {
  const target = options.target || document;

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    const keyMatches = e.key?.toLowerCase?.() === combo.key.toLowerCase();
    if (!keyMatches) return;

    if (combo.ctrlOrMeta) {
      if (!(e.ctrlKey || e.metaKey)) return;
    } else {
      if (combo.ctrl && !e.ctrlKey) return;
      if (combo.meta && !e.metaKey) return;
    }

    if (combo.alt && !e.altKey) return;
    if (combo.shift && !e.shiftKey) return;

    handler(e);
  }

  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
