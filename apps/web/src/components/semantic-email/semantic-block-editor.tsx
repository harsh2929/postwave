// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { GripVertical } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { FieldDiagnostics } from "./field-diagnostics";
import { NodeProperties } from "./node-properties";
import { SemanticPreview } from "./semantic-preview";
import {
  NODE_TYPE_HINTS,
  NODE_TYPE_LABELS,
  createNode,
  diagnosticsByNodeIndex,
  documentDiagnostics,
  duplicateNodeAt,
  insertNodeAt,
  moveNode,
  removeNodeAt,
  reorderNode,
  stageNodes,
  validateNodes,
} from "@/lib/semantic-email/authoring";
import { NODE_TYPES, hasErrors, type NodeType, type SemanticNode } from "@/lib/semantic-email/types";

/** Short, collision-resistant suffix for generated stable references. */
function mintSuffix(nodes: readonly SemanticNode[]): string {
  const taken = new Set(nodes.map((node) => node.id));
  let counter = nodes.length + 1;
  let candidate = String(counter);
  while ([...taken].some((id) => id.endsWith("_" + candidate))) {
    counter += 1;
    candidate = String(counter);
  }
  return candidate;
}

function summarize(node: SemanticNode): string {
  const content = node.content;
  const firstRun = (runs: { kind: string; text: string }[] | undefined) =>
    runs?.find((run) => run.text !== "")?.text ?? "";
  if (content.heading) return firstRun(content.heading.text.runs);
  if (content.paragraph) return firstRun(content.paragraph.text.runs);
  if (content.list) return `${content.list.items.length} item(s)`;
  if (content.answer) return firstRun(content.answer.question.runs);
  if (content.legal) return firstRun(content.legal.text.runs);
  if (content.action) return content.action.label;
  if (content.image) return content.image.alt || content.image.url;
  if (content.datetime) return content.datetime.display_value;
  if (content.deadline) return content.deadline.display_value;
  if (content.money) return content.money.display_value;
  if (content.offer) return firstRun(content.offer.description.runs);
  if (content.location) return content.location.name;
  if (content.product) return content.product.name;
  if (content.fact) return `${content.fact.label}: ${content.fact.value}`;
  if (content.personalization) return content.personalization.slot.id;
  if (content.structured_data) return content.structured_data.kind;
  if (content.poll) return firstRun(content.poll.question.runs);
  return "";
}

export interface SemanticBlockEditorProps {
  nodes: SemanticNode[];
  readOnly?: boolean;
  onNodesChange: (nodes: SemanticNode[]) => void;
  onStage: (nodes: Array<Record<string, unknown>>) => void;
}

