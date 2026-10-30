// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type {
  Comparator,
  EventCountValue,
  SegmentCondition,
  TagWindowValue,
} from "@/lib/segments-api";

import type { FieldKind } from "./field-picker";
import {
  DAY_WINDOW_COMPARATORS,
  SEGMENT_REFERENCE_COMPARATORS,
  TAG_WINDOW_COMPARATORS,
  formatRelativeDate,
  isRelativeDate,
  isValuelessComparator,
  parseRelativeDate,
} from "./segment-logic";

/** A segment a rule can refer to. */
export interface SegmentOption {
  id: string;
  name: string;
}

/** The segments a segment-of-segments rule can pick from, as loaded. */
export interface SegmentChoices {
  /** Undefined until the list has loaded. */
  items?: SegmentOption[];
  /** The list couldn't be loaded. */
  failed?: boolean;
  /** Loads the list again. */
  retry?: () => void;
}

export interface ValueInputProps {
  kind: FieldKind;
  comparator: Comparator;
  value: SegmentCondition["value"];
  onChange: (v: SegmentCondition["value"]) => void;
  /** Known allowed values (enum custom fields / registry) for suggestions. */
  options?: string[];
  /** The registry's value type, for values that need a dedicated control. */
  valueType?: string;
  /** The event an event-count field counts, as tracked (see FieldDef). */
  eventName?: string;
  /**
   * Segments a segment-of-segments rule may refer to (the one being edited is
   * already left out).
   */
  segments?: SegmentChoices;
}

const LIST_COMPARATORS: Comparator[] = ["in", "not_in"];

/** The registry value type of event-count predicates. */
export const EVENT_COUNT_VALUE_TYPE = "metric_aggregate";

