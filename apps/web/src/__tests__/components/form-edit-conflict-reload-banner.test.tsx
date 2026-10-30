// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// 412 recovery (desktop FormDetailSlideover "Reload current version"). With no
// unsaved draft the reload goes straight to GET /api/v1/forms/{id} and hands
// back the server copy; with a draft it confirms the discard first (covered
// end to end in form-spam-protection-card.test.tsx); a failed reload renders
// the server's sentence and keeps the banner up.
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditConflictReloadBanner } from "@/components/forms/edit-conflict-reload-banner";

import {
  button,
  click,
  eventually,
  json,
  mount,
  stubFetch,
  unmountAll,
  type RecordedCall,
} from "../helpers/forms-extras-harness";

const PATH = "/api/v1/forms/form_9";
let calls: RecordedCall[];
let fail: boolean;

beforeEach(() => {
  fail = false;
  ({ calls } = stubFetch((call) => {
    if (call.path !== PATH || call.method !== "GET") return undefined;
    return fail
      ? json({ error: { code: "not_found", message: "no such form" } }, { status: 404 })
      : json({ id: "form_9", name: "Latest", updatedAt: "2026-09-12T00:00:00Z" }, { etag: '"v9"' });
  }));
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("EditConflictReloadBanner", () => {
  it("reloads the latest version directly when nothing unsaved would be lost", async () => {
    const onReloaded = vi.fn();
    mount(
      createElement(EditConflictReloadBanner, {
        formId: "form_9",
        hasUnsavedChanges: false,
        onReloaded,
      }),
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "your save was not applied",
    );

    await click(button("Reload latest version"));
    await eventually(() => expect(onReloaded).toHaveBeenCalledTimes(1));
    expect(onReloaded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "form_9", name: "Latest" }),
    );
    expect(calls.filter((c) => c.path === PATH && c.method === "GET")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Discard your changes");
  });

  it("renders the server's sentence when the reload fails", async () => {
    fail = true;
    const onReloaded = vi.fn();
    mount(
      createElement(EditConflictReloadBanner, {
        formId: "form_9",
        hasUnsavedChanges: false,
        onReloaded,
      }),
    );
    await click(button("Reload latest version"));
    await eventually(() =>
      expect(document.body.textContent).toContain("no such form"),
    );
    expect(onReloaded).not.toHaveBeenCalled();
    expect(button("Reload latest version").disabled).toBe(false);
  });
});
