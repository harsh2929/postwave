import {
  DESKTOP_SHORTCUTS,
  detectShortcutPlatform,
  eventMatchesShortcutStroke,
  formatShortcutStroke,
  isShortcutEditableTarget,
  loadShortcutPreferences,
  shortcutBindingFor,
  type DesktopShortcutDefinition,
  type DesktopShortcutIntent,
  type ShortcutKeyboardEvent,
  type ShortcutPlatform,
} from "./desktop-shortcuts";

export interface ShortcutChordOption {
  key: string;
  label: string;
}

export interface ShortcutChordState {
  prefix: string;
  prompt: string;
  options: readonly ShortcutChordOption[];
}

export interface DesktopShortcutDispatcherOptions {
  platform?: ShortcutPlatform;
  sequenceTimeoutMs?: number;
  onIntent(
    intent: DesktopShortcutIntent,
    definition: DesktopShortcutDefinition,
  ): void;
  onChordChange?(state: ShortcutChordState | null): void;
  /** True while a modal, slideover, palette, or other top layer is open. */
  overlayActive?(): boolean;
  setTimer?(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
}

export interface DesktopShortcutDispatcher {
  handle(event: ShortcutKeyboardEvent): boolean;
  cancelChord(): void;
  dispose(): void;
}

interface ArmedChord {
  candidateIds: readonly string[];
}

/**
 * Stateful two-stroke dispatcher used by the application shell. It ignores
 * composition/AltGraph/repeats, obeys editable and overlay policies, and
 * emits an explicit HUD state while a sequence prefix is armed.
 */
export function createDesktopShortcutDispatcher(
  options: DesktopShortcutDispatcherOptions,
): DesktopShortcutDispatcher {
  const platform = options.platform ?? detectShortcutPlatform();
  const timeoutMs = options.sequenceTimeoutMs ?? 1_500;
  const schedule = (
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> =>
    options.setTimer
      ? options.setTimer(callback, delayMs)
      : setTimeout(callback, delayMs);
  const unschedule = (activeTimer: ReturnType<typeof setTimeout>): void => {
    if (options.clearTimer) options.clearTimer(activeTimer);
    else clearTimeout(activeTimer);
  };
  let armed: ArmedChord | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancelChord = (): void => {
    armed = null;
    if (timer !== null) {
      unschedule(timer);
      timer = null;
    }
    options.onChordChange?.(null);
  };

  const definitionAllowed = (
    definition: DesktopShortcutDefinition,
    event: ShortcutKeyboardEvent,
  ): boolean => {
    if (
      definition.editable === "block" &&
      isShortcutEditableTarget(event.target ?? null)
    ) {
      return false;
    }
    if (
      definition.overlay === "shell-only" &&
      (options.overlayActive?.() ?? false)
    ) {
      return false;
    }
    return true;
  };

  const arm = (
    candidates: readonly DesktopShortcutDefinition[],
    first: DesktopShortcutDefinition,
  ): void => {
    cancelChord();
    armed = { candidateIds: candidates.map((candidate) => candidate.id) };
    const preferences = loadShortcutPreferences();
    const firstStroke = shortcutBindingFor(first, preferences).strokes[0];
    options.onChordChange?.({
      prefix: formatShortcutStroke(firstStroke, platform),
      prompt: "Go to…",
      options: candidates.map((candidate) => {
        const binding = shortcutBindingFor(candidate, preferences);
        const second = binding.strokes[1];
        return {
          key: second ? formatShortcutStroke(second, platform) : "",
          label: candidate.label,
        };
      }),
    });
    timer = schedule(cancelChord, timeoutMs);
  };

  const dispatchFresh = (event: ShortcutKeyboardEvent): boolean => {
    const preferences = loadShortcutPreferences();
    const candidates = DESKTOP_SHORTCUTS.filter(
      (definition) =>
        definition.scope === "renderer" ||
        definition.scope === "renderer-native-menu",
    )
      .filter((definition) => definitionAllowed(definition, event))
      .filter((definition) =>
        eventMatchesShortcutStroke(
          event,
          shortcutBindingFor(definition, preferences).strokes[0],
          platform,
          preferences.layoutMode,
        ),
      );

    if (candidates.length === 0) return false;
    const sequenceCandidates = candidates.filter(
      (definition) =>
        shortcutBindingFor(definition, preferences).strokes.length === 2,
    );
    if (sequenceCandidates.length > 0) {
      event.preventDefault();
      arm(sequenceCandidates, sequenceCandidates[0]);
      return true;
    }

    const definition = candidates[0];
    event.preventDefault();
    options.onIntent(definition.intent, definition);
    return true;
  };

  const handle = (event: ShortcutKeyboardEvent): boolean => {
    if (event.isComposing || event.keyCode === 229 || event.repeat)
      return false;
    if (event.getModifierState?.("AltGraph")) return false;

    if (!armed) return dispatchFresh(event);

    const candidateIds = armed.candidateIds;
    const preferences = loadShortcutPreferences();
    const matching = DESKTOP_SHORTCUTS.filter((definition) =>
      candidateIds.includes(definition.id),
    ).find((definition) => {
      if (!definitionAllowed(definition, event)) return false;
      const second = shortcutBindingFor(definition, preferences).strokes[1];
      return (
        second !== undefined &&
        eventMatchesShortcutStroke(
          event,
          second,
          platform,
          preferences.layoutMode,
        )
      );
    });
    cancelChord();
    if (matching) {
      event.preventDefault();
      options.onIntent(matching.intent, matching);
      return true;
    }

    // A mismatching key cancels the chord, then gets one chance to act as a
    // fresh shortcut. This makes G, Cmd+K feel responsive rather than eating
    // the palette command after an abandoned sequence.
    return dispatchFresh(event);
  };

  return {
    handle,
    cancelChord,
    dispose: cancelChord,
  };
}
