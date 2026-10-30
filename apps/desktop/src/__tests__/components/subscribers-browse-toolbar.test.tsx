// @vitest-environment happy-dom

import axe from "axe-core";
import {
  act,
  type ComponentProps,
  createRef,
  type ReactElement,
  useRef,
  useState,
} from "react";
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

import type { SavedSegment, Subscriber } from "../../lib/api-client";
import { ColumnPicker } from "../../components/subscribers/ColumnPicker";

vi.mock("../../components/subscribers/SubscriberAddModal", () => ({
  SubscriberCreateMutationRows: () => null,
}));

import {
  SUBSCRIBER_SORTABLE_COLUMNS,
  SubscribersBrowseToolbar,
  SubscribersTable,
} from "../../components/subscribers/SubscribersBrowsePanel";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function savedSegment(): SavedSegment {
  return {
    id: "segment-1",
    tenant_id: "tenant-1",
    name: "Recent readers",
    description: "",
    predicate_json: { filters: { status: "subscribed" } },
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    is_pinned: false,
    visibility_scope: "workspace",
  };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function emptyTableProps(
  overrides: Partial<ComponentProps<typeof SubscribersTable>> = {},
): ComponentProps<typeof SubscribersTable> {
  return {
    recentSearchScope: "scope-a",
    rows: [],
    setRows: vi.fn(),
    selectedRows: [],
    onClearSelection: vi.fn(),
    onBulkDone: vi.fn(),
    onOpenDedupeReview: vi.fn(),
    canMutate: false,
    canImport: false,
    error: null,
    listRef: createRef<HTMLDivElement>(),
    liveEligible: false,
    listScrolled: false,
    bufferedNew: [],
    onFlushBufferedNew: vi.fn(),
    gridTemplateColumns: "40px minmax(0, 1fr) 40px",
    visibleColumnKeys: ["email"],
    allPageSelected: false,
    onTogglePage: vi.fn(),
    pageRows: [],
    sortColumn: "email",
    sortOrder: "asc",
    onToggleSort: vi.fn(),
    onReload: vi.fn(),
    loading: false,
    query: "",
    filter: "all",
    showArchived: false,
    onQueryChange: vi.fn(),
    onResetView: vi.fn(),
    onOpenImport: vi.fn(),
    onOpenCreate: vi.fn(),
    selectedKeys: new Set<string>(),
    focusedRowIndex: -1,
    onFocusedRowChange: vi.fn(),
    subscriberKey: (subscriber) =>
      subscriber.id == null ? subscriber.email : String(subscriber.id),
    onSelectRow: vi.fn(),
    onRenameEmail: vi.fn(),
    onStatusChange: vi.fn(),
    onRemoveTag: vi.fn(),
    onAddTag: vi.fn(),
    onOpenSubscriber: vi.fn(),
    pager: {
      page: 1,
      totalPages: 2,
      hasPrev: false,
      hasNext: true,
      label: "Page 1 of 2 · 0 of 25",
      hasTotal: true,
    },
    onPreviousPage: vi.fn(),
    onNextPage: vi.fn(),
    ...overrides,
  };
}

function findButton(label: string): HTMLButtonElement {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function click(element: Element | null): void {
  expect(element).not.toBeNull();
  act(() => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function press(key: string): void {
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
  });
}

interface SavedToolbarHarnessProps {
  canMutate?: boolean;
  error?: string | null;
  loading?: boolean;
  onApply?: (segment: SavedSegment) => void;
  onRemove?: (segment: SavedSegment) => void;
  onRequestPreview?: (segmentId: string, force?: boolean) => void;
  onRetry?: () => void;
  onSave?: () => void;
}

function SavedToolbarHarness({
  canMutate = true,
  error = null,
  loading = false,
  onApply = vi.fn(),
  onRemove = vi.fn(),
  onRequestPreview = vi.fn(),
  onRetry = vi.fn(),
  onSave = vi.fn(),
}: SavedToolbarHarnessProps): ReactElement {
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const segment = savedSegment();
  return (
    <SubscribersBrowseToolbar
      searchRef={searchRef}
      query=""
      onQueryChange={vi.fn()}
      filter="all"
      matchTotal={100}
      onFilterChange={vi.fn()}
      showArchived={false}
      onToggleArchived={vi.fn()}
      savedSegments={[segment]}
      savedPreviews={{
        [segment.id]: {
          kind: "ok",
          preview: {
            id: segment.id,
            count: 12,
            workspace_total: 100,
            workspace_percentage: 12,
            generated_at: new Date().toISOString(),
          },
          invalidated: false,
        },
      }}
      savedDropdownOpen={open}
      savedSegmentsError={error}
      savedSegmentsLoading={loading}
      onToggleSavedDropdown={() => setOpen((current) => !current)}
      onApplySavedSegment={onApply}
      onRemoveSavedSegment={onRemove}
      onRequestSavedPreview={onRequestPreview}
      onRetrySavedSegments={onRetry}
      onOpenSaveCurrent={onSave}
      canMutate={canMutate}
      visibleColumnKeys={["email", "status"]}
      onVisibleColumnsChange={vi.fn()}
      loading={false}
      onReload={vi.fn()}
    />
  );
}

function DirectoryGridHarness({
  onOpen,
  onSelect,
}: {
  onOpen: (subscriber: Subscriber) => void;
  onSelect: (subscriber: Subscriber) => void;
}): ReactElement {
  const [focusedRowIndex, setFocusedRowIndex] = useState(-1);
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const subscribers: Subscriber[] = [
    {
      id: "subscriber-1",
      email: "alice@example.test",
      status: "enabled",
    },
    {
      id: "subscriber-2",
      email: "bob@example.test",
      status: "unconfirmed",
    },
  ];
  return (
    <>
      <span data-testid="focused-subscriber-key">{focusedRowKey}</span>
      <SubscribersTable
        {...emptyTableProps({
          rows: subscribers,
          pageRows: subscribers,
          focusedRowIndex,
          onFocusedRowChange: setFocusedRowIndex,
          focusedRowKey,
          onFocusedRowKeyChange: setFocusedRowKey,
          onSelectRow: (subscriber) => onSelect(subscriber),
          onOpenSubscriber: onOpen,
          pager: {
            page: 1,
            totalPages: 1,
            hasPrev: false,
            hasNext: false,
            label: "Page 1 of 1 · 2 of 2",
            hasTotal: true,
          },
        })}
      />
    </>
  );
}

function savedTrigger(): HTMLButtonElement {
  const trigger = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      'button[aria-haspopup="menu"]',
    ),
  ).find((candidate) => candidate.textContent?.includes("Saved segments"));
  expect(trigger).toBeDefined();
  return trigger!;
}

