// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /app/aeo — the AEO Sensor page (analytics-1..10 desktop parity), rendered
// for real over a recording transport. Every assertion is by REQUEST (method,
// path, body) or by what RENDERS; nothing here passes because a button exists.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";
import {
  buttonByText,
  clickEl,
  recordingTransport,
  settle,
  typeInto,
  type Recorded,
} from "./_mount-transport";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  toasts: [] as { level: string; text: string }[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/aeo",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("sonner", () => {
  const rec = (level: string) => (message: unknown) => {
    mocks.toasts.push({ level, text: String(message) });
    return "toast-id";
  };
  const toast = Object.assign(rec("message"), {
    error: rec("error"),
    success: rec("success"),
    info: rec("info"),
    warning: rec("warning"),
    dismiss: vi.fn(),
  });
  return { toast };
});

/* ---------- fixtures: the shapes handlers.go answers with ------------- */

const VIEWER = {
  ...WHOAMI,
  role: "viewer" as const,
  effective_role: "viewer" as const,
};

const WARNING_BANNER =
  "AEO Sensor is disabled. Enable it in Settings to start tracking ChatGPT / Gemini / Perplexity citations.";

const ROLLUP = {
  engine: "chatgpt",
  day: "2026-09-11",
  mention_rate: 0.4235,
  citation_rate: 0.1,
  volatility_score: 12.34,
  ai_referral_pct: 0.05,
  sample_size: 40,
  computed_at: "2026-09-11T06:00:00Z",
};

const SETTINGS = {
  enabled: true,
  brand_terms: ["Moosewave", "postwave"],
  brand_domain: "moosewave.com",
  probe_prompt_pack: "starter",
  probe_interval_hours: 24,
  engines: [
    { key: "chatgpt", enabled: true },
    { key: "gemini", enabled: true },
    { key: "perplexity", enabled: false },
  ],
  volatility_window_days: 14,
  credentials_status: "partial",
};

const SUMMARY = {
  settings: SETTINGS,
  latest_rollups: [
    ROLLUP,
    { ...ROLLUP, engine: "gemini", mention_rate: 0.2, volatility_score: 65 },
  ],
  overall_mention_rate: 0.4235,
  overall_citation_rate: 0.1,
  volatility_score: 12.34,
  ai_referral_pct: 0.05,
  competitor_board: [
    { key: "acme", display_name: "Acme Mail", mention_rate: 0.25, domain: "acme.com" },
  ],
  warning_banner: WARNING_BANNER,
};

