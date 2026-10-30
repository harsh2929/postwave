/**
 * lib/templatePolicy.ts — can this template be used, and what happens if it is.
 *
 * Import-free on purpose (no react-native, no expo), so every decision below is
 * exercised in the node vitest environment rather than asserted by hand in a
 * render test.
 *
 * THE ONE GATE, TWO VERBS. Both mobile verbs run the SAME server-side check
 * before anything happens:
 *
 *   `ValidateTemplateEligibility` (campaigntemplates.go:1092)
 *     → `canonicalTemplateKind(kind)` must resolve ("" and "editable" both mean
 *       editable; "reference" is valid; anything else is rejected),
 *     → `review_status` must be exactly "approved",
 *     → `source_license_status` must be exactly "owned".
 *
 * and then each verb adds the same extra refusal for reference records:
 * `Repo.Clone` → `ErrReferenceCloneBlocked` (422 `reference_clone_blocked`,
 * extras.go:202) and `CreateCampaignFromTemplate` → 422 `adaptation_required`
 * (workflows.go:538). So the gate is one predicate and the two verbs differ
 * only in what they say when it fails.
 *
 * WHY THE PHONE EVALUATES IT AT ALL. Every one of those refusals is a 422 after
 * a round trip. A library screen that offers "Start a campaign" on a row that
 * cannot produce one is a button whose only outcome is an error toast — and the
 * reference-library rows (imported competitor designs, migration 1748) are a
 * large and permanent part of this catalogue, not an edge case. Deciding here
 * means the row can say WHY, and say it before the tap.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never treats an unrecognised
 * kind/status as usable. An app that ships before a server enum grows must fail
 * closed and point at desktop, not guess.
 */
import type { MobileTemplate } from "@/lib/templateCatalog";

/** Mirrors `MaxNameLength` (campaigntemplates.go:243). */
export const TEMPLATE_MAX_NAME_BYTES = 200;

/** `canonicalTemplateKind` accepts exactly these; "" collapses to editable. */
const EDITABLE_KINDS = new Set(["", "editable"]);
const REFERENCE_KIND = "reference";

export type TemplateBlockReason =
  | "reference"
  | "pending_review"
  | "rejected"
  | "unlicensed"
  | "unknown_kind";

export interface TemplateActionGate {
  /** True when both mobile verbs would pass the server's eligibility check. */
  allowed: boolean;
  reason: TemplateBlockReason | null;
  /** Shown on the row and in the sheet. Empty when `allowed`. */
  message: string;
  /** Short pill label for the row. Empty when `allowed`. */
  badge: string;
}

const ALLOWED: TemplateActionGate = {
  allowed: true,
  reason: null,
  message: "",
  badge: "",
};

const BLOCKED: Record<TemplateBlockReason, Omit<TemplateActionGate, "allowed">> =
  {
    reference: {
      reason: "reference",
      badge: "Reference",
      message:
        "A reference design, kept for inspiration. The server refuses to duplicate or send one directly — adapt it into an editable template on desktop first.",
    },
    pending_review: {
      reason: "pending_review",
      badge: "In review",
      message:
        "Waiting on review. It becomes usable once someone approves it — reviewing happens on desktop.",
    },
    rejected: {
      reason: "rejected",
      badge: "Rejected",
      message: "Rejected in review, so nothing can be built from it.",
    },
    unlicensed: {
      reason: "unlicensed",
      badge: "Licence unclear",
      message:
        "Its licence has not been cleared for this workspace, so it cannot be sent from here.",
    },
    unknown_kind: {
      reason: "unknown_kind",
      badge: "Unsupported",
      message:
        "This app doesn't recognise what kind of template this is. Open it on desktop rather than risk building the wrong thing from it.",
    },
  };

