// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Regression: useRegisterCommands drove an unbounded render loop.
//
//   register()  → setSlots(prev => ({ ...prev, [slot]: cmds }))   // new object
//               → commands (useMemo on slots) is new
//               → value (useMemo on commands) is new
//               → ctx, read via useContext, is new
//               → the effect lists `ctx` in its deps, so it re-runs
//               → register() …
//
// Memoizing `cmds` — which the hook's own doc demands — does not help: the
// feedback runs through the context value, not the argument. Every dashboard
// page using it (suppressions, pilot, approvals) span until React tore the tree
// down. A probe of the unfixed code killed the vitest worker outright.
//
// The test is deliberately BOUNDED: it throws at a render ceiling so a
// regression fails in milliseconds instead of hanging the suite the way the
// original probe did.
import { act, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  CommandRegistryProvider,
  useCommandRegistry,
  useRegisterCommands,
  type PageCommand,
} from "@/components/command-registry";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RENDER_CEILING = 25;

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

function makeHarness() {
  const counter = { renders: 0 };
  function Page({ commands }: { commands: PageCommand[] }) {
    counter.renders += 1;
    if (counter.renders > RENDER_CEILING) {
      throw new Error(`runaway re-render (> ${RENDER_CEILING})`);
    }
    useRegisterCommands(commands);
    const all = useCommandRegistry();
    return <div data-testid="count">{all.length}</div>;
  }
  return { counter, Page };
}

async function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  let error = "";
  await act(async () => {
    try {
      root!.render(node);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });
  return error;
}

describe("command registry", () => {
  it("settles instead of re-registering forever", async () => {
    const { counter, Page } = makeHarness();
    function App() {
      const cmds = useMemo<PageCommand[]>(
        () => [{ id: "a", label: "Do a thing", run: () => {} }],
        [],
      );
      return (
        <CommandRegistryProvider>
          <Page commands={cmds} />
        </CommandRegistryProvider>
      );
    }

    const error = await mount(<App />);

    expect(error).toBe("");
    expect(counter.renders).toBeLessThanOrEqual(RENDER_CEILING);
    // The command must actually be registered — settling by never registering
    // would pass the loop check while breaking the feature.
    expect(host!.querySelector('[data-testid="count"]')?.textContent).toBe("1");
  });

  it("settles for two pages registering into the same provider", async () => {
    const a = makeHarness();
    const b = makeHarness();
    function App() {
      const one = useMemo<PageCommand[]>(
        () => [{ id: "1", label: "One", run: () => {} }],
        [],
      );
      const two = useMemo<PageCommand[]>(
        () => [{ id: "2", label: "Two", run: () => {} }],
        [],
      );
      return (
        <CommandRegistryProvider>
          <a.Page commands={one} />
          <b.Page commands={two} />
        </CommandRegistryProvider>
      );
    }

    const error = await mount(<App />);

    expect(error).toBe("");
    expect(a.counter.renders).toBeLessThanOrEqual(RENDER_CEILING);
    expect(b.counter.renders).toBeLessThanOrEqual(RENDER_CEILING);
    // Both slots present, neither clobbering the other.
    expect(
      host!.querySelectorAll('[data-testid="count"]')[0]?.textContent,
    ).toBe("2");
  });

  it("settles when a conditional registration switches through an inline empty array", async () => {
    const counter = { renders: 0 };
    function Page() {
      counter.renders += 1;
      if (counter.renders > RENDER_CEILING) {
        throw new Error(`runaway re-render (> ${RENDER_CEILING})`);
      }
      const [enabled, setEnabled] = useState(true);
      const commands = useMemo<PageCommand[]>(
        () => [{ id: "conditional", label: "Conditional", run: () => {} }],
        [],
      );
      useRegisterCommands(enabled ? commands : []);
      const all = useCommandRegistry();
      return (
        <button type="button" onClick={() => setEnabled((value) => !value)}>
          <span data-testid="count">{all.length}</span>
        </button>
      );
    }

    const error = await mount(
      <CommandRegistryProvider>
        <Page />
      </CommandRegistryProvider>,
    );

    expect(error).toBe("");
    expect(host!.querySelector('[data-testid="count"]')?.textContent).toBe("1");

    await act(async () => {
      host!.querySelector("button")?.click();
    });
    expect(host!.querySelector('[data-testid="count"]')?.textContent).toBe("0");

    await act(async () => {
      host!.querySelector("button")?.click();
    });
    expect(host!.querySelector('[data-testid="count"]')?.textContent).toBe("1");
    expect(counter.renders).toBeLessThanOrEqual(RENDER_CEILING);
  });
});
