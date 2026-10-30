/**
 * Canonical desktop keyboard-shortcut contract.
 *
 * Renderer dispatch, native-menu contract tests, navigation labels, the
 * command palette, help, and Settings all consume this registry. A shortcut
 * must not be advertised anywhere unless it exists here.
 *
 * The registry stores semantic intent rather than callbacks so it remains
 * serializable, testable, and safe to expose in diagnostics. User overrides
 * contain keys/modifiers only; they never contain tenant or task data.
 */

import type { Section } from "./store";
import type { Platform } from "./tauri";

export type ShortcutPlatform = Extract<
  Platform,
  "macos" | "windows" | "linux" | "unknown"
>;

export type ShortcutCategory =
  | "Application"
  | "Navigation"
  | "Creation"
  | "Help";

export type ShortcutScope =
  | "renderer"
  | "renderer-native-menu"
  | "native-menu"
  | "native-global";
export type ShortcutLayoutMode = "logical" | "physical";
export type ShortcutOverlayPolicy = "always" | "shell-only";
export type ShortcutEditablePolicy = "allow" | "block";

export type DesktopShortcutIntent =
  | { kind: "command-palette.toggle" }
  | { kind: "help.toggle" }
  | { kind: "onboarding.restart" }
  | { kind: "section.open"; section: Section }
  | { kind: "campaign.create" }
  | { kind: "window.close" }
  | { kind: "app.quit" }
  | { kind: "settings.open" }
  | { kind: "native.quick-compose" };

