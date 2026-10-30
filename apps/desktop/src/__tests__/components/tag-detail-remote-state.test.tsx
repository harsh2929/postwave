// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
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

const mocks = vi.hoisted(() => ({
  listSubscribersWithTag: vi.fn(),
  tagMembership: vi.fn(),
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listSubscribersWithTag: mocks.listSubscribersWithTag,
    tagMembership: mocks.tagMembership,
    updateTag: mocks.updateTag,
    deleteTag: mocks.deleteTag,
  },
}));
vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));
vi.mock("../../hooks/useSlideoverBehavior", () => ({
  useSlideoverBehavior: () => undefined,
}));
vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopSectionResource: vi.fn(),
}));
vi.mock("../../lib/store", () => ({ setSection: vi.fn() }));
vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: () => () => undefined,
}));
vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: () => null,
}));
vi.mock("../../components/PendingSyncStatus", () => ({
  PendingSyncStatus: () => null,
}));

import { TagDetailSlideover } from "../../components/tags/TagDetailSlideover";
import { TagMembershipChart } from "../../components/tags/TagMembershipChart";

const TAG_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_TAG_ID = "22222222-2222-4222-8222-222222222222";
const SUBSCRIBER_ID = "33333333-3333-4333-8333-333333333333";

const tag = {
  id: TAG_ID,
  name: "customer",
  color: "slate",
  description: "Original description",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
  pii: false,
  version: 1,
  etag: `"tag:${TAG_ID}:v1"`,
};

const subscriber = {
  id: SUBSCRIBER_ID,
  email: "reader@example.test",
  status: "active",
  created_at: "2026-07-01T00:00:00Z",
};

function membership(tagId = tag.id, requestedWindowComplete = true) {
  return {
    tag_id: tagId,
    days: 30,
    current_count: 12,
    added: 3,
    removed: 1,
    daily: [{ date: "2026-07-01", net: 2 }],
    coverage: {
      contract_version: "canonical-join-events-v2",
      coverage_started_at: "2026-06-01T00:00:00Z",
      as_of: "2026-07-01T12:00:00Z",
      completeness: "complete_from_coverage_start",
      source: "subscriber_tags_event_ledger",
      requested_window_complete: requestedWindowComplete,
    },
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listSubscribersWithTag.mockResolvedValue({
    data: { tag: tag.name, items: [subscriber] },
  });
  mocks.tagMembership.mockImplementation((tagId: string) =>
    Promise.resolve({ data: membership(tagId) }),
  );
  mocks.updateTag.mockResolvedValue({ data: tag });
  mocks.deleteTag.mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
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

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function detail(onUpdated = vi.fn(), selectedTag = tag): ReactElement {
  return (
    <TagDetailSlideover
      tag={selectedTag}
      usage={{ tag: selectedTag.name, subscribers: 1, registered: true }}
      onClose={vi.fn()}
      onUpdated={onUpdated}
      onConflict={vi.fn()}
      usageAvailable
      canMutate
    />
  );
}

function setTextarea(value: string): HTMLTextAreaElement {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    ".tags-detail-slideover textarea",
  );
  if (!textarea) throw new Error("Missing tag description textarea");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

describe("tag detail remote-state validation", () => {
  it("shows an honest subscriber error and recovers without a false empty state", async () => {
    mocks.listSubscribersWithTag.mockResolvedValueOnce({
      data: { tag: tag.name, items: { invalid: true } },
    });
    render(detail());

    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll('[role="alert"]')).some((node) =>
          node.textContent?.includes(
            "Subscribers for this tag could not be verified",
          ),
        ),
      ).toBe(true);
    });
    expect(document.body.textContent).not.toContain(
      "No subscribers carry this tag yet",
    );

    act(() => button("Retry").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(subscriber.email);
      expect(document.body.textContent).not.toContain(
        "Subscribers for this tag could not be verified",
      );
    });
  });

  it("does not publish an unverified description update", async () => {
    mocks.updateTag.mockResolvedValueOnce({ data: { id: tag.id } });
    const onUpdated = vi.fn();
    render(detail(onUpdated));
    await waitFor(() =>
      expect(document.body.textContent).toContain(subscriber.email),
    );

    const textarea = setTextarea("Changed description");
    act(() => button("Save description").click());
    await waitFor(() => {
      expect(mocks.updateTag).toHaveBeenCalledWith(
        tag.id,
        {
          description: "Changed description",
        },
        tag.etag,
      );
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "The save response could not be verified.",
        }),
      );
    });
    expect(onUpdated).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Changed description");
  });

  it("renders only the latest subscriber request after the selected tag changes", async () => {
    let resolveFirst!: (value: {
      data: { tag: string; items: Array<typeof subscriber> };
    }) => void;
    const first = new Promise<{
      data: { tag: string; items: Array<typeof subscriber> };
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondTag = {
      ...tag,
      id: SECOND_TAG_ID,
      name: "prospect",
      etag: `"tag:${SECOND_TAG_ID}:v1"`,
    };
    const secondSubscriber = {
      ...subscriber,
      id: "44444444-4444-4444-8444-444444444444",
      email: "prospect@example.test",
    };
    mocks.listSubscribersWithTag
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({
        data: { tag: secondTag.name, items: [secondSubscriber] },
      });

    const view = render(detail(vi.fn(), tag));
    view.rerender(detail(vi.fn(), secondTag));
    await waitFor(() => {
      expect(document.body.textContent).toContain(secondSubscriber.email);
      expect(document.body.textContent).not.toContain(subscriber.email);
    });

    await act(async () => {
      resolveFirst({ data: { tag: tag.name, items: [subscriber] } });
      await first;
    });
    expect(document.body.textContent).toContain(secondSubscriber.email);
    expect(document.body.textContent).not.toContain(subscriber.email);
  });
});

describe("tag membership truthfulness", () => {
  it("renders exact requested-window metrics only with verified coverage", async () => {
    render(<TagMembershipChart tagId={tag.id} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Exact for the requested 30-day window",
      );
      expect(document.body.textContent).toContain("Joined");
      expect(document.body.textContent).toContain("3");
    });
    expect(mocks.tagMembership).toHaveBeenCalledWith(tag.id, 30);
  });

  it("labels partial requested windows without overstating totals", async () => {
    mocks.tagMembership.mockResolvedValueOnce({
      data: membership(tag.id, false),
    });
    render(<TagMembershipChart tagId={tag.id} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("earlier part");
      expect(document.body.textContent).toContain("Joined in covered period");
      expect(document.body.textContent).toContain("Left in covered period");
    });
  });

  it("fails closed on malformed or identity-mismatched coverage", async () => {
    mocks.tagMembership.mockResolvedValueOnce({
      data: { ...membership(SECOND_TAG_ID), current_count: 999_999 },
    });
    render(<TagMembershipChart tagId={tag.id} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Membership history could not be verified",
      );
    });
    expect(document.body.textContent).not.toContain("999,999");
  });
});