/**
 * The server's eligibility check, evaluated locally.
 *
 * `allowed` matches `ValidateTemplateEligibility` + the reference refusal
 * exactly: a template passes here if and only if it would pass there. The
 * REASON ordering deliberately does not match the Go control flow. On the
 * server the reference refusal comes AFTER the review/licence check
 * (`cloneCreateInput` calls `ValidateTemplateEligibility` first, extras.go:198),
 * so a reference record that is also awaiting review is reported as
 * `template_ineligible`. Here "reference" is checked first, because it is the
 * only one of the two an operator can act on — "adapt it on desktop" is a next
 * step, "approve it" is not one anybody would want for a competitor's email.
 * The verdict is identical either way; only the sentence differs.
 */
export function templateActionGate(
  template: MobileTemplate | null | undefined,
): TemplateActionGate {
  if (!template) return { allowed: false, ...BLOCKED.unknown_kind };
  const kind = template.templateKind.trim().toLowerCase();
  if (kind === REFERENCE_KIND) return { allowed: false, ...BLOCKED.reference };
  if (!EDITABLE_KINDS.has(kind)) {
    return { allowed: false, ...BLOCKED.unknown_kind };
  }
  const review = template.reviewStatus.trim().toLowerCase();
  if (review === "rejected") return { allowed: false, ...BLOCKED.rejected };
  if (review !== "approved") {
    return { allowed: false, ...BLOCKED.pending_review };
  }
  if (template.licenseStatus.trim().toLowerCase() !== "owned") {
    return { allowed: false, ...BLOCKED.unlicensed };
  }
  return ALLOWED;
}

/**
 * UTF-8 byte length. Go truncates names by BYTES, so a JavaScript `.length`
 * (UTF-16 units) would disagree with the server on any non-ASCII name.
 */
function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** The longest whole-character prefix of `value` that fits in `limit` bytes. */
function truncateUtf8(value: string, limit: number): string {
  let bytes = 0;
  let out = "";
  for (const character of value) {
    const size = utf8Length(character);
    if (bytes + size > limit) break;
    bytes += size;
    out += character;
  }
  return out;
}

/**
 * What the server will name the duplicate, computed the way the server does.
 *
 * Mobile sends a BARE clone POST (no body): `Deps.Clone` decodes with
 * `AllowEmptyBody`, and an omitted slug gets a collision-resistant
 * `-copy-XXXXXXXX` suffix, which is the only reliable way to avoid the 409
 * `slug_conflict` this endpoint returns for a duplicate slug. That means the
 * name is derived server-side by `cloneCopyName` (extras.go:258), and this
 * function reproduces it — byte truncation included, because Go truncates by
 * bytes and a UTF-16 `.length` would disagree on any non-ASCII name — so the
 * confirm can show the resulting name before the tap instead of after it.
 *
 * One deliberate imprecision: Go trims with `unicode.IsSpace` and this trims
 * with JavaScript's `String.prototype.trim`, which disagree on a handful of
 * exotic code points (U+0085, U+FEFF). That can shift the PREVIEWED name by a
 * character on a name nobody types; it never changes whether the clone
 * succeeds, which is the only thing the confirm is gating.
 */
export function cloneNameSuggestion(sourceName: string): string {
  const suffix = " (copy)";
  let base = sourceName.trim();
  if (utf8Length(base) > TEMPLATE_MAX_NAME_BYTES - suffix.length) {
    base = truncateUtf8(base, TEMPLATE_MAX_NAME_BYTES - suffix.length).trim();
  }
  if (!base) base = "Template";
  return base + suffix;
}

/** The subset of `ConfirmOptions` this module builds, restated import-free. */
export interface TemplateCloneConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  consequence: string;
}

/**
 * The pre-confirm for duplicating a design.
 *
 * WHY A CONFIRM AND NOT AN UNDO. The kit's rule is that a REVERSIBLE action
 * gets a toast with undo and no dialog. This one is not reversible from here:
 * `DELETE /campaign-templates/{id}` is deliberately absent from the mobile API
 * module (see the header of api/campaignTemplates.ts), so a clone made by a
 * mis-tap can only be cleaned up on desktop, and it lands in a library the
 * operator then has to go hunting through to find it.
 *
 * NO TYPED-PHRASE GATE. That escalation is for irreversible, high-blast-radius
 * actions; an extra row in a template library is neither. The cost paid here is
 * one tap, and what it buys is the derived name shown BEFORE it exists.
 *
 * "Start a campaign" deliberately has no confirm: it navigates straight to the
 * draft it created, so its result is self-evident and reachable, which is
 * exactly what this one is not.
 */
