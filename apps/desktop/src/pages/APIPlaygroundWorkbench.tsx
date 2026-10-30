import {
  type ReactElement,
  useDeferredValue,
  useId,
  useMemo,
  useState,
} from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { InlineHelp } from "../components/InlineHelp";
import { CopyButton } from "../components/playground/Copy";
import { PlaygroundCodeGen } from "../components/playground/PlaygroundCodeGen";
import {
  CustomHeadersEditor,
  ResponseHeadersTable,
  generateIdempotencyKey,
} from "../components/playground/PlaygroundHeaders";
import { PlaygroundJSONView } from "../components/playground/PlaygroundJSONView";
import type { PlaygroundEnvironment } from "../components/playground/playground-safety";
import { WindowedList } from "../components/virtualization/WindowedList";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import {
  PLAYGROUND_METHODS,
  PLAYGROUND_PARAMETER_ENUM_MAX_VALUES,
  PLAYGROUND_PARAMETER_ENUM_MAX_VALUE_BYTES,
  type NormalizedPlaygroundOperation,
  type PlaygroundParameter,
} from "./api-playground-openapi";
import {
  executionPolicyFor,
  playgroundRoleAllows,
} from "./api-playground-policy";
import {
  PLAYGROUND_HEADER_VALUE_MAX_BYTES,
  PLAYGROUND_PATH_VALUE_MAX_BYTES,
  PLAYGROUND_QUERY_MAX_BYTES,
  PLAYGROUND_REQUEST_BODY_MAX_BYTES,
} from "./api-playground-request";
import type { PlaygroundTransportResponse } from "./api-playground-transport";
import type {
  PlaygroundReviewSnapshot,
  PlaygroundWorkbenchController,
} from "./api-playground-workbench-state";

import "../styles-api-playground-workbench.css";

type CatalogFilter = "all" | "runnable" | "reference";

export function APIPlaygroundWorkbench({
  operations,
  controller,
  favorites,
  onToggleFavorite,
  environment,
  workspaceLabel,
  principalLabel,
  effectiveRole,
}: {
  operations: NormalizedPlaygroundOperation[];
  controller: PlaygroundWorkbenchController;
  favorites: ReadonlySet<string>;
  onToggleFavorite: (key: string) => void;
  environment: PlaygroundEnvironment;
  workspaceLabel: string;
  principalLabel: string;
  effectiveRole: string | null;
}): ReactElement {
  return (
    <div className="play-workbench">
      <EndpointNavigator
        operations={operations}
        selectedKey={controller.selectedKey}
        onSelect={controller.select}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
        selectionLocked={controller.sending}
      />
      <RequestEditor
        controller={controller}
        environment={environment}
        workspaceLabel={workspaceLabel}
        principalLabel={principalLabel}
        effectiveRole={effectiveRole}
      />
    </div>
  );
}

