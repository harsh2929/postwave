/**
 * Low-key easter eggs — the "someone loved this" signals the craft audit
 * asked for. Self-contained + idempotent so it can be wired from main.tsx
 * with a single call and never touches App.tsx (keeps it out of the way of
 * in-flight feature work).
 *
 *  1. A styled console signature on boot (the classic loved-SaaS dev-tools
 *     greeting + a hiring nudge).
 *  2. The Konami code (↑↑↓↓←→←→ B A) → confetti + a warm toast.
 *
 * Both degrade gracefully: confetti already honours prefers-reduced-motion,
 * and the toast still fires so the moment lands without the particles.
 */
import { celebrate } from "../components/Celebrate";
import { toast } from "../components/Toast";

let installed = false;

const KONAMI = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "b",
  "a",
] as const;

function consoleSignature(): void {
  // Wrapped in try/catch — a styled console.log is the definition of
  // non-essential, and some embedded webviews stub console.
  try {
    // eslint-disable-next-line no-console
    console.log(
      "%cPostwave",
      "font:600 28px Georgia,'Times New Roman',serif;color:#C8102E;",
    );
    // eslint-disable-next-line no-console
    console.log(
      "%cBuilt with love on the west coast. We're hiring — careers@moosewave.com",
      "color:#7a8699;font-size:12px;",
    );
  } catch {
    /* no-op */
  }
}

function installKonami(): void {
  let pos = 0;
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    // Don't swallow keystrokes while the user is typing — and reset so a
    // stray "b"/"a" in a field can't advance the sequence.
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.isContentEditable ||
        t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT")
    ) {
      pos = 0;
      return;
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === KONAMI[pos]) {
      pos += 1;
      if (pos === KONAMI.length) {
        pos = 0;
        celebrate({ count: 80 });
        toast.success({
          message: "You found it.",
          detail: "Built with love by the Moosewave crew 🌊",
        });
      }
    } else {
      // Restart cleanly — and re-arm if this key is itself the first note.
      pos = key === KONAMI[0] ? 1 : 0;
    }
  });
}

/** Wire the eggs once. Safe to call multiple times (idempotent). */
export function initEasterEggs(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  consoleSignature();
  installKonami();
}
