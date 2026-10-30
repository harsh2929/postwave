// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { CampaignReply } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  classify: vi.fn(),
  list: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listCampaignReplies: mocks.list,
    classifyCampaignReply: mocks.classify,
  },
}));
vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));

import { CampaignRepliesSection } from "../../components/CampaignRepliesSection";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let setRepliesAdmin: (value: boolean) => void;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.classify.mockReset();
  mocks.list.mockReset();
  mocks.toastError.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function reply(
  id: number,
  overrides: Partial<CampaignReply> = {},
): CampaignReply {
  return {
    id: String(id),
    from_email: `reader-${id}@example.com`,
    subject: `Reader subject ${id}`,
    body_text: `Reply body ${id}`,
    received_at: "2026-07-16T10:00:00Z",
    body_redacted: false,
    ...overrides,
  };
}

function listing(
  replies: CampaignReply[],
  intentCounts: Record<string, number> = { question: 1 },
) {
  return {
    data: {
      campaign_id: "campaign-1",
      count: replies.length,
      intent_counts: intentCounts,
      replies,
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function render(node: ReactElement): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await act(async () => Promise.resolve());
    }
  }
  throw failure;
}

describe("CampaignRepliesSection interactions", () => {
  it("never fetches or displays raw reply PII for a non-admin", () => {
    render(
      <CampaignRepliesSection
        campaignId="campaign-1"
        canAdmin={false}
        canMutate={false}
      />,
    );

    expect(mocks.list).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Reply content is restricted");
    expect(document.body.textContent).toContain("only workspace admins");
    expect(document.body.textContent).not.toContain("reader-1@example.com");
  });

  it("removes loaded reply PII immediately when admin authority is revoked", async () => {
    mocks.list.mockResolvedValue(
      listing([reply(1, { body_text: "Private reply body" })]),
    );
    render(<RepliesAuthorityHarness />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Private reply body"),
    );

    act(() => setRepliesAdmin(false));

    expect(document.body.textContent).not.toContain("Private reply body");
    expect(document.body.textContent).not.toContain("reader-1@example.com");
    expect(document.body.textContent).toContain("Reply content is restricted");
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("keeps reply browsing available to admins but natively locks classification without write access", async () => {
    mocks.list.mockResolvedValue(listing([reply(1)]));
    render(
      <CampaignRepliesSection
        campaignId="campaign-1"
        canAdmin
        canMutate={false}
      />,
    );
    await waitFor(() => expect(button("Classify")).toBeTruthy());

    expect(button("Classify").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Reply classification is read-only",
    );
    button("Classify").click();
    expect(mocks.classify).not.toHaveBeenCalled();
  });

  it("contains thrown loads, coalesces retry, and renders visible row detail", async () => {
    mocks.list.mockImplementationOnce(() => {
      throw new Error("reply service offline");
    });
    render(
      <CampaignRepliesSection campaignId="campaign-1" canAdmin canMutate />,
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Reply list unavailable: reply service offline",
      ),
    );

    const pending = deferred<ReturnType<typeof listing>>();
    mocks.list.mockReturnValue(pending.promise);
    const retry = button("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    pending.resolve(
      listing([
        reply(1, {
          intent_label: "question",
          from_email: "a-very-long-reader-address@example.com",
        }),
      ]),
    );
    await act(async () => pending.promise);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "a-very-long-reader-address@example.com",
      ),
    );
    expect(document.body.textContent).toContain("Intent: question");
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-07-16T10:00:00Z",
    );
    expect(document.querySelector("[title]")).toBeNull();

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("preserves filter focus and semantics while a filtered request loads", async () => {
    mocks.list.mockResolvedValueOnce(
      listing([reply(1, { intent_label: "question" })]),
    );
    const filtered = deferred<ReturnType<typeof listing>>();
    mocks.list.mockReturnValue(filtered.promise);
    render(
      <CampaignRepliesSection campaignId="campaign-1" canAdmin canMutate />,
    );
    await waitFor(() => expect(button("question · 1")).toBeTruthy());

    const question = button("question · 1");
    question.focus();
    act(() => question.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Loading question replies…"),
    );
    expect(document.activeElement).toBe(question);
    expect(question.getAttribute("aria-pressed")).toBe("true");
    expect(mocks.list).toHaveBeenLastCalledWith("campaign-1", {
      intent: "question",
    });

    filtered.resolve(listing([], { question: 1 }));
    await act(async () => filtered.promise);
    await waitFor(() =>
      expect(document.body.textContent).toContain("No question replies."),
    );
  });

  it("single-flights classification and visibly recovers from a rejection", async () => {
    mocks.list.mockResolvedValue(
      listing([reply(1), reply(2)], { question: 1 }),
    );
    const pending = deferred<{ data: CampaignReply }>();
    mocks.classify.mockReturnValueOnce(pending.promise);
    render(
      <CampaignRepliesSection campaignId="campaign-1" canAdmin canMutate />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      Array.from(document.querySelectorAll("button")).filter(
        (candidate) => candidate.textContent === "Classify",
      ),
    ).toHaveLength(2);

    const classifyButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((candidate) => candidate.textContent === "Classify");
    act(() => {
      classifyButtons[0]?.click();
      classifyButtons[0]?.click();
      classifyButtons[1]?.click();
    });
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    expect(classifyButtons[1]?.disabled).toBe(true);
    await act(async () => {
      pending.resolve({ data: reply(1, { intent_label: "question" }) });
      await pending.promise;
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Intent: question");

    const rejected = deferred<{ data: CampaignReply }>();
    mocks.classify.mockReturnValueOnce(rejected.promise);
    await act(async () => {
      button("Classify").click();
      rejected.reject(new Error("classifier unavailable"));
      try {
        await rejected.promise;
      } catch {
        // The component converts the rejection into visible recovery UI.
      }
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Couldn't classify the reply: classifier unavailable",
      ),
    );
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Couldn't classify reply",
      detail: "classifier unavailable",
    });
    expect(button("Classify").disabled).toBe(false);
  });

  it("drops an old campaign response after the campaign changes", async () => {
    const old = deferred<ReturnType<typeof listing>>();
    mocks.list
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(listing([reply(2, { subject: "New campaign" })]));
    render(<CampaignRepliesSection campaignId="old" canAdmin canMutate />);
    render(<CampaignRepliesSection campaignId="new" canAdmin canMutate />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("New campaign"),
    );
    old.resolve(listing([reply(1, { subject: "Stale campaign" })]));
    await act(async () => old.promise);
    expect(document.body.textContent).not.toContain("Stale campaign");
  });
});

function RepliesAuthorityHarness(): ReactElement {
  const [canAdmin, setCanAdmin] = useState(true);
  setRepliesAdmin = setCanAdmin;
  return (
    <CampaignRepliesSection
      campaignId="campaign-1"
      canAdmin={canAdmin}
      canMutate
    />
  );
}
