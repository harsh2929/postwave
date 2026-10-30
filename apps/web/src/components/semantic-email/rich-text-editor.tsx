// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { FieldDiagnostics, hasFieldError } from "./field-diagnostics";
import {
  INLINE_KINDS,
  SLOT_SEMANTIC_CLASSES,
  type Diagnostic,
  type InlineKind,
  type InlineRun,
  type RichText,
  type SlotSemanticClass,
} from "@/lib/semantic-email/types";

const KIND_LABELS: Record<InlineKind, string> = {
  text: "Text",
  strong: "Strong",
  emphasis: "Emphasis",
  link: "Link",
  slot: "Slot",
  line_break: "Line break",
};

/**
 * Changing a run's kind REPLACES the run rather than patching it.
 *
 * The inline union is closed the same way the node union is: a text run
 * carries only text, a link carries text and URL and never a slot, a line
 * break carries nothing. Patching in place would leave the old kind's payload
 * behind and produce an inline_cardinality error the author never typed — so
 * the editor cannot express it in the first place.
 */
function runOfKind(kind: InlineKind, previous: InlineRun): InlineRun {
  const empty: InlineRun = {
    kind,
    text: "",
    url: "",
    accessible_label: "",
    slot: null,
  };
  switch (kind) {
    case "text":
    case "strong":
    case "emphasis":
      return { ...empty, text: previous.text };
    case "link":
      return { ...empty, text: previous.text, url: previous.url };
    case "slot":
      return {
        ...empty,
        slot: previous.slot ?? {
          id: "",
          semantic_class: "text",
          required: false,
          fallback: "",
        },
      };
    case "line_break":
      return empty;
  }
}