function operationKey(operation: NormalizedPlaygroundOperation): string {
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

function EndpointNavigator({
  operations,
  selectedKey,
  onSelect,
  favorites,
  onToggleFavorite,
  selectionLocked,
}: {
  operations: NormalizedPlaygroundOperation[];
  selectedKey: string;
  onSelect: (key: string) => void;
  favorites: ReadonlySet<string>;
  onToggleFavorite: (key: string) => void;
  selectionLocked: boolean;
}): ReactElement {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [method, setMethod] = useState<
    "all" | NormalizedPlaygroundOperation["method"]
  >("all");
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>("all");
  const [tag, setTag] = useState("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const tags = useMemo(
    () =>
      [...new Set(operations.map((operation) => operation.primaryTag))].sort(),
    [operations],
  );
  const filtered = useMemo(() => {
    const matches = operations.filter((operation) => {
      const key = operationKey(operation);
      const policy = executionPolicyFor(operation);
      if (method !== "all" && operation.method !== method) return false;
      if (tag !== "all" && operation.primaryTag !== tag) return false;
      if (catalogFilter === "runnable" && !policy.executable) return false;
      if (catalogFilter === "reference" && policy.executable) return false;
      if (favoritesOnly && !favorites.has(key)) return false;
      if (!deferredSearch) return true;
      return [
        operation.path,
        operation.summary,
        operation.operationId,
        operation.primaryTag,
      ].some((value) => value.toLowerCase().includes(deferredSearch));
    });
    return matches.sort((left, right) => {
      const favoriteDelta =
        Number(favorites.has(operationKey(right))) -
        Number(favorites.has(operationKey(left)));
      return favoriteDelta || left.path.localeCompare(right.path);
    });
  }, [
    catalogFilter,
    deferredSearch,
    favorites,
    favoritesOnly,
    method,
    operations,
    tag,
  ]);

  return (
    <aside className="play-navigator" aria-label="Endpoint catalog">
      <div className="play-navigator-heading">
        <div>
          <span className="eyebrow">Catalog</span>
          <h2>Choose an operation</h2>
        </div>
        <span className="badge tabular" aria-live="polite">
          {filtered.length} / {operations.length}
        </span>
      </div>
      <label className="play-filter-field play-filter-search">
        <span>Search endpoints</span>
        <input
          type="search"
          className="input"
          value={search}
          maxLength={200}
          onChange={(event) => setSearch(event.target.value.slice(0, 200))}
          placeholder="Path, summary, tag, or operation ID"
        />
      </label>
      <div className="play-filter-grid">
        <label className="play-filter-field">
          <span>Method</span>
          <select
            className="input"
            value={method}
            onChange={(event) => setMethod(event.target.value as typeof method)}
          >
            <option value="all">All methods</option>
            {PLAYGROUND_METHODS.map((item) => (
              <option key={item} value={item}>
                {item.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="play-filter-field">
          <span>Availability</span>
          <select
            className="input"
            value={catalogFilter}
            onChange={(event) =>
              setCatalogFilter(event.target.value as CatalogFilter)
            }
          >
            <option value="all">Complete catalog</option>
            <option value="runnable">Reviewed runner</option>
            <option value="reference">Reference only</option>
          </select>
        </label>
        <label className="play-filter-field play-filter-tag">
          <span>Tag</span>
          <select
            className="input"
            value={tag}
            onChange={(event) => setTag(event.target.value)}
          >
            <option value="all">All {tags.length} tags</option>
            {tags.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="play-favorites-filter">
        <input
          type="checkbox"
          checked={favoritesOnly}
          onChange={(event) => setFavoritesOnly(event.target.checked)}
        />
        Favorites only
      </label>
      <WindowedList
        label="Filtered API operations"
        items={filtered}
        getKey={operationKey}
        height={640}
        itemHeight={76}
        overscan={8}
        emptyState={
          <div className="play-navigator-empty">
            <strong>No operations match.</strong>
            <span>Clear a filter or search the complete reference.</span>
          </div>
        }
        className="play-endpoint-window"
        renderItem={(operation) => {
          const key = operationKey(operation);
          const policy = executionPolicyFor(operation);
          const active = key === selectedKey;
          const favorite = favorites.has(key);
          return (
            <div
              className={`play-endpoint-option${active ? " is-active" : ""}`}
            >
              <button
                type="button"
                className="play-endpoint-select"
                aria-current={active ? "true" : undefined}
                disabled={selectionLocked}
                onClick={() => onSelect(key)}
              >
                <span
                  className={`badge play-method-pill is-${operation.method}`}
                >
                  {operation.method.toUpperCase()}
                </span>
                <span className="play-endpoint-copy">
                  <code>{operation.path}</code>
                  <span>{operation.summary}</span>
                </span>
                <span
                  className={`play-availability-dot${policy.executable ? " is-runnable" : ""}`}
                  title={policy.executable ? "Reviewed runner" : policy.reason}
                  aria-label={
                    policy.executable
                      ? "Reviewed runner"
                      : `Reference only: ${policy.reason ?? "Execution is unavailable."}`
                  }
                />
              </button>
              <button
                type="button"
                className={`play-fav${favorite ? " is-active" : ""}`}
                aria-pressed={favorite}
                aria-label={`${favorite ? "Remove" : "Add"} ${key} ${favorite ? "from" : "to"} favorites`}
                onClick={() => onToggleFavorite(key)}
              >
                <StarIcon filled={favorite} />
              </button>
            </div>
          );
        }}
      />
    </aside>
  );
}

function RequestEditor({
  controller,
  environment,
  workspaceLabel,
  principalLabel,
  effectiveRole,
}: {
  controller: PlaygroundWorkbenchController;
  environment: PlaygroundEnvironment;
  workspaceLabel: string;
  principalLabel: string;
  effectiveRole: string | null;
}): ReactElement {
  const operation = controller.selected;
  const policy = controller.policy;
  const pathParameters = operation.parameters.filter(
    (item) => item.location === "path",
  );
  const queryParameters = operation.parameters.filter(
    (item) => item.location === "query",
  );
  const headerParameters = operation.parameters.filter(
    (item) => item.location === "header",
  );
  const roleAllowed = playgroundRoleAllows(effectiveRole, policy.requiredRole);
  const supportsDryRun = queryParameters.some(
    (item) => item.name.toLowerCase() === "dry_run",
  );

  return (
    <main className="play-request-editor" aria-label="Request workbench">
      <header className="play-editor-header">
        <div className="play-editor-route">
          <span className={`badge play-method-pill is-${operation.method}`}>
            {operation.method.toUpperCase()}
          </span>
          <code>{operation.path}</code>
        </div>
        <CopyButton
          value={controller.request.plan.url || operation.path}
          label="Request URL"
          contentClass="secret"
          clearIfUnchangedAfterMs={60_000}
        />
        <h2>{operation.summary}</h2>
        <p>{operation.description}</p>
      </header>

      <section className={`play-execution-boundary is-${policy.effect}`}>
        <div>
          <span className="eyebrow">Execution contract</span>
          <strong>
            {policy.executable
              ? policy.effect === "read"
                ? "Reviewed read"
                : policy.effect === "destructive"
                  ? "Reviewed destructive operation"
                  : "Reviewed workspace change"
              : "Reference only"}
          </strong>
        </div>
        <dl>
          <div>
            <dt>Authority</dt>
            <dd>
              {policy.authMode === "workspace"
                ? "Workspace bearer / session"
                : policy.authMode}
            </dd>
          </div>
          <div>
            <dt>Minimum role</dt>
            <dd className={roleAllowed ? "" : "danger"}>
              {policy.requiredRole}
              {effectiveRole === null ? " · authority unresolved" : ""}
            </dd>
          </div>
          <div>
            <dt>Scopes</dt>
            <dd>
              {operation.requiredScopes.join(", ") || "Server route policy"}
            </dd>
          </div>
          <div>
            <dt>Dry run</dt>
            <dd>{supportsDryRun ? "Advertised" : "Not advertised"}</dd>
          </div>
        </dl>
        <p>
          {policy.executable && effectiveRole !== null
            ? `${environment.label} · ${workspaceLabel} · ${principalLabel}. The server rechecks every role and scope.`
            : policy.executable
              ? "Role authority is unresolved. Live execution remains disabled until it can be verified."
              : policy.reason}
        </p>
      </section>

      {pathParameters.length > 0 ? (
        <ParameterGroup
          legend="Path parameters"
          help="Each value becomes one encoded path segment. Dot, slash, backslash, control, and encoded traversal values are rejected."
          parameters={pathParameters}
          values={controller.draft.path}
          issues={controller.request.issues}
          onChange={(name, value) =>
            controller.updateDraftMap("path", name, value)
          }
        />
      ) : null}
      {queryParameters.length > 0 ? (
        <ParameterGroup
          legend="Query parameters"
          help="Required query values are validated before review. Values are URL encoded and are never retained in local history."
          parameters={queryParameters}
          values={controller.draft.query}
          issues={controller.request.issues}
          onChange={(name, value) =>
            controller.updateDraftMap("query", name, value)
          }
        />
      ) : null}
      {headerParameters.length > 0 ? (
        <ParameterGroup
          legend="Declared headers"
          help="Only headers declared by this operation are shown. Authentication and other protected headers remain transport-owned."
          parameters={headerParameters.filter(
            (item) => item.name.toLowerCase() !== "idempotency-key",
          )}
          values={controller.draft.headers}
          issues={controller.request.issues}
          onChange={(name, value) =>
            controller.updateDraftMap("headers", name, value)
          }
        />
      ) : null}

      <fieldset>
        <legend>Portable custom headers</legend>
        <CustomHeadersEditor
          rows={controller.draft.customHeaders}
          onChange={(customHeaders) =>
            controller.updateDraft({ customHeaders })
          }
          idempotencyKey={controller.draft.idempotencyKey}
          onRegenIdempotency={() =>
            controller.updateDraft({
              idempotencyKey: generateIdempotencyKey(),
            })
          }
          showIdempotency={policy.idempotency !== "none"}
        />
        <p className="muted small">
          Custom input is limited to portable, non-secret headers.
          Authorization, cookies, content framing, and Moosewave identity headers
          cannot be overridden.
        </p>
      </fieldset>

      {operation.requestBody ? (
        <RequestBodyEditor controller={controller} />
      ) : null}

      <fieldset>
        <legend>Code</legend>
        <p className="muted small play-field-intro">
          Snippets use <code>POSTWAVE_API_KEY</code>; the actual credential
          never enters the editor or clipboard.
        </p>
        <PlaygroundCodeGen plan={controller.request.plan} />
      </fieldset>

      <div className="play-sticky-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            controller.sending ||
            !policy.executable ||
            !roleAllowed ||
            controller.request.issues.length > 0 ||
            (controller.response?.ambiguous && policy.idempotency === "none")
          }
          onClick={() => void controller.requestSend()}
        >
          {controller.sending
            ? "Request in flight…"
            : policy.effect === "read"
              ? "Send reviewed read"
              : "Review exact request"}
        </button>
        {controller.sending ? (
          <button
            type="button"
            className="btn btn-danger"
            onClick={controller.cancel}
          >
            Cancel request
          </button>
        ) : null}
        {controller.response ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={controller.newAttempt}
          >
            {controller.response.ambiguous
              ? "I verified state · New attempt"
              : "New attempt"}
          </button>
        ) : null}
        {!roleAllowed ? (
          <span className="field-error" role="status">
            {effectiveRole === null
              ? "Role authority is unresolved; live execution is disabled."
              : `Effective role ${effectiveRole} does not meet ${policy.requiredRole}.`}
          </span>
        ) : null}
        <span className="spacer" />
        <span className="muted small">
          {controller.request.issues[0]?.message ??
            (effectiveRole === null
              ? "Waiting for exact role authority."
              : "Ready for exact request review.")}
        </span>
      </div>

      <MutationReview
        snapshot={controller.review}
        environment={environment}
        workspaceLabel={workspaceLabel}
        onClose={() => controller.setReview(null)}
        onConfirm={controller.confirmSend}
        busy={controller.sending}
      />
      {controller.response ? (
        <WorkbenchResponse
          response={controller.response}
          idempotency={controller.policy.idempotency}
        />
      ) : null}
    </main>
  );
}

function ParameterGroup({
  legend,
  help,
  parameters,
  values,
  issues,
  onChange,
}: {
  legend: string;
  help: string;
  parameters: PlaygroundParameter[];
  values: Record<string, string>;
  issues: PlaygroundWorkbenchController["request"]["issues"];
  onChange: (name: string, value: string) => void;
}): ReactElement | null {
  if (parameters.length === 0) return null;
  return (
    <fieldset>
      <legend>
        {legend}
        <InlineHelp text={help} ariaLabel={`About ${legend.toLowerCase()}`} />
      </legend>
      {parameters.map((parameter) => (
        <ParameterField
          key={`${parameter.location}:${parameter.name}`}
          parameter={parameter}
          value={values[parameter.name] ?? ""}
          issue={
            issues.find(
              (item) =>
                item.field === parameter.location &&
                item.name === parameter.name,
            )?.message
          }
          onChange={(value) => onChange(parameter.name, value)}
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
}): ReactElement {
  const inputId = useId();
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;
  const enumValues =
    Array.isArray(parameter.schema?.enum) &&
    parameter.schema.enum.length <= PLAYGROUND_PARAMETER_ENUM_MAX_VALUES &&
    parameter.schema.enum.every(
      (item) =>
        (typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean") &&
        new TextEncoder().encode(String(item)).byteLength <=
          PLAYGROUND_PARAMETER_ENUM_MAX_VALUE_BYTES,
    )
      ? parameter.schema.enum.filter(
          (item): item is string | number | boolean =>
            typeof item === "string" ||
            typeof item === "number" ||
            typeof item === "boolean",
        )
      : [];
  const describedBy =
    [parameter.description ? descriptionId : "", issue ? errorId : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  const maximumLength =
    parameter.location === "path"
      ? PLAYGROUND_PATH_VALUE_MAX_BYTES
      : parameter.location === "query"
        ? PLAYGROUND_QUERY_MAX_BYTES
        : PLAYGROUND_HEADER_VALUE_MAX_BYTES;
  const numeric =
    parameter.schema?.type === "integer" || parameter.schema?.type === "number";
  return (
    <div className="api-playground-param">
      <label htmlFor={inputId}>
        <code>{parameter.name}</code>
        {parameter.required ? <span className="danger"> *</span> : null}
        <span>{String(parameter.schema?.type ?? parameter.location)}</span>
      </label>
      <div>
        {enumValues.length > 0 ? (
          <select
            id={inputId}
            className="input"
            value={value}
            aria-invalid={Boolean(issue)}
            required={parameter.required}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">Unset</option>
            {enumValues.map((item) => (
              <option key={String(item)} value={String(item)}>
                {String(item)}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={inputId}
            className="input"
            type="text"
            inputMode={numeric ? "decimal" : undefined}
            maxLength={maximumLength}
            value={value}
            required={parameter.required}
            aria-invalid={Boolean(issue)}
            aria-describedby={describedBy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        {parameter.description ? (
          <p id={descriptionId} className="muted small">
            {parameter.description}
          </p>
        ) : null}
        {issue ? (
          <p id={errorId} className="field-error" role="alert">
            {issue}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function RequestBodyEditor({
  controller,
}: {
  controller: PlaygroundWorkbenchController;
}): ReactElement {
  const id = useId();
  const issue = controller.request.issues.find(
    (item) => item.field === "body",
  )?.message;
  const body = controller.selected.requestBody!;
  return (
    <fieldset>
      <legend>
        Request body {body.required ? <span className="danger">*</span> : null}
      </legend>
      <div className="play-body-meta">
        <span className="badge">
          {body.selectedMediaType ?? "unsupported media"}
        </span>
        {body.exampleSource ? (
          <span className="badge">{body.exampleSource} example</span>
        ) : null}
        {controller.selected.maxBodyBytes ? (
          <span className="muted small">
            Route limit {fmtBytes(controller.selected.maxBodyBytes)}
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            try {
              controller.updateDraft({
                body: JSON.stringify(
                  JSON.parse(controller.draft.body),
                  null,
                  2,
                ),
              });
            } catch {
              // The inline validation message already contains the parser detail.
            }
          }}
        >
          Format JSON
        </button>
      </div>
      <label htmlFor={id} className="visually-hidden">
        JSON request body for {controller.selected.summary}
      </label>
      <textarea
        id={id}
        className="api-playground-body mono"
        rows={Math.min(
          24,
          Math.max(8, controller.draft.body.split("\n").length + 1),
        )}
        value={controller.draft.body}
        required={body.required}
        maxLength={PLAYGROUND_REQUEST_BODY_MAX_BYTES}
        aria-invalid={Boolean(issue)}
        aria-describedby={issue ? `${id}-error` : undefined}
        spellCheck={false}
        onChange={(event) =>
          controller.updateDraft({ body: event.target.value })
        }
      />
      {issue ? (
        <p id={`${id}-error`} className="field-error" role="alert">
          {issue}
        </p>
      ) : null}
    </fieldset>
  );
}

function MutationReview({
  snapshot,
  environment,
  workspaceLabel,
  onClose,
  onConfirm,
  busy,
}: {
  snapshot: PlaygroundReviewSnapshot | null;
  environment: PlaygroundEnvironment;
  workspaceLabel: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  busy: boolean;
}): ReactElement {
  const phrase = snapshot
    ? `${snapshot.operation.method.toUpperCase()} ${snapshot.request.resolvedPath} @ ${workspaceLabel}`
    : "";
  return (
    <ConfirmModal
      open={Boolean(snapshot)}
      title={
        snapshot ? `Review ${snapshot.operation.summary}` : "Review request"
      }
      description={
        snapshot
          ? `${environment.label} · ${workspaceLabel}. Send only after the exact request below matches your intent.`
          : ""
      }
      confirmLabel={
        snapshot?.policy.effect === "destructive"
          ? "Run destructive request"
          : "Send mutation"
      }
      danger={snapshot?.policy.effect === "destructive"}
      typeToConfirm={
        snapshot?.policy.effect === "destructive" ? phrase : undefined
      }
      busy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      {snapshot ? (
        <div className="play-exact-review">
          <dl className="play-request-review">
            <div>
              <dt>Exact operation</dt>
              <dd className="mono">{phrase}</dd>
            </div>
            <div>
              <dt>Resolved URL</dt>
              <dd className="mono">{snapshot.request.plan.url}</dd>
            </div>
            <div>
              <dt>Minimum authority</dt>
              <dd>
                {snapshot.policy.requiredRole} ·{" "}
                {snapshot.operation.requiredScopes.join(", ") || "route policy"}
              </dd>
            </div>
            <div>
              <dt>Idempotency</dt>
              <dd>{snapshot.policy.idempotency}</dd>
            </div>
            <div>
              <dt>Body size</dt>
              <dd>{fmtBytes(snapshot.bodyBytes)}</dd>
            </div>
            <div>
              <dt>Local history</dt>
              <dd>
                Only method, route template, status, timing, and sanitized
                outcome classification are retained. Values and response bodies
                are not.
              </dd>
            </div>
          </dl>
          <section>
            <h3>Exact request headers</h3>
            <pre className="play-review-code">
              {JSON.stringify(snapshot.request.plan.headers, null, 2)}
            </pre>
          </section>
          <section>
            <h3>Exact request body</h3>
            <pre className="play-review-code">
              {snapshot.request.plan.body || "(none)"}
            </pre>
          </section>
        </div>
      ) : null}
    </ConfirmModal>
  );
}

const RESPONSE_TABS = [
  { value: "body", label: "Body" },
  { value: "headers", label: "Headers" },
] as const;

function WorkbenchResponse({
  response,
  idempotency,
}: {
  response: PlaygroundTransportResponse;
  idempotency: "none" | "optional" | "required";
}): ReactElement {
  const [tab, setTab] = useState<"body" | "headers">("body");
  const tabs = useTabsInteraction({
    value: tab,
    items: RESPONSE_TABS,
    onChange: setTab,
    activation: "automatic",
  });
  const isJSON = response.contentType.toLowerCase().includes("json");
  const parsed = useMemo((): unknown => {
    if (!isJSON) return undefined;
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      return undefined;
    }
  }, [isJSON, response.body]);
  return (
    <section className="play-response">
      <p
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        Latest API response: {response.status || response.statusText},{" "}
        {response.statusText || response.outcome}, {response.durationMs}
        milliseconds.
      </p>
      <header className="play-response-summary">
        <div>
          <span className="eyebrow">Latest response</span>
          <h2>
            <span
              className={`badge ${statusTone(response.status, response.outcome)}`}
            >
              {response.status || response.statusText}
            </span>{" "}
            {response.outcome === "http"
              ? response.statusText
              : response.outcome}
          </h2>
        </div>
        <dl>
          <div>
            <dt>Duration</dt>
            <dd>{response.durationMs} ms</dd>
          </div>
          <div>
            <dt>Preview</dt>
            <dd>{fmtBytes(response.previewBytes)}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{response.contentType || "unknown"}</dd>
          </div>
          <div>
            <dt>Request ID</dt>
            <dd className="mono">{response.requestId ?? "unavailable"}</dd>
          </div>
        </dl>
      </header>
      {response.truncated ? (
        <div className="notice warning" role="status">
          Preview stopped at 2 MiB and the response stream was cancelled. No
          omitted bytes were retained.
        </div>
      ) : null}
      {response.ambiguous ? (
        <div className="notice warning" role="alert">
          {idempotency === "none"
            ? "Outcome may be ambiguous. Verify server state before considering another request; this operation does not advertise idempotency."
            : "Outcome may be ambiguous. Keep the same idempotency key while investigating or retrying this exact request."}
        </div>
      ) : null}
      <div className="play-tabs play-tabs-inner">
        <div
          ref={tabs.listRef}
          {...tabs.listProps}
          aria-label="Response content"
        >
          {RESPONSE_TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              {...tabs.getTabProps(item.value)}
              className={`play-tab${tab === item.value ? " is-active" : ""}`}
            >
              {item.label}
              {item.value === "headers"
                ? ` (${Object.keys(response.headers).length})`
                : ""}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <CopyButton
          value={
            tab === "body"
              ? response.body
              : JSON.stringify(response.headers, null, 2)
          }
          label={tab === "body" ? "Response body" : "Response headers"}
          contentClass="secret"
          clearIfUnchangedAfterMs={60_000}
        />
      </div>
      {RESPONSE_TABS.map((item) => (
        <div key={item.value} {...tabs.getPanelProps(item.value)}>
          {tab === item.value ? (
            item.value === "body" ? (
              isJSON && parsed !== undefined ? (
                <PlaygroundJSONView value={parsed} />
              ) : (
                <PlaygroundJSONView
                  value={undefined}
                  rawFallback={response.body}
                />
              )
            ) : (
              <ResponseHeadersTable headers={response.headers} />
            )
          ) : null}
        </div>
      ))}
    </section>
  );
}

function statusTone(
  status: number,
  outcome: PlaygroundTransportResponse["outcome"],
): string {
  if (outcome !== "http") return "danger";
  if (status >= 200 && status < 300) return "success";
  if (status >= 400 && status < 500) return "warning";
  return status === 0 || status >= 500 ? "danger" : "";
}

function fmtBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function StarIcon({ filled }: { filled: boolean }): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}