export function SemanticBlockEditor({
  nodes,
  readOnly = false,
  onNodesChange,
  onStage,
}: SemanticBlockEditorProps) {
  const [selected, setSelected] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [slotDraft, setSlotDraft] = useState({ id: "", value: "" });
  // After a reorder the moved row is somewhere else in the DOM. Without this,
  // keyboard reordering loses focus on the first press and the author has to
  // tab back to the control they were using — which makes "move up twice"
  // impossible without a mouse.
  const pendingFocus = useRef<string | null>(null);

  // Validation runs on every change, not on save. The author is told which box
  // is wrong while they are still looking at it.
  const diagnostics = useMemo(() => validateNodes(nodes), [nodes]);
  const perNode = useMemo(
    () => diagnosticsByNodeIndex(diagnostics, nodes.length),
    [diagnostics, nodes.length],
  );
  const documentLevel = useMemo(
    () => documentDiagnostics(diagnostics),
    [diagnostics],
  );
  const blocked = hasErrors(diagnostics);

  useEffect(() => {
    if (!pendingFocus.current) return;
    const target = document.querySelector<HTMLElement>(
      `[data-focus-key="${pendingFocus.current}"]`,
    );
    pendingFocus.current = null;
    target?.focus();
  }, [nodes]);

  const commit = useCallback(
    (next: SemanticNode[]) => {
      onNodesChange(next);
    },
    [onNodesChange],
  );

  const addNode = (type: NodeType) => {
    const node = createNode(type, mintSuffix(nodes));
    const insertAt = nodes.length === 0 ? 0 : selected + 1;
    commit(insertNodeAt(nodes, node, insertAt));
    setSelected(insertAt);
    setAnnouncement(`${NODE_TYPE_LABELS[type]} added at position ${insertAt + 1}.`);
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= nodes.length) return;
    pendingFocus.current = `move-${direction === -1 ? "up" : "down"}-${nodes[index].id}`;
    commit(moveNode(nodes, index, direction));
    setSelected(target);
    setAnnouncement(
      `${nodeLabel(nodes[index])} moved to position ${target + 1} of ${nodes.length}.`,
    );
  };

  const drop = (from: number, to: number) => {
    if (from === to) return;
    commit(reorderNode(nodes, from, to));
    setSelected(to);
    setAnnouncement(
      `${nodeLabel(nodes[from])} moved to position ${to + 1} of ${nodes.length}.`,
    );
  };

  const remove = (index: number) => {
    const removed = nodes[index];
    commit(removeNodeAt(nodes, index));
    setSelected(Math.max(0, index - 1));
    setAnnouncement(`${nodeLabel(removed)} removed.`);
  };

  const duplicate = (index: number) => {
    commit(duplicateNodeAt(nodes, index, mintSuffix(nodes)));
    setSelected(index + 1);
    setAnnouncement(
      `${nodeLabel(nodes[index])} duplicated with a fresh identity at position ${index + 2}.`,
    );
  };

  const stage = () => {
    const result = stageNodes(nodes);
    if (!result.ok || result.nodes === null) {
      setAnnouncement(
        `Not staged: ${result.diagnostics.filter((item) => item.severity === "error").length} error(s) must be fixed first.`,
      );
      return;
    }
    onStage(result.nodes);
    setAnnouncement("Semantic source staged. Save the campaign to store it.");
  };

  const selectedNode = nodes[selected] ?? null;

  return (
    <div className="space-y-4">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div className="grid min-h-[640px] grid-cols-1 gap-4 lg:grid-cols-12">
        <aside
          aria-label="Block palette"
          className="col-span-1 space-y-2 rounded-md border bg-card p-3 lg:col-span-3"
        >
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Blocks
          </h3>
          <div className="space-y-1.5">
            {NODE_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                disabled={readOnly}
                onClick={() => addNode(type)}
                className="w-full rounded-md border bg-background px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
              >
                <div className="font-medium">{NODE_TYPE_LABELS[type]}</div>
                <div className="text-xs text-muted-foreground">
                  {NODE_TYPE_HINTS[type]}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <div className="col-span-1 space-y-2 overflow-y-auto rounded-md border bg-card p-3 lg:col-span-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Message structure
          </h3>
          {nodes.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Empty document. Add a block from the palette.
            </p>
          ) : null}
          <ol className="space-y-2">
            {nodes.map((node, index) => {
              const errors = perNode[index]?.filter(
                (item) => item.severity === "error",
              ).length;
              const warnings = perNode[index]?.filter(
                (item) => item.severity === "warning",
              ).length;
              return (
                <li
                  key={node.id + ":" + index}
                  onDragOver={(event) => {
                    if (readOnly) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    if (overIndex !== index) setOverIndex(index);
                  }}
                  onDragLeave={() =>
                    setOverIndex((previous) =>
                      previous === index ? null : previous,
                    )
                  }
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragIndex !== null) drop(dragIndex, index);
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  className={cn(
                    "space-y-1 rounded-md transition-[opacity,box-shadow] duration-150",
                    dragIndex === index && "opacity-40",
                    overIndex === index &&
                      dragIndex !== null &&
                      dragIndex !== index &&
                      "ring-2 ring-primary ring-offset-2 ring-offset-card",
                  )}
                >
                  <div className="flex items-start gap-1.5">
                    {/* Drag is a mouse ENHANCEMENT. The ↑/↓ buttons below are
                        the real reorder path: they work with a keyboard, they
                        work with a screen reader, and they announce where the
                        block landed. */}
                    <span
                      draggable={!readOnly}
                      onDragStart={(event) => {
                        setDragIndex(index);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", node.id);
                      }}
                      className="mt-2 cursor-grab text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
                      aria-hidden
                      title="Drag to reorder"
                    >
                      <GripVertical className="h-4 w-4" />
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelected(index)}
                      aria-current={selected === index}
                      className={cn(
                        "min-w-0 flex-1 rounded-md border px-2 py-1.5 text-left",
                        selected === index
                          ? "border-primary bg-accent"
                          : "bg-background hover:bg-accent",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="text-xs font-medium">
                          {index + 1}. {NODE_TYPE_LABELS[node.type as NodeType] ?? node.type}
                        </span>
                        {errors ? (
                          <span className="rounded bg-destructive/10 px-1.5 text-[10px] text-destructive-emphasis">
                            {errors} error{errors === 1 ? "" : "s"}
                          </span>
                        ) : null}
                        {warnings ? (
                          <span className="rounded bg-amber-500/10 px-1.5 text-[10px] text-amber-700 dark:text-amber-400">
                            {warnings} warning{warnings === 1 ? "" : "s"}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {summarize(node) || node.id}
                      </span>
                    </button>
                  </div>
                  <div className="flex items-center gap-2 pl-[26px] text-xs">
                    <button
                      type="button"
                      data-focus-key={`move-up-${node.id}`}
                      onClick={() => move(index, -1)}
                      disabled={readOnly || index === 0}
                      aria-label={`Move ${nodeLabel(node)} up to position ${index}`}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    >
                      ↑ Up
                    </button>
                    <button
                      type="button"
                      data-focus-key={`move-down-${node.id}`}
                      onClick={() => move(index, 1)}
                      disabled={readOnly || index === nodes.length - 1}
                      aria-label={`Move ${nodeLabel(node)} down to position ${index + 2}`}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    >
                      ↓ Down
                    </button>
                    <button
                      type="button"
                      onClick={() => duplicate(index)}
                      disabled={readOnly}
                      aria-label={`Duplicate ${nodeLabel(node)}`}
                      className="ml-auto text-muted-foreground hover:text-foreground disabled:opacity-30"
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      disabled={readOnly}
                      aria-label={`Remove ${nodeLabel(node)}`}
                      className="text-destructive hover:text-destructive/80 disabled:opacity-30"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <aside className="col-span-1 space-y-3 overflow-y-auto rounded-md border bg-card p-3 lg:col-span-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Properties
          </h3>
          {selectedNode === null ? (
            <p className="text-sm text-muted-foreground">
              Select a block to edit it.
            </p>
          ) : (
            <fieldset disabled={readOnly} className="space-y-3">
              <NodeProperties
                node={selectedNode}
                index={selected}
                nodes={nodes}
                diagnostics={diagnostics}
                onChange={(next) => {
                  const copy = [...nodes];
                  copy[selected] = next;
                  commit(copy);
                }}
              />
            </fieldset>
          )}
        </aside>
      </div>

      {documentLevel.length > 0 ? (
        <section className="rounded-md border p-3">
          <h3 className="text-sm font-medium">Document</h3>
          <FieldDiagnostics diagnostics={documentLevel} pointer="/" />
          <FieldDiagnostics diagnostics={documentLevel} pointer="/nodes" />
          <FieldDiagnostics diagnostics={documentLevel} pointer="/language" />
          <FieldDiagnostics diagnostics={documentLevel} pointer="/direction" />
          <FieldDiagnostics
            diagnostics={documentLevel}
            pointer="/schema_version"
          />
        </section>
      ) : null}

      <section className="space-y-2 rounded-md border p-3">
        <h3 className="text-sm font-medium">Preview fixture values</h3>
        <p className="text-xs text-muted-foreground">
          Personalization slots and conditions resolve against one exact
          scenario. A preview with no values shows the fallbacks, which is what
          a recipient with no data receives.
        </p>
        <ul className="space-y-1">
          {Object.entries(slots).map(([id, value]) => (
            <li key={id} className="flex items-center gap-2 text-sm">
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{id}</code>
              <span className="flex-1 truncate">{value}</span>
              <button
                type="button"
                className="text-xs text-destructive hover:text-destructive/80"
                aria-label={`Remove fixture value for ${id}`}
                onClick={() =>
                  setSlots((current) => {
                    const next = { ...current };
                    delete next[id];
                    return next;
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="semantic-slot-id">Slot id</Label>
            <Input
              id="semantic-slot-id"
              value={slotDraft.id}
              onChange={(event) =>
                setSlotDraft((current) => ({ ...current, id: event.target.value }))
              }
            />
          </div>
          <div>
            <Label htmlFor="semantic-slot-value">Value</Label>
            <Input
              id="semantic-slot-value"
              value={slotDraft.value}
              onChange={(event) =>
                setSlotDraft((current) => ({
                  ...current,
                  value: event.target.value,
                }))
              }
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={slotDraft.id.trim() === ""}
            onClick={() => {
              setSlots((current) => ({
                ...current,
                [slotDraft.id.trim()]: slotDraft.value,
              }));
              setSlotDraft({ id: "", value: "" });
            }}
          >
            Set fixture value
          </Button>
        </div>
      </section>

      <SemanticPreview nodes={nodes} slots={slots} />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={stage} disabled={readOnly || blocked}>
          Stage semantic source
        </Button>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {blocked
            ? `${diagnostics.filter((item) => item.severity === "error").length} error(s) block staging. The API applies the same rules on save.`
            : "No errors. Staging replaces the campaign's semantic node array."}
        </span>
      </div>
    </div>
  );
}

function nodeLabel(node: SemanticNode): string {
  const typeLabel = NODE_TYPE_LABELS[node.type as NodeType] ?? node.type;
  return `${typeLabel} ${node.id}`;
}
