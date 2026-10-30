// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import { STALE } from "@/lib/query-keys";
import { listScoredSubscribers } from "@/lib/subscriber-directory-api";

const PER_PAGE = 25;

export interface ScoreRangeBucket {
  range: string;
  min: number;
  max: number;
  count: number;
}

function bound(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : "invalid";
}

/**
 * "Browse by score": pick a decile bucket (or type a min/max) and page through
 * the scored subscribers in that range, highest first; each row opens the
 * subscriber. Reads GET /api/v1/engagement-scores/subscribers.
 */
export function ScoreDistributionBrowser({
  buckets,
  queryKeyPrefix,
}: {
  buckets: readonly ScoreRangeBucket[];
  queryKeyPrefix: readonly unknown[];
}) {
  const minId = useId();
  const maxId = useId();
  const [minDraft, setMinDraft] = useState("");
  const [maxDraft, setMaxDraft] = useState("");
  const [range, setRange] = useState<{ min: number | null; max: number | null } | null>(
    null,
  );
  const [page, setPage] = useState(1);
  const [formError, setFormError] = useState<string | null>(null);

  const results = useQuery({
    queryKey: [...queryKeyPrefix, "engagement-browse", range, page],
    queryFn: ({ signal }) =>
      listScoredSubscribers(
        { min: range?.min ?? null, max: range?.max ?? null, page, perPage: PER_PAGE },
        signal,
      ),
    enabled: range !== null,
    staleTime: STALE.list,
    retry: false,
  });

  const browse = (min: number | null, max: number | null) => {
    setMinDraft(min === null ? "" : String(min));
    setMaxDraft(max === null ? "" : String(max));
    setFormError(null);
    setPage(1);
    setRange({ min, max });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const min = bound(minDraft);
    const max = bound(maxDraft);
    if (min === "invalid" || max === "invalid") {
      setFormError("Score bounds must be whole numbers.");
      return;
    }
    if (min !== null && max !== null && min > max) {
      setFormError("The minimum cannot be above the maximum.");
      return;
    }
    browse(min, max);
  };

  const data = results.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  return (
    <div className="mt-4 space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">Browse by score</h3>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Score buckets">
        {buckets.map((bucket) => {
          const active = range?.min === bucket.min && range?.max === bucket.max;
          return (
            <Button
              key={`${bucket.min}:${bucket.max}`}
              type="button"
              size="sm"
              variant={active ? "secondary" : "outline"}
              aria-pressed={active}
              onClick={() => browse(bucket.min, bucket.max)}
            >
              {bucket.range}
            </Button>
          );
        })}
      </div>
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <div className="grid gap-1">
          <Label htmlFor={minId}>Min score</Label>
          <Input
            id={minId}
            inputMode="numeric"
            value={minDraft}
            placeholder="any"
            onChange={(event) => setMinDraft(event.target.value)}
            className="h-9 w-24"
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={maxId}>Max score</Label>
          <Input
            id={maxId}
            inputMode="numeric"
            value={maxDraft}
            placeholder="any"
            onChange={(event) => setMaxDraft(event.target.value)}
            className="h-9 w-24"
          />
        </div>
        <Button type="submit" variant="outline" size="sm" className="h-9">
          Browse
        </Button>
      </form>
      {formError ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}

      {range === null ? null : results.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading scored subscribers…
        </p>
      ) : results.isError ? (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <span>{apiErrorMessage(results.error, "Could not load scored subscribers.")}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void results.refetch()}>
            Retry
          </Button>
        </div>
      ) : data && data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No scored subscribers in this range.
        </p>
      ) : data ? (
        <>
          <ul aria-label="Scored subscribers" className="divide-y rounded-md border text-sm">
            {data.items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <Link
                  href={`/app/subscribers/${encodeURIComponent(item.id)}`}
                  className="min-w-0 truncate text-primary underline-offset-2 hover:underline"
                >
                  {item.email || item.id}
                </Link>
                <span className="tabular-nums text-muted-foreground">{item.score}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {data.total.toLocaleString()} in range · page {data.page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page <= 1 || results.isFetching}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page >= totalPages || results.isFetching}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
