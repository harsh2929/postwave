// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// CreateWritebackForm had NEITHER a test nor a page that renders it — it is
// mounted only by WritebackTargetsPanel, which was itself untested, so nothing
// in the suite executed a line of it. Its 17 controls, the provider
// availability filter and the two dynamic key/value editors were all unproven.
//
// This is a props-only component, so the transport stays the fixture one: it
// issues no request until submit, and a submit here 404s (no fixture), which is
// exactly the failure path the form's error branch is for.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Segment } from "@/lib/segments-api";
import type { WritebackProvider } from "@/lib/writeback-api";

import {
  clickEveryControl,
  renderPage,
  stubFixtureTransport,
  unmount,
} from "../pages/_harness";

const PROVIDERS: WritebackProvider[] = [
  { provider: "shopify", available: true },
  { provider: "hubspot", available: true },
  // Deliberately unavailable: the form must filter it out of the <select> AND
  // show the "some providers are hidden" note because of it.
  { provider: "klaviyo", available: false },
];

const SEGMENTS: Segment[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "t_test",
    name: "VIP buyers",
    description: "high value",
    queryAst: { op: "and", children: [] },
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    tenantId: "t_test",
    name: "Lapsed 90d",
    description: "",
    queryAst: { op: "and", children: [] },
    createdAt: "2026-07-02T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
  },
];

interface FormProps {
  providers: WritebackProvider[];
  segments: Segment[];
  segmentsLoaded: boolean;
  onCreated: () => void | Promise<void>;
}

function props(overrides: Partial<FormProps> = {}): FormProps {
  return {
    providers: PROVIDERS,
    segments: SEGMENTS,
    segmentsLoaded: true,
    onCreated: vi.fn(),
    ...overrides,
  };
}

/** Presses both "+ Add ..." buttons `n` times, so each editor holds n rows. */
async function addRows(container: HTMLElement, n: number) {
  const adders = [...container.querySelectorAll("button")].filter((b) =>
    /^\+ Add /.test(b.textContent ?? ""),
  );
  expect(adders).toHaveLength(2);
  for (let i = 0; i < n; i++) {
    await act(async () => {
      for (const b of adders) b.click();
    });
  }
}

async function form() {
  return (await import("@/components/integrations/writeback-create-form"))
    .CreateWritebackForm;
}

