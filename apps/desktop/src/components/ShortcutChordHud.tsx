import type { ReactElement } from "react";

import type { ShortcutChordState } from "../lib/desktop-shortcut-dispatcher";

export function ShortcutChordHud({
  state,
}: {
  state: ShortcutChordState | null;
}): ReactElement | null {
  if (!state) return null;
  return (
    <div
      className="shortcut-chord-hud"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="shortcut-chord-hud__prompt">
        <kbd>{state.prefix}</kbd>
        <span>{state.prompt}</span>
      </div>
      <ul className="shortcut-chord-hud__options" aria-label="Chord options">
        {state.options.map((option) => (
          <li key={`${option.key}:${option.label}`}>
            <kbd>{option.key}</kbd>
            <span>{option.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
