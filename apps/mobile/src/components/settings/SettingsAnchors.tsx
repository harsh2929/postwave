/**
 * SettingsAnchors — the "jump to a section" plumbing for the Settings screen.
 *
 * Settings is one long ScrollView with 20+ headings, several of which are
 * rendered by child components rather than the screen itself. Rather than
 * threading a ref and an onLayout through every one of those children, each
 * SectionHeader registers its own y-offset with this registry when it is given
 * an `anchor`. The screen owns the ScrollView ref and does the scrolling.
 *
 * Why offsets are held in a REF rather than state: onLayout fires for every
 * section on first paint and again on every re-layout (a role change alone
 * mounts or unmounts a dozen sections). Storing them in state would re-render
 * the whole screen once per section, per layout pass, for information nothing
 * renders.
 */
import { createContext, useCallback, useContext, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";

export interface SettingsAnchorRegistry {
  register: (key: string, y: number) => void;
  offsetFor: (key: string) => number | null;
}

const SettingsAnchorContext = createContext<SettingsAnchorRegistry | null>(
  null,
);

/** Creates the registry. Call this in the screen that owns the ScrollView. */
export function useSettingsAnchorRegistry(): SettingsAnchorRegistry {
  const offsets = useRef(new Map<string, number>());
  return useMemo(
    () => ({
      register: (key, y) => {
        offsets.current.set(key, y);
      },
      offsetFor: (key) => offsets.current.get(key) ?? null,
    }),
    [],
  );
}

export function SettingsAnchorProvider({
  registry,
  children,
}: {
  registry: SettingsAnchorRegistry;
  children: ReactNode;
}) {
  return (
    <SettingsAnchorContext.Provider value={registry}>
      {children}
    </SettingsAnchorContext.Provider>
  );
}

/**
 * Returns an onLayout handler for a section heading, or null when there is no
 * anchor to register (so the caller can skip the wrapper View entirely and
 * leave the layout of every non-anchored heading untouched).
 */
export function useSettingsAnchorLayout(
  anchor: string | undefined,
): ((event: LayoutChangeEvent) => void) | null {
  const registry = useContext(SettingsAnchorContext);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (!anchor || !registry) return;
      registry.register(anchor, event.nativeEvent.layout.y);
    },
    [anchor, registry],
  );
  if (!anchor || !registry) return null;
  return onLayout;
}