export function templateCloneConfirm(
  template: MobileTemplate,
): TemplateCloneConfirm {
  return {
    title: "Duplicate this design?",
    message:
      "An editable copy is added to this workspace's templates. Nothing is sent, and the original is untouched.",
    confirmLabel: "Duplicate",
    cancelLabel: "Cancel",
    // The server derives both name and slug when the body is omitted, so this
    // is the one chance to show what the copy will actually be called.
    consequence: `Saved as “${cloneNameSuggestion(template.name)}”. Removing it again is a desktop job.`,
  };
}

/**
 * What happens to the template's placeholders when a draft is built from it.
 *
 * `templateValues` seeds every variable from its own `default` and
 * `substitute` then leaves `{{name}}` verbatim wherever that default is null
 * (workflows.go:646 + :712). Mobile supplies no variable values — filling them
 * is authoring, which this surface deliberately does not do — so a draft made
 * here inherits the defaults, blanks and all. Saying that up front is the
 * difference between a useful shortcut and a draft that goes out with
 * "{{first_name}}" in the subject line.
 */
export function templatePlaceholderNotice(
  template: MobileTemplate,
): string | null {
  const names = template.variableNames;
  if (names.length === 0) return null;
  const shown = names.slice(0, 3).join(", ");
  const rest = names.length - Math.min(3, names.length);
  const list = rest > 0 ? `${shown} and ${rest} more` : shown;
  return `Fills ${names.length === 1 ? "1 placeholder" : `${names.length} placeholders`} (${list}) from the template's own defaults. Check the draft before sending.`;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code.trim();
  }
  return "";
}

function errorStatus(error: unknown): number {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return 0;
}

const CODE_MESSAGES: Record<string, string> = {
  not_found: "That template is no longer in this workspace.",
  template_ineligible:
    "The server refused it: a template has to be approved and owned before anything can be built from it.",
  reference_clone_blocked:
    "Reference designs can't be duplicated. Adapt it on desktop instead.",
  adaptation_required:
    "This is a reference design. Adapt it on desktop before a campaign can be started from it.",
  slug_conflict:
    "A template with that address already exists. Rename the copy on desktop.",
  campaigns_unavailable:
    "Campaign creation is switched off on this deployment, so a draft can't be made here.",
  mjml_not_rendered:
    "This design's MJML couldn't be rendered, so a draft can't be built from it.",
  // Unreachable from here — the rail is built only from TEMPLATE_GOALS — but a
  // 400 that arrives anyway means this build's taxonomy no longer matches the
  // server's CHECK constraint, and saying so beats "something went wrong".
  invalid_goal:
    "This app and the server disagree about the goal list. Update the app, or filter on desktop.",
};

/**
 * One sentence for a failed template verb.
 *
 * Branching on the server's `code` rather than on bare HTTP status is the whole
 * point: `template_ineligible`, `reference_clone_blocked` and
 * `adaptation_required` are all 422 and mean three different things, and
 * collapsing them into "Unprocessable" tells the operator nothing they can act
 * on.
 */
export function templateActionErrorMessage(
  error: unknown,
  fallback: string,
): string {
  const known = CODE_MESSAGES[errorCode(error)];
  if (known) return known;
  const status = errorStatus(error);
  if (status === 401) return "Your session expired. Sign in and try again.";
  if (status === 403) return "Your role on this workspace doesn't allow that.";
  if (status === 404) return "That template is no longer in this workspace.";
  if (status === 429) return "Too many requests just now — try again shortly.";
  if (status >= 500) return "The server couldn't complete that. Try again.";
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
