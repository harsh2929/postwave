// @vitest-environment happy-dom

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  useDiscardOnlyDraftLifecycle,
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  discardAndRecheckLifecycleTransition,
  getLifecycleDecisionState,
  inspectLifecycle,
  prepareLifecycle,
  requestLifecycleTransition,
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

interface HarnessProbe {
  setDraft: (value: string) => void;
  start: (operation: () => Promise<void>) => Promise<void>;
  draft: string;
  baseline: string;
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
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function ExistingHarness({
  ownerId,
  onProbe,
  saveRequest,
}: {
  ownerId: string;
  onProbe: (probe: HarnessProbe) => void;
  saveRequest: (draft: string) => Promise<void>;
}): null {
  const [draft, setDraft] = useState("saved");
  const [baseline, setBaseline] = useState("saved");
  const operation = useSingleFlightOperation({
    ownerId,
    label: `Operation ${ownerId}`,
  });

  const save = async (): Promise<boolean> => {
    const pending = operation.promiseRef.current;
    if (pending) {
      return (await pending) === true;
    }
    const value = draft;
    const request = operation.run(async (): Promise<boolean> => {
      try {
        await saveRequest(value);
        setBaseline(value);
        return true;
      } catch {
        // Production owners surface the failure while retaining the draft.
        return false;
      }
    });
    return request ? await request : false;
  };

  const discard = (): void => setDraft(baseline);
  useExistingSettingLifecycle({
    ownerId,
    label: `Existing ${ownerId}`,
    dirty: draft !== baseline,
    operationRef: operation.promiseRef,
    save,
    discard,
  });

  onProbe({
    setDraft,
    draft,
    baseline,
    start: async (work) => {
      const request = operation.run(work);
      if (request) await request;
      else await operation.wait();
    },
  });
  return null;
}

function DiscardHarness({
  ownerId,
  onProbe,
  onSubmit,
}: {
  ownerId: string;
  onProbe: (probe: HarnessProbe) => void;
  onSubmit: () => void;
}): null {
  const [draft, setDraft] = useState("");
  const operation = useSingleFlightOperation({
    ownerId,
    label: `Action ${ownerId} operation`,
  });
  const discard = (): void => setDraft("");
  useDiscardOnlyDraftLifecycle({
    ownerId,
    label: `Action ${ownerId}`,
    dirty: draft.length > 0,
    operationRef: operation.promiseRef,
    discard,
  });
  onProbe({
    setDraft,
    draft,
    baseline: "",
    start: async (work) => {
      onSubmit();
      const request = operation.run(work);
      if (request) await request;
      else await operation.wait();
    },
  });
  return null;
}

describe("settings draft lifecycle hooks", () => {
  it("permits hide and exposes acknowledged-baseline save plus discard", async () => {
    let probe!: HarnessProbe;
    const saveRequest = vi.fn().mockResolvedValue(undefined);
    render(
      <ExistingHarness
        ownerId="retention"
        onProbe={(value) => {
          probe = value;
        }}
        saveRequest={saveRequest}
      />,
    );
    act(() => probe.setDraft("changed"));

    await expect(inspectLifecycle(hideIntent)).resolves.toEqual([]);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Existing retention",
        level: "warning",
        canSave: true,
        canDiscard: true,
      },
    ]);

    await act(async () => prepareLifecycle(quitIntent));
    expect(saveRequest).toHaveBeenCalledWith("changed");
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("awaits the exact save promise and retains a failed draft for retry", async () => {
    let probe!: HarnessProbe;
    const pending = deferred();
    const saveRequest = vi
      .fn<(_: string) => Promise<void>>()
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error("offline"));
    render(
      <ExistingHarness
        ownerId="firewall"
        onProbe={(value) => {
          probe = value;
        }}
        saveRequest={saveRequest}
      />,
    );
    act(() => probe.setDraft("first"));
    const preparing = prepareLifecycle(quitIntent);
    await flush();
    expect(saveRequest).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "blocking", canSave: false, canDiscard: false },
    ]);
    pending.resolve();
    await act(async () => preparing);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);

    act(() => probe.setDraft("retryable"));
    await act(async () => prepareLifecycle(quitIntent));
    expect(saveRequest).toHaveBeenCalledTimes(2);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "warning", canSave: true, canDiscard: true },
    ]);
  });

  it("never auto-submits an action draft and discards it only by decision", async () => {
    let probe!: HarnessProbe;
    const onSubmit = vi.fn();
    const proceeded = vi.fn();
    render(
      <DiscardHarness
        ownerId="export"
        onProbe={(value) => {
          probe = value;
        }}
        onSubmit={onSubmit}
      />,
    );
    act(() => probe.setDraft("subscribers,campaigns"));

    await act(async () => prepareLifecycle(quitIntent));
    expect(onSubmit).not.toHaveBeenCalled();
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { canSave: false, canDiscard: true },
    ]);

    const transition = requestLifecycleTransition(quitIntent, proceeded);
    await waitFor(() => expect(getLifecycleDecisionState().phase).toBe("review"));
    await act(async () => discardAndRecheckLifecycleTransition());
    await expect(transition).resolves.toBe("proceeded");
    expect(proceeded).toHaveBeenCalledTimes(1);
    expect(probe.draft).toBe("");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("gives two mounted copies instance-safe identities without collisions", async () => {
    const probes: HarnessProbe[] = [];
    const saveRequest = vi.fn().mockResolvedValue(undefined);
    render(
      <>
        <ExistingHarness
          ownerId="same-resource"
          onProbe={(value) => {
            probes[0] = value;
          }}
          saveRequest={saveRequest}
        />
        <ExistingHarness
          ownerId="same-resource"
          onProbe={(value) => {
            probes[1] = value;
          }}
          saveRequest={saveRequest}
        />
      </>,
    );
    act(() => {
      probes[0]!.setDraft("one");
      probes[1]!.setDraft("two");
    });

    const concerns = await inspectLifecycle(quitIntent);
    expect(concerns).toHaveLength(2);
    expect(new Set(concerns.map((concern) => concern.guardId)).size).toBe(2);
    expect(concerns).not.toContainEqual(
      expect.objectContaining({ label: "Conflicting lifecycle safety owners" }),
    );
  });

  it("single-flights in the first tick and lets the exact work finish after unmount", async () => {
    let probe!: HarnessProbe;
    const pending = deferred();
    const work = vi.fn(() => pending.promise);
    render(
      <ExistingHarness
        ownerId="operation"
        onProbe={(value) => {
          probe = value;
        }}
        saveRequest={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = probe.start(work);
      second = probe.start(work);
    });
    expect(work).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "blocking", canSave: false, canDiscard: false },
    ]);

    act(() => root?.unmount());
    root = null;
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Operation operation",
        level: "blocking",
        canSave: false,
        canDiscard: false,
      },
    ]);
    pending.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(work).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });
});