export interface ShortcutStroke {
  /** Logical key from KeyboardEvent.key, normalized to lower case. */
  key: string;
  /** Physical KeyboardEvent.code used when layoutMode is physical. */
  code?: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutBinding {
  /** One stroke for ordinary shortcuts; two for the G-then-key chords. */
  strokes:
    | readonly [ShortcutStroke]
    | readonly [ShortcutStroke, ShortcutStroke];
}

export interface DesktopShortcutDefinition {
  id: string;
  label: string;
  description: string;
  category: ShortcutCategory;
  scope: ShortcutScope;
  binding: ShortcutBinding;
  intent: DesktopShortcutIntent;
  editable: ShortcutEditablePolicy;
  overlay: ShortcutOverlayPolicy;
  remappable: boolean;
}

const stroke = (
  key: string,
  code: string,
  modifiers: Omit<ShortcutStroke, "key" | "code"> = {},
): ShortcutStroke => ({ key, code, ...modifiers });

const single = (value: ShortcutStroke): ShortcutBinding => ({
  strokes: [value],
});

const sequence = (
  first: ShortcutStroke,
  second: ShortcutStroke,
): ShortcutBinding => ({ strokes: [first, second] });

const mod = (
  key: string,
  code: string,
  extra: Omit<ShortcutStroke, "key" | "code" | "mod"> = {},
): ShortcutBinding => single(stroke(key, code, { mod: true, ...extra }));

function sectionShortcut(
  id: string,
  label: string,
  section: Section,
  binding: ShortcutBinding,
  description = `Open ${label}`,
): DesktopShortcutDefinition {
  return {
    id,
    label,
    description,
    category: "Navigation",
    scope: "renderer",
    binding,
    intent: { kind: "section.open", section },
    editable: "block",
    overlay: "shell-only",
    remappable: true,
  };
}

const numberNavigation: readonly DesktopShortcutDefinition[] = [
  {
    ...sectionShortcut(
      "nav.dashboard",
      "Dashboard",
      "dashboard",
      mod("1", "Digit1"),
    ),
    scope: "renderer-native-menu",
    remappable: false,
  },
  sectionShortcut(
    "nav.subscribers",
    "Subscribers",
    "subscribers",
    mod("2", "Digit2"),
  ),
  sectionShortcut(
    "nav.campaigns",
    "Campaigns",
    "campaigns",
    mod("3", "Digit3"),
  ),
  sectionShortcut(
    "nav.sequences",
    "Sequences",
    "sequences",
    mod("4", "Digit4"),
  ),
  sectionShortcut("nav.forms", "Forms", "forms", mod("5", "Digit5")),
  sectionShortcut(
    "nav.templates",
    "Templates",
    "templates",
    mod("6", "Digit6"),
  ),
  sectionShortcut(
    "nav.analytics",
    "Analytics",
    "analytics",
    mod("7", "Digit7"),
  ),
  {
    ...sectionShortcut(
      "nav.approvals",
      "Approvals",
      "approvals",
      mod("8", "Digit8"),
    ),
    scope: "renderer-native-menu",
    remappable: false,
  },
  sectionShortcut("nav.audit", "Audit log", "audit", mod("9", "Digit9")),
  sectionShortcut("nav.ai", "Moosewave AI", "ai", mod("0", "Digit0")),
];

const gotoNavigation: readonly DesktopShortcutDefinition[] = [
  sectionShortcut(
    "goto.dashboard",
    "Dashboard",
    "dashboard",
    sequence(stroke("g", "KeyG"), stroke("d", "KeyD")),
    "Go to Dashboard",
  ),
  sectionShortcut(
    "goto.subscribers",
    "Subscribers",
    "subscribers",
    sequence(stroke("g", "KeyG"), stroke("s", "KeyS")),
    "Go to Subscribers",
  ),
  sectionShortcut(
    "goto.campaigns",
    "Campaigns",
    "campaigns",
    sequence(stroke("g", "KeyG"), stroke("c", "KeyC")),
    "Go to Campaigns",
  ),
  sectionShortcut(
    "goto.sequences",
    "Sequences",
    "sequences",
    sequence(stroke("g", "KeyG"), stroke("q", "KeyQ")),
    "Go to Sequences",
  ),
  sectionShortcut(
    "goto.automations",
    "Automations",
    "automations",
    sequence(stroke("g", "KeyG"), stroke("u", "KeyU")),
    "Go to Automations",
  ),
  sectionShortcut(
    "goto.segments",
    "Segments",
    "segments",
    sequence(stroke("g", "KeyG"), stroke("e", "KeyE")),
    "Go to Segments",
  ),
  sectionShortcut(
    "goto.analytics",
    "Analytics",
    "analytics",
    sequence(stroke("g", "KeyG"), stroke("a", "KeyA")),
    "Go to Analytics",
  ),
  sectionShortcut(
    "goto.forms",
    "Forms",
    "forms",
    sequence(stroke("g", "KeyG"), stroke("f", "KeyF")),
    "Go to Forms",
  ),
  sectionShortcut(
    "goto.templates",
    "Templates",
    "templates",
    sequence(stroke("g", "KeyG"), stroke("t", "KeyT")),
    "Go to Templates",
  ),
];

export const DESKTOP_SHORTCUTS: readonly DesktopShortcutDefinition[] = [
  {
    id: "app.command-palette",
    label: "Search and commands",
    description: "Open or close the command palette",
    category: "Application",
    scope: "renderer",
    binding: mod("k", "KeyK"),
    intent: { kind: "command-palette.toggle" },
    editable: "allow",
    overlay: "always",
    remappable: true,
  },
  {
    id: "app.help",
    label: "Help and shortcuts",
    description: "Open or close the in-app help menu",
    category: "Help",
    scope: "renderer",
    binding: mod("/", "Slash"),
    intent: { kind: "help.toggle" },
    editable: "allow",
    overlay: "shell-only",
    remappable: true,
  },
  {
    id: "app.onboarding",
    label: "Restart setup",
    description: "Reopen the first-run setup walkthrough",
    category: "Help",
    scope: "renderer",
    binding: mod("o", "KeyO", { shift: true }),
    intent: { kind: "onboarding.restart" },
    editable: "allow",
    overlay: "shell-only",
    remappable: true,
  },
  ...numberNavigation,
  sectionShortcut("nav.lists", "Lists", "lists", mod("l", "KeyL")),
  sectionShortcut("nav.domains", "Custom domains", "domains", mod("d", "KeyD")),
  ...gotoNavigation,
  {
    id: "native.new-campaign",
    label: "New campaign",
    description: "Create a campaign from the application menu",
    category: "Creation",
    scope: "native-menu",
    binding: mod("n", "KeyN"),
    intent: { kind: "campaign.create" },
    editable: "allow",
    overlay: "always",
    remappable: false,
  },
  {
    id: "native.settings",
    label: "Settings",
    description: "Open Settings from the application menu",
    category: "Application",
    scope: "native-menu",
    binding: mod(",", "Comma"),
    intent: { kind: "settings.open" },
    editable: "allow",
    overlay: "always",
    remappable: false,
  },
  {
    id: "native.close-window",
    label: "Close window",
    description: "Close or hide the current window after lifecycle review",
    category: "Application",
    scope: "native-menu",
    binding: mod("w", "KeyW"),
    intent: { kind: "window.close" },
    editable: "allow",
    overlay: "always",
    remappable: false,
  },
  {
    id: "native.quit",
    label: "Quit Moosewave",
    description: "Quit after lifecycle review",
    category: "Application",
    scope: "native-menu",
    binding: mod("q", "KeyQ"),
    intent: { kind: "app.quit" },
    editable: "allow",
    overlay: "always",
    remappable: false,
  },
  {
    id: "native.quick-compose",
    label: "Quick compose",
    description: "Show Moosewave and open a campaign draft",
    category: "Creation",
    scope: "native-global",
    binding: mod("p", "KeyP", { shift: true }),
    intent: { kind: "native.quick-compose" },
    editable: "allow",
    overlay: "always",
    remappable: false,
  },
];

const SHORTCUT_BY_ID = new Map(
  DESKTOP_SHORTCUTS.map((definition) => [definition.id, definition]),
);

export function desktopShortcutById(
  id: string,
): DesktopShortcutDefinition | null {
  return SHORTCUT_BY_ID.get(id) ?? null;
}

export function shortcutForSection(
  section: Section,
): DesktopShortcutDefinition | null {
  return (
    DESKTOP_SHORTCUTS.find(
      (definition) =>
        definition.id.startsWith("nav.") &&
        definition.intent.kind === "section.open" &&
        definition.intent.section === section,
    ) ?? null
  );
}

export function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === "undefined") return "unknown";
  const source = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (
    source.includes("mac") ||
    source.includes("iphone") ||
    source.includes("ipad")
  ) {
    return "macos";
  }
  if (source.includes("win")) return "windows";
  if (source.includes("linux")) return "linux";
  return "unknown";
}

