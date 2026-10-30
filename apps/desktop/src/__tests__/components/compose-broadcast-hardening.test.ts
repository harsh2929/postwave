// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import {
  emailBodyPreview,
  normalizeBroadcastResponse,
} from "../../components/ai/ComposeBroadcastForm";

describe("Compose broadcast trust boundaries", () => {
  it("accepts only bounded complete drafts and canonicalizes subject options", () => {
    expect(normalizeBroadcastResponse(null)).toBeNull();
    expect(
      normalizeBroadcastResponse({
        primary: { name: "Draft", subject: "", body: "Body" },
        subject_variants: [],
      }),
    ).toBeNull();
    expect(
      normalizeBroadcastResponse({
        primary: {
          name: "Draft",
          subject: "Subject",
          body: "x".repeat(200_001),
        },
        subject_variants: [],
      }),
    ).toBeNull();

    const result = normalizeBroadcastResponse({
      primary: {
        name: "Draft",
        subject: " Primary subject ",
        body: "Complete body",
      },
      subject_variants: [
        "primary subject",
        "Option two",
        "OPTION TWO",
        "Option three",
        "Option four",
        "Option five",
        "Option six",
      ],
      generated_at: "2026-08-08T00:00:00Z",
    });

    expect(result).toEqual({
      primary: {
        name: "Draft",
        subject: "Primary subject",
        body: "Complete body",
      },
      subject_variants: [
        "Primary subject",
        "Option two",
        "Option three",
        "Option four",
        "Option five",
      ],
      generated_at: "2026-08-08T00:00:00Z",
    });
  });

  it("projects HTML as visible text without executable or hidden document content", () => {
    const rawBody =
      "<style>.secret{display:none}</style><script>stealToken()</script>" +
      "<template>hidden template</template><noscript>hidden fallback</noscript>" +
      '<h1>Hello&nbsp;team</h1><p><a href="javascript:steal()">Review the launch.</a></p>';
    const preview = emailBodyPreview(rawBody);
    const normalized = normalizeBroadcastResponse({
      primary: { name: "Draft", subject: "Launch", body: rawBody },
      subject_variants: [],
    });

    expect(preview).toContain("Hello team");
    expect(preview).toContain("Review the launch.");
    expect(preview).not.toContain("stealToken");
    expect(preview).not.toContain("display:none");
    expect(preview).not.toContain("hidden template");
    expect(preview).not.toContain("hidden fallback");
    expect(normalized?.primary.body).toBe("Hello team\n\nReview the launch.");
    expect(normalized?.primary.body).not.toContain("javascript:");
  });

  it("bounds display projections while preserving an explicit truncation disclosure", () => {
    const preview = emailBodyPreview("a".repeat(25_000));

    expect(preview.length).toBeLessThan(21_000);
    expect(preview).toContain("Preview truncated");
    expect(preview).toContain(
      "complete normalized draft is preserved for copy and handoff",
    );
  });
});
