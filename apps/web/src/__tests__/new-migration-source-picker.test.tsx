import { describe, expect, it, vi } from "vitest";

// The bare `/app/migrations/new` route no longer renders a second, drift-prone
// source picker — it redirects to the single capability-driven index (MIGR-016).
const mocks = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

import NewMigrationRedirectPage from "@/app/(dashboard)/app/migrations/new/page";

describe("bare /app/migrations/new", () => {
  it("redirects to the canonical migrations index", () => {
    NewMigrationRedirectPage();
    expect(mocks.redirect).toHaveBeenCalledWith("/app/migrations");
  });
});