function ownedMenu(trigger: HTMLButtonElement): HTMLElement | null {
  const id = trigger.getAttribute("aria-controls");
  return id ? document.getElementById(id) : null;
}

describe("SubscribersBrowseToolbar", () => {
  it("keeps server-backed sort mappings explicit", () => {
    expect(SUBSCRIBER_SORTABLE_COLUMNS).toMatchObject({
      joined: "created_at",
      churn_score: "churn",
      full_name: "client",
    });
  });

  it("keeps empty selection and pagination boundaries focusable, explained, and inert", () => {
    const onTogglePage = vi.fn();
    const onPreviousPage = vi.fn();
    const onNextPage = vi.fn();
    render(
      <SubscribersTable
        {...emptyTableProps({
          onTogglePage,
          onPreviousPage,
          onNextPage,
        })}
      />,
    );

    const selectPage = document.querySelector<HTMLInputElement>(
      'input[aria-label="Select all on this page"]',
    );
    expect(selectPage).not.toBeNull();
    expect(selectPage?.disabled).toBe(false);
    expect(selectPage?.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(
        selectPage?.getAttribute("aria-describedby") ?? "",
      )?.textContent,
    ).toContain("No subscribers on this page");
    click(selectPage);
    expect(onTogglePage).not.toHaveBeenCalled();

    const previous = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Previous page"]',
    );
    const next = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Next page"]',
    );
    expect(previous?.disabled).toBe(false);
    expect(previous?.getAttribute("aria-disabled")).toBe("true");
    click(previous);
    expect(onPreviousPage).not.toHaveBeenCalled();
    click(next);
    expect(onNextPage).toHaveBeenCalledTimes(1);

    act(() => {
      root?.render(
        <SubscribersTable
          {...emptyTableProps({
            loading: true,
            onNextPage,
          })}
        />,
      );
    });
    const busyNext = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Next page"]',
    );
    expect(busyNext?.disabled).toBe(false);
    expect(busyNext?.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("Loading subscribers…");
    click(busyNext);
    expect(onNextPage).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a constrained no-match view from a truly empty workspace", () => {
    const onResetView = vi.fn();
    render(
      <SubscribersTable
        {...emptyTableProps({
          filter: "unconfirmed",
          showArchived: true,
          onResetView,
        })}
      />,
    );

    expect(document.body.textContent).toContain("No contacts match this view");
    expect(document.body.textContent).toContain("Status: Unconfirmed");
    expect(document.body.textContent).toContain("Archived contacts included");
    expect(document.body.textContent).not.toContain(
      "Build the audience that owns your inbox",
    );
    click(findButton("Reset view"));
    expect(onResetView).toHaveBeenCalledTimes(1);
  });

  it("renders honest active-filter counts and saved preview controls", () => {
    const onFilterChange = vi.fn();
    const onRemove = vi.fn();
    const segment = savedSegment();
    render(
      <SubscribersBrowseToolbar
        searchRef={createRef<HTMLInputElement>()}
        query="reader"
        onQueryChange={vi.fn()}
        filter="subscribed"
        matchTotal={1234}
        onFilterChange={onFilterChange}
        showArchived={false}
        onToggleArchived={vi.fn()}
        savedSegments={[segment]}
        savedPreviews={{
          [segment.id]: {
            kind: "ok",
            preview: {
              id: segment.id,
              count: 12,
              workspace_total: 100,
              workspace_percentage: 12,
              generated_at: new Date().toISOString(),
            },
            invalidated: false,
          },
        }}
        savedDropdownOpen
        onToggleSavedDropdown={vi.fn()}
        onApplySavedSegment={vi.fn()}
        onRemoveSavedSegment={onRemove}
        onOpenSaveCurrent={vi.fn()}
        canMutate
        visibleColumnKeys={["email", "status"]}
        onVisibleColumnsChange={vi.fn()}
        loading={false}
        onReload={vi.fn()}
      />,
    );

    expect(findButton("Subscribed (1,234)")).toBeTruthy();
    expect(findButton("All")).toBeTruthy();
    expect(document.body.textContent).toContain("12 matches");
    expect(document.body.textContent).toContain("12 of 100 subscribers");
    expect(document.body.textContent).toContain("12% of workspace");
    expect(document.body.textContent).not.toContain("reader@example.com");
    expect(document.querySelector("[title]")).toBeNull();

    act(() => findButton("All").click());
    expect(onFilterChange).toHaveBeenCalledWith("all");
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Delete Recent readers"]',
        )
        ?.click(),
    );
    expect(onRemove).toHaveBeenCalledWith(segment);
  });

  it("keeps the route-restored saved view visibly identified", () => {
    render(
      <SubscribersBrowseToolbar
        searchRef={createRef<HTMLInputElement>()}
        query=""
        onQueryChange={vi.fn()}
        filter="all"
        matchTotal={100}
        onFilterChange={vi.fn()}
        showArchived={false}
        onToggleArchived={vi.fn()}
        savedSegments={[savedSegment()]}
        activeSavedSegmentId="segment-1"
        savedPreviews={{}}
        savedDropdownOpen
        onToggleSavedDropdown={vi.fn()}
        onApplySavedSegment={vi.fn()}
        onRemoveSavedSegment={vi.fn()}
        onOpenSaveCurrent={vi.fn()}
        canMutate
        visibleColumnKeys={["email", "status"]}
        onVisibleColumnsChange={vi.fn()}
        loading={false}
        onReload={vi.fn()}
      />,
    );

    expect(
      document.querySelector(
        'button[aria-label="Saved segments. Active view: Recent readers"]',
      )?.textContent,
    ).toContain("View: Recent readers");
    expect(
      document.querySelector('button[role="menuitem"][aria-current="true"]')
        ?.textContent,
    ).toContain("Active");
  });

  it("keeps federated, long-field, tag, account, and model context directly visible", async () => {
    const subscriber: Subscriber & { churn_score: number } = {
      id: "subscriber-1",
      email: "reader-with-a-long-address@example.test",
      display_name:
        "A complete subscriber display name that must remain readable",
      account_name: "A complete account name that must remain readable",
      tags: ["product-research", "enterprise-advisory-board"],
      federated_master_id: "master-1",
      churn_score: 0.42,
      prediction_model_version: "churn-v7",
      prediction_confidence: 0.91,
    };
    render(
      <SubscribersTable
        {...emptyTableProps({
          rows: [subscriber],
          pageRows: [subscriber],
          visibleColumnKeys: [
            "email",
            "display_name",
            "account",
            "tags",
            "churn_score",
          ],
          gridTemplateColumns:
            "40px repeat(5, minmax(0, 1fr)) minmax(40px, auto)",
          pager: {
            page: 1,
            totalPages: 1,
            hasPrev: false,
            hasNext: false,
            label: "Page 1 of 1 · 1 of 1",
            hasTotal: true,
          },
        })}
      />,
    );

    expect(document.body.textContent).toContain(
      "Federated · parent workspace identity",
    );
    expect(document.body.textContent).toContain(subscriber.display_name);
    expect(document.body.textContent).toContain(subscriber.account_name);
    expect(document.body.textContent).toContain("product-research");
    expect(document.body.textContent).toContain("enterprise-advisory-board");
    expect(document.body.textContent).toContain("Scored by churn-v7 (0.91)");
    expect(container?.querySelector("[title]")).toBeNull();
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("exposes a semantic, roving-focus directory grid with complete keyboard actions", async () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    render(<DirectoryGridHarness onOpen={onOpen} onSelect={onSelect} />);

    const grid = document.querySelector<HTMLElement>(
      '[role="grid"][aria-label="Subscribers directory"]',
    );
    expect(grid).not.toBeNull();
    expect(grid?.getAttribute("aria-rowcount")).toBe("3");
    expect(grid?.getAttribute("aria-colcount")).toBe("3");
    expect(grid?.querySelectorAll('[role="columnheader"]')).toHaveLength(3);

    const rows = Array.from(
      grid?.querySelectorAll<HTMLElement>("[data-subscriber-row-index]") ?? [],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.tabIndex).toBe(0);
    expect(rows[1]?.tabIndex).toBe(-1);

    act(() => rows[0]?.focus());
    press("ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1]?.tabIndex).toBe(0);
    expect(
      document.querySelector('[data-testid="focused-subscriber-key"]')
        ?.textContent,
    ).toBe("subscriber-2");

    press(" ");
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "subscriber-2" }),
    );
    press("Enter");
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "subscriber-2" }),
    );

    const firstEmailCell = rows[0]?.querySelectorAll('[role="gridcell"]')[1];
    click(firstEmailCell ?? null);
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "subscriber-1" }),
    );

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("uses a compact accessible marker for the fixed-width avatar header", () => {
    render(
      <SubscribersTable
        {...emptyTableProps({
          visibleColumnKeys: ["avatar", "email"],
          gridTemplateColumns: "32px 32px minmax(0, 1fr) 64px",
        })}
      />,
    );

    const avatarHeader = document.querySelector<HTMLElement>(
      '[role="columnheader"][aria-label="Avatar"]',
    );
    expect(avatarHeader).not.toBeNull();
    expect(avatarHeader?.textContent).toBe("");
    expect(
      avatarHeader?.querySelector(".subscribers-avatar-column-marker"),
    ).not.toBeNull();
  });

  it("gives Column Picker a focusable checkbox-menu contract and explains locks", async () => {
    const onChange = vi.fn();
    render(
      <ColumnPicker
        catalog={[
          { key: "email", label: "Email", width: "1fr", required: true },
          { key: "status", label: "Status", width: "100px" },
          { key: "joined", label: "Joined", width: "100px" },
        ]}
        visible={["email", "status"]}
        onChange={onChange}
      />,
    );
    const trigger = findButton("Columns▾");
    expect(trigger.getAttribute("aria-controls")).toBeNull();

    const composingOpen = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
    });
    Object.defineProperty(composingOpen, "keyCode", { value: 229 });
    act(() => {
      trigger.dispatchEvent(composingOpen);
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();

    act(() => {
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    const menu = ownedMenu(trigger);
    expect(menu).not.toBeNull();
    expect(menu?.parentElement).toBe(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(menu?.getAttribute("aria-labelledby")).toBe(trigger.id);
    const items = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'),
    );
    expect(items).toHaveLength(3);
    expect(document.activeElement).toBe(items[0]);
    expect(items.filter((item) => item.tabIndex === 0)).toEqual([items[0]]);
    expect(items[0]?.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(items[0]?.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("required");

    press("ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    expect(items[1]?.tabIndex).toBe(0);
    press("End");
    expect(document.activeElement).toBe(items[2]);
    press("Home");
    expect(document.activeElement).toBe(items[0]);
    click(items[0] ?? null);
    expect(onChange).not.toHaveBeenCalled();
    press("j");
    expect(document.activeElement).toBe(items[2]);
    click(items[2] ?? null);
    expect(onChange).toHaveBeenCalledWith(["email", "status", "joined"]);
    expect(ownedMenu(trigger)).not.toBeNull();

    const composingEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    });
    Object.defineProperty(composingEscape, "isComposing", { value: true });
    act(() => {
      window.dispatchEvent(composingEscape);
    });
    expect(ownedMenu(trigger)).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await act(async () => Promise.resolve());
    expect(ownedMenu(trigger)).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses Column Picker on Tab, outside pointer, and focus departure", () => {
    render(
      <ColumnPicker
        catalog={[
          { key: "email", label: "Email", width: "1fr", required: true },
          { key: "status", label: "Status", width: "100px" },
        ]}
        visible={["email", "status"]}
        onChange={vi.fn()}
      />,
    );
    const trigger = findButton("Columns▾");
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(300);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(240);
    let anchor = {
      bottom: 204,
      height: 24,
      left: 250,
      right: 290,
      top: 180,
      width: 40,
      x: 250,
      y: 180,
      toJSON: () => ({}),
    };
    vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(() => anchor);
    click(trigger);
    let menu = ownedMenu(trigger);
    expect(menu?.style.position).toBe("fixed");
    expect(menu?.style.left).toBe("50px");
    expect(menu?.style.bottom).toBe("66px");
    anchor = {
      ...anchor,
      bottom: 34,
      left: 10,
      right: 50,
      top: 10,
      x: 10,
      y: 10,
    };
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    menu = ownedMenu(trigger);
    expect(menu?.style.left).toBe("8px");
    expect(menu?.style.top).toBe("40px");
    expect(menu?.style.bottom).toBe("");
    press("Tab");
    expect(ownedMenu(trigger)).toBeNull();

    click(trigger);
    act(() => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(ownedMenu(trigger)).toBeNull();

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    click(trigger);
    act(() => outside.focus());
    expect(ownedMenu(trigger)).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("models every saved-segment action as one roving, owned menu", () => {
    const onApply = vi.fn();
    const onRemove = vi.fn();
    const onRequestPreview = vi.fn();
    const onSave = vi.fn();
    render(
      <SavedToolbarHarness
        onApply={onApply}
        onRemove={onRemove}
        onRequestPreview={onRequestPreview}
        onSave={onSave}
      />,
    );
    const trigger = savedTrigger();
    click(trigger);
    const menu = ownedMenu(trigger);
    expect(menu).not.toBeNull();
    expect(menu?.parentElement).toBe(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(menu?.getAttribute("aria-labelledby")).toBe(trigger.id);
    const items = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    expect(items).toHaveLength(4);
    expect(items[0]?.textContent).toContain("Recent readers");
    expect(items[1]?.getAttribute("aria-label")).toBe(
      "Refresh live count for Recent readers",
    );
    expect(items[2]?.getAttribute("aria-label")).toBe("Delete Recent readers");
    expect(items[3]?.textContent).toContain("Save current segment");
    expect(document.activeElement).toBe(items[0]);
    expect(items.filter((item) => item.tabIndex === 0)).toEqual([items[0]]);
    expect(onRequestPreview).toHaveBeenCalledWith("segment-1");

    press("ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    click(items[1] ?? null);
    expect(onRequestPreview).toHaveBeenLastCalledWith("segment-1", true);
    expect(ownedMenu(trigger)).not.toBeNull();
    press("ArrowDown");
    expect(document.activeElement).toBe(items[2]);
    press("s");
    expect(document.activeElement).toBe(items[3]);
    press("Home");
    expect(document.activeElement).toBe(items[0]);
    click(items[0] ?? null);
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ id: "segment-1" }),
    );
    expect(ownedMenu(trigger)).toBeNull();
    expect(document.activeElement).toBe(trigger);

    click(trigger);
    const deleteItem = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Recent readers"]',
    );
    click(deleteItem);
    expect(onRemove).toHaveBeenCalledWith(
      expect.objectContaining({ id: "segment-1" }),
    );
    expect(ownedMenu(trigger)).toBeNull();
    expect(document.activeElement).toBe(trigger);

    click(trigger);
    const saveItem = Array.from(
      ownedMenu(trigger)?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? [],
    ).find((item) => item.textContent?.includes("Save current segment"));
    click(saveItem ?? null);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(ownedMenu(trigger)).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the last verified saved list usable while refresh fails", () => {
    const onApply = vi.fn();
    const onRetry = vi.fn();
    render(
      <SavedToolbarHarness
        error="Temporary service failure."
        onApply={onApply}
        onRetry={onRetry}
      />,
    );
    const trigger = savedTrigger();
    click(trigger);
    const menu = ownedMenu(trigger);
    expect(menu?.textContent).toContain(
      "The last verified list remains available.",
    );
    const apply = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    ).find((item) => item.textContent?.includes("Recent readers"));
    expect(apply).toBeDefined();
    click(
      Array.from(
        menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
      ).find((item) => item.textContent?.includes("Retry saved segments")) ??
        null,
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    click(apply ?? null);
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ id: "segment-1" }),
    );
  });

  it("keeps viewer-only saved actions focusable, explained, and inert", () => {
    const onRemove = vi.fn();
    const onSave = vi.fn();
    render(
      <SavedToolbarHarness
        canMutate={false}
        onRemove={onRemove}
        onSave={onSave}
      />,
    );
    const trigger = savedTrigger();
    click(trigger);
    const menu = ownedMenu(trigger);
    const deleteItem = menu?.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Recent readers"]',
    );
    const saveItem = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    ).find((item) => item.textContent?.includes("Save current segment"));
    for (const item of [deleteItem, saveItem]) {
      expect(item?.getAttribute("aria-disabled")).toBe("true");
      expect(
        document.getElementById(item?.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toContain("Viewer access");
      click(item ?? null);
    }
    expect(onRemove).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(ownedMenu(trigger)).not.toBeNull();
  });

  it("makes saved-segment dismissal IME-safe and collision-clamps its portal", async () => {
    render(<SavedToolbarHarness />);
    const trigger = savedTrigger();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(300);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(240);
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: 204,
      height: 24,
      left: 250,
      right: 290,
      top: 180,
      width: 40,
      x: 250,
      y: 180,
      toJSON: () => ({}),
    });
    click(trigger);
    const menu = ownedMenu(trigger);
    expect(menu?.style.position).toBe("fixed");
    expect(menu?.style.left).toBe("8px");
    expect(menu?.style.width).toBe("284px");
    expect(menu?.style.bottom).toBe("66px");
    expect(menu?.style.maxHeight).toBe("166px");

    const composingEscape = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(composingEscape, "keyCode", { value: 229 });
    act(() => {
      window.dispatchEvent(composingEscape);
    });
    expect(ownedMenu(trigger)).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await act(async () => Promise.resolve());
    expect(ownedMenu(trigger)).toBeNull();
    expect(document.activeElement).toBe(trigger);

    click(trigger);
    press("Tab");
    expect(ownedMenu(trigger)).toBeNull();
    click(trigger);
    act(() => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(ownedMenu(trigger)).toBeNull();
  });

  it("passes serious axe checks for both expanded subscriber menus", async () => {
    render(
      <ColumnPicker
        catalog={[
          { key: "email", label: "Email", width: "1fr", required: true },
          { key: "status", label: "Status", width: "100px" },
        ]}
        visible={["email", "status"]}
        onChange={vi.fn()}
      />,
    );
    click(findButton("Columns▾"));
    const columnResult = await axe.run(
      document.querySelector('[role="menu"]') ?? document.body,
    );
    expect(
      columnResult.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.replaceChildren();
    render(<SavedToolbarHarness canMutate={false} />);
    click(savedTrigger());
    const savedResult = await axe.run(
      ownedMenu(savedTrigger()) ?? document.body,
    );
    expect(
      savedResult.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });
});
