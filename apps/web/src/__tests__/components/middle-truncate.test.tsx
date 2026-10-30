// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A truncated address has to stay distinguishable from the next one.
//
// At 1,440 px the contacts directory rendered every verification address as
// "verify-check…": the rows were identical on screen and the full value was
// nowhere, not even in a tooltip. What tells such addresses apart is their end,
// so the end is what must survive.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { InlineEmailRename } from "@/components/subscribers/InlineEmailRename";
import {
  MIDDLE_TRUNCATE_TAIL,
  splitForMiddleTruncation,
} from "@/components/ui/middle-truncate";
import type { Subscriber } from "@/lib/subscribers-api";

const LONG = "verify-check-38f1c2@example.com";

let host: HTMLElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

function renderEmail(email: string): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const subscriber = {
    id: "11111111-2222-4333-8444-555555555555",
    email,
    status: "enabled",
    custom_fields: {},
    tags: [],
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  } as unknown as Subscriber;
  act(() => {
    root.render(
      <InlineEmailRename
        subscriber={subscriber}
        canWrite={false}
        onRenamed={() => undefined}
      />,
    );
  });
  return host;
}

describe("splitForMiddleTruncation", () => {
  it("keeps the tail and leaves the head to be ellipsized", () => {
    const { head, tail } = splitForMiddleTruncation(LONG);
    expect(head + tail).toBe(LONG);
    expect(tail).toHaveLength(MIDDLE_TRUNCATE_TAIL);
    // The kept tail carries the domain, which is what a shared prefix hides.
    expect(tail).toContain("@example.com");
  });

  it("leaves a short value in one piece, so it is never pinned unshrinkable", () => {
    expect(splitForMiddleTruncation("a@b.co")).toEqual({ head: "a@b.co", tail: "" });
    expect(splitForMiddleTruncation(LONG, 0)).toEqual({ head: LONG, tail: "" });
  });

  it("two addresses from one template differ in the part that is kept", () => {
    const first = splitForMiddleTruncation("verify-check-000001@example.com").tail;
    const second = splitForMiddleTruncation("verify-check-000002@example.com").tail;
    expect(first).not.toBe(second);
  });
});

describe("the directory's email cell", () => {
  it("offers the whole address and never truncates its end", () => {
    const rendered = renderEmail(LONG);
    const titled = rendered.querySelector(`[title="${LONG}"]`);
    expect(titled).not.toBeNull();
    const spans = [...(titled?.querySelectorAll("span") ?? [])];
    expect(spans.map((span) => span.textContent).join("")).toBe(LONG);
    // The head shrinks and ellipsizes; the tail does neither.
    expect(spans[0]?.className).toContain("truncate");
    expect(spans.at(-1)?.className).toContain("shrink-0");
    expect(spans.at(-1)?.textContent).toBe(
      LONG.slice(LONG.length - MIDDLE_TRUNCATE_TAIL),
    );
  });

  it("renders a short address as one piece", () => {
    const rendered = renderEmail("a@b.co");
    expect(rendered.textContent).toBe("a@b.co");
  });
});