function modifierTokens(
  strokeValue: ShortcutStroke,
  platform: ShortcutPlatform,
  spoken: boolean,
): string[] {
  const tokens: string[] = [];
  if (strokeValue.mod) {
    if (platform === "macos") tokens.push(spoken ? "Command" : "⌘");
    else tokens.push(spoken ? "Control" : "Ctrl");
  }
  if (strokeValue.alt) {
    tokens.push(
      spoken
        ? platform === "macos"
          ? "Option"
          : "Alt"
        : platform === "macos"
          ? "⌥"
          : "Alt",
    );
  }
  if (strokeValue.shift)
    tokens.push(spoken ? "Shift" : platform === "macos" ? "⇧" : "Shift");
  return tokens;
}

function displayKey(key: string, spoken: boolean): string {
  const normalized = normalizeShortcutKey(key);
  if (normalized === "/") return spoken ? "Slash" : "/";
  if (normalized === ",") return spoken ? "Comma" : ",";
  if (normalized === " ") return spoken ? "Space" : "Space";
  if (normalized === "escape") return spoken ? "Escape" : "Esc";
  if (normalized === "enter") return spoken ? "Enter" : "↵";
  if (normalized === "arrowup") return spoken ? "Up Arrow" : "↑";
  if (normalized === "arrowdown") return spoken ? "Down Arrow" : "↓";
  return normalized.length === 1 ? normalized.toUpperCase() : normalized;
}

export function formatShortcutStroke(
  strokeValue: ShortcutStroke,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  style: "compact" | "spoken" = "compact",
): string {
  const spoken = style === "spoken";
  const tokens = [
    ...modifierTokens(strokeValue, platform, spoken),
    displayKey(strokeValue.key, spoken),
  ];
  if (spoken) return tokens.join(" plus ");
  return platform === "macos" ? tokens.join("") : tokens.join("+");
}

