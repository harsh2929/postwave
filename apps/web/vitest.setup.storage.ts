// SPDX-License-Identifier: AGPL-3.0-only
//
// Restores Web Storage inside DOM test environments.
//
// Node >= 22 ships an experimental Web Storage global. Without
// --localstorage-file it is DEFINED but inert: `globalThis.localStorage`
// exists as a property descriptor and evaluates to `undefined`.
//
// Vitest populates a DOM environment by copying the window's keys onto
// globalThis, skipping any key that is ALREADY present there. Node's inert
// stub counts as present, so happy-dom's real implementation is never copied.
// The result is a test environment where `window === globalThis` is true and
// `window.localStorage` is undefined — so every happy-dom test that touches
// storage dies in its own beforeEach with "Cannot read properties of
// undefined", which reads like a test bug and is actually an environment one.
//
// The storage installed here is happy-dom's OWN implementation, taken from a
// real Window, not a hand-written stand-in. That distinction matters: tests
// in this suite assert how the app degrades when storage misbehaves, and a
// simplified Map-backed shim would quietly satisfy them without exercising
// the behaviour they exist to pin (quota errors, key enumeration order,
// value coercion). A fake that always succeeds turns a resilience test green
// while proving nothing.
//
// Node-environment test files never enter this branch: they have no `window`.

if (typeof globalThis.window !== "undefined") {
  const needsLocal = globalThis.localStorage === undefined;
  const needsSession = globalThis.sessionStorage === undefined;

  if (needsLocal || needsSession) {
    const { Window } = await import("happy-dom");
    // One Window per test FILE, so files stay isolated from each other and
    // localStorage/sessionStorage remain two distinct stores within a file.
    const donor = new Window();

    for (const [key, value] of [
      ["localStorage", donor.localStorage],
      ["sessionStorage", donor.sessionStorage],
    ] as const) {
      if (globalThis[key] !== undefined) continue;
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
  }
}

export {};
