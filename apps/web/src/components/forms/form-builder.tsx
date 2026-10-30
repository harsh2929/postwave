// SPDX-License-Identifier: AGPL-3.0-only
//
// Curated form builder. Renders an 8-block palette + structure list +
// per-field property editor. The output (`FormStructure` JSON) is the
// source of truth for persistence and server-side rendering.
//
// Historical note: an offscreen GrapesJS shell was mounted here so the
// "GrapesJS-based form builder" requirement formally passed, but it was
// never visible to users and the "Open advanced builder" CTA never
// shipped. Removed during the half-baked-feature audit; the React palette
// always was the real UX.
"use client";

import { nanoid } from "nanoid";
import { GripVertical } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { duplicateFieldAt, insertFieldAt } from "@/lib/form-field-ops";
import {
  type FieldKind,
  type Form,
  type FormField,
  type FormStructure,
	 safeCustomFieldKey,
} from "@/lib/forms-types";
import { FieldBlock } from "./field-block";

interface FormBuilderProps {
  form: Form;
  onChange: (structure: FormStructure) => void;
}

const FIELD_PALETTE: { kind: FieldKind; label: string; hint: string }[] = [
  { kind: "heading", label: "Heading", hint: "Section heading" },
  { kind: "text", label: "Paragraph", hint: "Plain copy" },
  { kind: "email", label: "Email", hint: "Email field" },
  { kind: "name", label: "Name", hint: "First name" },
  { kind: "checkbox", label: "Consent", hint: "Required checkbox" },
  { kind: "custom", label: "Custom field", hint: "Custom data on subscriber" },
	{ kind: "long_text", label: "Long text", hint: "Multi-line response" },
	{ kind: "radio", label: "Radio choices", hint: "Choose one visible option" },
	{ kind: "select", label: "Dropdown", hint: "Choose one compact option" },
	{ kind: "scale", label: "Rating scale", hint: "Numeric score" },
	{ kind: "step_break", label: "Step break", hint: "Start the next survey step" },
  { kind: "submit", label: "Submit button", hint: "Submit CTA" },
  { kind: "honeypot", label: "Honeypot", hint: "Hidden anti-bot field" },
  {
    kind: "file_upload",
    label: "File upload",
    hint: "Resume, brief, or asset",
  },
];

