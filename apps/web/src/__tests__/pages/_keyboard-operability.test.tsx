// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// KEYBOARD OPERABILITY (WCAG 2.1.1 / 2.1.2 / 2.4.3 / 2.4.7).
//
// WHY THIS EXISTS. Every sweep in this directory drives the app with a mouse.
// clickEveryControl() calls `el.click()`; fillEveryInput() writes through the
// native value setter; the dialog-flow file clicks Cancel and Confirm. None of
// them presses a key, and none of them ever asks where focus IS. So the whole
// suite is blind to the four ways a control can be mouse-only:
//
//   1. It is a <div> with an onClick — no tab stop, no Enter, no Space.
//   2. It is a real button that was pushed out of the tab order
//      (tabindex="-1", aria-hidden, a hidden ancestor).
//   3. It opens something that Escape cannot close, or that Tab can walk out
//      of while the overlay still covers the page.
//   4. It closes something and drops focus on <body>, so the next Tab starts
//      from the top of the document.
//
// The repo has already been bitten by this class: scrollable-regions-
// focusable.test.ts began as a ratchet over 49 keyboard-unreachable scroll
// containers, and confirmed-web-a11y-boundaries.test.ts records two rows that
// used to be mouse-only. Both are SOURCE scans. Nothing has ever pressed a key
// against a mounted page.
//
// WHAT HAPPY-DOM CAN AND CANNOT PROVE. Measured, not assumed: dispatching
// `keydown{key:"Enter"}` on a native <button> in happy-dom fires NO click
// event (nor does Space). That is a faithful reflection of where the behaviour
// lives — Enter/Space activation is the browser's default action for a button,
// not something the DOM event model synthesises. So "Enter activates it" is
// not directly assertable here, and a test that dispatched Enter and asserted
// "no crash" would be pure theatre.
//
// The assertable form of the same guarantee is: the control IS a native
// <button>/<a href> (the browser then activates it on Enter/Space for free),
// or it carries its own key handler. §A checks that across the whole source
// tree, §B checks it against what actually renders. Where a component DOES own
// a key handler — dialogs, the palette — §C and §D press the real key and
// assert the real consequence.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  renderPage,
  stubFixtureTransport,
  unmount,
  pressKey,
  WHOAMI,
} from "./_harness";
import { focusableElements } from "@/lib/focus-trap";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { AuthRole } from "@/lib/auth-api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

/* ------------------------------------------------------------------ *
 * Helpers.
 * ------------------------------------------------------------------ */

type FetchMock = ReturnType<typeof vi.fn>;

/** Answers 200 for everything and records the calls, so writes are visible. */
function recordingTransport(routes: Record<string, unknown> = {}): FetchMock {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
      .replace(/^https?:\/\/[^/]+/, "")
      .split("?")[0];
    return new Response(JSON.stringify(routes[path] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function mutations(stub: FetchMock): string[] {
  return (stub.mock.calls as [RequestInfo | URL, RequestInit | undefined][])
    .map(([input, init]) => ({
      method: (init?.method ?? "GET").toUpperCase(),
      path: String(input)
        .replace(/^https?:\/\/[^/]+/, "")
        .split("?")[0],
    }))
    .filter((c) => MUTATING.has(c.method))
    .map((c) => `${c.method} ${c.path}`);
}

async function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`no control to click: ${what}`);
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** A Tab / Shift-Tab keydown on whatever currently has focus. */
async function tab(shiftKey = false): Promise<void> {
  const target =
    (document.activeElement as HTMLElement | null) ?? document.body;
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * The open dialog, or a thrown error.
 *
 * Radix portals DialogContent into document.body, so querying the container
 * renderPage returns finds nothing and every assertion would pass vacuously.
 */
function openDialog(): HTMLElement {
  const nodes = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
  if (nodes.length === 0) throw new Error("no dialog is open");
  if (nodes.length > 1) throw new Error(`${nodes.length} dialogs are open`);
  return nodes[0];
}

function dialogCount(): number {
  return document.body.querySelectorAll('[role="dialog"]').length;
}

function byLabel(
  scope: ParentNode,
  label: string,
): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
}

/** Lets Radix's requestAnimationFrame-deferred focus restore land. */
async function settleFocus(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.body.innerHTML = "";
});

/* ================================================================== *
 * §A. THE SOURCE SWEEP — mouse-only handlers, repo-wide.
 *
 * A click handler on a <div>/<span>/<li>/<tr>/<svg> is unreachable from a
 * keyboard unless the tag is ALSO given a tab stop and its own key handler:
 * non-interactive elements have no default activation behaviour, so Enter and
 * Space do nothing at all.
 *
 * Three legitimate shapes are NOT defects and are cleared by name below:
 *
 *   - a BACKDROP whose onClick is a dismiss convenience, where Escape already
 *     dismisses the same surface (WCAG asks that the FUNCTION be keyboard
 *     operable, not that every affordance be);
 *   - a DELEGATION wrapper whose onClick reacts to a click on a focusable
 *     descendant (an <a> or a <button>) that the keyboard reaches directly;
 *   - a decorative wrapper whose onClick only calls stopPropagation.
 *
 * Everything else has to be listed with a reason, so a NEW mouse-only handler
 * fails here instead of shipping.
 * ================================================================== */

const SRC = resolve(process.cwd(), "src");

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkTsx(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Every JSX opening tag in `text`, with brace-aware bounds.
 *
 * Naively slicing to the next ">" ends the tag inside `onClick={(e) => …}` and
 * the sweep then never sees the props that follow it — which is exactly how a
 * scan like this reports a clean tree while missing the offenders.
 */
function openingTags(
  text: string,
): Array<{ tag: string; body: string; index: number }> {
  const out: Array<{ tag: string; body: string; index: number }> = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "<") continue;
    const m = /^<([A-Za-z][A-Za-z0-9._]*)/.exec(text.slice(i, i + 60));
    if (!m) continue;
    let depth = 0;
    let end = i;
    for (; end < text.length; end += 1) {
      const c = text[end];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ tag: m[1], body: text.slice(i, end + 1), index: i });
    i = end;
  }
  return out;
}

