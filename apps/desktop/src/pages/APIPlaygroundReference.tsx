import {
  type ReactElement,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import { CopyButton } from "../components/playground/Copy";
import { PlaygroundJSONView } from "../components/playground/PlaygroundJSONView";
import { WindowedList } from "../components/virtualization/WindowedList";
import "../styles-api-playground-reference.css";
import {
  PLAYGROUND_METHODS,
  type NormalizedPlaygroundOperation,
  type PlaygroundMethod,
  type PlaygroundParameter,
  type PlaygroundRequestBody,
} from "./api-playground-openapi";

const ALL_METHODS = "all";
const ALL_TAGS = "";
const ROW_HEIGHT = 72;

interface SearchableOperation {
  key: string;
  operation: NormalizedPlaygroundOperation;
  searchText: string;
}

export interface APIPlaygroundReferenceProps {
  operations: readonly NormalizedPlaygroundOperation[];
  selectedOperationKey?: string;
  onSelectedOperationChange?: (
    operation: NormalizedPlaygroundOperation,
  ) => void;
  listHeight?: number;
}

export function apiPlaygroundReferenceOperationKey(
  operation: NormalizedPlaygroundOperation,
): string {
  return operation.method.toUpperCase() + " " + operation.path;
}

export function APIPlaygroundReference({
  operations,
  selectedOperationKey,
  onSelectedOperationChange,
  listHeight = 560,
}: APIPlaygroundReferenceProps): ReactElement {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [method, setMethod] = useState<typeof ALL_METHODS | PlaygroundMethod>(
    ALL_METHODS,
  );
  const [tag, setTag] = useState(ALL_TAGS);
  const [localSelection, setLocalSelection] = useState<string | undefined>(
    selectedOperationKey,
  );
  const detailId = useId();
  const searchHelpId = useId();
  const entries = useMemo(() => buildSearchIndex(operations), [operations]);
  const tagOptions = useMemo(() => collectTags(operations), [operations]);
  const filteredEntries = useMemo(
    () => filterOperations(entries, deferredQuery, method, tag),
    [deferredQuery, entries, method, tag],
  );
  const desiredSelection = selectedOperationKey ?? localSelection;
  const selectedEntry =
    filteredEntries.find((entry) => entry.key === desiredSelection) ??
    filteredEntries[0];
  const filtersActive =
    query.trim().length > 0 || method !== ALL_METHODS || tag !== ALL_TAGS;

  useEffect(() => {
    if (selectedOperationKey !== undefined || selectedEntry === undefined) {
      return;
    }
    if (localSelection !== selectedEntry.key) {
      setLocalSelection(selectedEntry.key);
    }
  }, [localSelection, selectedEntry, selectedOperationKey]);

  const selectOperation = (entry: SearchableOperation): void => {
    if (selectedOperationKey === undefined) setLocalSelection(entry.key);
    onSelectedOperationChange?.(entry.operation);
  };
  const clearFilters = (): void => {
    setQuery("");
    setMethod(ALL_METHODS);
    setTag(ALL_TAGS);
  };

  if (operations.length === 0) {
    return (
      <section
        className="pwar pwar--empty"
        aria-labelledby={detailId + "-empty-title"}
      >
        <h2 id={detailId + "-empty-title"}>API contract is empty</h2>
        <p>
          No supported normalized operations were supplied. Reload the contract
          or ask an administrator to verify the published OpenAPI artifact.
        </p>
      </section>
    );
  }

  return (
    <section className="pwar" aria-label="API reference">
      <ReferenceFilters
        query={query}
        method={method}
        tag={tag}
        total={operations.length}
        visible={filteredEntries.length}
        searchHelpId={searchHelpId}
        tagOptions={tagOptions}
        filtersActive={filtersActive}
        onQueryChange={setQuery}
        onMethodChange={setMethod}
        onTagChange={setTag}
        onClear={clearFilters}
      />

      <div className="pwar__workspace">
        <div className="pwar__catalog">
          <WindowedList
            label="API operations"
            items={filteredEntries}
            getKey={(entry) => entry.key}
            height={listHeight}
            itemHeight={ROW_HEIGHT}
            totalCount={filteredEntries.length}
            className="pwar__operation-list"
            emptyState={
              <ReferenceEmptyResults
                filtersActive={filtersActive}
                onClear={clearFilters}
              />
            }
            renderItem={(entry) => (
              <OperationRow
                entry={entry}
                selected={entry.key === selectedEntry?.key}
                detailId={detailId}
                onSelect={selectOperation}
              />
            )}
          />
        </div>

        {selectedEntry ? (
          <OperationDetail id={detailId} operation={selectedEntry.operation} />
        ) : (
          <article
            id={detailId}
            className="pwar__detail pwar__detail--empty"
            aria-labelledby={detailId + "-title"}
          >
            <h2 id={detailId + "-title"}>Nothing selected</h2>
            <p>
              No normalized operation is available under the current filters.
            </p>
          </article>
        )}
      </div>
    </section>
  );
}

interface ReferenceFiltersProps {
  query: string;
  method: typeof ALL_METHODS | PlaygroundMethod;
  tag: string;
  total: number;
  visible: number;
  searchHelpId: string;
  tagOptions: readonly [string, number][];
  filtersActive: boolean;
  onQueryChange: (value: string) => void;
  onMethodChange: (value: typeof ALL_METHODS | PlaygroundMethod) => void;
  onTagChange: (value: string) => void;
  onClear: () => void;
}

function ReferenceFilters({
  query,
  method,
  tag,
  total,
  visible,
  searchHelpId,
  tagOptions,
  filtersActive,
  onQueryChange,
  onMethodChange,
  onTagChange,
  onClear,
}: ReferenceFiltersProps): ReactElement {
  return (
    <div className="pwar__filters">
      <div className="pwar__search-field">
        <label htmlFor={searchHelpId + "-input"}>Search API operations</label>
        <input
          id={searchHelpId + "-input"}
          type="search"
          value={query}
          maxLength={200}
          placeholder="Path, summary, parameter, scope, or auth scheme"
          aria-describedby={searchHelpId}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
        <span id={searchHelpId} className="visually-hidden">
          Search includes route metadata, parameters, media types, access
          requirements, and contract issues.
        </span>
      </div>

      <fieldset className="pwar__method-filter">
        <legend>HTTP method</legend>
        <div className="pwar__method-buttons">
          <FilterButton
            label="All"
            pressed={method === ALL_METHODS}
            onClick={() => onMethodChange(ALL_METHODS)}
          />
          {PLAYGROUND_METHODS.map((candidate) => (
            <FilterButton
              key={candidate}
              label={candidate.toUpperCase()}
              pressed={method === candidate}
              onClick={() => onMethodChange(candidate)}
            />
          ))}
        </div>
      </fieldset>

      <div className="pwar__tag-filter">
        <label htmlFor={searchHelpId + "-tag"}>Tag</label>
        <select
          id={searchHelpId + "-tag"}
          value={tag}
          onChange={(event) => onTagChange(event.currentTarget.value)}
        >
          <option value={ALL_TAGS}>All tags ({total})</option>
          {tagOptions.map(([name, count]) => (
            <option key={name} value={name}>
              {displayTag(name)} ({count})
            </option>
          ))}
        </select>
      </div>

      <div className="pwar__filter-summary">
        <p role="status" aria-live="polite" aria-atomic="true">
          {visible} of {total} operations
        </p>
        <button
          type="button"
          className="pwar__clear"
          disabled={!filtersActive}
          onClick={onClear}
        >
          Clear filters
        </button>
      </div>
    </div>
  );
}

function FilterButton({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick}>
      {label}
    </button>
  );
}

