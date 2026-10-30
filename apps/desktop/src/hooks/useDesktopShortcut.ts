import { useSyncExternalStore } from "react";

import {
  desktopShortcutById,
  formatShortcutBinding,
  getShortcutPreferencesRevision,
  loadShortcutPreferences,
  shortcutAriaKeyShortcuts,
  shortcutBindingFor,
  subscribeShortcutPreferences,
  type ShortcutBinding,
} from "../lib/desktop-shortcuts";

export interface DesktopShortcutProjection {
  binding: ShortcutBinding;
  label: string;
  ariaKeyShortcuts: string;
  isCustom: boolean;
}

export function useDesktopShortcut(
  id: string,
): DesktopShortcutProjection | null {
  useSyncExternalStore(
    subscribeShortcutPreferences,
    getShortcutPreferencesRevision,
    getShortcutPreferencesRevision,
  );
  const definition = desktopShortcutById(id);
  if (!definition) return null;
  const preferences = loadShortcutPreferences();
  const binding = shortcutBindingFor(definition, preferences);
  return {
    binding,
    label: formatShortcutBinding(binding),
    ariaKeyShortcuts: shortcutAriaKeyShortcuts(binding),
    isCustom: definition.id in preferences.overrides,
  };
}