const NON_INTERACTIVE =
  /^(div|span|li|tr|td|th|p|section|article|header|footer|nav|ul|ol|label|figure|main|aside|svg|img|h[1-6])$/;

/** "file:line" for every non-interactive tag with onClick and no key path. */
function mouseOnlyHandlers(): string[] {
  const found: string[] = [];
  for (const file of walkTsx(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const t of openingTags(text)) {
      if (!NON_INTERACTIVE.test(t.tag)) continue;
      if (!/\bonClick=/.test(t.body)) continue;
      const keyable =
        /\btabIndex=/.test(t.body) &&
        /\bonKeyDown=|\bonKeyUp=|\bonKeyPress=/.test(t.body);
      if (keyable) continue;
      const line = text.slice(0, t.index).split("\n").length;
      found.push(`${file.slice(SRC.length + 1)}:${line} <${t.tag}>`);
    }
  }
  return found.sort();
}

/**
 * Cleared mouse-only handlers, each with the reason it is not a defect.
 *
 * The line numbers are deliberate: moving one of these handlers without
 * re-reading it fails this test, which is the point of pinning them.
 */
const CLEARED: Record<string, string> = {
  // Backdrops. Each of these surfaces closes on Escape as well — asserted in
  // the "every overlay closes on Escape" test below, so this is not a promise
  // taken on trust.
  "app/(dashboard)/dashboard-shell.tsx:622":
    "aria-hidden backdrop; dashboard-shell.tsx:354-382 closes the mobile navigation on Escape",
  "components/queue-tray.tsx:300":
    "presentation backdrop; queue-tray.tsx:81 closes the tray on Escape",
  "components/tour/TourOverlay.tsx:346":
    "backdrop; TourOverlay.tsx:316 skips the tour on Escape",
  "components/tour/TourLauncher.tsx:268":
    "backdrop; TourLauncher.tsx:224 closes the shortcut panel on Escape",
  "components/marketing/mobile-nav.tsx:105":
    "aria-hidden backdrop; mobile-nav.tsx:46 closes the drawer on Escape",
  // Delegation onto focusable descendants.
  "components/docs/DocsMobileNav.tsx:72":
    "delegation: closes only when the click landed on a descendant <a>",
  "app/(dashboard)/app/subscribers/subscribers-table.tsx:1184":
    "tap-anywhere convenience; the card also renders a named 'Open subscriber' button",
  "app/(dashboard)/app/templates/_components/template-gallery.tsx:236":
    "<label> wrapping a Checkbox; the onClick only stops propagation",
  "app/forge/_components/install-tracker.tsx:30":
    "role=presentation wrapper around a real <a>; also has an Enter/Space onKeyDown",
  "components/tour/TourLauncher.tsx:275":
    "panel body; the onClick only stops the backdrop's dismiss from firing",
};

