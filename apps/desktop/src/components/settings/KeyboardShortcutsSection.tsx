import {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  DESKTOP_SHORTCUTS,
  bindingFromKeyboardEvent,
  formatShortcutBinding,
  getShortcutPreferencesRevision,
  loadShortcutPreferences,
  resetAllShortcutOverrides,
  resetShortcutOverride,
  setShortcutLayoutMode,
  setShortcutOverride,
  shortcutBindingFor,
  subscribeShortcutPreferences,
  type DesktopShortcutDefinition,
} from "../../lib/desktop-shortcuts";
import { ConfirmModal } from "../ConfirmModal";

const VISIBLE_SHORTCUTS = DESKTOP_SHORTCUTS;

export function KeyboardShortcutsSection(): ReactElement {
  useSyncExternalStore(
    subscribeShortcutPreferences,
    getShortcutPreferencesRevision,
    getShortcutPreferencesRevision,
  );
  const preferences = loadShortcutPreferences();
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const recordButtonRef = useRef<HTMLButtonElement | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en-US");
    if (!needle) return VISIBLE_SHORTCUTS;
    return VISIBLE_SHORTCUTS.filter((definition) =>
      `${definition.label} ${definition.description} ${definition.category}`
        .toLocaleLowerCase("en-US")
        .includes(needle),
    );
  }, [query]);

  useEffect(() => {
    if (!recordingId) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setRecordingId(null);
        setMessage("Shortcut recording cancelled.");
        requestAnimationFrame(() => recordButtonRef.current?.focus());
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        resetShortcutOverride(recordingId);
        setRecordingId(null);
        setMessage("Default shortcut restored.");
        requestAnimationFrame(() => recordButtonRef.current?.focus());
        return;
      }
      const binding = bindingFromKeyboardEvent(event);
      if (!binding) return;
      event.preventDefault();
      event.stopPropagation();
      const result = setShortcutOverride(recordingId, binding);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setRecordingId(null);
      setMessage(`Shortcut changed to ${formatShortcutBinding(binding)}.`);
      requestAnimationFrame(() => recordButtonRef.current?.focus());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId]);

  const startRecording = (
    definition: DesktopShortcutDefinition,
    button: HTMLButtonElement,
  ): void => {
    if (!definition.remappable) return;
    recordButtonRef.current = button;
    setRecordingId(definition.id);
    setMessage(
      `Recording ${definition.label}. Press a Command or Control shortcut, Alt or Option shortcut, or function key. Escape cancels; Backspace restores the default.`,
    );
  };

  return (
    <section
      className="settings-section keyboard-shortcuts-section"
      data-settings-anchor="keyboard-shortcuts"
      aria-labelledby="keyboard-shortcuts-heading"
    >
      <div className="settings-section-head">
        <div>
          <h2
            id="keyboard-shortcuts-heading"
            className="settings-section-title"
          >
            Keyboard shortcuts
          </h2>
          <div className="settings-section-sub">
            Platform-aware bindings shared by the app shell, command palette,
            navigation, and help. Menu-owned shortcuts stay locked to operating
            system conventions.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={Object.keys(preferences.overrides).length === 0}
          onClick={() => setConfirmReset(true)}
        >
          Restore defaults
        </button>
      </div>
      <div className="settings-section-body keyboard-shortcuts-body">
        <fieldset className="shortcut-layout-choice">
          <legend>Keyboard layout behavior</legend>
          <label className="radio-row">
            <input
              type="radio"
              name="shortcut-layout-mode"
              checked={preferences.layoutMode === "logical"}
              onChange={() => setShortcutLayoutMode("logical")}
            />
            Logical keys
            <span className="muted">
              Follows the character printed by your layout.
            </span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="shortcut-layout-mode"
              checked={preferences.layoutMode === "physical"}
              onChange={() => setShortcutLayoutMode("physical")}
            />
            Physical keys
            <span className="muted">
              Keeps the same key positions when layouts change.
            </span>
          </label>
        </fieldset>

        <label className="field shortcut-search-field">
          <span className="label">Find a shortcut</span>
          <input
            className="input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actions or categories"
          />
        </label>

        <div
          className="shortcut-table-scroll"
          role="region"
          aria-label="Keyboard shortcuts table"
        >
          <table className="shortcut-table">
            <caption className="sr-only">
              Application keyboard shortcuts and current bindings
            </caption>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Current shortcut</th>
                <th scope="col">Category</th>
                <th scope="col">
                  <span className="sr-only">Customize</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((definition) => {
                const binding = shortcutBindingFor(definition, preferences);
                const custom = definition.id in preferences.overrides;
                const recording = recordingId === definition.id;
                return (
                  <tr key={definition.id}>
                    <th scope="row">
                      <span className="shortcut-action-label">
                        {definition.label}
                      </span>
                      <span className="shortcut-action-description">
                        {definition.description}
                      </span>
                    </th>
                    <td>
                      <kbd>{formatShortcutBinding(binding)}</kbd>
                      {custom ? <span className="badge">Custom</span> : null}
                      {!definition.remappable ? (
                        <span className="badge">System</span>
                      ) : null}
                    </td>
                    <td>{definition.category}</td>
                    <td className="shortcut-row-actions">
                      {definition.remappable ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          aria-pressed={recording}
                          onClick={(event) =>
                            startRecording(definition, event.currentTarget)
                          }
                        >
                          {recording ? "Press shortcut…" : "Change"}
                        </button>
                      ) : (
                        <span className="muted">
                          Managed by the system menu
                        </span>
                      )}
                      {custom ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            resetShortcutOverride(definition.id);
                            setMessage(
                              `${definition.label} restored to its default.`,
                            );
                          }}
                        >
                          Reset
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {visible.length === 0 ? (
          <p className="muted" role="status">
            No shortcuts match “{query}”.
          </p>
        ) : null}
        <p
          className="shortcut-recording-status"
          role="status"
          aria-live="polite"
        >
          {message}
        </p>
      </div>

      <ConfirmModal
        open={confirmReset}
        title="Restore default shortcuts?"
        description="Every custom renderer shortcut will return to the platform-aware default. Keyboard layout behavior is kept."
        confirmLabel="Restore defaults"
        onClose={() => setConfirmReset(false)}
        onConfirm={() => {
          resetAllShortcutOverrides();
          setConfirmReset(false);
          setRecordingId(null);
          setMessage("All default shortcuts restored.");
        }}
      />
    </section>
  );
}
