/**
 * segmentCompile — the policy behind "describe an audience in words", read
 * off the Go handler rather than the OpenAPI spec.
 *
 * Contract (apps/api/internal/segments/handlers.go CompileFromText, :185):
 *
 *   POST /api/v1/segments/compile-from-text?engine=rules   (default)
 *     body { text }
 *     200 { ast, engine_used:"rules", query_ast, queryAst, rationale,
 *           suggested_name, suggestedName }
 *     400 text_too_long   — >4096 RUNES, not bytes (utf8.RuneCountInString)
 *     422 unsupported_text — the deterministic compiler did not recognise
 *                            the phrase. This is the documented signal to
 *                            RETRY with engine=ai, which desktop does.
 *
 *   POST /api/v1/segments/compile-from-text?engine=ai
 *     body { text, ai_processing_acknowledged: true }
 *     400 ai_processing_acknowledgement_required when the flag is absent
 *     503 ai_unavailable when no provider is wired on the server
 *     200 additionally carries nutrition_facts + ai_processing
 *
 * AUTHORIZATION. Both compile routes and /preview-count are mounted with
 * `apikeys.RequireScope(apikeys.ScopeReadSubscribers)`
 * (handlers.go:78-79, :120). `read:subscribers` IS in `readOnlyScopes`
 * (apps/api/internal/apikeys/middleware.go:332), so `sessionRoleAllowsScopes`
 * admits EVERY role — describing and previewing an audience is a read.
 * SAVING is `apikeys.RequireScope(apikeys.ScopeWriteSubscribers)`
 * (handlers.go:74), which `editorWriteScopes` extends to owner|admin|editor.
 * That asymmetry is why the sheet lets a viewer explore and only gates the
 * Save button.
 *
 * THE AI STEP IS NEVER AUTOMATIC. A 422 does not silently escalate the
 * operator's prose to a third-party model; the disclosure the server itself
 * publishes (GET /api/v1/segments/compile-from-text) is shown and the retry
 * is a deliberate second tap. The acknowledgement flag is per-request by the
 * handler's own design and is treated that way here.
 *
 * Import-free (no react-native) so every rule above is unit-tested.
 */
import { num } from "@/lib/format";


/** The server's rune cap on a description. */
export const COMPILE_TEXT_MAX_RUNES = 4096;

/**
 * What a phone should actually let someone type. The server accepts 4096
 * runes; a description that long is a document, not a sentence, and the
 * counter exists to tell the user where they are long before the server
 * refuses. Kept well under the server cap so the client never produces a
 * 400 the user cannot diagnose.
 */
export const COMPILE_TEXT_SOFT_MAX = 600;

export type CompileEngine = "rules" | "ai";

