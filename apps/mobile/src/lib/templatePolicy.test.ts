/**
 * The template eligibility gate, the derived clone name, and the error
 * vocabulary — driven against the Go source they mirror.
 *
 * The gate is the part worth pinning hardest. It decides whether a row offers
 * two verbs or explains a refusal, and it is a LOCAL COPY of a server check
 * (`ValidateTemplateEligibility`, campaigntemplates.go:1092, plus the reference
 * refusal in `cloneCreateInput`, extras.go:198-203). A local copy of a remote
 * rule rots silently: nothing fails, the screen simply starts offering buttons
 * whose only outcome is a 422 — or, worse, hiding verbs that would have worked.
 * So every branch below is written as "what would the server do", not as "what
 * does this function currently return".
 */
import { describe, expect, it } from "vitest";

import { parseTemplate, type MobileTemplate } from "./templateCatalog";
import {
  cloneNameSuggestion,
  templateActionErrorMessage,
  templateActionGate,
  templateCloneConfirm,
  templatePlaceholderNotice,
  TEMPLATE_MAX_NAME_BYTES,
} from "./templatePolicy";

/**
 * A row as `Repo.Search` marshals one. The three fields the gate reads are all
 * `omitempty` strings backed by NOT NULL columns with defaults
 * (`template_kind` 'editable', `review_status` 'approved',
 * `source_license_status` 'owned' — migration 1748:11, :24, :18), so the
 * default fixture is the eligible case.
 */
function template(overrides: Record<string, unknown> = {}): MobileTemplate {
  const parsed = parseTemplate({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "spring-launch",
    name: "Spring launch",
    subject: "The spring drop is live",
    variables: [],
    tags: [],
    template_kind: "editable",
    review_status: "approved",
    source_license_status: "owned",
    ...overrides,
  });
  if (!parsed) throw new Error("fixture failed to parse");
  return parsed;
}