export function FormBuilder({ form, onChange }: FormBuilderProps) {
  // The parent owns canonical `form.structure.fields`; we render directly
  // from props and emit on user actions. The previous design kept a local
  // `fields` mirror and synced both directions via two useEffects, which
  // caused an infinite render loop when the parent passed a new array
  // reference each render (parent setState → new prop → effect → emit →
  // parent setState …).
  const fields = form.structure.fields;
  const [selected, setSelected] = useState<string | null>(form.structure.fields[0]?.id ?? null);
  // Native HTML5 drag-reorder (matches the sequence-builder's palette DnD). The
  // ↑/↓ buttons stay as the keyboard-accessible path — drag is a mouse
  // enhancement, not the only way to reorder.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // Raw text for every editor whose committed value is a normalisation of what
  // was typed: the delimiter-joined lists (options, accepted MIME types) and
  // the numeric caps. Echoing the normalised value back as the controlled value
  // swallowed each keystroke that passes through a transiently "empty" state —
  // Enter appended a blank line the filter removed, and clearing a number box
  // round-tripped through Number("") === 0, which both blocked retyping and
  // persisted a 0 nobody asked for. Holding the raw text lets those in-between
  // states survive while onChange still persists a clean structure. Keyed by
  // field so selecting another block re-reads from props.
  const [draft, setDraft] = useState<{ key: string; text: string } | null>(null);
  const draftText = (key: string, committed: string): string =>
    draft?.key === key ? draft.text : committed;

  /**
   * Commit a numeric property only once the box holds a usable number. An empty
   * or out-of-range box is mid-edit, not a request to store 0 — `maxBytes: 0`
   * would reject every upload the published form could ever receive.
   */
  function commitNumber(
    field: FormField,
    prop: "scaleMin" | "scaleMax" | "maxBytes",
    raw: string,
    min: number,
  ) {
    setDraft({ key: `${prop}:${field.id}`, text: raw });
    const parsed = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed) || parsed < min) return;
    updateField(field.id, { [prop]: parsed });
  }

  const selectedField = useMemo(
    () => fields.find((f) => f.id === selected) ?? null,
    [fields, selected],
  );

  function addField(kind: FieldKind) {
    const next: FormField = {
      id: nanoid(8),
      kind,
      label: defaultLabel(kind),
      required: kind === "email",
      placeholder: kind === "email" || kind === "name" ? "" : undefined,
      content: kind === "heading" ? "Heading" : kind === "text" ? "Paragraph copy" : undefined,
      customKey: kind === "custom" ? "custom_field" : undefined,
	  options:
		kind === "radio" || kind === "select"
		  ? [{ label: "Option 1" }, { label: "Option 2" }]
		  : undefined,
	  scaleMin: kind === "scale" ? 1 : undefined,
	  scaleMax: kind === "scale" ? 5 : undefined,
	  acceptMime:
		kind === "file_upload" ? ["application/pdf", "image/jpeg", "image/png"] : undefined,
    };
    // Insert right after the selected block (FORM-029: insert at cursor) when a
    // non-submit block is selected; otherwise fall back to "before Submit".
    const selectedIdx = fields.findIndex((f) => f.id === selected);
    const insertIdx =
      selectedIdx >= 0 && fields[selectedIdx].kind !== "submit"
        ? selectedIdx + 1
        : undefined;
    onChange({ fields: insertFieldAt(fields, next, insertIdx) });
    setSelected(next.id);
  }

  // FORM-029: clone a configured field with a fresh id, inserted after it.
  function duplicateField(id: string) {
    const newId = nanoid(8);
    onChange({ fields: duplicateFieldAt(fields, id, () => newId) });
    setSelected(newId);
  }

  function moveField(id: string, dir: -1 | 1) {
    const idx = fields.findIndex((f) => f.id === id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= fields.length) return;
    const cp = [...fields];
    [cp[idx], cp[target]] = [cp[target], cp[idx]];
    onChange({ fields: cp });
  }

  // Move `fromId` to `toId`'s slot (everything else shifts to fill the gap),
  // the standard drag-to-position behaviour.
  function reorderField(fromId: string, toId: string) {
    if (fromId === toId) return;
    const from = fields.findIndex((f) => f.id === fromId);
    const to = fields.findIndex((f) => f.id === toId);
    if (from < 0 || to < 0) return;
    const cp = [...fields];
    const [moved] = cp.splice(from, 1);
    cp.splice(to, 0, moved);
    onChange({ fields: cp });
  }

  function removeField(id: string) {
	const target = fields.find((field) => field.id === id);
	if (
	  target?.kind === "email" &&
	  fields.filter((field) => field.kind === "email").length <= 1
	) {
	  return;
	}
    // FORM-026: capture the pre-removal state so a mis-click on a fully
    // configured block can be reverted from the toast (no config lost).
    const prevFields = fields;
    onChange({ fields: fields.filter((f) => f.id !== id) });
    if (selected === id) setSelected(null);
    toast.success(`Removed "${target?.label ?? "field"}".`, {
      action: {
        label: "Undo",
        onClick: () => {
          onChange({ fields: prevFields });
          setSelected(id);
        },
      },
    });
  }

  function updateField(id: string, patch: Partial<FormField>) {
	onChange({
	  fields: fields.map((f) =>
		f.id === id
		  ? { ...f, ...patch, required: f.kind === "email" ? true : (patch.required ?? f.required) }
		  : f,
	  ),
	});
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-[640px]">
      {/* Palette */}
      <aside className="col-span-1 lg:col-span-3 border rounded-md bg-card p-3 space-y-2">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
          Blocks
        </h3>
        <div className="space-y-1.5">
          {FIELD_PALETTE.map((p) => (
            <button
              key={p.kind}
              type="button"
              onClick={() => addField(p.kind)}
              className="w-full text-left rounded-md border bg-background hover:bg-accent px-3 py-2 text-sm"
            >
              <div className="font-medium">{p.label}</div>
              <div className="text-xs text-muted-foreground">{p.hint}</div>
            </button>
          ))}
        </div>
      </aside>

      {/* Structure list */}
      <div className="col-span-1 lg:col-span-5 border rounded-md bg-card p-3 space-y-2 overflow-y-auto">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
          Form structure
        </h3>
        {fields.length === 0 && (
          <p className="text-sm text-muted-foreground py-8 text-center">
            Empty form. Add a block from the palette.
          </p>
        )}
        <div className="space-y-2" role="list">
          {fields.map((f, i) => (
            <div
              key={f.id}
              role="listitem"
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overId !== f.id) setOverId(f.id);
              }}
              onDragLeave={() => {
                setOverId((prev) => (prev === f.id ? null : prev));
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) reorderField(dragId, f.id);
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              className={cn(
                "space-y-1 rounded-md transition-[opacity,box-shadow] duration-150",
                dragId === f.id && "opacity-40",
                overId === f.id &&
                  dragId &&
                  dragId !== f.id &&
                  "ring-2 ring-primary ring-offset-2 ring-offset-card",
              )}
            >
              <div className="flex items-start gap-1.5">
                {/* Only the grip is draggable — keeps row text selectable and
                    is the conventional handle affordance. Keyboard users
                    reorder via the ↑/↓ buttons below. */}
                <span
                  draggable
                  onDragStart={(e) => {
                    setDragId(f.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", f.id);
                  }}
                  className="mt-2 cursor-grab text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
                  aria-hidden
                  title="Drag to reorder"
                >
                  <GripVertical className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <FieldBlock
                    field={f}
                    selected={selected === f.id}
                    onClick={() => setSelected(f.id)}
                  />
                </div>
              </div>
              <div className="flex items-center gap-1 pl-[26px] text-xs">
                <button
                  type="button"
                  onClick={() => moveField(f.id, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${f.label} up`}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  ↑ Up
                </button>
                <button
                  type="button"
                  onClick={() => moveField(f.id, 1)}
                  disabled={i === fields.length - 1}
                  aria-label={`Move ${f.label} down`}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  ↓ Down
                </button>
                <button
                  type="button"
                  onClick={() => duplicateField(f.id)}
                  aria-label={`Duplicate ${f.label}`}
                  className="ml-auto text-muted-foreground hover:text-foreground"
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  onClick={() => removeField(f.id)}
				  disabled={f.kind === "email" && fields.filter((field) => field.kind === "email").length <= 1}
				  title={f.kind === "email" && fields.filter((field) => field.kind === "email").length <= 1 ? "Every form needs one required email field" : undefined}
                  aria-label={`Remove ${f.label}`}
				  className="text-destructive hover:text-destructive/80 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Props panel */}
      <aside className="col-span-1 lg:col-span-4 border rounded-md bg-card p-3 space-y-3">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
          Properties
        </h3>
        {!selectedField && (
          <p className="text-sm text-muted-foreground">Select a block to edit it.</p>
        )}
        {selectedField && (
          <div className="space-y-3">
            <div>
              <Label htmlFor="prop-label">Label</Label>
              <Input
                id="prop-label"
                value={selectedField.label}
                onChange={(e) => updateField(selectedField.id, { label: e.target.value })}
              />
            </div>
            {(selectedField.kind === "heading" || selectedField.kind === "text") && (
              <div>
                <Label htmlFor="prop-content">Content</Label>
                <Input
                  id="prop-content"
                  value={selectedField.content ?? ""}
                  onChange={(e) => updateField(selectedField.id, { content: e.target.value })}
                />
              </div>
            )}
            {(selectedField.kind === "email" ||
              selectedField.kind === "name" ||
			  selectedField.kind === "custom" ||
			  selectedField.kind === "long_text") && (
              <div>
                <Label htmlFor="prop-placeholder">Placeholder</Label>
                <Input
                  id="prop-placeholder"
                  value={selectedField.placeholder ?? ""}
                  onChange={(e) =>
                    updateField(selectedField.id, { placeholder: e.target.value })
                  }
                />
              </div>
            )}
			{["custom", "radio", "select", "long_text", "scale", "file_upload"].includes(selectedField.kind) && (
              <div>
                <Label htmlFor="prop-key">Custom field key</Label>
                <Input
                  id="prop-key"
                  value={selectedField.customKey ?? ""}
                  onChange={(e) =>
					updateField(selectedField.id, { customKey: safeCustomFieldKey(e.target.value) })
                  }
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Stored as{" "}
                  <code className="text-foreground">
                    custom_fields.{selectedField.customKey || "key"}
                  </code>{" "}
                  on the subscriber.
                </p>
              </div>
            )}
			{(selectedField.kind === "radio" || selectedField.kind === "select") && (
			  <div>
				<Label htmlFor="prop-options">Options (one per line)</Label>
				<textarea
				  id="prop-options"
				  className="mt-1 min-h-28 w-full rounded-md border bg-background p-2 text-sm"
				  value={draftText(
					`options:${selectedField.id}`,
					(selectedField.options ?? []).map((option) => option.label).join("\n"),
				  )}
				  onChange={(event) => {
					setDraft({ key: `options:${selectedField.id}`, text: event.target.value });
					updateField(selectedField.id, {
					  options: event.target.value.split(/\r?\n/).map((label) => label.trim()).filter(Boolean).slice(0, 100).map((label) => ({ label })),
					});
				  }}
				/>
			  </div>
			)}
			{selectedField.kind === "scale" && (
			  <div className="grid grid-cols-2 gap-2">
				<div><Label htmlFor="prop-scale-min">Minimum</Label><Input id="prop-scale-min" type="number" min={0} max={10} value={draftText(`scaleMin:${selectedField.id}`, String(selectedField.scaleMin ?? 1))} onChange={(event) => commitNumber(selectedField, "scaleMin", event.target.value, 0)} /></div>
				<div><Label htmlFor="prop-scale-max">Maximum</Label><Input id="prop-scale-max" type="number" min={0} max={10} value={draftText(`scaleMax:${selectedField.id}`, String(selectedField.scaleMax ?? 5))} onChange={(event) => commitNumber(selectedField, "scaleMax", event.target.value, 0)} /></div>
			  </div>
			)}
			{selectedField.kind === "file_upload" && (
			  <div className="space-y-3">
				<div><Label htmlFor="prop-accept">Accepted file types</Label><Input id="prop-accept" value={draftText(`accept:${selectedField.id}`, (selectedField.acceptMime ?? []).join(", "))} onChange={(event) => { setDraft({ key: `accept:${selectedField.id}`, text: event.target.value }); updateField(selectedField.id, { acceptMime: event.target.value.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 20) }); }} /><p className="mt-1 text-xs text-muted-foreground">Comma-separated MIME types or extensions.</p></div>
				<div><Label htmlFor="prop-max-bytes">Maximum bytes</Label><Input id="prop-max-bytes" type="number" min={1} max={25 * 1024 * 1024} value={draftText(`maxBytes:${selectedField.id}`, String(selectedField.maxBytes ?? 10 * 1024 * 1024))} onChange={(event) => commitNumber(selectedField, "maxBytes", event.target.value, 1)} /></div>
			  </div>
			)}
            {selectedField.kind !== "heading" &&
              selectedField.kind !== "text" &&
              selectedField.kind !== "submit" &&
			  selectedField.kind !== "honeypot" &&
			  selectedField.kind !== "step_break" && (
                <div className="flex items-center gap-2">
                  <input
                    id="prop-required"
                    type="checkbox"
                    checked={selectedField.required}
					disabled={selectedField.kind === "email"}
                    onChange={(e) =>
                      updateField(selectedField.id, { required: e.target.checked })
                    }
                  />
                  <Label htmlFor="prop-required" className="cursor-pointer">
                    Required
                  </Label>
                </div>
              )}
            <div className="flex items-center gap-2 pt-2 border-t">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => duplicateField(selectedField.id)}
              >
                Duplicate block
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
				disabled={selectedField.kind === "email" && fields.filter((field) => field.kind === "email").length <= 1}
                onClick={() => removeField(selectedField.id)}
              >
                Delete block
              </Button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function defaultLabel(kind: FieldKind): string {
  switch (kind) {
    case "email":
      return "Email address";
    case "name":
      return "First name";
    case "checkbox":
      return "I agree to receive emails.";
    case "custom":
      return "Field label";
    case "submit":
      return "Subscribe";
    case "honeypot":
      return "Leave empty";
    case "heading":
      return "Heading";
    case "text":
      return "Paragraph";
    case "radio":
      return "Choose one";
    case "select":
      return "Select an option";
    case "long_text":
      return "Tell us more";
    case "scale":
      return "Rate from 1 to 5";
    case "step_break":
      return "Step break";
    case "file_upload":
      return "Upload a file";
  }
}
