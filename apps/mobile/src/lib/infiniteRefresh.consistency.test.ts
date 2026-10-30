/**
 * Fleet guard: every screen that hands an INFINITE query's refetch to a
 * pull-to-refresh must bound the fan-out to one page.
 *
 * The cost this exists to stop is not hypothetical and was not new: TanStack
 * re-requests every loaded page of an infinite query, sequentially, and this
 * app had solved that THREE separate times — `firstPageOnly` on subscribers,
 * key-retirement on the audit windows, `resetQueries` on the helpdesk queue —
 * while six other paged screens still paid per page. A per-screen fix that
 * nobody generalises is a fix the next paged screen will not inherit, which is
 * what this test is for: add a paged list with a pull-to-refresh and the gate
 * goes red until the gesture is bounded or the screen is named below with a
 * reason.
 *
 * Comments are stripped before matching, because a source scan that counts the
 * word in a comment passes for a screen that does nothing.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Hooks in this app that return a `useInfiniteQuery` result. */
const INFINITE_HOOKS = [
  "useArchiveIssues",
  "useAssetLibrary",
  "useAuditLog",
  "useCampaignsPaginated",
  "useCollectionsList",
  "useDuplicatePairPages",
  "useGiftSubscriptions",
  "useHelpdeskConversations",
  "useHelpdeskThread",
  "useListMembers",
  "useSmsBroadcasts",
  "useSmsConversations",
  "useSmsThread",
  "useSubscriberTimeline",
  "useSubscribers",
  "useSuppressionList",
  "useTemplateCatalog",
];

/** Any of these, in stripped source, counts as bounding the fan-out. */
const BOUNDING_CALLS = [
  "useFirstPageRefresh",
  "refreshFirstPageOnly",
  // The subscribers screen delegates its whole refresh gesture to this hook,
  // which is where its `firstPageOnly` call lives.
  "useSubscribersPaging",
  "collapseInfiniteQueriesToFirstPage",
  "firstPageOnly",
  "refreshFirstPage",
  "resetQueries",
];

/**
 * Screens whose refresh legitimately does NOT bound the paged query, each with
 * the reason. A thread is scrollback: collapsing it would throw away the
 * history the reader scrolled to, which is the opposite of what the gesture
 * means on a conversation.
 */
const EXEMPT = new Map<string, string>([
  [
    "app/(tabs)/subscribers/[id].tsx",
    "activity timeline is scrollback, not a list to restart from the top",
  ],
  [
    // The screen was decomposed and its refresh moved into a controller hook.
    // The exemption follows the CODE, not the route: this guard's second test
    // exists precisely so a moved exemption cannot be left behind pointing at
    // a file that no longer does the thing it excuses.
    "src/hooks/useHelpdeskThreadScreen.ts",
    "conversation thread is scrollback",
  ],
  [
    "app/(tabs)/sms/[phone].tsx",
    "SMS thread is scrollback",
  ],
  [
    "src/components/duplicates/DuplicatesScreen.tsx",
    "the refresh refetches the scan, not the paired-rows infinite query",
  ],
  [
    // NOT a justification — a KNOWN GAP, and a narrow one. The reason chip,
    // the date window and a 1-2 character search all narrow this list on the
    // CLIENT across every loaded page, so the collapse would have to be gated
    // on all three being off; wiring that pushes `Suppressions` past its
    // 300-line function budget, and refactoring somebody else's 300/300 screen
    // to buy back the lines is a bigger change than the win. The bound belongs
    // here the moment that function is split.
    "app/(tabs)/suppressions/index.tsx",
    "KNOWN GAP — needs a client-narrowing gate that does not fit the line budget",
  ],
  [
    // NOT a justification — a KNOWN GAP. `broadcasts.refetch` is handed
    // straight to the refresh, so this screen still pays one request per
    // loaded page. It is owned by the SMS workstream; the fix is one call to
    // `refreshFirstPageOnly` with the SMS_BROADCASTS_KEY prefix.
    "src/components/sms/SmsBroadcastsScreen.tsx",
    "KNOWN GAP — owned by the SMS workstream, still unbounded",
  ],
]);

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Drop `import … from "…";` statements as well as comments.
 *
 * Without this the guard passes on the IMPORT of a bounding helper that the
 * screen never calls — which is exactly what a first version of this test did
 * when it was mutated: renaming the call site left the import behind and the
 * gate stayed green. A mention is not a use.
 */
function strippedBody(src: string): string {
  return stripComments(src).replace(
    /^\s*import[\s\S]*?from\s*["'][^"']*["'];?/gm,
    " ",
  );
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === ".expo") continue;
    const abs = join(root, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...sourceFiles(abs));
      continue;
    }
    if (![".ts", ".tsx"].includes(extname(entry))) continue;
    if (/\.(test|spec)\.[cm]?tsx?$/.test(entry)) continue;
    out.push(abs);
  }
  return out;
}

function pagedRefreshScreens(): { file: string; bounded: boolean }[] {
  const files = [
    ...sourceFiles(join(APP_ROOT, "app")),
    ...sourceFiles(join(APP_ROOT, "src")),
  ];
  const found: { file: string; bounded: boolean }[] = [];
  for (const abs of files) {
    const stripped = strippedBody(readFileSync(abs, "utf8"));
    const hasRefresh = /RefreshControl|useManualRefresh|onRefresh\s*[=:]/.test(
      stripped,
    );
    if (!hasRefresh) continue;
    const usesInfinite = INFINITE_HOOKS.some((h) =>
      new RegExp(`\\b${h}\\s*\\(`).test(stripped),
    );
    if (!usesInfinite) continue;
    // The hook file that DEFINES an infinite query is not a screen.
    if (/useInfiniteQuery\s*[<(]/.test(stripped)) continue;
    found.push({
      file: relative(APP_ROOT, abs).split("\\").join("/"),
      bounded: BOUNDING_CALLS.some((c) =>
        new RegExp(`\\b${c}\\b`).test(stripped),
      ),
    });
  }
  return found;
}

describe("pull-to-refresh on a paged list costs one page", () => {
  const screens = pagedRefreshScreens();

  it("finds the paged-refresh screens at all (the scan itself can rot)", () => {
    expect(screens.length).toBeGreaterThanOrEqual(10);
    expect(screens.map((s) => s.file)).toContain(
      "app/(tabs)/campaigns/index.tsx",
    );
  });

  it("every one either bounds the fan-out or is exempt with a reason", () => {
    const unbounded = screens
      .filter((s) => !s.bounded && !EXEMPT.has(s.file))
      .map((s) => s.file);
    expect(unbounded).toEqual([]);
  });

  it("no exemption outlives the screen it names", () => {
    const seen = new Set(screens.map((s) => s.file));
    expect([...EXEMPT.keys()].filter((f) => !seen.has(f))).toEqual([]);
  });
});