describe("§A no new mouse-only click handler enters the tree", () => {
  const found = mouseOnlyHandlers();

  it("reads a whole opening tag, not up to the first '>' in an arrow function", () => {
    // Guard the guard, on a literal rather than on the tree, so it stays
    // falsifiable. `=>` contains a ">", and so does every comparison inside a
    // handler; a scanner that ended the tag there would see neither the
    // onClick that makes an element a control nor the tabIndex/onKeyDown that
    // redeem it — and would go quiet in both directions at once.
    const src =
      '<div onKeyDown={(e) => { if (e.key === "Enter") go(); }} tabIndex={0} onClick={() => go()} />';
    const parsed = openingTags(src);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tag).toBe("div");
    expect(parsed[0].body).toContain("onClick=");
    expect(parsed[0].body).toContain("tabIndex=");
    expect(parsed[0].body).toContain("onKeyDown=");
  });

  it("still finds the offenders it is supposed to find", () => {
    // A sweep that reports nothing is indistinguishable from a clean tree.
    // This is a known, current delegation shape.
    expect(found).toContain(
      "app/(dashboard)/app/subscribers/subscribers-table.tsx:1184 <article>",
    );
  });

  it("leaves only handlers cleared with a stated reason", () => {
    const unexplained = found.filter(
      (entry) => !(entry.split(" ")[0] in CLEARED),
    );
    expect(unexplained).toEqual([]);
  });

  it("keeps every clearance real", () => {
    // A reason for a handler that no longer exists is a comment pretending to
    // be a decision — and it hides the fact that the sweep stopped seeing it.
    const locations = new Set(found.map((entry) => entry.split(" ")[0]));
    const stale = Object.keys(CLEARED).filter((k) => !locations.has(k));
    expect(stale).toEqual([]);
  });
});

/**
 * A Next Link or native anchor already renders the interactive element. A
 * Button inside it creates nested controls with competing focus/activation
 * semantics; the supported composition is Button `asChild` around the Link.
 */
