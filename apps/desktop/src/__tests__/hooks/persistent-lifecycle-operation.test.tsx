// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  type PersistentLifecycleOperation,
  usePersistentLifecycleOperation,
} from "../../hooks/usePersistentLifecycleOperation";
import { useDiscardOnlyDraftLifecycle } from "../../hooks/useSettingsDraftLifecycle";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};
const hideIntent: LifecycleIntent = {
  ...quitIntent,
  kind: "close-window",
  disposition: "hide",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: PersistentLifecycleOperation | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
});

function Harness(): ReactElement {
  latest = usePersistentLifecycleOperation({
    ownerId: "behavior-probe",
    label: "Behavior probe request",
  });
  useDiscardOnlyDraftLifecycle({
    ownerId: "behavior-probe-draft",
    label: "Behavior probe draft",
    dirty: false,
    operationRef: latest.promiseRef,
    discard: () => undefined,
  });
  return <span>{latest.active ? "active" : "idle"}</span>;
}

function renderHarness(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("persistent lifecycle operation", () => {
  it("is same-tick single-flight, hide-safe, and owned through unmount", async () => {
    const pending = deferred();
    renderHarness();

    let first!: Promise<void>;
    act(() => {
      first = latest!.run(() => pending.promise)!;
    });
    expect(latest?.run(async () => undefined)).toBeNull();
    await expect(inspectLifecycle(hideIntent)).resolves.toEqual([]);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Behavior probe request",
        level: "blocking",
        canSave: false,
        canDiscard: false,
      },
    ]);

    act(() => root?.unmount());
    root = null;
    await expect(inspectLifecycle(quitIntent)).resolves.toHaveLength(1);

    pending.resolve();
    await first;
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });
});
