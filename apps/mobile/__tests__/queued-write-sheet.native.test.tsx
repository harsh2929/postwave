/**
 * QueuedWriteSheet — edit a queued write's body before it retries (parity
 * register, shell-crosscutting "offline outbox depth"). What is pinned is what
 * makes an in-place edit on a phone safe rather than a typo machine:
 *
 *  1. A FLAT BODY EDITS PER FIELD AND KEEPS EACH FIELD'S TYPE: a number typed
 *     as text goes back as a number, a boolean stays a boolean, and the body
 *     handed to the re-issue is exactly the rebuilt object.
 *  2. A NUMBER THAT NO LONGER PARSES IS NAMED, and nothing is re-issued.
 *  3. A BODY THAT WOULD ONLY BE QUARANTINED AT REPLAY IS REFUSED HERE, with
 *     the online-only reason, while the person can still fix it.
 *  4. A SEQUENCE SAVE IS SHOWN, NEVER EDITED (the builder owns the steps);
 *     retry and discard stay available.
 *
 * The re-issue seam is injected: the sheet is a form over lib/queuedBodyEditor
 * and lib/queuedWriteDetail, both node-tested against a real QueryClient.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import {
  QueuedWriteSheet,
  SEQUENCE_SAVE_NOTE,
} from "@/components/diagnostics/QueuedWriteSheet";
import type { QueuedWriteReissue } from "@/hooks/useQueuedWriteDetails";
import type { QueuedWriteDetail } from "@/lib/queuedWriteDetail";

function detailOf(overrides: Partial<QueuedWriteDetail> = {}): QueuedWriteDetail {
  return {
    mutationId: 1,
    operationId: "operation-00000001",
    kind: "entity_write",
    label: "Rename segment",
    status: "failed",
    method: "PATCH",
    path: "/api/v1/segments/12",
    body: { name: "VIP", weight: 2, pii: false },
    failure: { status: 500, code: null, message: "boom" },
    editable: true,
    variables: {},
    ...overrides,
  };
}

const reissued: unknown[] = [];
const retried: unknown[] = [];
const discarded: unknown[] = [];
const closed: number[] = [];

const onReissue = (detail: QueuedWriteDetail, body: unknown): QueuedWriteReissue => {
  reissued.push({ path: detail.path, body });
  return { ok: true, reissued: { mutationId: 2, settled: Promise.resolve("sent") } };
};
const onRetry = (detail: QueuedWriteDetail): QueuedWriteReissue => {
  retried.push(detail.operationId);
  return { ok: true, reissued: { mutationId: 3, settled: Promise.resolve("sent") } };
};
const onDiscard = (detail: QueuedWriteDetail) => {
  discarded.push(detail.operationId);
};
const onClose = () => {
  closed.push(1);
};

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ConfirmProvider>{children}</ConfirmProvider>
    </SafeAreaProvider>
  );
}

/**
 * `render` RESOLVES A PROMISE in this RNTL/React pair — the module-level
 * `screen` is only bound once it settles. Awaiting it is not a style choice:
 * without the await every `screen.*` call throws "render function has not
 * been called" and the whole file fails before it asserts anything.
 */
async function renderSheet(detail: QueuedWriteDetail, startEditing = false) {
  await render(
    <QueuedWriteSheet
      visible
      detail={detail}
      startEditing={startEditing}
      onClose={onClose}
      onReissue={onReissue}
      onRetry={onRetry}
      onDiscard={onDiscard}
    />,
    { wrapper },
  );
}

afterEach(() => {
  reissued.length = 0;
  retried.length = 0;
  discarded.length = 0;
  closed.length = 0;
});

describe("QueuedWriteSheet", () => {
  it("shows the request as it will be sent, with the failure verbatim", async () => {
    await renderSheet(
      detailOf({
        path: "/api/v1/forms/9",
        body: { slug: "x" },
        failure: { status: 409, code: "slug_taken", message: "slug is taken" },
      }),
    );
    expect(screen.getByText("PATCH /api/v1/forms/9")).toBeTruthy();
    expect(screen.getByText("HTTP 409 · slug_taken · slug is taken")).toBeTruthy();
    expect(screen.getByText("slug: x")).toBeTruthy();
    expect(screen.getByLabelText("Edit")).toBeTruthy();
  });

  it("edits a flat body per field and hands back each field with its original type", async () => {
    await renderSheet(detailOf(), true);
    await fireEvent.changeText(screen.getByLabelText("name"), "VIP customers");
    await fireEvent.changeText(screen.getByLabelText("weight"), " 3 ");
    await fireEvent.press(screen.getByLabelText("Save and retry"));
    expect(reissued).toEqual([
      { path: "/api/v1/segments/12", body: { name: "VIP customers", weight: 3, pii: false } },
    ]);
    expect(closed).toHaveLength(1);
  });

  it("names the field whose number no longer parses and re-issues nothing", async () => {
    await renderSheet(detailOf(), true);
    await fireEvent.changeText(screen.getByLabelText("weight"), "heavy");
    await fireEvent.press(screen.getByLabelText("Save and retry"));
    expect(screen.getByText('"weight" must be a number (got "heavy").')).toBeTruthy();
    expect(reissued).toEqual([]);
    expect(closed).toEqual([]);
  });

  it("refuses an edit that turns the write into an online-only action, then accepts a safe one", async () => {
    // A nested body has no per-field form, so it edits as raw JSON.
    await renderSheet(
      detailOf({
        path: "/api/v1/campaigns/c1",
        body: { subject: "Hi", tags: ["x"] },
      }),
      true,
    );
    const json = screen.getByLabelText("Body as JSON");
    await fireEvent.changeText(json, '{"status":"scheduled"}');
    await fireEvent.press(screen.getByLabelText("Save and retry"));
    expect(screen.getByText(/online-only/)).toBeTruthy();
    expect(reissued).toEqual([]);

    await fireEvent.changeText(json, '{"subject":"Hello"}');
    await fireEvent.press(screen.getByLabelText("Save and retry"));
    expect(reissued).toEqual([{ path: "/api/v1/campaigns/c1", body: { subject: "Hello" } }]);
  });

  it("never edits a sequence save, but still retries and discards it", async () => {
    await renderSheet(
      detailOf({
        kind: "sequence_save",
        label: "Sequence changes",
        path: "/api/v1/voice/sequences/s1",
        body: { steps: [] },
        editable: false,
      }),
      true,
    );
    expect(screen.getByText(SEQUENCE_SAVE_NOTE)).toBeTruthy();
    expect(screen.queryByLabelText("Edit")).toBeNull();
    expect(screen.queryByLabelText("Save and retry")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Retry now"));
    expect(retried).toEqual(["operation-00000001"]);
    await fireEvent.press(screen.getByLabelText("Discard"));
    expect(discarded).toEqual(["operation-00000001"]);
  });

  it("offers no verb at all for a write that is on the wire", async () => {
    await renderSheet(detailOf({ status: "syncing", failure: null }));
    expect(screen.queryByLabelText("Edit")).toBeNull();
    expect(screen.queryByLabelText("Retry now")).toBeNull();
    expect(screen.queryByLabelText("Discard")).toBeNull();
  });
});