export function formatShortcutBinding(
  binding: ShortcutBinding,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  style: "compact" | "spoken" = "compact",
): string {
  const separator = style === "spoken" ? ", then " : " then ";
  return binding.strokes
    .map((strokeValue) => formatShortcutStroke(strokeValue, platform, style))
    .join(separator);
}

export function shortcutAriaKeyShortcuts(
  binding: ShortcutBinding,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  return binding.strokes
    .map((strokeValue) => {
      const values: string[] = [];
      if (strokeValue.mod)
        values.push(platform === "macos" ? "Meta" : "Control");
      if (strokeValue.alt) values.push("Alt");
      if (strokeValue.shift) values.push("Shift");
      values.push(displayKey(strokeValue.key, true).replaceAll(" ", ""));
      return values.join("+");
    })
    .join(" ");
}

export function normalizeShortcutKey(key: string): string {
  if (key === "Spacebar") return " ";
  if (key === "Esc") return "escape";
  return key.toLocaleLowerCase("en-US");
}

export interface ShortcutKeyboardEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target?: EventTarget | null;
  getModifierState?: (key: string) => boolean;
  preventDefault(): void;
}

function primaryModifierPressed(
  event: ShortcutKeyboardEvent,
  platform: ShortcutPlatform,
): boolean {
  if (platform === "macos") return event.metaKey && !event.ctrlKey;
  if (platform === "windows" || platform === "linux") {
    return event.ctrlKey && !event.metaKey;
  }
  return (event.metaKey || event.ctrlKey) && !(event.metaKey && event.ctrlKey);
}

export function eventMatchesShortcutStroke(
  event: ShortcutKeyboardEvent,
  candidate: ShortcutStroke,
  platform: ShortcutPlatform,
  layoutMode: ShortcutLayoutMode,
): boolean {
  if (event.repeat || event.isComposing || event.keyCode === 229) return false;
  if (event.getModifierState?.("AltGraph")) return false;

  const modPressed = primaryModifierPressed(event, platform);
  if (Boolean(candidate.mod) !== modPressed) return false;
  if (Boolean(candidate.shift) !== event.shiftKey) return false;
  if (Boolean(candidate.alt) !== event.altKey) return false;
  if (!candidate.mod && (event.metaKey || event.ctrlKey)) return false;

  if (layoutMode === "physical" && candidate.code && event.code) {
    return candidate.code === event.code;
  }
  return (
    normalizeShortcutKey(candidate.key) === normalizeShortcutKey(event.key)
  );
}

export function isShortcutEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }
  const owner = target.closest<HTMLElement>(
    "input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox']",
  );
  if (!owner) return false;
  if (owner instanceof HTMLInputElement) {
    const nonText = new Set([
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ]);
    return !nonText.has(owner.type.toLowerCase());
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Device-local remapping                                               */

const PREFERENCES_KEY = "postwave.desktop.shortcuts.v1";
const PREFERENCES_VERSION = 1;

export interface DesktopShortcutPreferences {
  version: 1;
  layoutMode: ShortcutLayoutMode;
  overrides: Readonly<Record<string, ShortcutBinding>>;
}

export const DEFAULT_SHORTCUT_PREFERENCES: DesktopShortcutPreferences = {
  version: PREFERENCES_VERSION,
  layoutMode: "logical",
  overrides: {},
};

function validStroke(value: unknown): value is ShortcutStroke {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.key === "string" &&
    candidate.key.length >= 1 &&
    candidate.key.length <= 24 &&
    (candidate.code === undefined ||
      (typeof candidate.code === "string" && candidate.code.length <= 32)) &&
    [candidate.mod, candidate.shift, candidate.alt].every(
      (entry) => entry === undefined || typeof entry === "boolean",
    )
  );
}

function validBinding(value: unknown): value is ShortcutBinding {
  if (!value || typeof value !== "object") return false;
  const strokes = (value as { strokes?: unknown }).strokes;
  return (
    Array.isArray(strokes) &&
    (strokes.length === 1 || strokes.length === 2) &&
    strokes.every(validStroke)
  );
}

