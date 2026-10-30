/**
 * ConflictSheet — resolving an offline sync conflict (parity register P2.56:
 * side-by-side "your version" vs the fetched server version, keep-mine,
 * keep-server, per-field merge).
 *
 * What is pinned here is the part a pure test of lib/offlineConflict cannot
 * reach: which REMEDY the sheet actually offers for each refusal, and what
 * body leaves the phone when the person picks one.
 *
 *  1. A PLAIN 409 READS THE SERVER COPY and shows both columns. "Keep mine"
 *     re-issues MY body — every field — after a confirm that says so.
 *  2. TURNING ONE FIELD OFF sends the server's value for that field and mine
 *     for the rest: the merge is never wider than the body I queued.
 *  3. A NAME COLLISION OFFERS NO KEEP-MINE AT ALL and routes to the editor,
 *     because a verbatim retry fails the same way; the server's own sentence
 *     is shown verbatim.
 *  4. A CAMPAIGN THAT STARTED SENDING is locked: no keep-mine, no edit, only
 *     the record and keep-server.
 *  5. OFFLINE NEVER FETCHES, says so, and still lets a winner be chosen.
 *
 * The record read is injected (`fetchCopy`) — api/queuedWriteConflict is a
 * one-line rawRequest wrapper, and injecting it keeps the wire out of a render
 * test without stubbing any of the decision logic.
 *
 * `render` resolves a promise in this RNTL/React pair, so every render is
 * awaited; without it `screen` is unbound and every query throws.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { router } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import {
  ConflictSheet,
  NO_READ_ROUTE_NOTE,
  OFFLINE_COPY_NOTE,
} from "@/components/diagnostics/ConflictSheet";
import type { AIApiResult } from "@/api/request";
import type { QueuedWriteReissue } from "@/hooks/useQueuedWriteDetails";
import type { QueuedWriteDetail } from "@/lib/queuedWriteDetail";

const hooks = require("@/hooks/useIsOnline") as {
  __setIsOnlineForTests: (value: boolean) => void;
  __resetOnlineGateForTests: () => void;
};

function detailOf(overrides: Partial<QueuedWriteDetail> = {}): QueuedWriteDetail {
  return {
    mutationId: 1,
    operationId: "operation-00000042",
    kind: "entity_write",
    label: "Rename form",
    status: "failed",
    method: "PATCH",
    path: "/api/v1/forms/9",
    body: { name: "Spring signup", slug: "spring" },
    failure: { status: 409, code: null, message: "conflict" },
    editable: true,
    variables: {},
    ...overrides,
  };
}

const keptMine: unknown[] = [];
const keptServer: string[] = [];
const edited: string[] = [];
const closed: number[] = [];
const fetched: string[] = [];

let serverCopy: AIApiResult<unknown> = {
  data: { name: "Spring sign-up 2026", slug: "spring" },
  error: null,
};

const onKeepMine = (
  detail: QueuedWriteDetail,
  body: unknown,
): QueuedWriteReissue => {
  keptMine.push({ path: detail.path, body });
  return { ok: true, reissued: { mutationId: 2, settled: Promise.resolve("sent") } };
};

async function fetchCopy(path: string): Promise<AIApiResult<unknown>> {
  fetched.push(path);
  return serverCopy;
}

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

async function renderSheet(detail: QueuedWriteDetail) {
  await render(
    <ConflictSheet
      visible
      detail={detail}
      onClose={() => {
        closed.push(1);
      }}
      onKeepMine={onKeepMine}
      onKeepServer={(item) => {
        keptServer.push(item.operationId);
      }}
      onEdit={(item) => {
        edited.push(item.operationId);
      }}
      fetchCopy={fetchCopy}
    />,
    { wrapper },
  );
}

afterEach(() => {
  keptMine.length = 0;
  keptServer.length = 0;
  edited.length = 0;
  closed.length = 0;
  fetched.length = 0;
  serverCopy = {
    data: { name: "Spring sign-up 2026", slug: "spring" },
    error: null,
  };
  hooks.__resetOnlineGateForTests();
  (router.push as ReturnType<typeof jest.fn>).mockClear();
});

describe("ConflictSheet", () => {
  it("puts the fetched server version beside mine and keeps every field on request", async () => {
    await renderSheet(detailOf());
    // Read once, from the queued write's OWN path — never a guessed one.
    expect(await screen.findByText("Mine: Spring signup")).toBeTruthy();
    expect(fetched).toEqual(["/api/v1/forms/9"]);
    expect(screen.getByText("Server: Spring sign-up 2026")).toBeTruthy();
    // A field that did not move still gets a row, marked as unchanged.
    expect(screen.getByText("slug · same")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Keep mine"));
    // The consequence is stated before anything is sent.
    expect(
      screen.getByText("This replaces the server's copy of 2 fields."),
    ).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Replace server fields"));
    expect(keptMine).toEqual([
      {
        path: "/api/v1/forms/9",
        body: { name: "Spring signup", slug: "spring" },
      },
    ]);
  });

  it("sends the server's value for a field I hand back, and mine for the rest", async () => {
    await renderSheet(detailOf());
    await screen.findByText("Mine: Spring signup");

    await fireEvent.press(screen.getByLabelText("Keep my name"));
    // The verb changes with the meaning: this is no longer "keep mine".
    await fireEvent.press(screen.getByLabelText("Send selection"));
    await fireEvent.press(screen.getByLabelText("Send these fields"));
    expect(keptMine).toEqual([
      {
        path: "/api/v1/forms/9",
        // name took the server's value; slug stayed mine.
        body: { name: "Spring sign-up 2026", slug: "spring" },
      },
    ]);
  });

  it("refuses keep-mine for a name collision and routes to the editor, quoting the server", async () => {
    await renderSheet(
      detailOf({
        failure: { status: 409, code: "slug_taken", message: "slug is already taken" },
      }),
    );
    expect(screen.getByText("slug is already taken")).toBeTruthy();
    expect(screen.queryByLabelText("Keep mine")).toBeNull();
    // No comparison table either — the remedy is a different value, not a winner.
    expect(screen.queryByText("Mine: Spring signup")).toBeNull();
    expect(fetched).toEqual([]);

    await fireEvent.press(screen.getByLabelText("Edit instead"));
    expect(edited).toEqual(["operation-00000042"]);
  });

  it("locks a campaign that started sending: no keep-mine, no edit, the record instead", async () => {
    await renderSheet(
      detailOf({
        label: "Campaign subject",
        path: "/api/v1/campaigns/c-1",
        kind: "campaign_update",
        body: { subject: "Hello" },
        failure: {
          status: 409,
          code: "campaign_dispatching",
          message: "campaign is dispatching",
        },
      }),
    );
    expect(screen.queryByLabelText("Keep mine")).toBeNull();
    expect(screen.queryByLabelText("Edit instead")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Open the record"));
    expect(router.push).toHaveBeenCalledWith("/(tabs)/campaigns/c-1");

    await fireEvent.press(screen.getByLabelText("Keep server"));
    expect(keptServer).toEqual(["operation-00000042"]);
  });

  it("never reaches for the server copy while offline, and says why", async () => {
    hooks.__setIsOnlineForTests(false);
    await renderSheet(detailOf());
    expect(screen.getByText(OFFLINE_COPY_NOTE)).toBeTruthy();
    expect(fetched).toEqual([]);
    // Mine is still shown and still sendable — it just queues.
    expect(screen.getByText("Mine: Spring signup")).toBeTruthy();
    // Both columns are still drawn; the server side is honest about being unread.
    expect(screen.getAllByText("Server: (unavailable)")).toHaveLength(2);
    await fireEvent.press(screen.getByLabelText("Keep mine"));
    await fireEvent.press(screen.getByLabelText("Replace server fields"));
    expect(keptMine).toEqual([
      {
        path: "/api/v1/forms/9",
        body: { name: "Spring signup", slug: "spring" },
      },
    ]);
  });

  it("says so when the entity has no single-record read route, rather than GETting a 404", async () => {
    await renderSheet(
      detailOf({
        label: "Rename tag",
        path: "/api/v1/tags/12",
        body: { name: "VIP" },
      }),
    );
    expect(screen.getByText(NO_READ_ROUTE_NOTE)).toBeTruthy();
    expect(fetched).toEqual([]);
  });

  it("shows the read failure instead of an empty server column", async () => {
    serverCopy = {
      data: null,
      error: { status: 500, message: "upstream unavailable" },
    };
    await renderSheet(detailOf());
    expect(await screen.findByText("upstream unavailable")).toBeTruthy();
    expect(screen.getAllByText("Server: (unavailable)")).toHaveLength(2);
  });
});
