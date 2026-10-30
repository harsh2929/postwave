// @vitest-environment happy-dom

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type DraftLifecycleController,
  type DraftLifecycleMode,
  useDraftLifecycleController,
} from "../../hooks/useDraftLifecycleController";
import {
  inspectLifecycle,
  prepareLifecycle,
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

interface Probe {
  controller: DraftLifecycleController;
  setDraft: (value: string) => void;
  draft: string;
  open: boolean;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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
  resetLifecycleCoordinatorForTests();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function Harness({
  mode,
  saveRequest,
  onProbe,
}: {
  mode: DraftLifecycleMode;
  saveRequest: (draft: string) => Promise<void>;
  onProbe: (probe: Probe) => void;
}): null {
  const initial = mode === "edit" ? "saved" : "";
  const [draft, setDraft] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [open, setOpen] = useState(true);
  const controller = useDraftLifecycleController({
    ownerId: `test-${mode}`,
    label: `${mode} test draft`,
    mode,
    enabled: open,
    dirty: draft !== baseline,
    save: async () => {
      await saveRequest(draft);
      setBaseline(draft);
      return true;
    },
    discard: () => setDraft(baseline),
    close: () => setOpen(false),
    detail: "Unsaved test draft.",
  });
  onProbe({ controller, setDraft, draft, open });
  return null;
}

describe("draft lifecycle controller", () => {
  it("keeps create drafts discard-only and requires explicit local discard", async () => {
    let probe!: Probe;
    const saveRequest = vi.fn().mockResolvedValue(undefined);
    render(
      <Harness
        mode="create"
        saveRequest={saveRequest}
        onProbe={(value) => {
          probe = value;
        }}
      />,
    );
    act(() => probe.setDraft("new resource"));

    await act(async () => prepareLifecycle(quitIntent));
    expect(saveRequest).not.toHaveBeenCalled();
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { canSave: false, canDiscard: true },
    ]);

    act(() => probe.controller.requestClose());
    expect(probe.open).toBe(true);
    expect(probe.controller.discardConfirmOpen).toBe(true);
    act(() => probe.controller.discardAndClose());
    expect(probe.open).toBe(false);
    expect(probe.draft).toBe("");
  });

  it("prepares acknowledged edits through the exact save callback", async () => {
    let probe!: Probe;
    const saveRequest = vi.fn().mockResolvedValue(undefined);
    render(
      <Harness
        mode="edit"
        saveRequest={saveRequest}
        onProbe={(value) => {
          probe = value;
        }}
      />,
    );
    act(() => probe.setDraft("changed"));

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { canSave: true, canDiscard: true },
    ]);
    await act(async () => prepareLifecycle(quitIntent));
    expect(saveRequest).toHaveBeenCalledTimes(1);
    expect(saveRequest).toHaveBeenCalledWith("changed");
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("single-flights same-tick submits and retains the operation after unmount", async () => {
    let probe!: Probe;
    const pending = deferred();
    const saveRequest = vi.fn(() => pending.promise);
    render(
      <Harness
        mode="edit"
        saveRequest={saveRequest}
        onProbe={(value) => {
          probe = value;
        }}
      />,
    );
    act(() => probe.setDraft("changed"));

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = probe.controller.submit();
      second = probe.controller.submit();
    });
    expect(saveRequest).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
    root = null;
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "blocking", canSave: false, canDiscard: false },
    ]);

    pending.resolve();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    await flush();
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("retains a failed edit for retry", async () => {
    let probe!: Probe;
    const saveRequest = vi.fn().mockRejectedValue(new Error("offline"));
    render(
      <Harness
        mode="edit"
        saveRequest={saveRequest}
        onProbe={(value) => {
          probe = value;
        }}
      />,
    );
    act(() => probe.setDraft("retry me"));
    await act(async () => {
      await probe.controller.submit();
    });
    expect(probe.draft).toBe("retry me");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { canSave: true, canDiscard: true },
    ]);
  });
});
