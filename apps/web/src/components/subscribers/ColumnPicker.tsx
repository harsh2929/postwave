// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns3 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api";
import { base, STALE } from "@/lib/query-keys";
import {
  DEFAULT_DIRECTORY_COLUMNS,
  DIRECTORY_COLUMNS,
  getDirectoryViewPrefs,
  normalizeDirectoryColumns,
  putDirectoryViewPrefs,
  type DirectoryColumnKey,
  type DirectoryViewPrefs,
} from "@/lib/subscriber-directory-api";

import { useDirectoryIdentity } from "./directory-context";

const SAVE_DEBOUNCE_MS = 500;

/**
 * The signed-in user's visible directory columns, persisted per user through
 * GET/PUT /api/v1/me/prefs/subscribers_view (the same preference desktop
 * reads, so a column set follows the person across clients). Changes apply
 * immediately and are written after a short debounce, flushed on unmount.
 */
export function useDirectoryColumns() {
  const identity = useDirectoryIdentity();
  const queryClient = useQueryClient();
  const key = base("subscribers-view-prefs", identity.tenantId, identity.role);
  const prefs = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getDirectoryViewPrefs(signal),
    enabled: identity.ready,
    staleTime: STALE.list,
  });
  const [draft, setDraft] = useState<DirectoryColumnKey[] | null>(null);
  const pending = useRef<{ previous: DirectoryViewPrefs; columns: DirectoryColumnKey[] } | null>(
    null,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  });

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    try {
      const saved = await putDirectoryViewPrefs(next.previous, next.columns);
      queryClient.setQueryData(keyRef.current, saved);
    } catch (error) {
      toast.error(apiErrorMessage(error, "Could not save your column choice."));
    }
  }, [queryClient]);

  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );

  const columns =
    draft ?? prefs.data?.columns ?? DEFAULT_DIRECTORY_COLUMNS;

  const setColumns = useCallback(
    (next: readonly DirectoryColumnKey[]) => {
      if (!identity.canWrite) return;
      const normalized = normalizeDirectoryColumns(next);
      setDraft(normalized);
      pending.current = {
        previous: prefs.data ?? { columns: null, widths: {}, sort: "", order: "" },
        columns: normalized,
      };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush, identity.canWrite, prefs.data],
  );

  return {
    columns,
    isVisible: (column: DirectoryColumnKey) => columns.includes(column),
    setColumns,
    flush,
    canPersist: identity.canWrite,
    loadError: prefs.isError ? prefs.error : null,
  };
}

export function ColumnPicker({
  controller,
}: {
  controller: ReturnType<typeof useDirectoryColumns>;
}) {
  const { columns, setColumns, canPersist, loadError } = controller;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-9">
          <Columns3 aria-hidden className="h-4 w-4" />
          Columns
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Visible columns</DialogTitle>
          <DialogDescription>
            {canPersist
              ? "Saved to your profile and used on every device."
              : "Viewers see the default columns; column choices are not saved for this role."}
          </DialogDescription>
        </DialogHeader>
        {loadError ? (
          <p role="alert" className="text-sm text-destructive">
            {apiErrorMessage(loadError, "Could not load your saved columns; showing the defaults.")}
          </p>
        ) : null}
        <fieldset className="grid gap-2" disabled={!canPersist}>
          <legend className="sr-only">Columns</legend>
          {DIRECTORY_COLUMNS.map((column) => {
            const required = "required" in column && column.required === true;
            const checked = columns.includes(column.key);
            return (
              <label key={column.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={checked}
                  disabled={required}
                  onChange={(event) =>
                    setColumns(
                      event.target.checked
                        ? [...columns, column.key]
                        : columns.filter((key) => key !== column.key),
                    )
                  }
                />
                {column.label}
                {required ? (
                  <span className="text-xs text-muted-foreground">(always shown)</span>
                ) : null}
              </label>
            );
          })}
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}
