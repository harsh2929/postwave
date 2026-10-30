import type { FormEvent, ReactElement } from "react";

import {
  PLATFORM_FILTERS,
  REASON_FILTERS,
  type PushPlatformFilter,
  type PushReasonFilter,
  type PushSourceFilter,
} from "./push-suppression-model";

interface FilterChoice<T extends string> {
  value: T;
  label: string;
}

interface ChipGroupProps<T extends string> {
  legend: string;
  hint?: string;
  choices: readonly FilterChoice<T>[];
  value: T;
  onChange: (value: T) => void;
}

function ChipGroup<T extends string>({
  legend,
  hint,
  choices,
  value,
  onChange,
}: ChipGroupProps<T>): ReactElement {
  return (
    <fieldset className="push-filter-group">
      <legend>{legend}</legend>
      {hint ? <p className="push-filter-hint">{hint}</p> : null}
      <div className="push-filter-chips">
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className="push-filter-chip"
            aria-pressed={value === choice.value}
            onClick={() => onChange(choice.value)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

interface Props {
  platform: PushPlatformFilter;
  reason: PushReasonFilter;
  source: PushSourceFilter;
  sourceChoices: ReadonlyArray<FilterChoice<PushSourceFilter>>;
  queryInput: string;
  queryError: string | null;
  loading: boolean;
  onPlatformChange: (value: PushPlatformFilter) => void;
  onReasonChange: (value: PushReasonFilter) => void;
  onSourceChange: (value: PushSourceFilter) => void;
  onQueryChange: (value: string) => void;
}

export function PushSuppressionFilters({
  platform,
  reason,
  source,
  sourceChoices,
  queryInput,
  queryError,
  loading,
  onPlatformChange,
  onReasonChange,
  onSourceChange,
  onQueryChange,
}: Props): ReactElement {
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
  };
  return (
    <form
      className="push-suppression-filters"
      role="search"
      aria-label="Search and filter push suppressions"
      aria-busy={loading ? "true" : undefined}
      onSubmit={submit}
      noValidate
    >
      <div className="push-search-field">
        <label htmlFor="push-suppression-search">
          Device-token fingerprint prefix
        </label>
        <p id="push-suppression-search-hint">
          Server search checks the 16-character privacy-safe fingerprint; raw
          device tokens are never searched or returned.
        </p>
        <input
          id="push-suppression-search"
          type="search"
          value={queryInput}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="8–16 lowercase hex characters"
          inputMode="text"
          minLength={8}
          maxLength={16}
          pattern="[0-9a-f]{8,16}"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={
            queryError
              ? "push-suppression-search-hint push-suppression-search-error"
              : "push-suppression-search-hint"
          }
          aria-invalid={queryError ? "true" : undefined}
        />
        {queryError ? (
          <p
            id="push-suppression-search-error"
            className="field-v2-error"
            role="alert"
          >
            {queryError}
          </p>
        ) : null}
      </div>
      <div className="push-filter-grid">
        <ChipGroup
          legend="Platform"
          choices={PLATFORM_FILTERS}
          value={platform}
          onChange={onPlatformChange}
        />
        <ChipGroup
          legend="Reason"
          choices={REASON_FILTERS}
          value={reason}
          onChange={onReasonChange}
        />
        <ChipGroup
          legend="Source on this verified page"
          hint="Source is narrowed locally because the registry API does not expose a source query."
          choices={sourceChoices}
          value={source}
          onChange={onSourceChange}
        />
      </div>
    </form>
  );
}
