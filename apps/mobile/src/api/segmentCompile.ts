/**
 * segmentCompile — the network half of "describe an audience in words".
 *
 * Three calls, all against routes whose Go mount was read directly
 * (apps/api/internal/segments/handlers.go):
 *
 *   GET  /api/v1/segments/compile-from-text   → the AI availability +
 *        processing disclosure. Costs nothing and never touches a provider.
 *   POST /api/v1/segments/compile-from-text[?engine=ai]  → the AST.
 *   POST /api/v1/segments/preview-count       → how many people match.
 *   POST /api/v1/segments                     → save (write scope).
 *
 * They go through `rawRequest` rather than the SDK because the branch that
 * matters is the ERROR CODE, not the status: a 422 `unsupported_text` is a
 * routing signal ("offer the AI engine"), while any other 422 is a failure.
 * rawRequest is the only transport in this app that carries `error.code`
 * through.
 */
import { rawRequest, type AIApiResult } from "@/api/request";
import {
  parseAIDisclosure,
  parseCompiledDraft,
  parsePreviewCount,
  type AIDisclosure,
  type CompiledSegmentDraft,
  type CompileEngine,
  type PreviewCountResult,
} from "@/lib/segmentCompile";

/** GET the disclosure. Safe to call before the user has typed anything. */
export async function fetchAICompileDisclosure(): Promise<
  AIApiResult<AIDisclosure>
> {
  const res = await rawRequest<unknown>(
    "GET",
    "/api/v1/segments/compile-from-text",
  );
  if (res.error) return { data: null, error: res.error };
  return { data: parseAIDisclosure(res.data), error: null };
}

/**
 * Compile a description into an AST.
 *
 * `acknowledged` is only sent for engine="ai" and is REQUIRED there — the
 * handler 400s with `ai_processing_acknowledgement_required` otherwise. It
 * is per-request by the server's design, so the caller must decide each
 * time rather than storing a blanket consent.
 */
export async function compileSegmentFromText(input: {
  text: string;
  engine: CompileEngine;
  acknowledged?: boolean;
}): Promise<AIApiResult<CompiledSegmentDraft>> {
  const path =
    input.engine === "ai"
      ? "/api/v1/segments/compile-from-text?engine=ai"
      : "/api/v1/segments/compile-from-text";
  const body =
    input.engine === "ai"
      ? { text: input.text, ai_processing_acknowledged: input.acknowledged === true }
      : { text: input.text };
  const res = await rawRequest<unknown>("POST", path, body);
  if (res.error) return { data: null, error: res.error };
  const draft = parseCompiledDraft(res.data, input.engine);
  if (!draft) {
    return {
      data: null,
      error: {
        status: 200,
        message:
          "The server accepted the description but returned no rule tree.",
        code: "empty_ast",
      },
    };
  }
  return { data: draft, error: null };
}

/** Live count for a compiled AST. */
export async function previewSegmentCount(
  queryAst: unknown,
): Promise<AIApiResult<PreviewCountResult>> {
  const res = await rawRequest<unknown>(
    "POST",
    "/api/v1/segments/preview-count",
    { queryAst },
  );
  if (res.error) return { data: null, error: res.error };
  return { data: parsePreviewCount(res.data), error: null };
}

/**
 * Save the draft as a segment.
 *
 * `queryAst` is passed through EXACTLY as the compiler returned it. Any
 * client-side reshaping here would risk saving a tree that previewed
 * differently from the one that gets stored.
 */
export async function createSegmentFromDraft(input: {
  name: string;
  description: string;
  queryAst: unknown;
}): Promise<AIApiResult<{ id?: string; name?: string }>> {
  return rawRequest<{ id?: string; name?: string }>(
    "POST",
    "/api/v1/segments",
    {
      name: input.name,
      description: input.description,
      queryAst: input.queryAst,
    },
  );
}
