// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubscribersHeader } from "@/app/(dashboard)/app/subscribers/subscribers-header";

const dynamicState = vi.hoisted(() => ({
  nextBoundary: 0,
  mounted: [0, 0],
  props: [null, null] as Array<Record<string, unknown> | null>,
}));

vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: () => {
      const boundary = dynamicState.nextBoundary++;
      return function DeferredDialogBoundary(
        props: Record<string, unknown>,
      ): JSX.Element {
        React.useEffect(() => {
          dynamicState.mounted[boundary] += 1;
          return () => {
            dynamicState.mounted[boundary] -= 1;
          };
        }, []);
        React.useEffect(() => {
          dynamicState.props[boundary] = props;
        }, [props]);
        return <span data-deferred-subscriber-dialog={boundary} />;
      };
    },
  };
});

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const onCreated = vi.fn();

function HeaderHarness() {
  const [open, setOpen] = useState(false);
  return (
    <SubscribersHeader
      total={12}
      open={open}
      onOpenChange={setOpen}
      onCreated={onCreated}
      onExport={vi.fn()}
      exporting={false}
      onPaste={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

beforeEach(() => {
  dynamicState.mounted.fill(0);
  dynamicState.props.fill(null);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("subscriber header deferred dialogs", () => {
  it("mounts each form only after its named trigger and restores trigger focus", async () => {
    await act(async () => {
      root?.render(createElement(HeaderHarness));
      await Promise.resolve();
    });

    // Boundary 0 is Create; boundary 1 is Paste. Neither implementation is
    // mounted while both dialogs are closed.
    expect(dynamicState.mounted).toEqual([0, 0]);

    const pasteTrigger = button("Paste emails");
    expect(pasteTrigger.getAttribute("aria-haspopup")).toBe("dialog");
    await act(async () => pasteTrigger.click());
    expect(dynamicState.mounted).toEqual([0, 1]);
    expect(dynamicState.props[1]?.open).toBe(true);
    await act(async () => {
      (dynamicState.props[1]?.onOpenChange as (open: boolean) => void)(false);
    });
    act(() => {
      (dynamicState.props[1]?.onCloseAutoFocus as () => void)();
    });
    expect(document.activeElement).toBe(pasteTrigger);

    const createTrigger = button("New subscriber");
    expect(createTrigger.getAttribute("aria-haspopup")).toBe("dialog");
    await act(async () => createTrigger.click());
    expect(dynamicState.mounted).toEqual([1, 1]);
    // Boundary 0 is AddSubscriberDialog (audience-19): the evidence-gated add
    // form, handed the header's write gate and the page's onCreated.
    expect(dynamicState.props[0]?.open).toBe(true);
    expect(dynamicState.props[0]?.canWrite).toBe(true);
    expect(dynamicState.props[0]?.onCreated).toBe(onCreated);
    expect(dynamicState.props[0]).not.toHaveProperty("draft");
    pasteTrigger.focus();
    // The add dialog is controlled with no Radix trigger, so the header owns
    // focus return: closing it lands focus back on "New subscriber".
    await act(async () => {
      (dynamicState.props[0]?.onOpenChange as (open: boolean) => void)(false);
    });
    expect(document.activeElement).toBe(createTrigger);
  });
});
