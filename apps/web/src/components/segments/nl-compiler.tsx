// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import { Loader2, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import {
  compileFromText,
  type CompileFromTextResponse,
  type SegmentNode,
} from "@/lib/segments-api";

/**
 * Natural-language → rules helper (SEG-014). Types a description, calls
 * POST /segments/compile-from-text (rules engine, then AI on an
 * unsupported-text 422), and loads the returned AST + suggested name for the
 * user to review before saving.
 */
export function NaturalLanguageCompiler({
  onResult,
  initialText = "",
}: {
  onResult: (result: { ast: SegmentNode; suggestedName?: string }) => void;
  /** Review-first preset recreation can seed text without compiling or saving. */
  initialText?: string;
}) {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<CompileFromTextResponse | null>(
    null,
  );
  const appliedInitialText = React.useRef(false);
  React.useEffect(() => {
    if (appliedInitialText.current || !initialText.trim()) return;
    appliedInitialText.current = true;
    setText((current) =>
      current.trim() ? current : initialText.slice(0, 1_000),
    );
  }, [initialText]);

  async function run() {
    const description = text.trim();
    if (!description || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      let res: CompileFromTextResponse;
      try {
        res = await compileFromText(description, { engine: "rules" });
      } catch (err) {
        // The deterministic engine returns 422 unsupported_text when the
        // phrase doesn't match a known pattern; fall back to the AI engine.
        if (err instanceof ApiError && err.status === 422) {
          res = await compileFromText(description, {
            engine: "ai",
            acknowledged: true,
          });
        } else {
          throw err;
        }
      }
      setResult(res);
      onResult({
        ast: res.queryAst ?? res.ast,
        suggestedName: res.suggested_name,
      });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 503
          ? "AI compilation isn't available right now. Try describing it more simply, or build the rules manually."
          : err instanceof Error
            ? err.message
            : "Couldn't turn that into rules.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <label
        htmlFor="seg-nl"
        className="flex items-center gap-1.5 text-sm font-medium"
      >
        <Wand2 className="h-4 w-4 text-primary" aria-hidden />
        Describe your audience
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        e.g. &ldquo;subscribers who opened an email in the last 30 days and are
        tagged vip&rdquo;. We&apos;ll draft the rules for you to review.
      </p>
      <div className="mt-2 flex gap-2">
        <Input
          id="seg-nl"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
          placeholder="Describe the segment in plain language"
          disabled={busy}
        />
        <Button
          type="button"
          onClick={() => void run()}
          disabled={busy || !text.trim()}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Wand2 className="h-4 w-4" />
          )}
          Generate
        </Button>
      </div>
      {error ? (
        <div
          role="alert"
          className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive-emphasis"
        >
          {error}
        </div>
      ) : null}
      {result?.rationale ? (
        <div className="mt-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Applied.</span>{" "}
          {result.rationale}
          {result.suggested_name ? (
            <>
              {" "}
              Suggested name:{" "}
              <span className="font-medium text-foreground">
                {result.suggested_name}
              </span>
              .
            </>
          ) : null}
        </div>
      ) : result ? (
        <div className="mt-2 text-xs text-muted-foreground">
          Rules applied below — review them before saving.
        </div>
      ) : null}
    </div>
  );
}