export function RichTextEditor({
  label,
  value,
  pointer,
  diagnostics,
  idPrefix,
  onChange,
}: {
  label: string;
  value: RichText;
  /** JSON Pointer of the rich-text object, e.g. /nodes/0/content/heading/text */
  pointer: string;
  diagnostics: readonly Diagnostic[];
  idPrefix: string;
  onChange: (next: RichText) => void;
}) {
  const runs = value.runs;

  const setRun = (index: number, run: InlineRun) => {
    const next = [...runs];
    next[index] = run;
    onChange({ runs: next });
  };

  const addRun = (kind: InlineKind) => {
    onChange({
      runs: [
        ...runs,
        runOfKind(kind, {
          kind,
          text: kind === "line_break" || kind === "slot" ? "" : "New text",
          url: "",
          accessible_label: "",
          slot: null,
        }),
      ],
    });
  };

  const removeRun = (index: number) => {
    onChange({ runs: runs.filter((_, position) => position !== index) });
  };

  const moveRun = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= runs.length) return;
    const next = [...runs];
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ runs: next });
  };

  return (
    <fieldset className="rounded-md border p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">
        {label}
      </legend>
      <FieldDiagnostics diagnostics={diagnostics} pointer={pointer + "/runs"} />
      <ul className="space-y-2">
        {runs.map((run, index) => {
          const runPointer = `${pointer}/runs/${index}`;
          const controlId = `${idPrefix}-run-${index}`;
          // The row's buttons are named from its POSITION, not its kind. Three
          // text runs are three identical kinds, so kind alone gave nine
          // buttons three names between them and a screen-reader user no way
          // to tell which run a press would move or delete.
          const runName = `${KIND_LABELS[run.kind as InlineKind] ?? run.kind} run ${index + 1}`;
          return (
            <li key={index} className="rounded-md border bg-background p-2">
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-32">
                  <Label htmlFor={`${controlId}-kind`} className="text-xs">
                    Kind
                  </Label>
                  <Select
                    id={`${controlId}-kind`}
                    value={run.kind}
                    aria-invalid={hasFieldError(diagnostics, runPointer)}
                    onChange={(event) =>
                      setRun(index, runOfKind(event.target.value as InlineKind, run))
                    }
                  >
                    {INLINE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {KIND_LABELS[kind]}
                      </option>
                    ))}
                  </Select>
                </div>

                {(run.kind === "text" ||
                  run.kind === "strong" ||
                  run.kind === "emphasis" ||
                  run.kind === "link") && (
                  <div className="min-w-40 flex-1">
                    <Label htmlFor={`${controlId}-text`} className="text-xs">
                      Text
                    </Label>
                    <Input
                      id={`${controlId}-text`}
                      value={run.text}
                      aria-invalid={hasFieldError(diagnostics, runPointer + "/text")}
                      onChange={(event) =>
                        setRun(index, { ...run, text: event.target.value })
                      }
                    />
                  </div>
                )}

                {run.kind === "link" && (
                  <>
                    <div className="min-w-40 flex-1">
                      <Label htmlFor={`${controlId}-url`} className="text-xs">
                        URL
                      </Label>
                      <Input
                        id={`${controlId}-url`}
                        value={run.url}
                        aria-invalid={hasFieldError(diagnostics, runPointer + "/url")}
                        onChange={(event) =>
                          setRun(index, { ...run, url: event.target.value })
                        }
                      />
                    </div>
                    <div className="min-w-40 flex-1">
                      <Label htmlFor={`${controlId}-label`} className="text-xs">
                        Accessible label
                      </Label>
                      <Input
                        id={`${controlId}-label`}
                        value={run.accessible_label}
                        onChange={(event) =>
                          setRun(index, {
                            ...run,
                            accessible_label: event.target.value,
                          })
                        }
                      />
                    </div>
                  </>
                )}

                {run.kind === "slot" && !run.slot && (
                  // decode.ts maps a wire run with a missing or null slot to
                  // this shape, so it arrives from the API. Rendering nothing
                  // left the row uneditable and its emptiness unexplained;
                  // runOfKind mints the same empty declaration "+ Slot" does.
                  <div className="min-w-40 flex-1 pb-1">
                    <p className="text-xs text-muted-foreground">
                      This run has no slot declaration, so it compiles to
                      nothing for every recipient.
                    </p>
                    <button
                      type="button"
                      className="mt-1 rounded border px-2 py-1 text-xs hover:bg-accent"
                      onClick={() => setRun(index, runOfKind("slot", run))}
                    >
                      Add slot declaration
                    </button>
                  </div>
                )}

                {run.kind === "slot" && run.slot && (
                  <>
                    <div className="w-40">
                      <Label htmlFor={`${controlId}-slot-id`} className="text-xs">
                        Slot id
                      </Label>
                      <Input
                        id={`${controlId}-slot-id`}
                        value={run.slot.id}
                        aria-invalid={hasFieldError(
                          diagnostics,
                          runPointer + "/slot/id",
                        )}
                        onChange={(event) =>
                          setRun(index, {
                            ...run,
                            slot: { ...run.slot!, id: event.target.value },
                          })
                        }
                      />
                    </div>
                    <div className="w-36">
                      <Label htmlFor={`${controlId}-slot-class`} className="text-xs">
                        Class
                      </Label>
                      <Select
                        id={`${controlId}-slot-class`}
                        value={run.slot.semantic_class}
                        onChange={(event) =>
                          setRun(index, {
                            ...run,
                            slot: {
                              ...run.slot!,
                              semantic_class: event.target
                                .value as SlotSemanticClass,
                            },
                          })
                        }
                      >
                        {SLOT_SEMANTIC_CLASSES.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="min-w-32 flex-1">
                      <Label
                        htmlFor={`${controlId}-slot-fallback`}
                        className="text-xs"
                      >
                        Fallback
                      </Label>
                      <Input
                        id={`${controlId}-slot-fallback`}
                        value={run.slot.fallback}
                        onChange={(event) =>
                          setRun(index, {
                            ...run,
                            slot: { ...run.slot!, fallback: event.target.value },
                          })
                        }
                      />
                    </div>
                    <label className="flex items-center gap-1.5 pb-2 text-xs">
                      <input
                        type="checkbox"
                        checked={run.slot.required}
                        onChange={(event) =>
                          setRun(index, {
                            ...run,
                            slot: { ...run.slot!, required: event.target.checked },
                          })
                        }
                      />
                      Required
                    </label>
                  </>
                )}
              </div>

              <div className="mt-1.5 flex items-center gap-2 text-xs">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={index === 0}
                  aria-label={`Move ${runName} up`}
                  onClick={() => moveRun(index, -1)}
                >
                  ↑ Up
                </button>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={index === runs.length - 1}
                  aria-label={`Move ${runName} down`}
                  onClick={() => moveRun(index, 1)}
                >
                  ↓ Down
                </button>
                <button
                  type="button"
                  className="ml-auto text-destructive hover:text-destructive/80"
                  aria-label={`Remove ${runName}`}
                  onClick={() => removeRun(index)}
                >
                  Remove
                </button>
              </div>
              <FieldDiagnostics diagnostics={diagnostics} pointer={runPointer} />
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {INLINE_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="rounded border px-2 py-1 text-xs hover:bg-accent"
            onClick={() => addRun(kind)}
          >
            + {KIND_LABELS[kind]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
