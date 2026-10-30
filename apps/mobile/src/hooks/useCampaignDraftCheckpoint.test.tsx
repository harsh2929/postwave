/**
 * ECO-03 as the campaign screen actually assembles it: the real hook, the real
 * client, the real merge/veto policy, and a mocked transport.
 *
 * The scenario is the one the server package's own header describes — "open
 * the campaign on your phone and the half-written subject line from your
 * laptop is not there." These assert that it now IS there, that resuming it
 * fills the edit sheet rather than the record, and that the phone cannot
 * destroy the part of that draft it is unable to show.
 */
import { useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CampaignFieldsDraft } from "@/lib/campaignFields";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  appStateListener: null as ((next: string) => void) | null,
}));
const rawRequest = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (next: string) => void) => {
      state.appStateListener = listener;
      return { remove: () => (state.appStateListener = null) };
    },
  },
}));
vi.mock("@/api/request", () => ({
  rawRequest: (...args: unknown[]) => rawRequest(...args),
}));
vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: () => true }));

const { useCampaignDraftCheckpoint } = await import(
  "./useCampaignDraftCheckpoint"
);

const RECORD = {
  id: "cmp_1",
  subject: "Saved subject",
  preview_text: "Saved preview",
  from_name: "Ada",
  reply_to: "ada@example.com",
  updated_at: "2026-08-04T10:00:00Z",
};

/** What apps/web writes: the campaign PATCH body, body draft included. */
const LAPTOP_CHECKPOINT = {
  entity_key: "campaign",
  entity_id: "cmp_1",
  content: {
    subject: "Half a thought",
    preview_text: "Saved preview",
    from_name: "Ada",
    reply_to: "ada@example.com",
    body_html: "<p>three paragraphs typed on the laptop</p>",
  },
  version: 4,
  updated_at: "2026-08-04T10:05:00Z",
};

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let held: unknown;
let renderer: TestRenderer.ReactTestRenderer | undefined;
let latest: ReturnType<typeof useCampaignDraftCheckpoint> | undefined;
const opened: number[] = [];

const puts = () => calls.filter((c) => c.method === "PUT");
const deletes = () => calls.filter((c) => c.method === "DELETE");

function Probe({ draft }: { draft: CampaignFieldsDraft | null }) {
  latest = useCampaignDraftCheckpoint({
    campaign: RECORD,
    campaignId: RECORD.id,
    canEdit: true,
    onOpenEditor: () => opened.push(1),
  });
  // Stands in for CampaignSubjectModal, which reports its draft up on every
  // change and null the moment it holds nothing unsaved.
  const report = latest.onDraftChange;
  useEffect(() => {
    report(draft);
  }, [draft, report]);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  opened.length = 0;
  latest = undefined;
  renderer = undefined;
  held = null;
  rawRequest.mockImplementation(
    async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (method === "GET") {
        return {
          data: held ? { found: true, checkpoint: held } : { found: false },
          error: null,
        };
      }
      if (method === "DELETE") {
        held = null;
        return { data: { discarded: true }, error: null };
      }
      const sent = body as { content: unknown; version: number };
      held = {
        entity_key: "campaign",
        entity_id: "cmp_1",
        content: sent.content,
        version: sent.version + 1,
        updated_at: "2026-08-04T10:10:00Z",
      };
      return { data: held, error: null };
    },
  );
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function mount(draft: CampaignFieldsDraft | null) {
  await act(async () => {
    renderer = TestRenderer.create(<Probe draft={draft} />);
  });
}

async function update(draft: CampaignFieldsDraft | null) {
  await act(async () => {
    renderer?.update(<Probe draft={draft} />);
  });
}

async function tick(ms = 2_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const typed = (over: Partial<CampaignFieldsDraft> = {}): CampaignFieldsDraft => ({
  subject: "Saved subject",
  previewText: "Saved preview",
  fromName: "Ada",
  replyTo: "ada@example.com",
  ...over,
});

describe("the half-written subject line from the laptop", () => {
  it("is there when the campaign is opened on the phone", async () => {
    held = LAPTOP_CHECKPOINT;
    await mount(null);
    expect(latest?.state.offer?.content).toMatchObject({
      subject: "Half a thought",
    });
    // Offered, not applied: the sheet has not been opened and holds nothing.
    expect(opened).toEqual([]);
    expect(latest?.seed).toBeUndefined();
  });

  it("fills the edit sheet only when the person resumes it", async () => {
    held = LAPTOP_CHECKPOINT;
    await mount(null);
    await act(async () => latest?.state.resume());
    expect(opened).toEqual([1]);
    expect(latest?.seed).toEqual({
      subject: "Half a thought",
      previewText: "Saved preview",
      fromName: "Ada",
      replyTo: "ada@example.com",
    });
  });

  it("is written in the vocabulary the web editor restores from", async () => {
    await mount(null);
    await update(typed({ subject: "Typed on the phone" }));
    await tick();
    expect(puts()[0]?.body).toEqual({
      version: 0,
      content: {
        subject: "Typed on the phone",
        preview_text: "Saved preview",
        from_name: "Ada",
        reply_to: "ada@example.com",
      },
    });
  });
});

describe("sharing one checkpoint with a surface that can edit more", () => {
  it("keeps the laptop's body when the phone edits the subject", async () => {
    held = LAPTOP_CHECKPOINT;
    await mount(null);
    await act(async () => latest?.state.resume());
    await update(typed({ subject: "Fixed on the phone" }));
    await tick();
    expect(puts()[0]?.body).toEqual({
      version: 4,
      content: {
        subject: "Fixed on the phone",
        preview_text: "Saved preview",
        from_name: "Ada",
        reply_to: "ada@example.com",
        body_html: "<p>three paragraphs typed on the laptop</p>",
      },
    });
  });

  it("will not delete a draft holding a body it cannot show", async () => {
    // Closing the four-field sheet is not a decision about the laptop's body.
    held = LAPTOP_CHECKPOINT;
    await mount(null);
    await act(async () => latest?.state.resume());
    await update(typed({ subject: "Fixed on the phone" }));
    await tick();
    await update(null);
    await tick(0);
    expect(deletes()).toEqual([]);
  });

  it("does delete a draft this surface wrote by itself", async () => {
    // Nothing is at stake: every field in it is one this sheet holds, and the
    // record now has them.
    await mount(null);
    await update(typed({ subject: "Typed on the phone" }));
    await tick();
    await update(null);
    await tick(0);
    expect(deletes()).toHaveLength(1);
  });
});

describe("being interrupted", () => {
  it("keeps a draft that is still inside the debounce window", async () => {
    await mount(null);
    await update(typed({ subject: "Mid-sen" }));
    await tick(300);
    expect(puts()).toHaveLength(0);
    await act(async () => {
      state.appStateListener?.("background");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.body).toMatchObject({
      content: { subject: "Mid-sen" },
    });
  });
});
