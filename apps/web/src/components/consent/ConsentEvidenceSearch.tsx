// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { CONSENT_QUERY_MAX } from "./consent-evidence-view";

/**
 * Search over LOADED consent evidence (email, source, policy, record identity).
 *
 * "/" anywhere on the page focuses the field unless the operator is already
 * typing in another control; Esc clears a non-empty query (desktop
 * Consent.tsx:644-670, 1641-1663). Search never widens the read — rows on
 * pages that have not been loaded cannot match.
 */
export function ConsentEvidenceSearch({
  value,
  onChange,
  label = "Search loaded evidence",
  placeholder = "Email, source, policy, or record identity",
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  placeholder?: string;
}) {
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key !== "/" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={inputRef}
          id={inputId}
          type="search"
          className="pl-9 pr-10"
          placeholder={placeholder}
          maxLength={CONSENT_QUERY_MAX}
          autoComplete="off"
          aria-describedby={hintId}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !value) return;
            event.preventDefault();
            onChange("");
          }}
        />
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground"
        >
          /
        </kbd>
      </div>
      <p id={hintId} className="sr-only">
        Press slash to focus this search and Escape to clear it.
      </p>
    </div>
  );
}