describe("templateActionGate", () => {
  it("allows an approved, owned, editable template — the only case the server allows", () => {
    const gate = templateActionGate(template());
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeNull();
    // Nothing to say when there is nothing to refuse.
    expect(gate.message).toBe("");
    expect(gate.badge).toBe("");
  });

  it("treats an omitted template_kind as editable, exactly as canonicalTemplateKind does", () => {
    // `canonicalTemplateKind` maps "" -> "editable" (campaigntemplates.go:1065),
    // and `template_kind` carries omitempty, so a "" on the wire is not a
    // reason to refuse.
    expect(templateActionGate(template({ template_kind: "" })).allowed).toBe(
      true,
    );
  });

  it("refuses a reference record, which the server refuses for BOTH verbs", () => {
    // Clone -> ErrReferenceCloneBlocked (extras.go:202);
    // create-campaign -> 422 adaptation_required (workflows.go:538-540).
    const gate = templateActionGate(template({ template_kind: "reference" }));
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("reference");
    expect(gate.badge).toBe("Reference");
    expect(gate.message).toMatch(/adapt/i);
  });

  it("refuses anything the CHECK constraint does not name, rather than guessing", () => {
    // campaign_templates_kind_chk allows exactly editable|reference
    // (1748:33). A third value can only mean this build is older than the
    // server, and an app that guesses there builds the wrong thing.
    const gate = templateActionGate(template({ template_kind: "storyboard" }));
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("unknown_kind");
  });

  it("separates 'waiting on review' from 'rejected', which are different next steps", () => {
    const pending = templateActionGate(template({ review_status: "pending" }));
    expect(pending.allowed).toBe(false);
    expect(pending.reason).toBe("pending_review");

    const rejected = templateActionGate(template({ review_status: "rejected" }));
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toBe("rejected");
  });

  it("refuses an unreviewed licence, matching the exact string the server compares", () => {
    // ValidateTemplateEligibility requires SourceLicenseStatus == "owned"
    // verbatim; "personal-use-unreviewed" is the other value the package
    // defines (campaigntemplates.go:238).
    const gate = templateActionGate(
      template({ source_license_status: "personal-use-unreviewed" }),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("unlicensed");
  });

  it("reports the reference refusal ahead of a review one, and refuses either way", () => {
    // The server would call this template_ineligible (it validates review and
    // licence before the reference check). The VERDICT is what has to match —
    // and "adapt it on desktop" is the only actionable sentence of the two.
    const gate = templateActionGate(
      template({ template_kind: "reference", review_status: "pending" }),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("reference");
  });

  it("fails closed on a missing template instead of offering a verb", () => {
    expect(templateActionGate(null).allowed).toBe(false);
    expect(templateActionGate(undefined).allowed).toBe(false);
  });

  it("is case- and whitespace-insensitive, as every Go comparison here is", () => {
    // canonicalTemplateKind lowercases + trims; review/licence are compared
    // against lowercase constants written by the DB defaults.
    expect(
      templateActionGate(
        template({
          template_kind: " Editable ",
          review_status: " APPROVED ",
          source_license_status: "Owned",
        }),
      ).allowed,
    ).toBe(true);
  });
});

describe("cloneNameSuggestion", () => {
  it("appends the suffix cloneCopyName appends", () => {
    expect(cloneNameSuggestion("Spring launch")).toBe("Spring launch (copy)");
  });

  it("trims first, exactly as strings.TrimSpace does", () => {
    expect(cloneNameSuggestion("  Spring launch  ")).toBe(
      "Spring launch (copy)",
    );
  });

  it("keeps the whole result inside MaxNameLength", () => {
    const suggested = cloneNameSuggestion("x".repeat(400));
    expect(suggested.endsWith(" (copy)")).toBe(true);
    expect(suggested.length).toBe(TEMPLATE_MAX_NAME_BYTES);
  });

  it("truncates by BYTES, so a multi-byte name is not silently over the limit", () => {
    // Go slices `base[:MaxNameLength-len(suffix)]` and then walks back to a
    // valid rune boundary. A JavaScript `.length` truncation would leave a
    // 3-byte-per-character name at ~579 bytes and disagree with the server.
    const suggested = cloneNameSuggestion("あ".repeat(200));
    const bytes = new TextEncoder().encode(suggested).length;
    expect(bytes).toBeLessThanOrEqual(TEMPLATE_MAX_NAME_BYTES);
    // 193 usable bytes / 3 bytes per character = 64 whole characters.
    expect(suggested).toBe(`${"あ".repeat(64)} (copy)`);
  });

  it("never splits a character in half while truncating", () => {
    const suggested = cloneNameSuggestion("😀".repeat(100));
    expect(suggested).not.toContain("�");
    expect([...suggested].every((ch) => ch !== "\uD83D")).toBe(true);
  });

  it("falls back to 'Template' when the source name is only whitespace", () => {
    // Mirrors `if base == "" { base = "Template" }` (extras.go:275).
    expect(cloneNameSuggestion("   ")).toBe("Template (copy)");
    expect(cloneNameSuggestion("")).toBe("Template (copy)");
  });
});

describe("templateCloneConfirm", () => {
  it("names the copy the server will create, before it exists", () => {
    const confirm = templateCloneConfirm(template());
    expect(confirm.consequence).toContain("Spring launch (copy)");
    expect(confirm.confirmLabel).toBe("Duplicate");
  });

  it("says the clone cannot be undone from here, because it cannot", () => {
    // DELETE /campaign-templates/{id} is deliberately absent from the mobile
    // API module, so this is the operator's only warning.
    expect(templateCloneConfirm(template()).consequence).toMatch(/desktop/i);
  });

  it("carries no typed-phrase gate — this is a confirm, not an escalation", () => {
    expect("confirmPhrase" in templateCloneConfirm(template())).toBe(false);
  });
});

describe("templatePlaceholderNotice", () => {
  it("says nothing when the design has no placeholders to leave unfilled", () => {
    expect(templatePlaceholderNotice(template())).toBeNull();
  });

  it("warns that placeholders fall back to the template's own defaults", () => {
    // `substitute` leaves {{name}} VERBATIM when the value is nil
    // (workflows.go:718-720), and mobile supplies no values at all — so a
    // draft can carry "{{first_name}}" into a subject line.
    const notice = templatePlaceholderNotice(
      template({ variables: [{ name: "first_name" }] }),
    );
    expect(notice).toContain("1 placeholder");
    expect(notice).toContain("first_name");
  });

  it("lists at most three and counts the rest, rather than growing without bound", () => {
    const notice = templatePlaceholderNotice(
      template({
        variables: ["a", "b", "c", "d", "e"].map((name) => ({ name })),
      }),
    );
    expect(notice).toContain("5 placeholders");
    expect(notice).toContain("a, b, c and 2 more");
  });
});

describe("templateActionErrorMessage", () => {
  it("distinguishes the three 422s that mean three different things", () => {
    const ineligible = templateActionErrorMessage(
      { status: 422, code: "template_ineligible" },
      "fallback",
    );
    const referenceClone = templateActionErrorMessage(
      { status: 422, code: "reference_clone_blocked" },
      "fallback",
    );
    const adaptation = templateActionErrorMessage(
      { status: 422, code: "adaptation_required" },
      "fallback",
    );
    expect(new Set([ineligible, referenceClone, adaptation]).size).toBe(3);
    expect(referenceClone).toMatch(/duplicated/i);
    expect(adaptation).toMatch(/campaign/i);
  });

  it("explains the 409 the clone endpoint returns for a slug collision", () => {
    expect(
      templateActionErrorMessage({ status: 409, code: "slug_conflict" }, "x"),
    ).toMatch(/already exists/i);
  });

  it("reads a 403 as a role problem, which is what the scope middleware means", () => {
    expect(templateActionErrorMessage({ status: 403 }, "x")).toMatch(/role/i);
  });

  it("falls back to the caller's sentence rather than surfacing nothing", () => {
    expect(templateActionErrorMessage({}, "Couldn't duplicate that.")).toBe(
      "Couldn't duplicate that.",
    );
    expect(templateActionErrorMessage(null, "Couldn't duplicate that.")).toBe(
      "Couldn't duplicate that.",
    );
  });

  it("prefers a real Error message over a generic fallback", () => {
    expect(
      templateActionErrorMessage(new Error("Network request failed"), "x"),
    ).toBe("Network request failed");
  });
});