export function parseShortcutPreferences(
  raw: string | null,
): DesktopShortcutPreferences {
  if (!raw) return DEFAULT_SHORTCUT_PREFERENCES;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== PREFERENCES_VERSION) {
      return DEFAULT_SHORTCUT_PREFERENCES;
    }
    const layoutMode =
      parsed.layoutMode === "physical" ? "physical" : "logical";
    const rawOverrides = parsed.overrides;
    const overrides: Record<string, ShortcutBinding> = {};
    if (rawOverrides && typeof rawOverrides === "object") {
      for (const [id, binding] of Object.entries(rawOverrides)) {
        const definition = desktopShortcutById(id);
        if (!definition?.remappable || !validBinding(binding)) continue;
        overrides[id] = binding;
      }
    }
    return { version: 1, layoutMode, overrides };
  } catch {
    return DEFAULT_SHORTCUT_PREFERENCES;
  }
}

export function loadShortcutPreferences(): DesktopShortcutPreferences {
  if (typeof localStorage === "undefined") return DEFAULT_SHORTCUT_PREFERENCES;
  try {
    return parseShortcutPreferences(localStorage.getItem(PREFERENCES_KEY));
  } catch {
    return DEFAULT_SHORTCUT_PREFERENCES;
  }
}

const shortcutSubscribers = new Set<() => void>();
let shortcutPreferencesRevision = 0;
let storageListenerInstalled = false;

function emitShortcutPreferences(): void {
  shortcutPreferencesRevision += 1;
  for (const subscriber of shortcutSubscribers) subscriber();
}

function ensureShortcutStorageListener(): void {
  if (storageListenerInstalled || typeof window === "undefined") return;
  storageListenerInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.key === PREFERENCES_KEY) emitShortcutPreferences();
  });
}

export function getShortcutPreferencesRevision(): number {
  return shortcutPreferencesRevision;
}

export function subscribeShortcutPreferences(
  subscriber: () => void,
): () => void {
  ensureShortcutStorageListener();
  shortcutSubscribers.add(subscriber);
  return () => {
    shortcutSubscribers.delete(subscriber);
  };
}

function persistShortcutPreferences(
  preferences: DesktopShortcutPreferences,
): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    }
    emitShortcutPreferences();
    return true;
  } catch {
    return false;
  }
}

export function shortcutBindingFor(
  definition: DesktopShortcutDefinition,
  preferences: DesktopShortcutPreferences = loadShortcutPreferences(),
): ShortcutBinding {
  return preferences.overrides[definition.id] ?? definition.binding;
}

export function bindingFingerprint(binding: ShortcutBinding): string {
  return binding.strokes
    .map((value) =>
      [
        value.mod ? "M" : "-",
        value.alt ? "A" : "-",
        value.shift ? "S" : "-",
        normalizeShortcutKey(value.key),
      ].join(":"),
    )
    .join(">");
}

export interface ShortcutBindingConflict {
  id: string;
  label: string;
}

export function findShortcutBindingConflicts(
  id: string,
  binding: ShortcutBinding,
  preferences: DesktopShortcutPreferences = loadShortcutPreferences(),
): ShortcutBindingConflict[] {
  const fingerprint = bindingFingerprint(binding);
  return DESKTOP_SHORTCUTS.filter((definition) => definition.id !== id)
    .filter(
      (definition) =>
        bindingFingerprint(shortcutBindingFor(definition, preferences)) ===
        fingerprint,
    )
    .map((definition) => ({ id: definition.id, label: definition.label }));
}

export type ShortcutPreferenceResult =
  | { ok: true; preferences: DesktopShortcutPreferences }
  | {
      ok: false;
      reason:
        | "unknown"
        | "locked"
        | "invalid"
        | "reserved"
        | "conflict"
        | "storage";
      message: string;
    };

export function reservedShortcutReason(
  binding: ShortcutBinding,
): string | null {
  if (binding.strokes.length !== 1) return null;
  const value = binding.strokes[0];
  const key = normalizeShortcutKey(value.key);
  if (value.mod && ["a", "c", "v", "x", "y", "z", "m"].includes(key)) {
    return "That binding is reserved for a standard Edit or Window command.";
  }
  if (value.alt && key === "f4") {
    return "Alt+F4 is reserved for the operating system's close command.";
  }
  if (["f1", "f10", "f11", "f12"].includes(key)) {
    return "That function key is reserved for system help, menus, full screen, or developer tooling.";
  }
  return null;
}

