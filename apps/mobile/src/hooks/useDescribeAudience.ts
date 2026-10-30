/**
 * useDescribeAudience — the state machine behind "describe an audience in
 * words", so the sheet stays a view.
 *
 * The flow, and why it is shaped this way:
 *
 *   type → COMPILE (rules) → preview count → [save]
 *                ↓ 422 unsupported_text
 *          offer the AI engine, with the server's own disclosure, as a
 *          SECOND deliberate tap. Never automatic — see lib/segmentCompile.
 *
 * The preview count is chained onto a successful compile rather than being a
 * separate button: a rule tree with no size attached is not a reviewable
 * audience, and asking the user to press twice for the one number they care
 * about is the desktop's affordance, not a phone's.
 *
 * A compile is REPLACED, never merged. Every new attempt clears the previous
 * draft, count and error before it starts, so a failed second attempt can
 * never leave the first attempt's count sitting under the new rule text.
 */
import { useCallback, useEffect, useState } from "react";

import {
  compileSegmentFromText,
  createSegmentFromDraft,
  fetchAICompileDisclosure,
  previewSegmentCount,
} from "@/api/segmentCompile";
import {
  compileFailure,
  describeInputProblem,
  type AIDisclosure,
  type CompiledSegmentDraft,
  type PreviewCountResult,
} from "@/lib/segmentCompile";

export interface DescribeAudienceState {
  draft: CompiledSegmentDraft | null;
  preview: PreviewCountResult | null;
  /** Set when the preview call itself failed — the draft is still valid. */
  previewError: string | null;
  error: string | null;
  canRetryWithAI: boolean;
  compiling: boolean;
  previewing: boolean;
  saving: boolean;
  disclosure: AIDisclosure | null;
}

const IDLE: DescribeAudienceState = {
  draft: null,
  preview: null,
  previewError: null,
  error: null,
  canRetryWithAI: false,
  compiling: false,
  previewing: false,
  saving: false,
  disclosure: null,
};

export function useDescribeAudience(input: { enabled: boolean }) {
  const [state, setState] = useState<DescribeAudienceState>(IDLE);

  // Fetched once the sheet opens. It costs nothing (the handler never calls a
  // provider) and it is the only way to know whether offering the AI retry is
  // honest on THIS deployment.
  useEffect(() => {
    if (!input.enabled) return;
    let cancelled = false;
    void (async () => {
      const res = await fetchAICompileDisclosure();
      if (cancelled || res.error || !res.data) return;
      setState((prev) => ({ ...prev, disclosure: res.data }));
    })();
    return () => {
      cancelled = true;
    };
  }, [input.enabled]);

  const reset = useCallback(() => {
    setState((prev) => ({ ...IDLE, disclosure: prev.disclosure }));
  }, []);

  const compile = useCallback(
    async (text: string, engine: "rules" | "ai", acknowledged?: boolean) => {
      const problem = describeInputProblem(text);
      if (problem) {
        setState((prev) => ({
          ...prev,
          error: problem,
          canRetryWithAI: false,
          draft: null,
          preview: null,
          previewError: null,
        }));
        return;
      }
      setState((prev) => ({
        ...prev,
        compiling: true,
        error: null,
        canRetryWithAI: false,
        draft: null,
        preview: null,
        previewError: null,
      }));
      const res = await compileSegmentFromText({
        text: text.trim(),
        engine,
        ...(acknowledged === undefined ? {} : { acknowledged }),
      });
      if (res.error || !res.data) {
        const failure = compileFailure({
          status: res.error?.status ?? 0,
          ...(res.error?.code ? { code: res.error.code } : {}),
          message: res.error?.message ?? "Couldn't compile that description.",
        });
        setState((prev) => ({
          ...prev,
          compiling: false,
          error: failure.message,
          // Only offer the AI engine when the SERVER said the rules engine
          // could not read the phrase AND this deployment actually has a
          // provider wired. Offering it otherwise produces a button whose
          // only possible outcome is a 503.
          canRetryWithAI:
            failure.canRetryWithAI &&
            engine === "rules" &&
            prev.disclosure?.available === true,
        }));
        return;
      }
      const draft = res.data;
      setState((prev) => ({
        ...prev,
        compiling: false,
        draft,
        previewing: true,
      }));
      const count = await previewSegmentCount(draft.ast);
      setState((prev) => ({
        ...prev,
        previewing: false,
        preview: count.data,
        previewError: count.error
          ? // The draft survives a failed count: the rule is compiled and
            // saveable, we just cannot say how many people it reaches.
            count.error.message || "Couldn't count that audience."
          : null,
      }));
    },
    [],
  );

  const save = useCallback(
    async (params: {
      name: string;
      description: string;
      queryAst: unknown;
    }): Promise<{ ok: true; id?: string } | { ok: false; message: string }> => {
      setState((prev) => ({ ...prev, saving: true }));
      const res = await createSegmentFromDraft(params);
      setState((prev) => ({ ...prev, saving: false }));
      if (res.error) {
        if (res.error.code === "name_taken") {
          return {
            ok: false,
            message: "A segment with that name already exists. Pick another.",
          };
        }
        return {
          ok: false,
          message: res.error.message || "Couldn't save that segment.",
        };
      }
      const id = res.data?.id;
      return id ? { ok: true, id } : { ok: true };
    },
    [],
  );

  return { state, compile, save, reset };
}