beforeEach(() => {
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CreateWritebackForm", () => {
  it("offers only the AVAILABLE providers and says why the others are missing", async () => {
    const CreateWritebackForm = await form();
    const { container, root } = await renderPage(CreateWritebackForm, props());
    try {
      const select = container.querySelector<HTMLSelectElement>("#wb-provider");
      expect(select).not.toBeNull();
      const options = [...select!.querySelectorAll("option")].map(
        (o) => o.textContent,
      );
      // Fails if the `.available` filter is dropped (3 options), or if
      // providerLabel() stops mapping ids to display names ("shopify").
      expect(options).toEqual(["Shopify", "HubSpot"]);
      expect(container.textContent).toContain(
        "Some providers are hidden",
      );
      // The submit is live because at least one adapter is available.
      const submit = container.querySelector<HTMLButtonElement>(
        "button[type='submit']",
      );
      expect(submit?.disabled).toBe(false);
      expect(submit?.textContent).toBe("Create write-back target");
    } finally {
      unmount(root);
    }
  });

  it("disables submit and explains when no adapter is configured", async () => {
    const CreateWritebackForm = await form();
    const { container, root } = await renderPage(
      CreateWritebackForm,
      props({ providers: [{ provider: "klaviyo", available: false }] }),
    );
    try {
      expect(container.textContent).toContain(
        "No write-back adapters are configured on this server.",
      );
      const submit = container.querySelector<HTMLButtonElement>(
        "button[type='submit']",
      );
      expect(submit?.disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });

  it("lists every segment in the source picker and offers a list-id input instead", async () => {
    const CreateWritebackForm = await form();
    const { container, root } = await renderPage(CreateWritebackForm, props());
    try {
      const select = container.querySelector<HTMLSelectElement>(
        "#wb-source-segment",
      );
      const options = [...select!.querySelectorAll("option")].map(
        (o) => o.textContent,
      );
      expect(options).toEqual([
        "Select a segment...",
        "VIP buyers",
        "Lapsed 90d",
      ]);
      // The list-id input is the OTHER branch of the same slot; it must not be
      // mounted while the segment radio is selected.
      expect(container.querySelector("#wb-source-list")).toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("tells the operator when there are no segments to pick", async () => {
    const CreateWritebackForm = await form();
    const { container, root } = await renderPage(
      CreateWritebackForm,
      props({ segments: [], segmentsLoaded: true }),
    );
    try {
      expect(container.textContent).toContain("No segments yet");
    } finally {
      unmount(root);
    }
  });

  it("does not claim 'no segments' while the segments are still loading", async () => {
    const CreateWritebackForm = await form();
    const { container, root } = await renderPage(
      CreateWritebackForm,
      props({ segments: [], segmentsLoaded: false }),
    );
    try {
      // Guarding on `segments.length === 0` alone would flash this message on
      // every mount before the query resolves.
      expect(container.textContent).not.toContain("No segments yet");
    } finally {
      unmount(root);
    }
  });

  it("survives pressing every control, and the add buttons really add rows", async () => {
    const CreateWritebackForm = await form();
    const { container, root } = await renderPage(CreateWritebackForm, props());
    try {
      const before = container.querySelectorAll(
        "input[aria-label*='platform_field']",
      ).length;
      expect(before).toBe(0);

      const { clicked, failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
      // "+ Add static field", "+ Add trait mapping", submit.
      expect(clicked).toBeGreaterThanOrEqual(3);

      // Falsifiable: if either KeyValueEditor's onChange were wired to the
      // wrong setter (a copy/paste both editors invite), one of these stays 0.
      expect(
        container.querySelectorAll(
          "input[aria-label='Static field platform_field (row 1)']",
        ).length,
      ).toBe(1);
      expect(
        container.querySelectorAll(
          "input[aria-label='Trait mapping platform_field (row 1)']",
        ).length,
      ).toBe(1);
      expect(
        container.querySelectorAll(
          "input[aria-label='Static field constant value (e.g. optin) (row 1)']",
        ).length,
      ).toBe(1);
      expect(
        container.querySelectorAll(
          "input[aria-label='Trait mapping trait key (e.g. lifetime_value) (row 1)']",
        ).length,
      ).toBe(1);
    } finally {
      unmount(root);
    }
  });

  it("gives every row control a UNIQUE accessible name across both editors", async () => {
    const CreateWritebackForm = await form();
    const { container, root } = await renderPage(CreateWritebackForm, props());
    try {
      // Two rows in each editor: enough for row numbering to matter.
      await addRows(container, 2);

      const named = [
        ...container.querySelectorAll<HTMLElement>(
          "input[aria-label], button[aria-label]",
        ),
      ].map((el) => el.getAttribute("aria-label") ?? "");

      // Both editors are passed keyPlaceholder="platform_field", so a name
      // derived from the placeholder alone collides: "platform_field (row 1)"
      // would answer for the static-fields key AND the trait-mapping key.
      expect(named.length).toBe(12); // 2 rows x (key + value + remove) x 2
      expect(new Set(named).size).toBe(named.length);

      // Every remove button is destructive, so none may share a name with
      // another: "Remove row" x4 gives a screen-reader user no way to tell
      // which row - or which section - a press would delete.
      const removes = [
        ...container.querySelectorAll<HTMLButtonElement>("button[aria-label]"),
      ].map((el) => el.getAttribute("aria-label"));
      expect(removes.sort()).toEqual([
        "Remove Static field row 1",
        "Remove Static field row 2",
        "Remove Trait mapping row 1",
        "Remove Trait mapping row 2",
      ]);
    } finally {
      unmount(root);
    }
  });

  it("heads each key/value editor with a legend rather than an orphan label", async () => {
    const CreateWritebackForm = await form();
    const { container, root } = await renderPage(CreateWritebackForm, props());
    try {
      // A <label> with neither htmlFor nor a nested control labels nothing;
      // each of these headings sits over a whole editor, not one input.
      const orphans = [...container.querySelectorAll("label")].filter(
        (el) => !el.getAttribute("for") && !el.querySelector("input, select, textarea"),
      );
      expect(orphans.map((el) => el.textContent?.trim())).toEqual([]);

      const legends = [...container.querySelectorAll("fieldset > legend")].map(
        (el) => el.textContent?.trim(),
      );
      expect(legends).toEqual([
        "Static fields (platform field -> constant value)",
        "Trait mapping (platform field -> Moosewave trait)",
      ]);
    } finally {
      unmount(root);
    }
  });
});
