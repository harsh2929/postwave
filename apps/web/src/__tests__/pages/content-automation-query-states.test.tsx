// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, stubTransport, unmount, WHOAMI } from "./_harness";

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

const ROUTES: Array<{
  name: string;
  load: () => Promise<ComponentType>;
  falseEmptyCopy: string[];
}> = [
  {
    name: "onsite growth",
    load: async () =>
      (await import("@/app/(dashboard)/app/onsite-growth/page")).default,
    falseEmptyCopy: ["No onsite capabilities are offered by this build."],
  },
  {
    name: "social capture",
    load: async () =>
      (await import("@/app/(dashboard)/app/social-capture/page")).default,
    falseEmptyCopy: [
      "No networks offered by this build.",
      "No tap-to-text rules yet.",
      "No auto-replies configured.",
      "No leads captured from social replies yet.",
    ],
  },
  {
    name: "assets",
    load: async () =>
      (await import("@/app/(dashboard)/app/assets/page")).default,
    falseEmptyCopy: ["No assets uploaded yet."],
  },
  {
    name: "content library",
    load: async () =>
      (await import("@/app/(dashboard)/app/content-library/page")).default,
    falseEmptyCopy: ["No collections yet.", "No saved blocks yet."],
  },
  {
    name: "content quality",
    load: async () =>
      (await import("@/app/(dashboard)/app/content-quality/page")).default,
    falseEmptyCopy: [
      "No campaigns were sent",
      "No templates have enough sends to be ranked.",
      "No AI regression run has ever completed.",
    ],
  },
  {
    name: "AI quality",
    load: async () =>
      (await import("@/app/(dashboard)/app/ai-quality/page")).default,
    falseEmptyCopy: ["No golden examples yet.", "No regression runs yet."],
  },
  {
    name: "translations",
    load: async () =>
      (await import("@/app/(dashboard)/app/translations/page")).default,
    falseEmptyCopy: ["No translation entries yet."],
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content and automation query states", () => {
  it.each(ROUTES)(
    "$name exposes request failures without presenting them as empty data",
    async ({ load, falseEmptyCopy }) => {
      stubTransport("error");
      const Page = await load();
      const { container, root } = await renderPage(Page);
      try {
        expect(
          container.querySelectorAll('[role="alert"]').length,
        ).toBeGreaterThan(0);
        expect(
          Array.from(container.querySelectorAll("button")).some(
            (button) => button.textContent?.trim() === "Retry",
          ),
        ).toBe(true);
        for (const copy of falseEmptyCopy) {
          expect(container.textContent).not.toContain(copy);
        }
      } finally {
        unmount(root);
      }
    },
  );
});
