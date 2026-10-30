// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { documentFromNodes } from "@/lib/semantic-email/decode";
import { compileDocument } from "@/lib/semantic-email/project";
import type { SemanticNode } from "@/lib/semantic-email/types";

type Tab = "html" | "text";

/**
 * Matches the MJML block editor's compile debounce (components/editor/
 * block-editor.tsx) so the two preview panes feel the same under the keyboard.
 */
const COMPILE_DEBOUNCE_MS = 350;

/**
 * The last value that has held still for `delayMs`, starting with the first one
 * so the pane compiles immediately on mount.
 *
 * WHY THE PREVIEW NEEDS THIS. Every text field in NodeProperties calls
 * `onChange` per keystroke, and the editor commits a NEW `nodes` array each
 * time. Recompiling from that identity ran decode + normalize + project (~2,000
 * lines) synchronously per character AND rewrote the iframe's `srcDoc`, which
 * makes the browser tear down and re-navigate the whole preview document —
 * a flash on screen and a stalled caret while composing body copy, the most
 * keystroke-dense task in the product.
 */
function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(settled, value)) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, settled, delayMs]);
  return settled;
}

/**
 * Both projections, from the same compile of the same tree.
 *
 * Showing the plain text next to the HTML is not a developer nicety. The
 * plain-text part is what parsers and AI summarisers read, and it is the half
 * nobody ever looks at — which is how a message ends up where the one action
 * being asked for is typographically identical to the unsubscribe link. Here
 * they are the same size on the same screen.
 */
export function SemanticPreview({
  nodes,
  slots,
}: {
  nodes: readonly SemanticNode[];
  slots: Record<string, string>;
}) {
  const [tab, setTab] = useState<Tab>("html");
  // One settled value for both inputs: the compile is a function of the pair,
  // so debouncing them separately would compile an intermediate that never
  // existed in the editor.
  const input = useMemo(() => ({ nodes, slots }), [nodes, slots]);
  const settled = useSettled(input, COMPILE_DEBOUNCE_MS);
  const result = useMemo(
    () =>
      compileDocument(documentFromNodes([...settled.nodes]), {
        slots: settled.slots,
      }),
    [settled],
  );

  const blockingErrors = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );

  return (
    <Tabs asChild value={tab} onValueChange={(value) => setTab(value as Tab)}>
      <section className="space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">Preview</h3>
          <TabsList aria-label="Projection" className="ml-auto w-auto">
            {(["html", "text"] as const).map((value) => (
              <TabsTrigger key={value} value={value} className="border text-xs">
                {value === "html" ? "HTML" : "Plain text"}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {result.ok ? null : (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive-emphasis">
            Nothing to preview: {blockingErrors.length} error(s) stop this
            document compiling. Compilation fails closed rather than guessing —
            an unresolved condition or a required slot with no fallback has no
            single right answer.
          </p>
        )}

        <TabsContent value="html" className="mt-0">
          {result.ok ? (
            <div className="overflow-auto rounded bg-neutral-100 p-4 dark:bg-neutral-900">
              {/*
                sandbox="" with no flags: no scripts, no same-origin. Inline
                styles still apply because sandboxing does not disable CSS.
                Same posture as the campaign email preview pane.
              */}
              <iframe
                title="Semantic email HTML projection"
                srcDoc={result.html}
                sandbox=""
                referrerPolicy="no-referrer"
                className="h-[480px] w-full rounded border bg-white"
              />
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="text" className="mt-0">
          {result.ok ? (
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded border bg-muted p-3 text-xs">
              {result.text}
            </pre>
          ) : null}
        </TabsContent>

        <p className="text-xs text-muted-foreground">
          Rendered with the same projection rules the API compiles with, pinned
          to the Go renderer by a differential test. Provider markup (Gmail
          annotations) is not shown: it is only emitted when sender-eligibility
          evidence proves it would be honoured, which a draft does not have.
        </p>
      </section>
    </Tabs>
  );
}
