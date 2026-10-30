// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { SemanticBlockEditor } from "@/components/semantic-email/semantic-block-editor";
import { decodeSemanticNodes } from "@/lib/semantic-email/decode";
import type { SemanticNode } from "@/lib/semantic-email/types";

const MAX_SEMANTIC_SOURCE_BYTES = 1 << 20;

export interface SemanticSourceUpdate {
  nodes: Array<Record<string, unknown>>;
  factContract: Record<string, unknown>;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be one JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseNodes(value: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Semantic source must be a non-empty JSON node array.");
  }
  if (
    parsed.some(
      (node) =>
        node === null || typeof node !== "object" || Array.isArray(node),
    )
  ) {
    throw new Error("Every semantic node must be one JSON object.");
  }
  return parsed as Array<Record<string, unknown>>;
}

function withinBound(value: string): boolean {
  return (
    new TextEncoder().encode(value).byteLength <= MAX_SEMANTIC_SOURCE_BYTES
  );
}

type Mode = "blocks" | "json";

/**
 * Lossless authoring for the server-owned semantic-email v2 boundary.
 *
 * Two views over the SAME node array:
 *
 *   * Blocks — a block editor over the closed node union. Every control is
 *     populated from the union itself, so it can express what the union allows
 *     and nothing it forbids, and it validates as the author types instead of
 *     at save time.
 *   * JSON — the original escape hatch. It stays because it round-trips
 *     ANYTHING, including a tree the block editor cannot open (an unknown
 *     field from a newer API, say). Refusing to open is honest; quietly
 *     dropping the field on save would not be.
 *
 * Neither view converts through legacy blocks, HTML, MJML, or plain text. The
 * API remains authoritative for closed-union validation and field-addressable
 * diagnostics.
 */
