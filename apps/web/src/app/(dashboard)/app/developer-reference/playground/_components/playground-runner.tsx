// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Runner tab — pick an operation, fill its declared inputs, and send ONE
 * exact request with the dashboard session (desktop APIPlaygroundWorkbench).
 *
 * Reads send on click. Every write opens a review of the exact method, URL,
 * headers and body first; DELETE additionally requires the route typed back.
 * While a request is in flight it can be cancelled, and once a response lands
 * "New attempt" mints a fresh Idempotency-Key and clears it.
 */
import { useDeferredValue, useId, useMemo, useState } from "react";
import { Braces, Star } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  PLAYGROUND_METHODS,
  playgroundEnumValues,
  playgroundPolicyFor,
  type PlaygroundMethod,
  type PlaygroundOperation,
  type PlaygroundParameter,
} from "@/lib/api-playground-catalog";
import type { PlaygroundResponse } from "@/lib/api-playground-transport";

import type { PlaygroundController } from "./use-playground-controller";

const PAGE_SIZE = 100;

export function MethodBadge({ method }: { method: PlaygroundMethod }) {
  const variant =
    method === "get"
      ? "info"
      : method === "delete"
        ? "destructive"
        : method === "post"
          ? "success"
          : "warning";
  return (
    <Badge variant={variant} className="shrink-0 font-mono uppercase">
      {method}
    </Badge>
  );
}

export function PlaygroundRunner({
  operations,
  controller,
  favorites,
  onToggleFavorite,
  workspaceLabel,
}: {
  operations: PlaygroundOperation[];
  controller: PlaygroundController;
  favorites: ReadonlySet<string>;
  onToggleFavorite: (key: string) => void;
  workspaceLabel: string;
}) {
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <OperationNavigator
        operations={operations}
        selectedKey={controller.selected.key}
        onSelect={controller.select}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
        locked={controller.sending}
      />
      <RequestEditor controller={controller} workspaceLabel={workspaceLabel} />
    </div>
  );
}

type Availability = "all" | "runnable" | "reference";

