// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Reference tab — the complete live contract, filterable (desktop
 * APIPlaygroundReference). Every operation is listed, including the ones the
 * runner will not execute; those carry the reason, and a release-held route
 * names its hold rather than disappearing.
 */
import { useDeferredValue, useId, useMemo, useState, type ReactNode } from "react";
import { Copy, Play } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  PLAYGROUND_METHODS,
  playgroundPolicyFor,
  type PlaygroundMethod,
  type PlaygroundOperation,
} from "@/lib/api-playground-catalog";
import { copyToClipboard } from "@/lib/clipboard";

import { MethodBadge } from "./playground-runner";

const PAGE_SIZE = 100;

export function PlaygroundReference({
  operations,
  selectedKey,
  onSelect,
  onOpenInRunner,
}: {
  operations: PlaygroundOperation[];
  selectedKey: string;
  onSelect: (key: string) => void;
  onOpenInRunner: (key: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const needle = useDeferredValue(query.trim().toLowerCase());
  const [method, setMethod] = useState<"all" | PlaygroundMethod>("all");
  const [tag, setTag] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const operation of operations) {
      for (const item of new Set(operation.tags)) {
        counts.set(item, (counts.get(item) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [operations]);
  const filtered = useMemo(
    () =>
      operations.filter(
        (operation) =>
          (method === "all" || operation.method === method) &&
          (!tag || operation.tags.includes(tag)) &&
          (!needle || operation.searchText.includes(needle)),
      ),
    [method, needle, operations, tag],
  );
  const filtersActive = query.trim().length > 0 || method !== "all" || tag !== "";
  const selected = filtered.find((operation) => operation.key === selectedKey) ?? filtered[0];
  const shown = filtered.slice(0, limit);
  const clear = () => {
    setQuery("");
    setMethod("all");
    setTag("");
    setLimit(PAGE_SIZE);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-xl border p-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="space-y-1">
          <label htmlFor={`${id}-search`} className="text-xs font-medium text-muted-foreground">
            Search API operations
          </label>
          <Input
            id={`${id}-search`}
            type="search"
            value={query}
            maxLength={200}
            placeholder="Path, summary, parameter, scope, or hold"
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(PAGE_SIZE);
            }}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-tag`} className="text-xs font-medium text-muted-foreground">
            Tag
          </label>
          <Select id={`${id}-tag`} value={tag} onChange={(event) => setTag(event.target.value)}>
            <option value="">All tags ({operations.length})</option>
            {tagCounts.map(([name, count]) => (
              <option key={name} value={name}>
                {name} ({count})
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-1 md:col-span-2" role="group" aria-label="HTTP method">
          {(["all", ...PLAYGROUND_METHODS] as const).map((candidate) => (
            <Button
              key={candidate}
              type="button"
              size="sm"
              variant={method === candidate ? "secondary" : "ghost"}
              aria-pressed={method === candidate}
              onClick={() => setMethod(candidate)}
            >
              {candidate === "all" ? "All" : candidate.toUpperCase()}
            </Button>
          ))}
          <span className="ml-auto text-xs tabular-nums text-muted-foreground" role="status" aria-live="polite">
            {filtered.length} of {operations.length} operations
          </span>
          <Button type="button" size="sm" variant="outline" disabled={!filtersActive} onClick={clear}>
            Clear filters
          </Button>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="min-w-0 space-y-2">
          {filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              <p>No operations match these filters.</p>
              <Button type="button" variant="link" className="px-0" onClick={clear}>
                Clear filters
              </Button>
            </div>
          ) : (
            <ul className="max-h-[34rem] divide-y overflow-y-auto rounded-lg border" aria-label="API operations">
              {shown.map((operation) => (
                <li key={operation.key}>
                  <button
                    type="button"
                    aria-pressed={operation.key === selected?.key}
                    onClick={() => onSelect(operation.key)}
                    className={`flex w-full min-w-0 items-start gap-2 p-2.5 text-left hover:bg-muted/40 ${operation.key === selected?.key ? "bg-muted/60" : ""}`}
                  >
                    <MethodBadge method={operation.method} />
                    <span className="min-w-0">
                      <code className="block break-all text-xs">{operation.path}</code>
                      <span className="block truncate text-xs text-muted-foreground">
                        {operation.summary}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {filtered.length > shown.length ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setLimit((current) => current + PAGE_SIZE)}
            >
              Show {Math.min(PAGE_SIZE, filtered.length - shown.length)} more
            </Button>
          ) : null}
        </div>
        {selected ? (
          <OperationDetail operation={selected} onOpenInRunner={onOpenInRunner} />
        ) : (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            Nothing selected — no operation matches the current filters.
          </p>
        )}
      </div>
    </div>
  );
}

function OperationDetail({
  operation,
  onOpenInRunner,
}: {
  operation: PlaygroundOperation;
  onOpenInRunner: (key: string) => void;
}) {
  const policy = playgroundPolicyFor(operation);
  const route = operation.key;

  async function copyRoute() {
    const result = await copyToClipboard(route);
    if (result === "copied") toast.success(`Copied ${route}`);
    else if (result === "unavailable") toast.error("Clipboard is unavailable in this browser context.");
    else toast.error("Couldn’t copy the route.");
  }

  return (
    <article aria-label={`${route} reference`} className="min-w-0 space-y-4 rounded-xl border p-4">
      <header className="space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <MethodBadge method={operation.method} />
          <code className="break-all text-sm font-medium">{operation.path}</code>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Copy route ${route}`}
            onClick={() => void copyRoute()}
          >
            <Copy aria-hidden />
            Copy route
          </Button>
        </div>
        <h2 className="text-base font-semibold">{operation.summary}</h2>
        {operation.description ? (
          <p className="whitespace-pre-line text-sm text-muted-foreground">{operation.description}</p>
        ) : null}
        <div className="flex flex-wrap gap-1.5" aria-label="Operation metadata">
          <Badge variant="outline">{operation.explicitlyPublic ? "Public" : "Authenticated"}</Badge>
          <Badge variant={policy.executable ? "success" : "secondary"}>
            {policy.executable ? "Runs on web" : "Reference only"}
          </Badge>
          {operation.deprecated ? <Badge variant="destructive">Deprecated</Badge> : null}
          {operation.releaseHold ? <Badge variant="warning">Release hold</Badge> : null}
          {operation.contractIssues.length > 0 ? (
            <Badge variant="destructive">
              {operation.contractIssues.length} contract{" "}
              {operation.contractIssues.length === 1 ? "issue" : "issues"}
            </Badge>
          ) : null}
        </div>
        {policy.executable ? (
          <Button type="button" size="sm" onClick={() => onOpenInRunner(operation.key)}>
            <Play aria-hidden />
            Open in runner
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">{policy.reason}</p>
        )}
      </header>

      {operation.releaseHold ? (
        <Alert variant="warning">
          <AlertTitle>Release hold</AlertTitle>
          <AlertDescription>
            {operation.releaseHold}. The server answers this route with a 503
            release hold until it is released, so the runner does not send it.
          </AlertDescription>
        </Alert>
      ) : null}
      {operation.contractIssues.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>Contract issues</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {operation.contractIssues.map((issue, index) => (
                <li key={`${index}-${issue}`}>{issue}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <DetailSection title="Contract">
        <Facts
          rows={[
            ["Operation ID", operation.operationId],
            ["Tags", operation.tags.join(", ")],
            [
              "Request body",
              operation.requestBody
                ? operation.requestBody.required
                  ? "Required body declared"
                  : "Optional body declared"
                : "No request body declared",
            ],
            [
              "Maximum request body",
              operation.maxBodyBytes === undefined ? "Not declared" : `${operation.maxBodyBytes} bytes`,
            ],
          ]}
        />
      </DetailSection>

      <DetailSection title="Authentication and authorization">
        {operation.explicitlyPublic ? (
          <p className="text-sm text-muted-foreground">Explicitly public — no authentication required.</p>
        ) : operation.security.length > 0 ? (
          <ol className="space-y-1 text-sm">
            {operation.security.map((option, index) => (
              <li key={`${index}-${option.join("+")}`}>
                <span className="text-muted-foreground">Option {index + 1}: </span>
                <code>{option.join(" + ") || "No schemes declared"}</code>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No authentication scheme is declared.</p>
        )}
        <Facts
          rows={[
            ["Required role", operation.requiredRole ?? "Not declared"],
            ["Required scopes", operation.requiredScopes.join(", ") || "None declared"],
            ["Scope mode", operation.requiredScopeMode ?? "Not declared"],
          ]}
        />
      </DetailSection>

      <DetailSection title={`Parameters (${operation.parameters.length})`}>
        {operation.parameters.length === 0 ? (
          <p className="text-sm text-muted-foreground">No path, query, or header parameters.</p>
        ) : (
          <ul className="space-y-3">
            {operation.parameters.map((parameter) => (
              <li key={`${parameter.location}:${parameter.name}`} className="space-y-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all font-medium">{parameter.name}</code>
                  <Badge variant="outline">{parameter.location}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {parameter.required ? "Required" : "Optional"}
                  </span>
                </div>
                {parameter.description ? (
                  <p className="text-muted-foreground">{parameter.description}</p>
                ) : null}
                <JsonDisclosure label="Example" subject={parameter.name} value={parameter.example} />
                <JsonDisclosure label="Schema" subject={parameter.name} value={parameter.schema} />
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Request body">
        {operation.requestBody ? (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              {operation.requestBody.required ? "Required body." : "Optional body."}{" "}
              {operation.requestBody.description ?? ""}
            </p>
            <p>
              Media types:{" "}
              <code className="break-all">{operation.requestBody.mediaTypes.join(", ") || "none"}</code>
            </p>
            <JsonDisclosure label="Example body" subject="request body" value={operation.requestBody.example} />
            <JsonDisclosure label="Request schema" subject="request body" value={operation.requestBody.schema} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No request body is declared.</p>
        )}
      </DetailSection>

      <DetailSection title="Responses">
        {operation.responses.statuses.length === 0 ? (
          <p className="text-sm text-muted-foreground">No response statuses are declared.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {operation.responses.statuses.map((status) => {
              const media = operation.responses.mediaTypesByStatus[status] ?? [];
              return (
                <li key={status} className="flex flex-wrap gap-2">
                  <code className="font-medium">{status}</code>
                  <span className="break-all text-muted-foreground">
                    {media.length > 0 ? media.join(", ") : "No response body media declared"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </DetailSection>
    </article>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t pt-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function JsonDisclosure({
  label,
  subject,
  value,
}: {
  label: string;
  subject: string;
  value: unknown;
}) {
  const [open, setOpen] = useState(false);
  if (value === undefined) return null;
  return (
    <details
      className="rounded-md border bg-muted/10"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer px-2 py-1 text-xs font-medium" aria-label={`${label} for ${subject}`}>
        {label}
      </summary>
      {open ? (
        <pre
          tabIndex={0}
          role="group"
          aria-label={`${label} for ${subject} JSON`}
          className="max-h-80 overflow-auto border-t p-2 text-xs leading-5"
        >
          <code>{JSON.stringify(value, null, 2)}</code>
        </pre>
      ) : null}
    </details>
  );
}