function nestedLinkButtons(text: string, file: string): string[] {
  const mask = (value: string) => value.replace(/[^\n\r]/gu, " ");
  const source = text
    .replace(/\/\*[\s\S]*?\*\//gu, mask)
    .replace(/(^|[ \t])\/\/[^\n\r]*/gmu, mask);
  const found: string[] = [];
  const links: Array<{ tag: "Link" | "a"; index: number }> = [];
  const wanted = new Set(["Link", "a", "Button", "button"]);
  const events: Array<{
    name: string;
    body: string;
    index: number;
    closing: boolean;
  }> = openingTags(source)
    .filter(({ tag }) => wanted.has(tag))
    .map(({ tag, body, index }) => ({
      name: tag,
      body,
      index,
      closing: false,
    }));
  for (const match of source.matchAll(/<\/(Link|a|Button|button)\s*>/gu)) {
    events.push({
      name: match[1],
      body: match[0],
      index: match.index,
      closing: true,
    });
  }
  events.sort((a, b) => a.index - b.index);

  for (const event of events) {
    const { name, body, index, closing } = event;
    if (closing) {
      if (name === "Link" || name === "a") {
        const open = links.map((link) => link.tag).lastIndexOf(name);
        if (open >= 0) links.splice(open, 1);
      }
      continue;
    }
    if (name === "Link" || name === "a") {
      if (!/\/\s*>$/u.test(body)) links.push({ tag: name, index });
      continue;
    }
    if (links.length > 0) {
      const line = text.slice(0, index).split("\n").length;
      found.push(`${file}:${line} <${links.at(-1)?.tag}><${name}>`);
    }
  }
  return found;
}

describe("§A links do not contain nested buttons", () => {
  it("keeps the nesting guard falsifiable", () => {
    expect(
      nestedLinkButtons(
        '<Link href="/next"><span><Button>Open</Button></span></Link>',
        "sentinel.tsx",
      ),
    ).toEqual(["sentinel.tsx:1 <Link><Button>"]);
    expect(
      nestedLinkButtons(
        '<Button asChild><Link href="/next">Open</Link></Button>',
        "sentinel.tsx",
      ),
    ).toEqual([]);
  });

  it("finds no nested Link/anchor and Button/button controls in production TSX", () => {
    const found = walkTsx(SRC).flatMap((file) =>
      nestedLinkButtons(readFileSync(file, "utf8"), file.slice(SRC.length + 1)),
    );
    expect(found.sort()).toEqual([]);
  });
});

describe("§A′ flow-canvas navigation is keyboard operable", () => {
  it("gives both the scroll canvas and click-to-pan minimap keyboard access", () => {
    const text = readFileSync(
      join(SRC, "app/(dashboard)/app/flows/_components/flow-canvas.tsx"),
      "utf8",
    );
    const svg = openingTags(text).find(
      (t) => t.tag === "svg" && /Flow minimap/.test(t.body),
    );
    expect(svg, "the minimap <svg> moved; re-read it").toBeDefined();

    expect(svg!.body).toContain('role="button"');
    expect(svg!.body).toContain("cursor-pointer");
    expect(svg!.body).toMatch(/onClick=/);
    expect(svg!.body).toContain("tabIndex={0}");
    expect(svg!.body).toMatch(/onKeyDown=/);
    expect(svg!.body).toContain("arrow keys to pan");

    const scrollContainer = openingTags(text).find((t) =>
      /ref=\{scrollRef\}/.test(t.body),
    );
    expect(scrollContainer).toBeDefined();
    expect(scrollContainer!.body).toContain("tabIndex={0}");
    expect(scrollContainer!.body).toContain('aria-label="Flow canvas"');
  });
});

/* ================================================================== *
 * §B. THE RENDERED SWEEP — is every action in the tab order?
 *
 * §A reads source. This mounts pages and asks the question of what actually
 * renders, which catches the cases a source scan cannot see: a control the
 * click sweep happily presses but that `tabindex="-1"`, `aria-hidden` or a
 * `hidden` ancestor has removed from the tab order. A mouse can reach it; a
 * Tab key can never land on it.
 *
 * The tab-order oracle is the app's OWN focusableElements() (src/lib/
 * focus-trap.ts) — the same function the shell's modals use to decide where
 * Tab may go — so this asserts against the repo's real definition of reachable
 * rather than a second one invented here.
 * ================================================================== */

// The fixture transport, not the recording one used elsewhere in this file:
// answering `{}` for every path invents a truthy-but-empty payload the server
// never sends, and _harness.tsx documents the two pages that "crashed" on it.
// Four more do (campaigns, subscribers, landing-pages, deliverability), and
// chasing those would be chasing a harness artefact.
const SWEPT_PAGES: Array<[string, () => Promise<{ default: unknown }>]> = [
  [
    "campaigns",
    async () => {
      const { CampaignsClient } =
        await import("@/app/(dashboard)/app/campaigns/campaigns-client");
      return { default: CampaignsClient };
    },
  ],
  ["subscribers", () => import("@/app/(dashboard)/app/subscribers/page")],
  [
    "suppressions",
    () => import("@/app/(dashboard)/app/suppressions/page-client"),
  ],
  ["settings", () => import("@/app/(dashboard)/app/settings/page")],
  ["flows", () => import("@/app/(dashboard)/app/flows/page")],
  ["discounts", () => import("@/app/(dashboard)/app/discounts/page")],
  ["approvals", () => import("@/app/(dashboard)/app/approvals/page")],
  ["landing-pages", () => import("@/app/(dashboard)/app/landing-pages/page")],
  ["integrations", () => import("@/app/(dashboard)/app/integrations/page")],
  ["maintenance", () => import("@/app/(dashboard)/app/maintenance/page")],
  ["settings/team", () => import("@/app/(dashboard)/app/settings/team/page")],
  [
    "settings/webhooks",
    () => import("@/app/(dashboard)/app/settings/webhooks/page"),
  ],
  ["notifications", () => import("@/app/(dashboard)/app/notifications/page")],
];

/**
 * Composite widgets that move focus with the ARROW keys, not Tab.
 *
 * A tablist, menu, radiogroup, listbox or toolbar implements ROVING TABINDEX:
 * exactly one member is `tabindex=0` and the rest are `tabindex=-1`, so Tab
 * enters the group once and arrows walk it. Reporting the `-1` members as
 * unreachable would be wrong, and worse, it would push someone to "fix" a
 * correct widget by giving every tab its own tab stop.
 *
 * The group is still checked, just by the right rule: the whole group is
 * unreachable if NO member is tabbable, which is the way roving tabindex
 * actually breaks (an initial state where nothing is selected).
 */
const ROVING =
  "[role='tablist'],[role='menu'],[role='menubar'],[role='radiogroup'],[role='listbox'],[role='toolbar'],[role='tree'],[role='grid']";

describe("§B every rendered action is reachable by Tab", () => {
  for (const [name, load] of SWEPT_PAGES) {
    it(`${name}: no enabled control sits outside the tab order`, async () => {
      stubFixtureTransport();
      const Page = (await load()).default;
      const { container, root } = await renderPage(Page as never);
      try {
        const tabbable = new Set(focusableElements(container));
        const enabledActions = [
          ...container.querySelectorAll<HTMLElement>(
            "button, [role='button'], a[href], input:not([type='hidden']), select, textarea",
          ),
        ].filter((el) => !(el as HTMLButtonElement).disabled);

        // Guard the guard. A page that rendered no controls would satisfy
        // "every control is reachable" without proving anything, and a mount
        // failure looks exactly like that. Native form controls belong here as
        // much as buttons and links do: the discounts empty/error surface, for
        // example, has a real enabled search field even while creation remains
        // truthfully release-held. Excluding inputs made that keyboard control
        // invisible to this test and produced a false vacuity failure.
        expect(
          enabledActions.length,
          `${name} rendered no enabled controls — the sweep below is vacuous`,
        ).toBeGreaterThan(0);

        const unreachable = enabledActions
          .filter((el) => !tabbable.has(el))
          .filter((el) => el.closest(ROVING) === null)
          .map(
            (el) =>
              `<${el.tagName.toLowerCase()}> "${
                el.getAttribute("aria-label") ??
                el.textContent?.trim().slice(0, 40)
              }" tabindex=${el.getAttribute("tabindex")} aria-hidden=${el.getAttribute("aria-hidden")}`,
          );
        expect(unreachable, `${name}: mouse-only controls`).toEqual([]);

        // And the roving groups the filter above excused are checked by their
        // own rule, so the exclusion cannot become a blanket amnesty.
        //
        // The tab stop may sit on the GROUP rather than on a member: Radix's
        // RovingFocusGroup puts `tabindex=0` on the tablist itself and leaves
        // every trigger at -1, forwarding entry focus to the selected one.
        // Measured, not assumed — approvals and integrations both render
        // exactly that shape, and an earlier version of this check called both
        // of them defects.
        const strandedGroups = [
          ...container.querySelectorAll<HTMLElement>(ROVING),
        ]
          .filter(
            (group) =>
              group.querySelectorAll("button, [role='tab'], a[href]").length >
              0,
          )
          .filter(
            (group) =>
              group.getAttribute("tabindex") === "-1" ||
              (group.getAttribute("tabindex") === null &&
                focusableElements(group).length === 0),
          )
          .map(
            (group) =>
              `<${group.tagName.toLowerCase()} role="${group.getAttribute("role")}"> "${group.getAttribute("aria-label") ?? group.textContent?.trim().slice(0, 40)}"`,
          );
        expect(
          strandedGroups,
          `${name}: a roving-tabindex group with no tab stop at all`,
        ).toEqual([]);

        // The entry-focus pattern only works if something inside is marked
        // current: a group whose tab stop is on the wrapper and whose members
        // are ALL aria-selected=false hands focus to nowhere.
        for (const group of container.querySelectorAll<HTMLElement>(
          "[role='tablist']",
        )) {
          const tabs = [...group.querySelectorAll("[role='tab']")];
          if (tabs.length === 0) continue;
          expect(
            tabs.some((t) => t.getAttribute("aria-selected") === "true"),
            `${name}: a tablist with no selected tab — entry focus has no target`,
          ).toBe(true);
        }
      } finally {
        unmount(root);
      }
    });
  }

  it("every rendered activatable control is a NATIVE button or link", async () => {
    // Enter and Space come free on <button> and <a href>. On anything else
    // they are the component's own job, and the source sweep in §A is what
    // covers that — so a role="button" <div> reaching the DOM here would mean
    // §A missed it. Asserted across every swept page at once.
    const offenders: string[] = [];
    for (const [name, load] of SWEPT_PAGES) {
      stubFixtureTransport();
      const Page = (await load()).default;
      const { container, root } = await renderPage(Page as never);
      try {
        for (const el of container.querySelectorAll<HTMLElement>(
          "[role='button']",
        )) {
          if (el.tagName !== "BUTTON" && el.tagName !== "A") {
            offenders.push(
              `${name}: <${el.tagName.toLowerCase()} role="button"> "${el.textContent?.trim().slice(0, 30)}"`,
            );
          }
        }
      } finally {
        unmount(root);
        vi.unstubAllGlobals();
      }
    }
    expect(offenders).toEqual([]);
    // Ten pages in one test, each allowed up to 1.5 s for a lazily loaded
    // chunk's fallback to clear (see renderPage): a per-sweep budget, not the
    // 5 s default meant for a single page.
  }, 60_000);
});

/* ================================================================== *
 * §C. THE DIALOG KEYBOARD CONTRACT.
 *
 * ConfirmDialog is the primitive behind 89 destructive call sites. The
 * dialog-flow suite proves Cancel and Confirm do the right thing WITH A MOUSE.
 * Every assertion below is about the keyboard, and every one of them is a way
 * the same component can strand a keyboard user:
 *
 *   - focus left on the trigger BEHIND the overlay: the user is typing into a
 *     page they cannot see;
 *   - Tab walking out of the open dialog onto the page underneath (2.1.2);
 *   - Escape not closing, so the only exit is the mouse (2.1.2);
 *   - Escape mistaken for confirmation — the failure that actually deletes
 *     something;
 *   - focus dropped on <body> after close, so the next Tab restarts at the top
 *     of the document (2.4.3).
 * ================================================================== */

function DialogSubject({ token }: { token?: string }) {
  const [confirmed, setConfirmed] = useState(0);
  return (
    <div>
      <span>confirmed:{confirmed}</span>
      <Button type="button" data-testid="before">
        before
      </Button>
      <ConfirmDialog
        trigger={
          <Button type="button" variant="destructive" data-testid="trigger">
            Delete thing
          </Button>
        }
        title="Delete this thing?"
        description="It does not come back."
        confirmLabel="Delete"
        confirmationToken={token}
        onConfirm={async () => {
          await api.delete("/api/v1/test-fixture/thing-1");
          setConfirmed((n) => n + 1);
        }}
      />
      <Button type="button" data-testid="after">
        after
      </Button>
    </div>
  );
}

/** Focuses the trigger the way a keyboard user arrives at it, then opens. */
async function openFromKeyboard(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector<HTMLElement>(
    '[data-testid="trigger"]',
  );
  if (!trigger) throw new Error("no trigger");
  trigger.focus();
  // Precondition, not decoration: Radix restores focus to whatever held it
  // when the dialog mounted. Opening from a click that never focused the
  // trigger would make every restore assertion below trivially "correct" while
  // proving nothing about the real path.
  expect(document.activeElement).toBe(trigger);
  await click(trigger, "trigger");
  return trigger;
}

/**
 * Asserts focus actually LEFT the trigger for the dialog.
 *
 * Every "focus comes back to the trigger" test needs this first, and finding
 * that out was the point of mutation-testing this file: a mutant that stripped
 * all focus management from DialogContent left focus sitting on the trigger
 * the whole time, so all three restore assertions passed while the component
 * managed nothing at all. Proving focus moved is what makes proving it came
 * back mean something.
 */
function expectFocusMovedInto(dialog: HTMLElement, trigger: HTMLElement): void {
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(trigger);
}

describe("§C ConfirmDialog is fully operable from the keyboard", () => {
  it("opening moves focus INTO the dialog, not onto the page behind it", async () => {
    recordingTransport();
    const { container, root } = await renderPage(DialogSubject);
    try {
      const trigger = await openFromKeyboard(container);
      const dialog = openDialog();

      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(trigger);
      expect(document.activeElement).not.toBe(document.body);
    } finally {
      unmount(root);
    }
  });

  it("Tab cannot walk out of the open dialog (2.1.2, forwards)", async () => {
    recordingTransport();
    const { container, root } = await renderPage(DialogSubject);
    try {
      await openFromKeyboard(container);
      const dialog = openDialog();
      const inside = focusableElements(dialog);
      expect(inside.length).toBeGreaterThan(1);

      // Stand on the LAST control in the dialog: the only place from which the
      // browser's own Tab would leave, so it is the only place the trap can be
      // observed doing anything.
      inside[inside.length - 1].focus();
      expect(document.activeElement).toBe(inside[inside.length - 1]);

      await tab();

      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(inside[0]);
      // And specifically NOT the page controls sitting either side of the
      // trigger, which are what an untrapped Tab reaches.
      expect(
        container.querySelector('[data-testid="after"]') ===
          document.activeElement,
      ).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("Shift+Tab cannot walk out of the open dialog either (2.1.2, backwards)", async () => {
    recordingTransport();
    const { container, root } = await renderPage(DialogSubject);
    try {
      await openFromKeyboard(container);
      const dialog = openDialog();
      const inside = focusableElements(dialog);

      inside[0].focus();
      await tab(true);

      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(inside[inside.length - 1]);
      expect(
        container.querySelector('[data-testid="before"]') ===
          document.activeElement,
      ).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("Escape closes it AND performs no write", async () => {
    const stub = recordingTransport();
    const { container, root } = await renderPage(DialogSubject);
    try {
      await openFromKeyboard(container);
      expect(dialogCount()).toBe(1);

      await pressKey(openDialog(), "Escape");

      // The two halves are equally important. A dialog that closes on Escape
      // but treats it as confirmation has just deleted the thing, and the
      // "it closed" half alone would call that a pass.
      expect(dialogCount()).toBe(0);
      expect(mutations(stub)).toEqual([]);
      expect(container.textContent).toContain("confirmed:0");
    } finally {
      unmount(root);
    }
  });

  it("Escape returns focus to the trigger, not to <body> (2.4.3)", async () => {
    recordingTransport();
    const { container, root } = await renderPage(DialogSubject);
    try {
      const trigger = await openFromKeyboard(container);
      expectFocusMovedInto(openDialog(), trigger);

      await pressKey(openDialog(), "Escape");
      await settleFocus();

      expect(document.activeElement).toBe(trigger);
      expect(document.activeElement).not.toBe(document.body);
    } finally {
      unmount(root);
    }
  });

  it("Cancel returns focus to the trigger", async () => {
    recordingTransport();
    const { container, root } = await renderPage(DialogSubject);
    try {
      const trigger = await openFromKeyboard(container);
      expectFocusMovedInto(openDialog(), trigger);

      await click(byLabel(openDialog(), "Cancel"), "cancel");
      await settleFocus();

      expect(dialogCount()).toBe(0);
      expect(document.activeElement).toBe(trigger);
    } finally {
      unmount(root);
    }
  });

  it("confirming returns focus to the trigger after the write lands", async () => {
    const stub = recordingTransport();
    const { container, root } = await renderPage(DialogSubject);
    try {
      const trigger = await openFromKeyboard(container);
      expectFocusMovedInto(openDialog(), trigger);

      await click(byLabel(openDialog(), "Delete"), "confirm");
      await settleFocus();

      // The write happened — otherwise "focus is back on the trigger" would
      // describe a dialog that simply did nothing.
      expect(mutations(stub)).toEqual(["DELETE /api/v1/test-fixture/thing-1"]);
      expect(container.textContent).toContain("confirmed:1");
      expect(document.activeElement).toBe(trigger);
    } finally {
      unmount(root);
    }
  });

  it("a typed-confirmation gate is not a keyboard trap — Escape still leaves", async () => {
    // The high-blast-radius variant (migration rollback, SMS suppression
    // removal) disables its confirm button until an exact token is typed. If
    // Escape were suppressed while the gate is shut, the ONLY way out of the
    // dialog would be clicking Cancel — WCAG 2.1.2, on the most dangerous
    // dialog in the app.
    const stub = recordingTransport();
    const { container, root } = await renderPage(DialogSubject, {
      token: "DELETE",
    });
    try {
      const trigger = await openFromKeyboard(container);
      expect(byLabel(openDialog(), "Delete")?.disabled).toBe(true);

      await pressKey(openDialog(), "Escape");
      await settleFocus();

      expect(dialogCount()).toBe(0);
      expect(mutations(stub)).toEqual([]);
      expect(document.activeElement).toBe(trigger);
    } finally {
      unmount(root);
    }
  });

  it("the token input is reachable by Tab from inside the dialog", async () => {
    // The gate is useless if the field that opens it is not in the dialog's
    // own tab ring: a keyboard user would see a permanently-disabled confirm.
    recordingTransport();
    const { container, root } = await renderPage(DialogSubject, {
      token: "DELETE",
    });
    try {
      await openFromKeyboard(container);
      const dialog = openDialog();
      const input = dialog.querySelector<HTMLInputElement>("input");
      expect(input).not.toBeNull();
      expect(focusableElements(dialog)).toContain(input as HTMLElement);
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * §D. THE SAME CONTRACT ON A REAL PAGE.
 *
 * §C exercises the primitive in isolation. This mounts the team roster —
 * whose dialog suspends a colleague's access — and repeats the two assertions
 * that protect a keyboard user: Escape does not confirm, and focus comes back
 * to the row control it left. A page can break both without touching
 * ConfirmDialog, by re-rendering the row (and destroying the trigger) while
 * the dialog is open.
 * ================================================================== */

const ROSTER_ROUTES = {
  "/api/v1/workspace/members": {
    members: [
      {
        id: "m_1",
        email: "teammate@postwave.test",
        role: "editor",
        status: "active",
        isSelf: false,
      },
    ],
    callerIsOwner: true,
  },
  "/api/v1/workspace/invites": { invites: [] },
};

describe("§D team roster — the keyboard contract survives a real page", () => {
  async function mountRoster() {
    const stub = recordingTransport(ROSTER_ROUTES);
    const { TeamRoster } =
      await import("@/app/(dashboard)/app/settings/team/team-roster");
    const mounted = await renderPage(TeamRoster, {
      canWrite: true,
      callerCanOwner: true,
      tenantId: WHOAMI.tenant_id,
      role: "owner" as AuthRole,
      identityReady: true,
      identity: WHOAMI,
    });
    expect(mounted.text).toContain("teammate@postwave.test");
    return { stub, ...mounted };
  }

  it("Escape closes the remove-access dialog and suspends nobody", async () => {
    const { stub, container, root } = await mountRoster();
    try {
      const remove = byLabel(container, "Remove");
      remove?.focus();
      await click(remove, "Remove");
      expect(openDialog().textContent).toContain(
        "Remove teammate@postwave.test?",
      );

      await pressKey(openDialog(), "Escape");
      await settleFocus();

      expect(dialogCount()).toBe(0);
      expect(mutations(stub)).toEqual([]);
      // Focus is back on the row's own control, so the next Tab continues down
      // the table instead of restarting at the top of the document.
      expect(document.activeElement).toBe(remove);
      expect(container.textContent).toContain("teammate@postwave.test");
    } finally {
      unmount(root);
    }
  });

  it("Tab stays inside the remove-access dialog", async () => {
    const { container, root } = await mountRoster();
    try {
      const remove = byLabel(container, "Remove");
      remove?.focus();
      await click(remove, "Remove");

      const dialog = openDialog();
      const inside = focusableElements(dialog);
      expect(inside.length).toBeGreaterThan(1);
      inside[inside.length - 1].focus();
      await tab();

      // Asserting only "still inside the dialog" was NOT enough, and mutation
      // testing is what showed it: with all focus management stripped out,
      // focus simply does not move, which is trivially "still inside". The
      // trap has to be seen WRAPPING, so the destination is named.
      expect(document.activeElement).toBe(inside[0]);
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(container.contains(document.activeElement)).toBe(false);
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * §E. FOCUS MUST BE VISIBLE (2.4.7).
 *
 * Every interactive primitive in src/components/ui removes the platform focus
 * ring (`focus:outline-none` / `focus-visible:outline-none`) so it can draw its
 * own. That is standard practice and fine — right up until one variant removes
 * the outline and forgets the replacement, at which point a keyboard user
 * cannot see where they are and NOTHING else in this suite notices, because
 * focus still moves correctly.
 *
 * This is the one assertion in the file that reads class names, and it does so
 * because the consequence it guards — a visible ring — lives in CSS that
 * happy-dom does not compute. It is checked at the definition site, where a
 * missing ring is one fact rather than a rendering to interrogate.
 * ================================================================== */

/** A class string that suppresses the outline but declares no ring. */
function killsOutlineWithoutRing(classes: string): boolean {
  if (!/outline-none/.test(classes)) return false;
  return !/focus-visible:ring|focus:ring|focus-visible:outline-\[|focus-visible:border|ring-offset/.test(
    classes,
  );
}

/** "components/ui/x.tsx:NN" for every class string that does. */
function ringlessOutlineKills(): string[] {
  const dir = join(SRC, "components/ui");
  const out: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.tsx$/.test(f))) {
    const text = readFileSync(join(dir, file), "utf8");
    // Per class string, not per file: a ring declared 200 lines away in a
    // different variant does not make THIS one visible.
    for (const m of text.matchAll(/"([^"]*outline-none[^"]*)"/g)) {
      if (!killsOutlineWithoutRing(m[1])) continue;
      out.push(
        `components/ui/${file}:${text.slice(0, m.index!).split("\n").length}`,
      );
    }
  }
  return out.sort();
}

/**
 * Outline suppressions that are NOT invisible focus, and why.
 *
 * A ring is one way to show focus, not the only one. Each entry below draws a
 * different visible indicator, which is the requirement 2.4.7 actually states.
 * Written out rather than folded into the regex above, because widening the
 * detector until the list empties is how a ratchet stops being able to fail.
 */
const FOCUS_INDICATOR_CLEARED: Record<string, string> = {
  "components/ui/action-menu.tsx:175":
    "menu item: `focus:bg-accent` repaints the row on focus — a visible indicator, just not a ring",
  "components/ui/command.tsx:84":
    "palette search box: a focused text input shows a caret, and the bordered wrapper is the drawn surface",
  "components/ui/command.tsx:154":
    "cmdk item: virtual focus via aria-activedescendant, painted by `data-[selected=true]:bg-accent`",
};

describe("§E a primitive that removes the focus outline shows focus another way", () => {
  const found = ringlessOutlineKills();

  it("leaves only suppressions cleared with a stated indicator", () => {
    const unexplained = found.filter((f) => !(f in FOCUS_INDICATOR_CLEARED));
    expect(unexplained).toEqual([]);
  });

  it("keeps every clearance real", () => {
    const stale = Object.keys(FOCUS_INDICATOR_CLEARED).filter(
      (k) => !found.includes(k),
    );
    expect(stale).toEqual([]);
  });

  it("the detector can actually see a missing indicator", () => {
    // Guard the guard: the predicate IS the test, so prove it rejects the
    // shape it exists to reject and accepts the shape it exists to accept.
    expect(
      killsOutlineWithoutRing("focus-visible:outline-none rounded-md"),
    ).toBe(true);
    expect(
      killsOutlineWithoutRing(
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      ),
    ).toBe(false);
    expect(killsOutlineWithoutRing("rounded-md border")).toBe(false);
  });

  it("the shared Button — every clickable surface in the app — keeps its ring", () => {
    // The one primitive whose regression would be invisible everywhere at
    // once. Named explicitly so it cannot be quietly moved into the cleared
    // list above.
    const text = readFileSync(join(SRC, "components/ui/button.tsx"), "utf8");
    const base = /cva\(\s*"([^"]*)"/.exec(text);
    expect(
      base,
      "button.tsx no longer declares its base classes as a literal",
    ).not.toBeNull();
    expect(base![1]).toContain("focus-visible:outline-none");
    expect(base![1]).toContain("focus-visible:ring-2");
    expect(killsOutlineWithoutRing(base![1])).toBe(false);
  });
});
