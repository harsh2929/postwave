// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// messaging-59 — "Run pre-send check on a pasted draft (subject / from / body
// → EQ + voice drift + placement verdict)". The gap was a verdict call that
// posted `{}`; /app/preflight now posts the operator's draft itself, so the
// standalone PresendCheckPanel is NOT mounted a second time on this page. This
// pins that the page's own verdict request carries the draft and that all
// three graded components render from the reply.
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";
import {
  buttonByText,
  clickEl,
  recordingTransport,
  settle,
  typeInto,
} from "./_mount-transport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/preflight",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preflight — pre-send verdict on the pasted draft (messaging-59)", () => {
  it("posts sender, subject and HTML to the verdict and renders all three checks", async () => {
    const { calls } = recordingTransport((req) =>
      req.method === "POST" && req.path === "/api/v1/presend/verdict"
        ? {
            body: {
              verdict: "warn",
              complete: true,
              summary: "One check wants a look.",
              components: [
                { name: "eq_score", status: "ok", score: 82 },
                { name: "voice_drift", status: "warn", score: 61, message: "Tone drifted." },
                { name: "placement", status: "ok", score: 0.9 },
              ],
              computed_at: "2026-09-12T10:00:00Z",
            },
          }
        : undefined,
    );
    const Page = (await import("@/app/(dashboard)/app/preflight/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      await typeInto(
        container.querySelector<HTMLInputElement>("#pf-from")!,
        "news@qa-sender.test",
      );
      await clickEl(buttonByText(container, "Run pre-send checks"));
      await settle();

      const posts = calls.filter(
        (c) => c.method === "POST" && c.path === "/api/v1/presend/verdict",
      );
      expect(posts).toHaveLength(1);
      expect(posts[0].body).toEqual({
        from: "news@qa-sender.test",
        subject: "Your invoice is ready",
        html: '<img src="hero.png">',
      });

      const section = container
        .querySelector("#pf-verdict")!
        .closest("section")!;
      const text = section.textContent ?? "";
      expect(text).toContain("One check wants a look.");
      expect(text).toContain("eq score");
      expect(text).toContain("voice drift");
      expect(text).toContain("placement");
    } finally {
      unmount(root);
    }
  });
});
