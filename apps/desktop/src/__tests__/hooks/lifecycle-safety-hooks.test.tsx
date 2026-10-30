// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { useBlockingLifecycleOperation } from "../../hooks/useBlockingLifecycleOperation";
import {
  type ShownOnceSecretLifecycle,
  useShownOnceSecretLifecycle,
} from "../../hooks/useShownOnceSecretLifecycle";
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function SecretHarness({ active }: { active: boolean }): null {
  useShownOnceSecretLifecycle("test-secret", "Shown-once secret", active);
  return null;
}

function SecretControllerHarness({
  onProbe,
}: {
  onProbe: (controller: ShownOnceSecretLifecycle) => void;
}): null {
  onProbe(
    useShownOnceSecretLifecycle(
      "shared-secret",
      "Shared shown-once secret",
      false,
    ),
  );
  return null;
}

function OperationHarness({ active }: { active: boolean }): null {
  useBlockingLifecycleOperation(
    "test-operation",
    "Sensitive operation",
    active,
  );
  return null;
}

describe("sensitive lifecycle hooks", () => {
  it("blocks destructive transitions but permits hiding a shown-once value", async () => {
    render(<SecretHarness active />);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Shown-once secret",
        level: "blocking",
        canSave: false,
        canDiscard: false,
      },
    ]);
    await expect(
      inspectLifecycle({
        ...quitIntent,
        kind: "close-window",
        disposition: "hide",
      }),
    ).resolves.toEqual([]);

    act(() => root?.render(<SecretHarness active={false} />));
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("waits for an in-flight operation without inventing save or discard", async () => {
    render(<OperationHarness active />);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Sensitive operation",
        level: "blocking",
        canSave: false,
        canDiscard: false,
        canRecover: false,
      },
    ]);

    act(() => root?.render(<OperationHarness active={false} />));
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("acquires and resolves synchronously with collision-free mounted identities", async () => {
    const probes: ShownOnceSecretLifecycle[] = [];
    render(
      <>
        <SecretControllerHarness
          onProbe={(controller) => {
            probes[0] = controller;
          }}
        />
        <SecretControllerHarness
          onProbe={(controller) => {
            probes[1] = controller;
          }}
        />
      </>,
    );

    act(() => {
      probes[0]!.activate();
      probes[1]!.activate();
    });
    const concerns = await inspectLifecycle(quitIntent);
    expect(concerns).toHaveLength(2);
    expect(new Set(concerns.map((concern) => concern.guardId)).size).toBe(2);
    expect(concerns).not.toContainEqual(
      expect.objectContaining({ label: "Conflicting lifecycle safety owners" }),
    );

    act(() => probes[0]!.resolve());
    await expect(inspectLifecycle(quitIntent)).resolves.toHaveLength(1);
    act(() => probes[1]!.resolve());
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });
});
