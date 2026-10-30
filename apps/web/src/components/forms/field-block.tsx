// SPDX-License-Identifier: AGPL-3.0-only
//
// Common shape for an in-builder field row: label + input + optional error
// slot. Used by the Builder tab's "props panel" preview when the user
// inspects a field. The hosted form on forms.moosewave.com uses static HTML
// from compileFormHtml() — this React component is admin-only.
"use client";

import { type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { normalizeScaleRange, type FormField } from "@/lib/forms-types";

interface FieldBlockProps {
  field: FormField;
  selected?: boolean;
  onClick?: () => void;
  /** Renders an error message under the input (for the live preview tab). */
  error?: ReactNode;
}

export function FieldBlock({ field, selected, onClick, error }: FieldBlockProps) {
  return (
    <div
      className={cn(
        "relative border rounded-md px-3 py-2 cursor-pointer transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/40",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={Boolean(selected)}
        className="absolute inset-0 z-10 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span className="sr-only">
          Select {field.label || field.kind.replaceAll("_", " ")} field
        </span>
      </button>
      <div className="pointer-events-none" aria-hidden="true">
      {field.kind === "heading" && (
        <h3 className="text-lg font-semibold">{field.content ?? field.label}</h3>
      )}
      {field.kind === "text" && (
        <p className="text-sm text-muted-foreground">{field.content ?? field.label}</p>
      )}
      {field.kind === "email" && (
        <Labeled field={field}>
          <input
            type="email"
            className="w-full border rounded-md h-9 px-3 text-sm bg-background"
            placeholder={field.placeholder}
            disabled
          />
        </Labeled>
      )}
      {field.kind === "name" && (
        <Labeled field={field}>
          <input
            type="text"
            className="w-full border rounded-md h-9 px-3 text-sm bg-background"
            placeholder={field.placeholder}
            disabled
          />
        </Labeled>
      )}
      {field.kind === "checkbox" && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" disabled className="mt-0.5" />
          <span>{field.label}</span>
        </label>
      )}
      {field.kind === "custom" && (
        <Labeled field={field}>
          <input
            type="text"
            className="w-full border rounded-md h-9 px-3 text-sm bg-background"
            placeholder={field.placeholder}
            disabled
          />
          <span className="block text-[11px] text-muted-foreground mt-1">
            custom_fields.{field.customKey ?? field.id}
          </span>
        </Labeled>
      )}
	  {field.kind === "long_text" && (
		<Labeled field={field}>
		  <textarea disabled rows={3} className="w-full rounded-md border bg-background p-2 text-sm" placeholder={field.placeholder} />
		</Labeled>
	  )}
	  {field.kind === "select" && (
		<Labeled field={field}>
		  <select disabled className="h-9 w-full rounded-md border bg-background px-3 text-sm">
			<option>Select…</option>
			{(field.options ?? []).map((option) => <option key={option.value ?? option.label}>{option.label}</option>)}
		  </select>
		</Labeled>
	  )}
	  {field.kind === "radio" && (
		<fieldset className="space-y-1">
		  <legend className="text-xs font-medium text-muted-foreground">{field.label}{field.required ? " *" : ""}</legend>
		  {(field.options ?? []).map((option) => (
			<label key={option.value ?? option.label} className="flex items-center gap-2 text-sm">
			  <input type="radio" disabled /> {option.label}
			</label>
		  ))}
		</fieldset>
	  )}
	  {field.kind === "scale" && (
		<fieldset>
		  <legend className="text-xs font-medium text-muted-foreground">{field.label}{field.required ? " *" : ""}</legend>
		  <div className="mt-1 flex flex-wrap gap-2">
			{scalePoints(field).map((value) => (
			  <label key={value} className="flex items-center gap-1 text-sm"><input type="radio" disabled />{value}</label>
			))}
		  </div>
		</fieldset>
	  )}
	  {field.kind === "step_break" && (
		<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><span className="h-px flex-1 bg-border" />Next step<span className="h-px flex-1 bg-border" /></div>
	  )}
	  {field.kind === "file_upload" && (
		<Labeled field={field}>
		  <input type="file" disabled className="block w-full text-sm" accept={(field.acceptMime ?? []).join(",")} />
		</Labeled>
	  )}
      {field.kind === "honeypot" && (
        <div className="text-xs text-muted-foreground italic">
          Honeypot — hidden from real users; bots that fill it get silently
          dropped.
        </div>
      )}
      {field.kind === "submit" && (
        <button
          type="button"
          disabled
          className="bg-primary text-primary-foreground rounded-md h-9 px-4 text-sm font-medium"
        >
          {field.label}
        </button>
      )}
      </div>
      {error && (
        <div className="relative z-20 mt-1 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * The selectable points of a `scale` field, via the same normalisation the
 * published form and SurveyForm use. Previously this preview clamped the count
 * to `Math.max(0, …)`, so an inverted range silently drew an empty row — the
 * builder showed nothing was wrong while the stored range was unanswerable.
 */
function scalePoints(field: FormField): number[] {
  const { min, max } = normalizeScaleRange(field.scaleMin, field.scaleMax);
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

function Labeled({ field, children }: { field: FormField; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">
        {field.label}
        {field.required && <span className="text-destructive"> *</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