const PROMPT = {
  id: "p1",
  category: "discovery",
  prompt_text: "Best email marketing platform for ecommerce?",
  enabled: true,
  source: "starter",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

const PROBE = {
  id: 101,
  prompt_id: "p1",
  engine: "chatgpt",
  response_text: "Moosewave is one option…",
  mentioned: true,
  cited: false,
  competitor_hits: { acme: 1 },
  latency_ms: 812,
  token_count: 210,
  status: "rate_limited",
  probed_at: "2026-09-11T05:59:00Z",
};

const COMPETITOR = {
  id: "c1",
  competitor_key: "acme",
  display_name: "Acme Mail",
  terms: ["Acme", "AcmeMail"],
  domain: "acme.com",
};

type Overrides = Partial<Record<"summary" | "prompts" | "probes" | "competitors", unknown>>;

/** Serves the AEO reads; every write is answered `{ok:true}` and recorded. */
function transport(overrides: Overrides = {}) {
  return recordingTransport((req: Recorded) => {
    if (req.method === "GET") {
      if (req.path === "/api/v1/aeo/summary") {
        return { body: overrides.summary ?? SUMMARY };
      }
      if (req.path === "/api/v1/aeo/prompts") {
        return { body: overrides.prompts ?? { items: [PROMPT] } };
      }
      if (req.path === "/api/v1/aeo/probes") {
        return { body: overrides.probes ?? { items: [PROBE] } };
      }
      if (req.path === "/api/v1/aeo/competitors") {
        return { body: overrides.competitors ?? { items: [COMPETITOR], max: 5 } };
      }
      return undefined;
    }
    if (req.path === "/api/v1/aeo/run-now") {
      return { body: { probes: 12, rollups: [ROLLUP] } };
    }
    if (req.path.startsWith("/api/v1/aeo/")) {
      return { body: { ok: true } };
    }
    return undefined;
  });
}

function writes(calls: Recorded[]): Recorded[] {
  return calls.filter((c) => c.method !== "GET");
}

async function selectValue(el: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function inputByLabel(container: ParentNode, label: string): HTMLInputElement {
  // Exact text first ("Prompt" must not resolve to "Prompt category"), then
  // a prefix match for labels that carry a parenthetical hint.
  const labels = [...container.querySelectorAll("label")];
  const lab =
    labels.find((l) => (l.textContent ?? "").trim() === label) ??
    labels.find((l) => (l.textContent ?? "").trim().startsWith(label));
  const id = lab?.getAttribute("for");
  const el = id ? container.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`) : null;
  if (!el) throw new Error(`input for label "${label}" not found`);
  return el;
}

function openDialog(): HTMLElement {
  const dialogs = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) throw new Error("no dialog open");
  return dialog;
}

async function mountAeo(overrides: Overrides = {}) {
  const { calls } = transport(overrides);
  const Page = (await import("@/app/(dashboard)/app/aeo/page")).default;
  const rendered = await renderPage(Page);
  // The four panels are next/dynamic chunks; give them a beat past the
  // harness's settle so the competitor list's own GET has been issued.
  await settle(8);
  return { calls, ...rendered };
}

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.toasts.length = 0;
});

/* ---------- owner: reads, rendering, every verb ----------------------- */

describe("/app/aeo — owner", () => {
  it("issues every read on load and renders banner, tiles, engines, board, prompts, probes", async () => {
    mocks.whoami.mockResolvedValue(WHOAMI);
    const { calls, container, root } = await mountAeo();
    try {
      const gets = calls.filter((c) => c.method === "GET").map((c) => `${c.path}${c.query.toString() ? `?${c.query}` : ""}`);
      expect(gets).toEqual(
        expect.arrayContaining([
          "/api/v1/aeo/summary",
          "/api/v1/aeo/prompts",
          "/api/v1/aeo/probes?limit=50",
          "/api/v1/aeo/competitors",
        ]),
      );
      expect(writes(calls)).toEqual([]);

      const text = container.textContent ?? "";
      expect(text).toContain("AEO Sensor");
      // analytics-2: the server-authored banner, verbatim.
      expect(text).toContain(WARNING_BANNER);
      // analytics-3: tiles formatted from the fixture (rates ×100, 1dp).
      const tiles = [...container.querySelectorAll("dl dd")].map((d) => d.textContent);
      expect(tiles).toEqual(
        expect.arrayContaining(["42.4%", "10.0%", "12.3", "5.0%"]),
      );
      // analytics-4: per-engine snapshot from latest_rollups; perplexity absent.
      expect(text).toContain("ChatGPT");
      expect(text).toContain("Citation 10.0% · Sample 40");
      expect(text).toContain("Volatility 65.0");
      expect(text).toContain("No data yet — waiting for first probe pass.");
      // analytics-5: settings pre-filled.
      expect(inputByLabel(container, "Brand domain").value).toBe("moosewave.com");
      expect(inputByLabel(container, "Brand terms").value).toBe("Moosewave, postwave");
      // analytics-6: board shows the roster with its summary mention rate.
      expect(text).toContain("Acme Mail");
      expect(text).toContain("25.0%");
      // analytics-8: prompts listed.
      expect(text).toContain("Best email marketing platform for ecommerce?");
      // analytics-10: probes listed, status humanised.
      expect(text).toContain("rate limited");
      // Owner: no read-only note.
      expect(text).not.toContain("Only workspace owners and admins");
    } finally {
      unmount(root);
    }
  });

  it("analytics-1: Run probe pass now → POST /api/v1/aeo/run-now {} and shows the returned probe count", async () => {
    mocks.whoami.mockResolvedValue(WHOAMI);
    const { calls, container, root } = await mountAeo();
    try {
      const before = calls.length;
      await clickEl(buttonByText(container, "Run probe pass now"));
      await settle(6);
      expect(writes(calls)).toEqual([
        expect.objectContaining({ method: "POST", path: "/api/v1/aeo/run-now", body: {} }),
      ]);
      expect(container.textContent).toContain("Probe pass complete — 12 probes recorded.");
      // Refresh after the mutation: summary + probes re-read.
      const after = calls.slice(before).filter((c) => c.method === "GET").map((c) => c.path);
      expect(after).toEqual(expect.arrayContaining(["/api/v1/aeo/summary", "/api/v1/aeo/probes"]));
    } finally {
      unmount(root);
    }
  });

  it("analytics-5: Save brand setup → PUT /api/v1/aeo/settings with the edited partial settings", async () => {
    mocks.whoami.mockResolvedValue(WHOAMI);
    const { calls, container, root } = await mountAeo();
    try {
      await typeInto(inputByLabel(container, "Brand domain"), "postwave.io");
      await typeInto(inputByLabel(container, "Brand terms"), "Moosewave, PW, , Moosewave Marketing");
      await typeInto(inputByLabel(container, "Probe interval"), "48");
      await typeInto(inputByLabel(container, "Volatility window"), "21");
      // Turn Perplexity on (it was off in the fixture).
      const perplexity = [...container.querySelectorAll("label")].find((l) =>
        (l.textContent ?? "").trim() === "Perplexity",
      )?.querySelector("input");
      await clickEl(perplexity);
      const pack = container.querySelector<HTMLSelectElement>("select[id$='-pack']");
      await selectValue(pack!, "starter_plus_custom");

      await clickEl(buttonByText(container, "Save brand setup"));
      await settle(4);
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          method: "PUT",
          path: "/api/v1/aeo/settings",
          body: {
            enabled: true,
            brand_domain: "postwave.io",
            brand_terms: ["Moosewave", "PW", "Moosewave Marketing"],
            engines: [
              { key: "chatgpt", enabled: true },
              { key: "gemini", enabled: true },
              { key: "perplexity", enabled: true },
              { key: "grok", enabled: false },
              { key: "copilot", enabled: false },
            ],
            probe_interval_hours: 48,
            probe_prompt_pack: "starter_plus_custom",
            volatility_window_days: 21,
          },
        }),
      ]);
      expect(mocks.toasts).toContainEqual({ level: "success", text: "Brand setup saved" });
    } finally {
      unmount(root);
    }
  });

  it("analytics-6/7: Add competitor → PUT /api/v1/aeo/competitors; Remove → confirm → DELETE /{key}", async () => {
    mocks.whoami.mockResolvedValue(WHOAMI);
    const { calls, container, root } = await mountAeo();
    try {
      await typeInto(inputByLabel(container, "Key"), " Beta ");
      await typeInto(inputByLabel(container, "Display name"), "Beta Send");
      await typeInto(inputByLabel(container, "Terms"), "Beta, BetaSend");
      await typeInto(inputByLabel(container, "Domain"), "beta.io");
      await clickEl(buttonByText(container, "Add competitor"));
      await settle(4);
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          method: "PUT",
          path: "/api/v1/aeo/competitors",
          body: {
            competitor_key: "beta",
            display_name: "Beta Send",
            terms: ["Beta", "BetaSend"],
            domain: "beta.io",
          },
        }),
      ]);
      // Form cleared after success.
      expect(inputByLabel(container, "Key").value).toBe("");

      // Remove: the confirm dialog names the consequence; nothing is sent
      // until it is confirmed.
      await clickEl(buttonByText(container, /^Remove$/));
      await settle(2);
      const dialog = openDialog();
      expect(dialog.textContent).toContain("Remove Acme Mail?");
      expect(dialog.textContent).toContain('deletes the "acme" competitor row');
      expect(writes(calls)).toHaveLength(1);
      await clickEl(buttonByText(dialog, "Remove competitor"));
      await settle(4);
      expect(writes(calls)[1]).toEqual(
        expect.objectContaining({ method: "DELETE", path: "/api/v1/aeo/competitors/acme" }),
      );
    } finally {
      unmount(root);
    }
  });

  it("analytics-8/9: Add prompt → POST {category,prompt_text}; toggle → POST /{id}/toggle {enabled}; Delete → confirm → DELETE /{id}", async () => {
    mocks.whoami.mockResolvedValue(WHOAMI);
    const { calls, container, root } = await mountAeo();
    try {
      const category = container.querySelector<HTMLSelectElement>("select[id$='-category']");
      await selectValue(category!, "comparison");
      const addBtn = buttonByText(container, "Add prompt")!;
      // Guard: too short → button disabled, nothing sent.
      await typeInto(inputByLabel(container, "Prompt"), "abc");
      expect(addBtn.disabled).toBe(true);
      await typeInto(inputByLabel(container, "Prompt"), "  Moosewave vs Acme Mail?  ");
      expect(addBtn.disabled).toBe(false);
      await clickEl(addBtn);
      await settle(4);
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          method: "POST",
          path: "/api/v1/aeo/prompts",
          body: { category: "comparison", prompt_text: "Moosewave vs Acme Mail?" },
        }),
      ]);

      const toggle = container.querySelector<HTMLInputElement>(
        'input[aria-label="Disable prompt: Best email marketing platform for ecommerce?"]',
      );
      await clickEl(toggle);
      await settle(4);
      expect(writes(calls)[1]).toEqual(
        expect.objectContaining({
          method: "POST",
          path: "/api/v1/aeo/prompts/p1/toggle",
          body: { enabled: false },
        }),
      );

      await clickEl(buttonByText(container, /^Delete$/));
      await settle(2);
      const dialog = openDialog();
      expect(dialog.textContent).toContain("Delete this prompt and its probes?");
      expect(dialog.textContent).toContain("every probe recorded for it is deleted with it");
      expect(writes(calls)).toHaveLength(2);
      await clickEl(buttonByText(dialog, "Delete prompt and its probes"));
      await settle(4);
      expect(writes(calls)[2]).toEqual(
        expect.objectContaining({ method: "DELETE", path: "/api/v1/aeo/prompts/p1" }),
      );
      // Delete cascades to probes: the probes list is re-read.
      const tail = calls.slice(-6).filter((c) => c.method === "GET").map((c) => c.path);
      expect(tail).toContain("/api/v1/aeo/probes");
    } finally {
      unmount(root);
    }
  });
});

/* ---------- viewer: gated, sends nothing ------------------------------ */

describe("/app/aeo — viewer", () => {
  it("shows the read-only reason, disables every write verb, and sends no request on click", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    const { calls, container, root } = await mountAeo();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain(
        "Only workspace owners and admins can change AEO Sensor settings",
      );
      // The reads still happen — a viewer can look.
      expect(calls.some((c) => c.path === "/api/v1/aeo/summary")).toBe(true);

      const gated = ["Run probe pass now", "Save brand setup", "Add competitor", "Add prompt"];
      for (const label of gated) {
        const btn = buttonByText(container, label);
        expect(btn, label).toBeDefined();
        expect(btn!.disabled, `${label} disabled`).toBe(true);
        expect(btn!.getAttribute("aria-describedby")).toBe("aeo-write-gate");
        expect(btn!.getAttribute("title")).toContain("Only workspace owners and admins");
      }
      expect(buttonByText(container, /^Remove$/)!.disabled).toBe(true);
      expect(buttonByText(container, /^Delete$/)!.disabled).toBe(true);
      const toggle = container.querySelector<HTMLInputElement>('input[aria-label^="Disable prompt"]');
      expect(toggle?.disabled).toBe(true);
      expect(container.querySelector("#aeo-write-gate")?.textContent).toContain(
        "Only workspace owners and admins",
      );

      // Clicking every one of them sends nothing.
      for (const label of gated) await clickEl(buttonByText(container, label));
      await clickEl(buttonByText(container, /^Remove$/));
      await clickEl(buttonByText(container, /^Delete$/));
      await clickEl(toggle);
      await settle(4);
      expect(writes(calls)).toEqual([]);
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      unmount(root);
    }
  });
});

/* ---------- contract failure is shown as such -------------------------- */

describe("/app/aeo — malformed summary", () => {
  it("renders a contract error, not an empty dashboard", async () => {
    mocks.whoami.mockResolvedValue(WHOAMI);
    const { container, root } = await mountAeo({
      summary: { ...SUMMARY, overall_mention_rate: "0.42" },
    });
    try {
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(
        "Couldn't load AEO Sensor data: AEO summary response was malformed.",
      );
      // No tile pretends to be measured, and the banner is not shown from
      // data that failed the contract.
      const tiles = [...container.querySelectorAll("dl dd")].map((d) => d.textContent);
      expect(tiles).not.toContain("42.4%");
      expect(container.textContent).not.toContain(WARNING_BANNER);
      // The other surfaces still loaded independently.
      expect(container.textContent).toContain("Best email marketing platform for ecommerce?");
    } finally {
      unmount(root);
    }
  });
});