export function setShortcutOverride(
  id: string,
  binding: ShortcutBinding,
): ShortcutPreferenceResult {
  const definition = desktopShortcutById(id);
  if (!definition) {
    return { ok: false, reason: "unknown", message: "Unknown shortcut." };
  }
  if (!definition.remappable) {
    return {
      ok: false,
      reason: "locked",
      message: "This shortcut is owned by the operating-system menu.",
    };
  }
  if (!validBinding(binding)) {
    return { ok: false, reason: "invalid", message: "Invalid shortcut." };
  }
  const captured = binding.strokes[0];
  const functionKey = /^f(?:[1-9]|1[0-2])$/i.test(captured.key);
  if (
    binding.strokes.length !== 1 ||
    (!captured.mod && !captured.alt && !functionKey)
  ) {
    return {
      ok: false,
      reason: "invalid",
      message:
        "Use Control/Command, Alt/Option, or a function key so typing is never hijacked.",
    };
  }
  const reserved = reservedShortcutReason(binding);
  if (reserved) {
    return { ok: false, reason: "reserved", message: reserved };
  }
  const current = loadShortcutPreferences();
  const conflicts = findShortcutBindingConflicts(id, binding, current);
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: "conflict",
      message: `Already used by ${conflicts.map((entry) => entry.label).join(", ")}.`,
    };
  }
  const next: DesktopShortcutPreferences = {
    ...current,
    overrides: { ...current.overrides, [id]: binding },
  };
  if (!persistShortcutPreferences(next)) {
    return {
      ok: false,
      reason: "storage",
      message: "Moosewave could not save shortcut preferences on this device.",
    };
  }
  return { ok: true, preferences: next };
}

export function resetShortcutOverride(id: string): void {
  const current = loadShortcutPreferences();
  if (!(id in current.overrides)) return;
  const overrides = { ...current.overrides };
  delete overrides[id];
  persistShortcutPreferences({ ...current, overrides });
}

export function resetAllShortcutOverrides(): void {
  persistShortcutPreferences({
    ...loadShortcutPreferences(),
    overrides: {},
  });
}

export function setShortcutLayoutMode(layoutMode: ShortcutLayoutMode): void {
  persistShortcutPreferences({ ...loadShortcutPreferences(), layoutMode });
}

export function bindingFromKeyboardEvent(
  event: ShortcutKeyboardEvent,
): ShortcutBinding | null {
  if (event.isComposing || event.keyCode === 229 || event.repeat) return null;
  if (event.getModifierState?.("AltGraph")) return null;
  if (event.metaKey && event.ctrlKey) return null;
  const key = normalizeShortcutKey(event.key);
  if (
    key === "shift" ||
    key === "control" ||
    key === "meta" ||
    key === "alt" ||
    key === "altgraph" ||
    key === "escape" ||
    key === "tab"
  ) {
    return null;
  }
  return single({
    key,
    ...(event.code ? { code: event.code } : {}),
    ...(event.metaKey || event.ctrlKey ? { mod: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
    ...(event.altKey ? { alt: true } : {}),
  });
}

/** Compatibility maps for older consumers while dispatch migrates. */
export const NUMERIC_SHORTCUT_SECTIONS: Readonly<Record<string, Section>> =
  Object.fromEntries(
    numberNavigation.map((definition) => [
      definition.binding.strokes[0].key,
      (
        definition.intent as Extract<
          DesktopShortcutIntent,
          { kind: "section.open" }
        >
      ).section,
    ]),
  );

export const LETTER_SHORTCUT_SECTIONS: Readonly<Record<string, Section>> = {
  l: "lists",
  d: "domains",
};

export const GOTO_SHORTCUT_SECTIONS: Readonly<Record<string, Section>> =
  Object.fromEntries(
    gotoNavigation.map((definition) => [
      definition.binding.strokes[1]?.key ?? "",
      (
        definition.intent as Extract<
          DesktopShortcutIntent,
          { kind: "section.open" }
        >
      ).section,
    ]),
  );