export function CampaignSemanticSourceEditor({
  nodes,
  factContract,
  enabled,
  onChange,
}: {
  nodes: Array<Record<string, unknown>>;
  factContract: Record<string, unknown>;
  enabled: boolean;
  onChange: (update: SemanticSourceUpdate) => void;
}) {
  const sourceFingerprint = useMemo(
    () => JSON.stringify([nodes, factContract]),
    [nodes, factContract],
  );
  // Open on Blocks, unless this document carries something the block editor
  // cannot model — landing an author on a refusal banner would be a worse
  // first impression than simply showing them the view that works.
  const [mode, setMode] = useState<Mode>(() =>
    decodeSemanticNodes(nodes).nodes === null ? "json" : "blocks",
  );
  const [nodeJSON, setNodeJSON] = useState(() => pretty(nodes));
  const [contractJSON, setContractJSON] = useState(() => pretty(factContract));
  const [dirty, setDirty] = useState(false);
  const [appliedFingerprint, setAppliedFingerprint] =
    useState(sourceFingerprint);

  const decoded = useMemo(() => decodeSemanticNodes(nodes), [nodes]);
  const [blockNodes, setBlockNodes] = useState<SemanticNode[]>(
    () => decoded.nodes ?? [],
  );
  const [blockFingerprint, setBlockFingerprint] = useState(sourceFingerprint);

  useEffect(() => {
    if (dirty || sourceFingerprint === appliedFingerprint) return;
    setNodeJSON(pretty(nodes));
    setContractJSON(pretty(factContract));
    setAppliedFingerprint(sourceFingerprint);
  }, [appliedFingerprint, dirty, factContract, nodes, sourceFingerprint]);

  // The block editor owns its working copy so a keystroke does not re-render
  // the whole campaign page. It re-reads only when the campaign's own node
  // array changed underneath it.
  useEffect(() => {
    if (sourceFingerprint === blockFingerprint) return;
    setBlockNodes(decoded.nodes ?? []);
    setBlockFingerprint(sourceFingerprint);
  }, [blockFingerprint, decoded.nodes, sourceFingerprint]);

  const apply = () => {
    if (!withinBound(nodeJSON) || !withinBound(contractJSON)) {
      toast.error("Semantic source exceeds the 1 MiB authoring limit.");
      return;
    }
    try {
      const nextNodes = parseNodes(nodeJSON);
      const nextContract = parseObject(contractJSON, "Fact Contract");
      onChange({ nodes: nextNodes, factContract: nextContract });
      setNodeJSON(pretty(nextNodes));
      setContractJSON(pretty(nextContract));
      setAppliedFingerprint(JSON.stringify([nextNodes, nextContract]));
      setBlockFingerprint("");
      setDirty(false);
      toast.success(
        "Semantic source staged. Save the campaign to validate it.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Invalid JSON source.",
      );
    }
  };

  const stageFromBlocks = (staged: Array<Record<string, unknown>>) => {
    const encoded = pretty(staged);
    if (!withinBound(encoded)) {
      toast.error("Semantic source exceeds the 1 MiB authoring limit.");
      return;
    }
    let contract: Record<string, unknown>;
    try {
      contract = parseObject(contractJSON, "Fact Contract");
    } catch {
      contract = factContract;
    }
    onChange({ nodes: staged, factContract: contract });
    setNodeJSON(encoded);
    setAppliedFingerprint(JSON.stringify([staged, contract]));
    setBlockFingerprint(JSON.stringify([staged, contract]));
    setDirty(false);
    toast.success("Semantic source staged. Save the campaign to store it.");
  };

  return (
    <section className="grid min-w-0 gap-4 rounded-md border bg-card p-4">
      <div>
        <h2 className="font-medium">Semantic source · AST v2</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This node array and Fact Contract are the authoring authority. HTML,
          semantic plain text, structured data, and MIME are server projections.
        </p>
        {!enabled ? (
          <p className="mt-2 text-sm text-amber-700 [overflow-wrap:anywhere] dark:text-amber-300">
            Editing is read-only until{" "}
            <code>NEXT_PUBLIC_ENABLE_CAMPAIGN_CONTENT_AST_V2=1</code> is
            enabled.
          </p>
        ) : null}
      </div>

      <Tabs
        value={mode}
        onValueChange={(value) => setMode(value as Mode)}
        className="grid gap-4"
      >
        <TabsList aria-label="Semantic authoring view" className="w-auto">
          <TabsTrigger value="blocks" className="border">
            Blocks
          </TabsTrigger>
          <TabsTrigger value="json" className="border">
            JSON
          </TabsTrigger>
        </TabsList>

        <TabsContent value="blocks" className="mt-0">
          {decoded.nodes === null ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <p className="font-medium">
                This document cannot be opened in the block editor.
              </p>
              <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                {decoded.diagnostics.map((diagnostic, index) => (
                  <li key={index}>{diagnostic.message}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Editing it here would silently drop whatever this editor does
                not understand. Use the JSON view, which round-trips it exactly.
              </p>
            </div>
          ) : (
            <SemanticBlockEditor
              nodes={blockNodes}
              readOnly={!enabled}
              onNodesChange={setBlockNodes}
              onStage={stageFromBlocks}
            />
          )}
        </TabsContent>

        <TabsContent value="json" className="mt-0 grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="campaign-semantic-nodes">Semantic node array</Label>
            <Textarea
              id="campaign-semantic-nodes"
              className="min-h-[360px] font-mono text-xs"
              spellCheck={false}
              readOnly={!enabled}
              value={nodeJSON}
              onChange={(event) => {
                setNodeJSON(event.target.value);
                setDirty(true);
              }}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="campaign-fact-contract">Fact Contract v1</Label>
            <Textarea
              id="campaign-fact-contract"
              className="min-h-[240px] font-mono text-xs"
              spellCheck={false}
              readOnly={!enabled}
              value={contractJSON}
              onChange={(event) => {
                setContractJSON(event.target.value);
                setDirty(true);
              }}
            />
          </div>

          {enabled ? (
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <Button type="button" disabled={!dirty} onClick={apply}>
                Apply semantic source
              </Button>
              <span
                className="text-xs text-muted-foreground"
                aria-live="polite"
              >
                {dirty
                  ? "Local JSON has not been staged."
                  : "Source is staged."}
              </span>
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
    </section>
  );
}