export function ValueInput({
  kind,
  comparator,
  value,
  onChange,
  options,
  valueType,
  eventName,
  segments,
}: ValueInputProps) {
  // Presence operators take no value — the compiler emits IS [NOT] NULL.
  if (isValuelessComparator(comparator)) {
    return (
      <span className="inline-flex h-9 items-center px-1 text-xs text-muted-foreground">
        No value needed
      </span>
    );
  }

  if (SEGMENT_REFERENCE_COMPARATORS.includes(comparator)) {
    return (
      <SegmentReferenceSelect
        value={typeof value === "string" ? value : ""}
        segments={segments}
        onChange={onChange}
      />
    );
  }

  if (TAG_WINDOW_COMPARATORS.includes(comparator)) {
    return <TagWindowInput value={value} onChange={onChange} />;
  }

  if (valueType === EVENT_COUNT_VALUE_TYPE) {
    return (
      <EventCountInput
        windowOnly={DAY_WINDOW_COMPARATORS.includes(comparator)}
        eventName={eventName}
        value={value}
        onChange={onChange}
      />
    );
  }

  if (DAY_WINDOW_COMPARATORS.includes(comparator)) {
    return (
      <DayCountInput
        value={dayCountOf(value)}
        onChange={(days) => onChange(days ?? "")}
      />
    );
  }

  // For in/not_in, render de-duplicated removable chips (SEG-035).
  if (LIST_COMPARATORS.includes(comparator)) {
    const values = Array.isArray(value)
      ? value.map((v) => String(v))
      : String(value ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    return <ChipsInput values={values} options={options} onChange={onChange} />;
  }

  switch (kind) {
    case "date":
      return (
        <DateValueInput
          comparator={comparator}
          value={value}
          onChange={onChange}
        />
      );
    case "numeric":
      return (
        <Input
          type="number"
          aria-label="Value"
          min={0}
          step={1}
          // Preserve empty as "" (unset) instead of silently coercing to 0.
          value={scalarText(value)}
          onChange={(e) => {
            const raw = e.target.value;
            onChange(raw === "" ? "" : Number(raw));
          }}
        />
      );
    case "boolean":
      return (
        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Value"
          value={String(value ?? "true")}
          onChange={(e) => onChange(e.target.value === "true")}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    case "string":
    default:
      // Matching a field with a closed set of values (status, RFM segment,
      // …) is a choice, not free text: a typo would save a rule that matches
      // nobody. Partial matches (contains, starts with) stay free text, with
      // the known values as suggestions.
      if (
        options &&
        options.length > 0 &&
        (comparator === "equals" || comparator === "not_equals")
      ) {
        return (
          <OptionSelect
            value={scalarText(value)}
            options={options}
            onChange={onChange}
          />
        );
      }
      return (
        <SuggestingTextInput
          value={scalarText(value)}
          options={options}
          onChange={onChange}
        />
      );
  }
}

/**
 * Text for a scalar input. A value of another shape (left over from a
 * comparator that took an object or a list) shows as empty, not as
 * "[object Object]".
 */
function scalarText(value: SegmentCondition["value"]): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/** Free text, with the field's known values offered as suggestions. */
function SuggestingTextInput({
  value,
  options,
  onChange,
}: {
  value: string;
  options?: string[];
  onChange: (v: string) => void;
}) {
  const listId = React.useId();
  const suggest = options && options.length > 0;
  return (
    <>
      <Input
        type="text"
        aria-label="Value"
        list={suggest ? listId : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {suggest ? (
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}

/** One of a field's known values. */
function OptionSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const known = options.includes(value);
  return (
    <select
      className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[18rem]"
      aria-label="Value"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="" disabled>
        Choose a value
      </option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
      {value && !known ? <option value={value}>{value}</option> : null}
    </select>
  );
}

/** A stored day count, accepting the `now-Nd` token older rules carry. */
function dayCountOf(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  const relative = parseRelativeDate(value);
  if (relative) return relative.days;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A whole number of days, 1 to 36,500. Emits undefined while the box is
 * empty, so the rule reads as incomplete instead of silently becoming 1.
 */
function DayCountInput({
  value,
  onChange,
  label = "Days",
}: {
  value: number | undefined;
  onChange: (days: number | undefined) => void;
  label?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        max={36500}
        step={1}
        aria-label={label}
        className="w-24"
        value={value === undefined ? "" : String(value)}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return onChange(undefined);
          const n = Number(raw);
          onChange(Number.isFinite(n) ? Math.trunc(n) : undefined);
        }}
      />
      <span className="text-sm text-muted-foreground">days</span>
    </span>
  );
}

/** Picks another saved segment for a segment-of-segments rule. */
function SegmentReferenceSelect({
  value,
  segments,
  onChange,
}: {
  value: string;
  segments?: SegmentChoices;
  onChange: (v: string) => void;
}) {
  const items = segments?.items;
  const failed = items === undefined && segments?.failed === true;
  const loading = items === undefined && !failed;
  const known = items?.some((s) => s.id === value) ?? false;
  const retry = segments?.retry;
  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
      <select
        className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[18rem]"
        aria-label="Segment"
        value={value}
        disabled={items === undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          {loading
            ? "Loading segments…"
            : failed
              ? "Couldn't load your segments"
              : items!.length === 0
                ? "No other segments yet"
                : "Choose a segment"}
        </option>
        {items?.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        {value && !loading && !known ? (
          <option value={value}>
            {failed
              ? "A saved segment (couldn't load its name)"
              : "A segment that no longer exists"}
          </option>
        ) : null}
      </select>
      {failed ? (
        <>
          <span role="alert" className="sr-only">
            Couldn&apos;t load your segments.
          </span>
          {retry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:h-9 sm:min-h-0"
              aria-label="Retry loading segments"
              onClick={retry}
            >
              Retry
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Tag name plus look-back window, stored as `{ tag, days }`. */
function TagWindowInput({
  value,
  onChange,
}: {
  value: SegmentCondition["value"];
  onChange: (v: TagWindowValue) => void;
}) {
  const current = isRecord(value) ? value : {};
  const tag = typeof current.tag === "string" ? current.tag : "";
  const days = typeof current.days === "number" ? current.days : undefined;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Input
        type="text"
        aria-label="Tag name"
        placeholder="Tag name"
        className="w-40"
        value={tag}
        onChange={(e) => onChange({ tag: e.target.value, days })}
      />
      <DayCountInput
        value={days}
        onChange={(d) => onChange({ tag, days: d })}
      />
    </span>
  );
}

/**
 * Event count rule. Count comparators take a count and an optional window
 * ("within the last N days"); the window comparators take only the window.
 * Every value it writes names the event, so the rule counts the event the
 * field stands for rather than whatever is tracked under its slug.
 */
function EventCountInput({
  windowOnly,
  eventName,
  value,
  onChange,
}: {
  windowOnly: boolean;
  eventName?: string;
  value: SegmentCondition["value"];
  onChange: (v: EventCountValue) => void;
}) {
  const emit = (next: EventCountValue) =>
    onChange(eventName ? { ...next, event_name: eventName } : next);
  const current = isRecord(value) ? value : {};
  // Rules written before the { count, days } shape store a bare number, which
  // the compiler reads as the window for window comparators and as the
  // all-time count threshold for the others.
  const bare = typeof value === "number" ? value : undefined;
  const count = windowOnly
    ? undefined
    : (bare ?? (typeof current.count === "number" ? current.count : undefined));
  const days = windowOnly
    ? (bare ?? (typeof current.days === "number" ? current.days : undefined))
    : typeof current.days === "number"
      ? current.days
      : undefined;
  if (windowOnly) {
    return <DayCountInput value={days} onChange={(d) => emit({ days: d })} />;
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        aria-label="Count"
        className="w-24"
        value={count === undefined ? "" : String(count)}
        onChange={(e) => {
          const raw = e.target.value.trim();
          const next = raw === "" ? undefined : Number(raw);
          emit({
            ...(next !== undefined && Number.isFinite(next)
              ? { count: next }
              : {}),
            ...(days !== undefined ? { days } : {}),
          });
        }}
      />
      <span className="text-sm text-muted-foreground">
        times, within the last
      </span>
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        max={36500}
        step={1}
        aria-label="Window in days (optional)"
        placeholder="all time"
        className="w-24"
        value={days === undefined ? "" : String(days)}
        onChange={(e) => {
          const raw = e.target.value.trim();
          const next = raw === "" ? undefined : Math.trunc(Number(raw));
          emit({
            ...(count !== undefined ? { count } : {}),
            ...(next !== undefined && Number.isFinite(next)
              ? { days: next }
              : {}),
          });
        }}
      />
      <span className="text-sm text-muted-foreground">days</span>
    </span>
  );
}

/**
 * Date value editor with an Absolute/Relative toggle. Relative mode encodes a
 * rolling `now-Nd` window that stays correct over time; the helper text reads
 * the meaning off the paired comparator (SEG-008).
 */
function DateValueInput({
  comparator,
  value,
  onChange,
}: {
  comparator: Comparator;
  value: SegmentCondition["value"];
  onChange: (v: SegmentCondition["value"]) => void;
}) {
  const relative = isRelativeDate(value);
  const parsed = parseRelativeDate(value);
  const withinLast = comparator === "gte" || comparator === "gt";

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2">
        <div
          role="radiogroup"
          aria-label="Date mode"
          className="inline-flex shrink-0 rounded-md border bg-background p-0.5"
        >
          <ModeButton
            active={!relative}
            onClick={() => onChange("")}
            label="Date"
          />
          <ModeButton
            active={relative}
            onClick={() => onChange(formatRelativeDate(parsed?.days ?? 30))}
            label="Relative"
          />
        </div>
        {relative ? (
          <Input
            type="number"
            min={1}
            step={1}
            aria-label="Days"
            className="w-24"
            value={parsed ? String(parsed.days) : ""}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange(formatRelativeDate(Number.isFinite(n) ? n : 1));
            }}
          />
        ) : (
          <Input
            type="datetime-local"
            aria-label="Value"
            value={
              typeof value === "string" && !isRelativeDate(value) ? value : ""
            }
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
      {relative ? (
        <span className="text-xs text-muted-foreground">
          {withinLast
            ? `Within the last ${parsed?.days ?? 30} days`
            : `${parsed?.days ?? 30} or more days ago`}
        </span>
      ) : null}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "rounded px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/** Removable, de-duplicated chips for list-membership values (SEG-035). */
function ChipsInput({
  values,
  options,
  onChange,
}: {
  values: string[];
  options?: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const listId = React.useId();

  const commit = (raw: string) => {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const seen = new Set(values.map((v) => v.toLowerCase()));
    const next = [...values];
    for (const p of parts) {
      if (!seen.has(p.toLowerCase())) {
        seen.add(p.toLowerCase());
        next.push(p);
      }
    }
    onChange(next);
    setDraft("");
  };

  const remove = (v: string) => onChange(values.filter((x) => x !== v));

  const suggestions = (options ?? []).filter(
    (o) => !values.some((v) => v.toLowerCase() === o.toLowerCase()),
  );

  return (
    <div className="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-background px-2 py-1">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs"
        >
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => remove(v)}
            className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        className="min-w-[6rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        aria-label="Add value"
        placeholder={values.length ? "Add…" : "alpha, beta, gamma"}
        list={suggestions.length ? listId : undefined}
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          // Comma commits the pending token(s) immediately.
          if (v.endsWith(",")) commit(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && values.length) {
            remove(values[values.length - 1]!);
          }
        }}
        onBlur={() => draft.trim() && commit(draft)}
      />
      {suggestions.length ? (
        <datalist id={listId}>
          {suggestions.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}