function ReferenceEmptyResults({
  filtersActive,
  onClear,
}: {
  filtersActive: boolean;
  onClear: () => void;
}): ReactElement {
  return (
    <div className="pwar__no-results">
      <h2>No operations match</h2>
      <p>
        {filtersActive
          ? "Change the search, method, or tag filters to broaden the catalog."
          : "The normalized contract does not contain a displayable operation."}
      </p>
      {filtersActive ? (
        <button type="button" onClick={onClear}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

function OperationRow({
  entry,
  selected,
  detailId,
  onSelect,
}: {
  entry: SearchableOperation;
  selected: boolean;
  detailId: string;
  onSelect: (entry: SearchableOperation) => void;
}): ReactElement {
  const operation = entry.operation;
  const summary = operation.summary || operation.operationId || "No summary";
  return (
    <button
      type="button"
      className="pwar__operation"
      aria-pressed={selected}
      aria-controls={detailId}
      aria-label={
        operation.method.toUpperCase() + " " + operation.path + ": " + summary
      }
      onClick={() => onSelect(entry)}
    >
      <span
        className={"pwar__method pwar__method--" + operation.method}
        aria-hidden="true"
      >
        {operation.method.toUpperCase()}
      </span>
      <span className="pwar__operation-copy">
        <code>{operation.path}</code>
        <span>{summary}</span>
      </span>
      <span className="pwar__operation-tag">
        {displayTag(operation.primaryTag)}
      </span>
    </button>
  );
}

function OperationDetail({
  id,
  operation,
}: {
  id: string;
  operation: NormalizedPlaygroundOperation;
}): ReactElement {
  const titleId = id + "-title";
  const route = operation.method.toUpperCase() + " " + operation.path;
  return (
    <article id={id} className="pwar__detail" aria-labelledby={titleId}>
      <header className="pwar__detail-header">
        <div className="pwar__route">
          <span className={"pwar__method pwar__method--" + operation.method}>
            {operation.method.toUpperCase()}
          </span>
          <code>{operation.path}</code>
          <CopyButton
            value={route}
            label="Copy route"
            ariaLabel={"Copy route " + route}
            contentClass="public"
          />
        </div>
        <h2 id={titleId}>
          {operation.summary || operation.operationId || route}
        </h2>
        {operation.description ? <p>{operation.description}</p> : null}
        <OperationBadges operation={operation} />
      </header>

      <ContractAlerts operation={operation} />
      <OperationOverview operation={operation} />
      <AccessContract operation={operation} />
      <ParameterContract parameters={operation.parameters} />
      <RequestContract
        requestBody={operation.requestBody}
        bodyless={operation.bodyless}
      />
      <ResponseContract operation={operation} />
    </article>
  );
}

function OperationBadges({
  operation,
}: {
  operation: NormalizedPlaygroundOperation;
}): ReactElement {
  return (
    <div className="pwar__badges" aria-label="Operation metadata">
      <span className="pwar__badge">
        {operation.explicitlyPublic ? "Public" : "Authenticated"}
      </span>
      {operation.responses.private ? (
        <span className="pwar__badge pwar__badge--private">
          Private response
        </span>
      ) : null}
      {operation.deprecated ? (
        <span className="pwar__badge pwar__badge--danger">Deprecated</span>
      ) : null}
      {operation.releaseHold ? (
        <span className="pwar__badge pwar__badge--warning">Release hold</span>
      ) : null}
      {operation.contractIssues.length > 0 ? (
        <span className="pwar__badge pwar__badge--danger">
          {operation.contractIssues.length} contract{" "}
          {operation.contractIssues.length === 1 ? "issue" : "issues"}
        </span>
      ) : null}
    </div>
  );
}

function ContractAlerts({
  operation,
}: {
  operation: NormalizedPlaygroundOperation;
}): ReactElement | null {
  if (!operation.releaseHold && operation.contractIssues.length === 0) {
    return null;
  }
  return (
    <section className="pwar__alerts" aria-label="Contract warnings">
      {operation.releaseHold ? (
        <div className="pwar__alert pwar__alert--warning">
          <h3>Release hold</h3>
          <p>{operation.releaseHold}</p>
        </div>
      ) : null}
      {operation.contractIssues.length > 0 ? (
        <div className="pwar__alert pwar__alert--danger">
          <h3>Contract issues</h3>
          <ul>
            {operation.contractIssues.map((issue, index) => (
              <li key={String(index) + issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function OperationOverview({
  operation,
}: {
  operation: NormalizedPlaygroundOperation;
}): ReactElement {
  const tags =
    operation.tags.length > 0
      ? operation.tags.map(displayTag).join(", ")
      : "None declared";
  return (
    <DetailSection title="Contract">
      <dl className="pwar__facts">
        <Fact
          label="Operation ID"
          value={operation.operationId || "Not declared"}
        />
        <Fact label="Primary tag" value={displayTag(operation.primaryTag)} />
        <Fact label="All tags" value={tags} />
        <Fact
          label="Request body policy"
          value={
            operation.requestBody
              ? operation.requestBody.required
                ? "Required body declared"
                : "Optional body declared"
              : operation.bodyless
                ? "Explicitly bodyless"
                : "No request body declared"
          }
        />
        <Fact
          label="Maximum request body"
          value={
            operation.maxBodyBytes === undefined
              ? "Not declared"
              : formatBytes(operation.maxBodyBytes)
          }
        />
        <Fact
          label="Response visibility"
          value={operation.responses.private ? "Private" : "Not marked private"}
        />
      </dl>
    </DetailSection>
  );
}

function AccessContract({
  operation,
}: {
  operation: NormalizedPlaygroundOperation;
}): ReactElement {
  return (
    <DetailSection title="Authentication and authorization">
      {operation.explicitlyPublic ? (
        <p className="pwar__plain-note">
          Explicitly public. No authentication is required by this operation.
        </p>
      ) : operation.security.length > 0 ? (
        <ol className="pwar__auth-options">
          {operation.security.map((requirement, index) => (
            <li key={String(index) + requirement.schemes.join("+")}>
              <span>Option {index + 1}</span>
              <code>
                {requirement.schemes.length > 0
                  ? requirement.schemes.join(" + ")
                  : "No schemes declared"}
              </code>
            </li>
          ))}
        </ol>
      ) : (
        <p className="pwar__plain-note pwar__plain-note--warning">
          This operation is not public, but no authentication scheme is
          declared.
        </p>
      )}
      {operation.security.length > 1 ? (
        <p className="pwar__hint">
          Authentication options are alternatives; schemes within one option are
          all required.
        </p>
      ) : null}
      <dl className="pwar__facts">
        <Fact
          label="Required role"
          value={operation.requiredRole || "Not declared"}
        />
        <Fact
          label="Required scopes"
          value={
            operation.requiredScopes.length > 0
              ? operation.requiredScopes.join(", ")
              : "None declared"
          }
        />
        <Fact
          label="Scope mode"
          value={operation.requiredScopeMode || "Not declared"}
        />
      </dl>
    </DetailSection>
  );
}

function ParameterContract({
  parameters,
}: {
  parameters: readonly PlaygroundParameter[];
}): ReactElement {
  return (
    <DetailSection title={"Parameters (" + String(parameters.length) + ")"}>
      {parameters.length === 0 ? (
        <p className="pwar__plain-note">
          No path, query, or header parameters.
        </p>
      ) : (
        <ul className="pwar__parameter-list">
          {parameters.map((parameter) => (
            <ParameterDetail
              key={parameter.location + ":" + parameter.name}
              parameter={parameter}
            />
          ))}
        </ul>
      )}
    </DetailSection>
  );
}

function ParameterDetail({
  parameter,
}: {
  parameter: PlaygroundParameter;
}): ReactElement {
  return (
    <li>
      <div className="pwar__parameter-heading">
        <code>{parameter.name}</code>
        <span>{parameter.location}</span>
        <span>{parameter.required ? "Required" : "Optional"}</span>
      </div>
      {parameter.description ? <p>{parameter.description}</p> : null}
      {parameter.style || parameter.explode !== undefined ? (
        <p className="pwar__hint">
          Serialization: {parameter.style || "default"}
          {parameter.explode === undefined
            ? ""
            : parameter.explode
              ? ", explode"
              : ", no explode"}
        </p>
      ) : null}
      <JsonDisclosure
        label="Example"
        accessibleLabel={`Example for ${parameter.name}`}
        value={parameter.example}
      />
      <JsonDisclosure
        label="Schema"
        accessibleLabel={`Schema for ${parameter.name}`}
        value={parameter.schema}
      />
    </li>
  );
}

function RequestContract({
  requestBody,
  bodyless,
}: {
  requestBody: PlaygroundRequestBody | undefined;
  bodyless: boolean;
}): ReactElement {
  return (
    <DetailSection title="Request body">
      {requestBody ? (
        <>
          <p className="pwar__plain-note">
            {requestBody.required ? "Required body." : "Optional body."}{" "}
            {requestBody.description || ""}
          </p>
          <MediaTypes
            values={requestBody.mediaTypes}
            selected={requestBody.selectedMediaType}
            emptyLabel="No request media type declared."
          />
          {requestBody.exampleSource ? (
            <p className="pwar__hint">
              Example source: {requestBody.exampleSource}
            </p>
          ) : null}
          <JsonDisclosure label="Example body" value={requestBody.example} />
          <JsonDisclosure label="Request schema" value={requestBody.schema} />
        </>
      ) : (
        <p className="pwar__plain-note">
          {bodyless
            ? "This operation is bodyless; no request body is accepted."
            : "No request body is declared in the normalized contract."}
        </p>
      )}
    </DetailSection>
  );
}

function ResponseContract({
  operation,
}: {
  operation: NormalizedPlaygroundOperation;
}): ReactElement {
  return (
    <DetailSection title="Responses">
      <dl className="pwar__facts">
        <Fact
          label="Statuses"
          value={
            operation.responses.statuses.length > 0
              ? operation.responses.statuses.join(", ")
              : "None declared"
          }
        />
        <Fact
          label="Visibility"
          value={operation.responses.private ? "Private" : "Not marked private"}
        />
      </dl>
      {operation.responses.statuses.length > 0 ? (
        <ul className="pwar__response-contracts">
          {operation.responses.statuses.map((status) => {
            const media = operation.responses.mediaTypesByStatus[status] ?? [];
            return (
              <li key={status}>
                <code>{status}</code>
                <span>
                  {media.length > 0
                    ? media.join(", ")
                    : "No response body media declared"}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="pwar__plain-note pwar__plain-note--warning">
          No response statuses are declared.
        </p>
      )}
      <MediaTypes
        values={operation.responses.mediaTypes}
        emptyLabel="No response media type declared."
      />
    </DetailSection>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="pwar__section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Fact({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function MediaTypes({
  values,
  selected,
  emptyLabel,
}: {
  values: readonly string[];
  selected?: string;
  emptyLabel: string;
}): ReactElement {
  if (values.length === 0) {
    return <p className="pwar__plain-note">{emptyLabel}</p>;
  }
  return (
    <div className="pwar__media">
      <span>Media types</span>
      <ul>
        {values.map((value) => (
          <li key={value}>
            <code>{value}</code>
            {value === selected ? <span>Selected</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function JsonDisclosure({
  label,
  accessibleLabel,
  value,
}: {
  label: string;
  accessibleLabel?: string;
  value: unknown;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (value === undefined) return null;
  return (
    <details
      className="pwar__json"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label={accessibleLabel}>{label}</summary>
      {open ? (
        <div className="pwar__json-content">
          <PlaygroundJSONView
            value={value}
            ariaLabel={`${accessibleLabel ?? label} JSON`}
          />
        </div>
      ) : null}
    </details>
  );
}

function buildSearchIndex(
  operations: readonly NormalizedPlaygroundOperation[],
): SearchableOperation[] {
  return operations.map((operation) => ({
    key: apiPlaygroundReferenceOperationKey(operation),
    operation,
    searchText: operationSearchText(operation),
  }));
}

function filterOperations(
  entries: readonly SearchableOperation[],
  query: string,
  method: typeof ALL_METHODS | PlaygroundMethod,
  tag: string,
): SearchableOperation[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(
    (entry) =>
      (method === ALL_METHODS || entry.operation.method === method) &&
      (tag === ALL_TAGS || entry.operation.tags.includes(tag)) &&
      (needle.length === 0 || entry.searchText.includes(needle)),
  );
}

function collectTags(
  operations: readonly NormalizedPlaygroundOperation[],
): [string, number][] {
  const counts = new Map<string, number>();
  for (const operation of operations) {
    for (const tag of new Set(operation.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort(([left], [right]) =>
    displayTag(left).localeCompare(displayTag(right)),
  );
}

function operationSearchText(operation: NormalizedPlaygroundOperation): string {
  const values: string[] = [
    operation.method,
    operation.path,
    operation.operationId,
    operation.summary,
    operation.description,
    operation.primaryTag,
    ...operation.tags,
    operation.requiredRole ?? "",
    ...operation.requiredScopes,
    operation.requiredScopeMode ?? "",
    operation.releaseHold ?? "",
    ...operation.contractIssues,
    ...operation.responses.statuses,
    ...operation.responses.mediaTypes,
  ];
  for (const parameter of operation.parameters) {
    values.push(
      parameter.name,
      parameter.location,
      parameter.description ?? "",
      parameter.style ?? "",
    );
  }
  for (const requirement of operation.security) {
    values.push(...requirement.schemes);
  }
  if (operation.requestBody) {
    values.push(
      operation.requestBody.description ?? "",
      ...operation.requestBody.mediaTypes,
    );
  }
  return values.join(" ").toLocaleLowerCase();
}

function displayTag(tag: string): string {
  return tag.trim() || "Unnamed tag";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return String(bytes) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}