function OperationNavigator({
  operations,
  selectedKey,
  onSelect,
  favorites,
  onToggleFavorite,
  locked,
}: {
  operations: PlaygroundOperation[];
  selectedKey: string;
  onSelect: (key: string) => boolean;
  favorites: ReadonlySet<string>;
  onToggleFavorite: (key: string) => void;
  locked: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const needle = useDeferredValue(search.trim().toLowerCase());
  const [method, setMethod] = useState<"all" | PlaygroundMethod>("all");
  const [availability, setAvailability] = useState<Availability>("all");
  const [tag, setTag] = useState("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const tags = useMemo(
    () => [...new Set(operations.map((operation) => operation.primaryTag))].sort(),
    [operations],
  );
  const filtered = useMemo(() => {
    const matches = operations.filter((operation) => {
      const executable = playgroundPolicyFor(operation).executable;
      if (method !== "all" && operation.method !== method) return false;
      if (tag !== "all" && operation.primaryTag !== tag) return false;
      if (availability === "runnable" && !executable) return false;
      if (availability === "reference" && executable) return false;
      if (favoritesOnly && !favorites.has(operation.key)) return false;
      return !needle || operation.searchText.includes(needle);
    });
    return matches.sort(
      (left, right) =>
        Number(favorites.has(right.key)) - Number(favorites.has(left.key)) ||
        left.path.localeCompare(right.path),
    );
  }, [availability, favorites, favoritesOnly, method, needle, operations, tag]);
  const shown = filtered.slice(0, limit);

  return (
    <aside aria-label="Operation catalog" className="min-w-0 space-y-3 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Choose an operation</h2>
        <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {filtered.length} / {operations.length}
        </span>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-search`} className="text-xs font-medium text-muted-foreground">
          Search endpoints
        </label>
        <Input
          id={`${id}-search`}
          type="search"
          value={search}
          maxLength={200}
          placeholder="Path, summary, tag, or operation ID"
          onChange={(event) => {
            setSearch(event.target.value);
            setLimit(PAGE_SIZE);
          }}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label htmlFor={`${id}-method`} className="text-xs font-medium text-muted-foreground">
            Method
          </label>
          <Select
            id={`${id}-method`}
            value={method}
            onChange={(event) => setMethod(event.target.value as typeof method)}
          >
            <option value="all">All methods</option>
            {PLAYGROUND_METHODS.map((item) => (
              <option key={item} value={item}>
                {item.toUpperCase()}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label
            htmlFor={`${id}-availability`}
            className="text-xs font-medium text-muted-foreground"
          >
            Availability
          </label>
          <Select
            id={`${id}-availability`}
            value={availability}
            onChange={(event) => setAvailability(event.target.value as Availability)}
          >
            <option value="all">Complete catalog</option>
            <option value="runnable">Runs on web</option>
            <option value="reference">Reference only</option>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-tag`} className="text-xs font-medium text-muted-foreground">
          Tag
        </label>
        <Select id={`${id}-tag`} value={tag} onChange={(event) => setTag(event.target.value)}>
          <option value="all">All {tags.length} tags</option>
          {tags.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={favoritesOnly}
          onChange={(event) => setFavoritesOnly(event.target.checked)}
        />
        Favorites only
      </label>
      {filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No operations match. Clear a filter or search the reference.
        </p>
      ) : (
        <ul className="max-h-[34rem] divide-y overflow-y-auto rounded-lg border" aria-label="Filtered API operations">
          {shown.map((operation) => {
            const policy = playgroundPolicyFor(operation);
            const active = operation.key === selectedKey;
            const favorite = favorites.has(operation.key);
            return (
              <li key={operation.key} className={active ? "bg-muted/60" : undefined}>
                <div className="flex items-start gap-1 p-1">
                  <button
                    type="button"
                    disabled={locked}
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelect(operation.key)}
                    className="flex min-w-0 flex-1 items-start gap-2 rounded-md p-2 text-left hover:bg-muted/40 disabled:opacity-60"
                  >
                    <MethodBadge method={operation.method} />
                    <span className="min-w-0">
                      <code className="block break-all text-xs">{operation.path}</code>
                      <span className="block truncate text-xs text-muted-foreground">
                        {operation.summary}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {policy.executable ? "Runs on web" : "Reference only"}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={favorite}
                    aria-label={`${favorite ? "Remove" : "Add"} ${operation.key} ${favorite ? "from" : "to"} favorites`}
                    onClick={() => onToggleFavorite(operation.key)}
                    className="rounded-md p-2 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  >
                    <Star aria-hidden className={`size-4 ${favorite ? "fill-current text-warning-emphasis" : ""}`} />
                  </button>
                </div>
              </li>
            );
          })}
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
    </aside>
  );
}

function RequestEditor({
  controller,
  workspaceLabel,
}: {
  controller: PlaygroundController;
  workspaceLabel: string;
}) {
  const { selected: operation, policy } = controller;
  const pathParameters = operation.parameters.filter((item) => item.location === "path");
  const queryParameters = operation.parameters.filter((item) => item.location === "query");
  const idempotent = policy.idempotency !== "none";

  return (
    <section aria-label="Request workbench" className="min-w-0 space-y-4 rounded-xl border p-4">
      <header className="space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <MethodBadge method={operation.method} />
          <code className="break-all text-sm font-medium">{operation.path}</code>
        </div>
        <h2 className="text-base font-semibold">{operation.summary}</h2>
        {operation.description ? (
          <p className="line-clamp-3 text-sm text-muted-foreground">{operation.description}</p>
        ) : null}
      </header>

      <div className="rounded-lg border bg-muted/20 p-3 text-sm">
        <p className="font-medium">
          {!policy.executable
            ? "Reference only"
            : policy.effect === "read"
              ? "Read · sends on click"
              : policy.effect === "destructive"
                ? "Destructive · reviewed, then typed confirmation"
                : "Workspace change · reviewed before sending"}
        </p>
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Minimum role</dt>
            <dd className={controller.roleAllowed ? undefined : "text-destructive-emphasis"}>
              {policy.requiredRole}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Scopes</dt>
            <dd className="break-words">
              {operation.requiredScopes.join(", ") || "Server route policy"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Idempotency</dt>
            <dd>{policy.idempotency}</dd>
          </div>
        </dl>
        {!policy.executable ? (
          <p className="mt-2 text-muted-foreground">{policy.reason}</p>
        ) : (
          <p className="mt-2 text-muted-foreground">
            Sends with your dashboard session in {workspaceLabel}. The server
            rechecks every role and scope.
          </p>
        )}
      </div>

      {pathParameters.length > 0 ? (
        <ParameterGroup
          legend="Path parameters"
          parameters={pathParameters}
          values={controller.draft.path}
          controller={controller}
          field="path"
        />
      ) : null}
      {queryParameters.length > 0 ? (
        <ParameterGroup
          legend="Query parameters"
          parameters={queryParameters}
          values={controller.draft.query}
          controller={controller}
          field="query"
        />
      ) : null}
      {policy.editableHeaders.length > 0 ? (
        <ParameterGroup
          legend="Declared headers"
          parameters={policy.editableHeaders}
          values={controller.draft.headers}
          controller={controller}
          field="headers"
        />
      ) : null}
      {idempotent ? (
        <p className="text-xs text-muted-foreground">
          Idempotency-Key for this attempt:{" "}
          <code className="break-all">{controller.draft.idempotencyKey}</code>
        </p>
      ) : null}

      {operation.requestBody ? <BodyEditor controller={controller} /> : null}

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button
          type="button"
          disabled={controller.blocker !== null}
          onClick={controller.send}
        >
          {controller.sending
            ? "Request in flight…"
            : policy.executable
              ? policy.effect === "read"
                ? "Send request"
                : "Review request"
              : operation.method === "get"
                ? "Send request"
                : "Review request"}
        </Button>
        {controller.sending ? (
          <Button type="button" variant="destructive" onClick={controller.cancel}>
            Cancel request
          </Button>
        ) : null}
        {controller.response && !controller.sending ? (
          <Button type="button" variant="ghost" onClick={controller.newAttempt}>
            {controller.response.ambiguous
              ? "I verified state · New attempt"
              : "New attempt"}
          </Button>
        ) : null}
        <p className="basis-full text-xs text-muted-foreground" role="status">
          {controller.blocker ?? "Ready — the exact request below is what will be sent."}
        </p>
      </div>

      <p className="break-all rounded-md bg-muted/30 p-2 font-mono text-xs">
        {controller.request.plan.method} {controller.request.plan.url}
      </p>

      <ReviewDialog controller={controller} workspaceLabel={workspaceLabel} />
      {controller.response ? (
        <ResponsePanel response={controller.response} idempotent={idempotent} />
      ) : null}
    </section>
  );
}

function ParameterGroup({
  legend,
  parameters,
  values,
  controller,
  field,
}: {
  legend: string;
  parameters: PlaygroundParameter[];
  values: Record<string, string>;
  controller: PlaygroundController;
  field: "path" | "query" | "headers";
}) {
  const issueField = field === "headers" ? "header" : field;
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold">{legend}</legend>
      {parameters.map((parameter) => (
        <ParameterField
          key={`${parameter.location}:${parameter.name}`}
          parameter={parameter}
          value={values[parameter.name] ?? ""}
          issue={
            controller.request.issues.find(
              (item) => item.field === issueField && item.name === parameter.name,
            )?.message
          }
          onChange={(value) => controller.updateParameter(field, parameter.name, value)}
        />
      ))}
    </fieldset>
  );
}

function ParameterField({
  parameter,
  value,
  issue,
  onChange,
}: {
  parameter: PlaygroundParameter;
  value: string;
  issue?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const enumValues = playgroundEnumValues(parameter);
  const type = typeof parameter.schema?.type === "string" ? parameter.schema.type : parameter.location;
  return (
    <div className="grid gap-1 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:items-start sm:gap-3">
      <label htmlFor={id} className="min-w-0 pt-2 text-sm">
        <code className="break-all">{parameter.name}</code>
        {parameter.required ? <span className="text-destructive-emphasis"> *</span> : null}
        <span className="ml-1 text-xs text-muted-foreground">{type}</span>
      </label>
      <div className="min-w-0 space-y-1">
        {enumValues.length > 0 ? (
          <Select
            id={id}
            value={value}
            aria-invalid={Boolean(issue)}
            aria-describedby={issue ? errorId : undefined}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">Unset</option>
            {enumValues.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            id={id}
            value={value}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(issue)}
            aria-describedby={issue ? errorId : undefined}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        {parameter.description ? (
          <p className="text-xs text-muted-foreground">{parameter.description}</p>
        ) : null}
        {issue ? (
          <p id={errorId} className="text-xs text-destructive-emphasis">
            {issue}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function BodyEditor({ controller }: { controller: PlaygroundController }) {
  const id = useId();
  const body = controller.selected.requestBody!;
  const issue = controller.request.issues.find((item) => item.field === "body")?.message;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold">
        Request body{body.required ? <span className="text-destructive-emphasis"> *</span> : null}
      </legend>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary">{body.jsonMediaType ?? "unsupported media"}</Badge>
        {body.exampleSource ? <span>{body.exampleSource} example</span> : null}
        <Button type="button" variant="outline" size="sm" onClick={controller.formatBody}>
          <Braces aria-hidden />
          Format JSON
        </Button>
      </div>
      <label htmlFor={id} className="sr-only">
        JSON request body for {controller.selected.summary}
      </label>
      <Textarea
        id={id}
        value={controller.draft.body}
        rows={Math.min(20, Math.max(6, controller.draft.body.split("\n").length + 1))}
        spellCheck={false}
        className="font-mono text-xs"
        aria-invalid={Boolean(issue)}
        aria-describedby={issue ? `${id}-error` : undefined}
        onChange={(event) => controller.updateBody(event.target.value)}
      />
      {issue ? (
        <p id={`${id}-error`} className="text-xs text-destructive-emphasis">
          {issue}
        </p>
      ) : null}
    </fieldset>
  );
}

function ReviewDialog({
  controller,
  workspaceLabel,
}: {
  controller: PlaygroundController;
  workspaceLabel: string;
}) {
  const review = controller.review;
  const destructive = review?.policy.effect === "destructive";
  const exact = review ? `${review.request.plan.method} ${review.request.plan.url}` : "";
  const headers = review ? JSON.stringify(review.request.plan.headers, null, 2) : "";
  return (
    <ConfirmDialog
      open={review !== null}
      onOpenChange={(open) => {
        if (!open) controller.dismissReview();
      }}
      title={review ? `Review ${review.operation.summary}` : "Review request"}
      confirmLabel={destructive ? "Run destructive request" : `Send ${review?.request.plan.method ?? ""} request`}
      confirmVariant={destructive ? "destructive" : "default"}
      confirmationToken={destructive ? exact : undefined}
      onConfirm={controller.confirmReview}
      description={
        review ? (
          <>
            This sends one real {review.request.plan.method} to{" "}
            {review.operation.path} in {workspaceLabel} with your session. It is
            not a dry run — the server applies it as soon as it arrives, and a
            cancelled request may still have been applied.
            <span className="mt-3 block text-xs font-semibold text-foreground">
              Exact request
            </span>
            <span className="block break-all font-mono text-xs text-foreground">{exact}</span>
            <span className="mt-2 block text-xs font-semibold text-foreground">Headers</span>
            <span
              tabIndex={0}
              role="group"
              aria-label="Exact request headers"
              className="block max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 font-mono text-xs text-foreground"
            >
              {headers}
            </span>
            <span className="mt-2 block text-xs font-semibold text-foreground">Body</span>
            <span
              tabIndex={0}
              role="group"
              aria-label="Exact request body"
              className="block max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 font-mono text-xs text-foreground"
            >
              {review.request.plan.body || "(none)"}
            </span>
          </>
        ) : (
          ""
        )
      }
    />
  );
}

function statusVariant(response: PlaygroundResponse) {
  if (response.outcome !== "http" || response.status >= 500) return "destructive" as const;
  if (response.status >= 400) return "warning" as const;
  if (response.status >= 200 && response.status < 300) return "success" as const;
  return "secondary" as const;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function ResponsePanel({
  response,
  idempotent,
}: {
  response: PlaygroundResponse;
  idempotent: boolean;
}) {
  const [view, setView] = useState<"body" | "headers">("body");
  const pretty = useMemo(() => {
    if (!response.body.trim() || response.truncated) return response.body;
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return response.body;
    }
  }, [response.body, response.truncated]);
  const headerCount = Object.keys(response.headers).length;
  return (
    <section aria-label="Latest response" className="space-y-3 border-t pt-4">
      <p className="sr-only" role="status" aria-live="polite">
        Latest response: {response.status || response.statusText}, {response.durationMs} milliseconds.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusVariant(response)} className="tabular-nums">
          {response.status || response.statusText}
        </Badge>
        <span className="text-sm font-medium">{response.statusText}</span>
        <span className="text-xs text-muted-foreground">
          {response.durationMs} ms · {formatBytes(response.previewBytes)} ·{" "}
          {response.contentType || "no content type"}
        </span>
        <span className="basis-full break-all text-xs text-muted-foreground">
          Request ID <code>{response.requestId}</code>
        </span>
      </div>
      {response.serverMessage ? (
        <Alert variant={response.status >= 500 ? "destructive" : "warning"}>
          <AlertTitle>
            {response.status === 503 ? "The server withheld this request" : "The server refused this request"}
          </AlertTitle>
          <AlertDescription>{response.serverMessage}</AlertDescription>
        </Alert>
      ) : null}
      {response.ambiguous ? (
        <Alert variant="warning" role="alert">
          <AlertTitle>Outcome may be ambiguous</AlertTitle>
          <AlertDescription>
            {idempotent
              ? "The write may have been applied. Re-sending the exact same request reuses its Idempotency-Key, so the server can deduplicate it."
              : "The write may have been applied and this operation declares no idempotency. Verify server state before another attempt."}
          </AlertDescription>
        </Alert>
      ) : null}
      {response.truncated ? (
        <p className="text-xs text-muted-foreground" role="status">
          Preview stopped at 2 MiB and the response stream was cancelled.
        </p>
      ) : null}
      <div className="flex gap-2" role="group" aria-label="Response view">
        <Button
          type="button"
          size="sm"
          variant={view === "body" ? "secondary" : "ghost"}
          aria-pressed={view === "body"}
          onClick={() => setView("body")}
        >
          Body
        </Button>
        <Button
          type="button"
          size="sm"
          variant={view === "headers" ? "secondary" : "ghost"}
          aria-pressed={view === "headers"}
          onClick={() => setView("headers")}
        >
          Headers ({headerCount})
        </Button>
      </div>
      <pre
        tabIndex={0}
        role="group"
        aria-label={view === "body" ? "Response body" : "Response headers"}
        className="max-h-[34rem] overflow-auto rounded-lg border bg-background p-3 text-xs leading-5"
      >
        <code>
          {view === "body"
            ? pretty || "(empty body)"
            : JSON.stringify(response.headers, null, 2)}
        </code>
      </pre>
    </section>
  );
}