export interface CompiledSegmentDraft {
  /** The canonical AST, exactly as returned — passed back verbatim. */
  ast: unknown;
  engineUsed: CompileEngine;
  /** Rules engine only: why it read the phrase that way. */
  rationale: string | null;
  /** Rules engine only: a name proposal the user may keep or replace. */
  suggestedName: string | null;
  /**
   * AI engine only: the server's own provenance envelope. Rendered verbatim
   * — it is the only thing that makes a model-derived audience reviewable.
   */
  aiProcessing: Record<string, unknown> | null;
  nutritionFacts: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Count runes the way Go's utf8.RuneCountInString does, not UTF-16 units. */
export function runeCount(text: string): number {
  return Array.from(text).length;
}

/**
 * Whether the description can be sent at all, and what to tell the user when
 * it cannot. Returns null when it is fine.
 */
export function describeInputProblem(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "Describe the audience you want first.";
  const runes = runeCount(trimmed);
  if (runes > COMPILE_TEXT_SOFT_MAX) {
    return `That's ${num(runes)} characters. Keep it under ${num(COMPILE_TEXT_SOFT_MAX)} — a sentence or two works best, and anything longer belongs in the visual builder on the web admin.`;
  }
  return null;
}

/**
 * Parse a compile response. Every field is optional-by-default because a
 * shape we do not recognise must degrade to "no rationale" rather than
 * throwing away a perfectly good AST.
 *
 * Returns null when there is no AST at all — a 200 with no tree is not a
 * draft, and rendering an empty rule list as a compiled audience would be
 * the worst possible outcome here.
 */
export function parseCompiledDraft(
  raw: unknown,
  requestedEngine: CompileEngine,
): CompiledSegmentDraft | null {
  if (!isRecord(raw)) return null;
  const ast = raw.ast ?? raw.query_ast ?? raw.queryAst;
  if (ast == null) return null;
  const engineUsed = raw.engine_used === "ai" ? "ai" : raw.engine_used === "rules" ? "rules" : requestedEngine;
  return {
    ast,
    engineUsed,
    rationale: str(raw.rationale),
    suggestedName: str(raw.suggested_name ?? raw.suggestedName),
    aiProcessing: isRecord(raw.ai_processing) ? raw.ai_processing : null,
    nutritionFacts: isRecord(raw.nutrition_facts) ? raw.nutrition_facts : null,
  };
}

export interface PreviewCountResult {
  /** null when the server capped the count — absence, not zero. */
  count: number | null;
  capped: boolean;
  computedInMs: number | null;
}

/**
 * Parse /preview-count.
 *
 * The capped branch is the one that matters: the handler returns HTTP 200
 * with `{count: 0, capped: true}` when the 10s deadline trips
 * (preview_count.go:185-192). Rendering that literal 0 would tell an
 * operator their audience is empty when in fact it was too expensive to
 * count. `count` is therefore null whenever `capped` is set.
 */
export function parsePreviewCount(raw: unknown): PreviewCountResult {
  if (!isRecord(raw)) return { count: null, capped: false, computedInMs: null };
  const capped = raw.capped === true;
  const rawCount = raw.count;
  const count =
    capped || typeof rawCount !== "number" || !Number.isFinite(rawCount)
      ? null
      : rawCount;
  const ms = raw.computed_in_ms;
  return {
    count,
    capped,
    computedInMs: typeof ms === "number" && Number.isFinite(ms) ? ms : null,
  };
}

/** The line under the preview number. Never invents a figure it does not have. */
export function previewCountLabel(result: PreviewCountResult | null): string {
  if (!result) return "Not previewed yet.";
  if (result.capped) {
    return "Too large to count in 10 seconds — the server stopped. The audience is real; its size is unknown from here.";
  }
  if (result.count == null) {
    return "The server answered without a count. Try again, or preview on the web admin.";
  }
  return result.count === 1
    ? "1 person matches right now."
    : `${num(result.count)} people match right now.`;
}

/**
 * How to react to a failed rules-engine compile.
 *
 * `unsupported_text` is the ONLY code that should offer the AI retry — every
 * other failure is a real error and an "ask the AI instead" button on it
 * would send prose to a third party to work around, say, an expired session.
 */
export function compileFailure(error: {
  status: number;
  code?: string | undefined;
  message: string;
}): { message: string; canRetryWithAI: boolean } {
  if (error.status === 422 && error.code === "unsupported_text") {
    return {
      message:
        "The rules compiler didn't recognise that phrasing. It understands things like \"opened an email in the last 30 days\" or \"joined in the last 7 days and is tagged vip\".",
      canRetryWithAI: true,
    };
  }
  if (error.status === 400 && error.code === "text_too_long") {
    return {
      message: `That description is longer than the server's ${num(COMPILE_TEXT_MAX_RUNES)}-character limit.`,
      canRetryWithAI: false,
    };
  }
  if (error.code === "ai_unavailable" || error.status === 503) {
    return {
      message:
        "This deployment has no AI compiler configured. Use the visual builder on the web admin for phrasing the rules compiler can't read.",
      canRetryWithAI: false,
    };
  }
  if (error.code === "ai_compile_failed") {
    return {
      message:
        "The AI compiler couldn't turn that into an executable audience. Try naming a concrete behaviour and a time window.",
      canRetryWithAI: false,
    };
  }
  return { message: error.message || "Couldn't compile that description.", canRetryWithAI: false };
}

/** The AI availability + processing disclosure the server publishes. */
export interface AIDisclosure {
  available: boolean;
  /** Verbatim server text/fields; rendered as-is, never summarised. */
  processing: Record<string, unknown> | null;
}

export function parseAIDisclosure(raw: unknown): AIDisclosure {
  if (!isRecord(raw)) return { available: false, processing: null };
  return {
    available: raw.available === true,
    processing: isRecord(raw.ai_processing) ? raw.ai_processing : null,
  };
}

/**
 * Flatten the server's ai_processing envelope into label/value lines.
 *
 * Deliberately generic: the handler adds provider/model only when the
 * provider exposes them, and declares retention/residency as
 * "not_declared". Hardcoding a field list here would silently drop whatever
 * a future provider adds, which is the opposite of a disclosure.
 */
export function disclosureLines(
  processing: Record<string, unknown> | null,
): { label: string; value: string }[] {
  if (!processing) return [];
  const out: { label: string; value: string }[] = [];
  for (const [key, value] of Object.entries(processing)) {
    let text: string;
    if (Array.isArray(value)) text = value.map((v) => String(v)).join(", ");
    else if (value == null) text = "—";
    else if (typeof value === "object") continue;
    else text = String(value);
    if (!text) text = "—";
    out.push({
      label: key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
      value: text.replace(/_/g, " "),
    });
  }
  return out;
}

/**
 * The name to save under. The rules engine proposes one; the AI engine does
 * not, so fall back to the operator's own words truncated to something that
 * fits a list row.
 */
export function defaultSegmentName(
  draft: CompiledSegmentDraft,
  text: string,
): string {
  if (draft.suggestedName) return draft.suggestedName;
  const words = text.trim().replace(/\s+/g, " ");
  if (!words) return "Described audience";
  const chars = Array.from(words);
  if (chars.length <= 60) return words;
  return `${chars.slice(0, 57).join("")}…`;
}
