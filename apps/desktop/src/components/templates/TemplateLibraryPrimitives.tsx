import type { ReactElement } from "react";

import type { TemplateGoal, TemplateStats } from "../../lib/api-client";
import type {
  CampaignTemplateDiscoveryLifecycle,
  CampaignTemplateDiscoverySort,
  CampaignTemplateDiscoveryView,
} from "../../lib/campaign-template-discovery-preferences";
import { ChoiceGroup } from "../ChoiceGroup";
import { InlineHelp } from "../InlineHelp";
import { Modal, ModalFooter } from "../Modal";

export type TemplateSource =
  | "all"
  | "platform"
  | "team"
  | "mine"
  | "favorited"
  | "archived"
  | "saved_blocks";
export type TemplateKind = "regular" | "automation" | "broadcast";

export interface TemplateCreateDraft {
  name: string;
  slug: string;
  kind: TemplateKind;
  category: string;
  goal: TemplateGoal | "";
  subject: string;
  preview_text: string;
  body_html: string;
}

export interface SavedBlockDraft {
  name: string;
  body_html: string;
  body_json: string;
}

export interface SavedBlockDraftValidation {
  nameMissing: boolean;
  contentMissing: boolean;
  jsonError: string | null;
}

export function validateSavedBlockDraft(
  draft: SavedBlockDraft,
): SavedBlockDraftValidation {
  const rawJson = draft.body_json.trim();
  let jsonError: string | null = null;
  let hasJsonContent = false;
  if (rawJson) {
    try {
      const parsed: unknown = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        hasJsonContent = parsed.length > 0;
      } else if (parsed !== null && typeof parsed === "object") {
        hasJsonContent = Object.keys(parsed).length > 0;
      } else {
        jsonError = "Block JSON must be an object or array.";
      }
    } catch {
      jsonError = "Block JSON must be valid JSON.";
    }
  }
  return {
    nameMissing: draft.name.trim().length === 0,
    contentMissing: draft.body_html.trim().length === 0 && !hasJsonContent,
    jsonError,
  };
}

export const TEMPLATE_SOURCES: {
  id: TemplateSource;
  label: string;
  hint: string;
}[] = [
  {
    id: "all",
    label: "All templates",
    hint: "Every template visible to your workspace.",
  },
  {
    id: "platform",
    label: "Inspiration",
    hint: "Browse curated designs and make an editable version your own.",
  },
  {
    id: "team",
    label: "Team templates",
    hint: "Templates other teammates have built.",
  },
  {
    id: "mine",
    label: "My templates",
    hint: "Editable templates you've authored or saved.",
  },
  { id: "favorited", label: "Favorites", hint: "Templates you've starred." },
  {
    id: "archived",
    label: "Archived",
    hint: "Recoverable workspace templates kept with their revision history.",
  },
  {
    id: "saved_blocks",
    label: "Saved blocks",
    hint: "Reusable block snippets you've saved from the editor.",
  },
];

export const TEMPLATE_GOAL_LABELS: Record<TemplateGoal, string> = {
  welcome: "Welcome",
  newsletter: "Newsletter",
  announcement: "Announcement",
  promotional: "Promotional",
  re_engagement: "Re-engagement",
  transactional: "Transactional",
  automation: "Automation",
};

export const TEMPLATE_GOAL_ORDER: TemplateGoal[] = [
  "welcome",
  "newsletter",
  "announcement",
  "promotional",
  "re_engagement",
  "transactional",
  "automation",
];

const TEMPLATE_KIND_OPTIONS: TemplateKind[] = [
  "regular",
  "automation",
  "broadcast",
];

export const EMPTY_TEMPLATE_CREATE_DRAFT: TemplateCreateDraft = {
  name: "",
  slug: "",
  kind: "regular",
  category: "newsletter",
  goal: "",
  subject: "",
  preview_text: "",
  body_html: "",
};

export function templateSlugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
}

export function TemplateCreateModal({
  draft,
  open,
  operationActive,
  slugTouched,
  submitErr,
  submitting,
  onClose,
  onDraftChange,
  onSlugTouched,
  onSubmit,
}: {
  draft: TemplateCreateDraft;
  open: boolean;
  operationActive: boolean;
  slugTouched: boolean;
  submitErr: string | null;
  submitting: boolean;
  onClose: () => void;
  onDraftChange: (draft: TemplateCreateDraft) => void;
  onSlugTouched: () => void;
  onSubmit: () => void;
}): ReactElement {
  const nameMissing = draft.name.trim().length === 0;
  const slugInvalid =
    draft.slug.trim().length > 0 &&
    !/^[a-z][a-z0-9-]{0,79}$/.test(draft.slug.trim());
  const submitUnavailable = operationActive || nameMissing || slugInvalid;
  const actionReason = operationActive
    ? "Wait for the active template create request to finish."
    : nameMissing
      ? "Enter a template name before creating it."
      : slugInvalid
        ? "Correct the slug before creating the template."
        : "The template is ready to create.";
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New template"
      description="Templates can be reused across campaigns and automations."
      closeOnBackdrop={!operationActive}
      closeOnEscape={!operationActive}
      closeDisabled={operationActive}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitUnavailable) onSubmit();
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="tpl-new-name">
            Name <span aria-hidden="true">*</span>
          </label>
          <input
            id="tpl-new-name"
            className="input"
            placeholder="Weekly digest"
            value={draft.name}
            required
            readOnly={operationActive}
            aria-disabled={operationActive}
            aria-invalid={submitErr?.startsWith("Name") || undefined}
            aria-describedby="tpl-new-name-hint tpl-new-action-reason"
            autoComplete="off"
            onChange={(event) => {
              if (operationActive) return;
              const name = event.target.value;
              onDraftChange({
                ...draft,
                name,
                slug: slugTouched ? draft.slug : templateSlugify(name),
              });
            }}
          />
          <div id="tpl-new-name-hint" className="field-hint">
            Required. Use a name teammates can distinguish in search results.
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="tpl-new-slug">
            Slug
          </label>
          <input
            id="tpl-new-slug"
            className="input mono"
            placeholder="weekly-digest"
            value={draft.slug}
            maxLength={80}
            pattern="[a-z][a-z0-9-]{0,79}"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            readOnly={operationActive}
            aria-disabled={operationActive}
            aria-invalid={
              slugInvalid || submitErr?.startsWith("Slug") || undefined
            }
            aria-describedby="tpl-new-slug-hint tpl-new-action-reason"
            onChange={(event) => {
              if (operationActive) return;
              onSlugTouched();
              onDraftChange({ ...draft, slug: event.target.value });
            }}
          />
          <div id="tpl-new-slug-hint" className="field-hint">
            Up to 80 characters. Start with a lowercase letter; then use
            lowercase letters, digits, or dashes.
          </div>
        </div>
        <div className="tpl-template-classification-grid">
          <div className="field">
            <label className="field-label" htmlFor="tpl-new-goal">
              Goal
            </label>
            <select
              id="tpl-new-goal"
              className="input"
              value={draft.goal}
              aria-disabled={operationActive}
              aria-describedby="tpl-new-action-reason"
              onChange={(event) => {
                if (operationActive) return;
                onDraftChange({
                  ...draft,
                  goal: event.target.value as TemplateGoal | "",
                });
              }}
            >
              <option value="">No goal</option>
              {TEMPLATE_GOAL_ORDER.map((goal) => (
                <option key={goal} value={goal}>
                  {TEMPLATE_GOAL_LABELS[goal]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="tpl-new-kind">
              Kind
            </label>
            <select
              id="tpl-new-kind"
              className="input"
              value={draft.kind}
              aria-disabled={operationActive}
              aria-describedby="tpl-new-action-reason"
              onChange={(event) => {
                if (operationActive) return;
                onDraftChange({
                  ...draft,
                  kind: event.target.value as TemplateKind,
                });
              }}
            >
              {TEMPLATE_KIND_OPTIONS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind[0].toUpperCase() + kind.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="tpl-new-category">
              Category
            </label>
            <select
              id="tpl-new-category"
              className="input"
              value={draft.category}
              aria-disabled={operationActive}
              aria-describedby="tpl-new-action-reason"
              onChange={(event) => {
                if (operationActive) return;
                onDraftChange({ ...draft, category: event.target.value });
              }}
            >
              <option value="newsletter">Newsletter</option>
              <option value="promotional">Promotional</option>
              <option value="transactional">Transactional</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="tpl-new-subject">
            Subject
          </label>
          <input
            id="tpl-new-subject"
            className="input"
            placeholder="What's new this week"
            value={draft.subject}
            readOnly={operationActive}
            aria-disabled={operationActive}
            aria-describedby="tpl-new-action-reason"
            onChange={(event) => {
              if (!operationActive) {
                onDraftChange({ ...draft, subject: event.target.value });
              }
            }}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="tpl-new-preview">
            Preview text
          </label>
          <input
            id="tpl-new-preview"
            className="input"
            placeholder="Shown in the inbox preview"
            value={draft.preview_text}
            readOnly={operationActive}
            aria-disabled={operationActive}
            aria-describedby="tpl-new-action-reason"
            onChange={(event) => {
              if (!operationActive) {
                onDraftChange({ ...draft, preview_text: event.target.value });
              }
            }}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="tpl-new-html">
            HTML body
          </label>
          <textarea
            id="tpl-new-html"
            className="input mono tpl-code-field"
            rows={8}
            value={draft.body_html}
            aria-disabled={operationActive}
            aria-describedby="tpl-new-html-hint tpl-new-action-reason"
            autoComplete="off"
            spellCheck={false}
            readOnly={operationActive}
            onChange={(event) => {
              if (!operationActive) {
                onDraftChange({ ...draft, body_html: event.target.value });
              }
            }}
            placeholder="<p>Hello…</p>"
          />
          <div id="tpl-new-html-hint" className="field-hint">
            Scripts are not executed in Moosewave previews. Review links and
            remote assets before sending.
          </div>
        </div>
        {submitErr ? (
          <div className="field-error" role="alert">
            {submitErr}
          </div>
        ) : null}
        <p
          id="tpl-new-action-reason"
          className="pw-action-status"
          role="status"
        >
          {actionReason}
        </p>
        <ModalFooter>
          <button
            type="button"
            className={`btn${operationActive ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => {
              if (!operationActive) onClose();
            }}
            aria-disabled={operationActive}
            aria-describedby="tpl-new-action-reason"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={`btn btn-primary${submitUnavailable ? " pw-discoverable-unavailable" : ""}`}
            aria-disabled={submitUnavailable}
            aria-busy={submitting}
            aria-describedby="tpl-new-action-reason"
          >
            {submitting ? "Creating…" : "Create template"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

export function SavedBlockCreateModal({
  draft,
  open,
  operationActive,
  saving,
  onClose,
  onDraftChange,
  onSubmit,
}: {
  draft: SavedBlockDraft;
  open: boolean;
  operationActive: boolean;
  saving: boolean;
  onClose: () => void;
  onDraftChange: (draft: SavedBlockDraft) => void;
  onSubmit: () => void;
}): ReactElement {
  const validation = validateSavedBlockDraft(draft);
  const { contentMissing, nameMissing } = validation;
  const jsonInvalid = validation.jsonError !== null;
  const submitUnavailable =
    operationActive || nameMissing || contentMissing || jsonInvalid;
  const actionReason = operationActive
    ? "Wait for the active saved-block request to finish."
    : nameMissing
      ? "Enter a saved-block name before saving."
      : jsonInvalid
        ? "Correct the block JSON before saving."
        : contentMissing
          ? "Add HTML or non-empty block JSON before saving."
          : "The saved block is ready to save.";
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New saved block"
      description="Store reusable HTML or structured block JSON for this workspace."
      closeOnBackdrop={!operationActive}
      closeOnEscape={!operationActive}
      closeDisabled={operationActive}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitUnavailable) onSubmit();
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="sb-name">
            Name <span aria-hidden="true">*</span>
          </label>
          <input
            id="sb-name"
            className="input"
            placeholder='e.g. "Spring banner — desktop"'
            maxLength={120}
            value={draft.name}
            required
            readOnly={operationActive}
            autoComplete="off"
            aria-disabled={operationActive}
            aria-describedby="sb-name-hint sb-action-reason"
            onChange={(event) => {
              if (!operationActive) {
                onDraftChange({ ...draft, name: event.target.value });
              }
            }}
          />
          <div id="sb-name-hint" className="field-hint">
            Required. Up to 120 characters; include the section and variant.
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="sb-html">
            HTML body
          </label>
          <textarea
            id="sb-html"
            className="input mono tpl-code-field"
            rows={7}
            value={draft.body_html}
            autoComplete="off"
            spellCheck={false}
            readOnly={operationActive}
            aria-disabled={operationActive}
            aria-describedby="sb-content-hint sb-action-reason"
            onChange={(event) => {
              if (!operationActive) {
                onDraftChange({ ...draft, body_html: event.target.value });
              }
            }}
            placeholder="<table>…</table>"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="sb-json">
            Block JSON (optional)
          </label>
          <textarea
            id="sb-json"
            className="input mono tpl-code-field"
            rows={5}
            value={draft.body_json}
            autoComplete="off"
            spellCheck={false}
            readOnly={operationActive}
            aria-disabled={operationActive}
            aria-invalid={jsonInvalid || undefined}
            aria-describedby="sb-content-hint sb-json-error sb-action-reason"
            onChange={(event) => {
              if (!operationActive) {
                onDraftChange({ ...draft, body_json: event.target.value });
              }
            }}
            placeholder='{"block_id":"hero_text","config":{…}}'
          />
          <div id="sb-content-hint" className="field-hint">
            Add HTML, non-empty JSON, or both. Scripts are not executed in
            Moosewave previews.
          </div>
          <div
            id="sb-json-error"
            className={jsonInvalid ? "field-error" : "field-hint"}
          >
            {validation.jsonError ?? "JSON syntax is valid."}
          </div>
        </div>
        <p id="sb-action-reason" className="pw-action-status" role="status">
          {actionReason}
        </p>
        <ModalFooter>
          <button
            type="button"
            className={`btn${operationActive ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => {
              if (!operationActive) onClose();
            }}
            aria-disabled={operationActive}
            aria-describedby="sb-action-reason"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={`btn btn-primary${submitUnavailable ? " pw-discoverable-unavailable" : ""}`}
            aria-disabled={submitUnavailable}
            aria-busy={saving}
            aria-describedby="sb-action-reason"
          >
            {saving ? "Saving…" : "Save block"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

export function TemplateFilters({
  goalCountMap,
  goalFilter,
  query,
  lifecycle,
  sort,
  source,
  stats,
  view,
  onGoalChange,
  onLifecycleChange,
  onQueryChange,
  onQueryCompositionChange,
  onSortChange,
  onSourceChange,
  onViewChange,
}: {
  goalCountMap: ReadonlyMap<string, number>;
  goalFilter: TemplateGoal | "";
  query: string;
  lifecycle: CampaignTemplateDiscoveryLifecycle;
  sort: CampaignTemplateDiscoverySort;
  source: TemplateSource;
  stats: TemplateStats | null;
  view: CampaignTemplateDiscoveryView;
  onGoalChange: (goal: TemplateGoal | "") => void;
  onLifecycleChange: (lifecycle: CampaignTemplateDiscoveryLifecycle) => void;
  onQueryChange: (query: string) => void;
  onQueryCompositionChange?: (composing: boolean) => void;
  onSortChange: (sort: CampaignTemplateDiscoverySort) => void;
  onSourceChange: (source: TemplateSource) => void;
  onViewChange: (view: CampaignTemplateDiscoveryView) => void;
}): ReactElement {
  const sourceEntry =
    TEMPLATE_SOURCES.find((entry) => entry.id === source) ??
    TEMPLATE_SOURCES[0];
  const savedBlocksMode = source === "saved_blocks";
  const searchLabel = savedBlocksMode
    ? "Search saved blocks"
    : "Search templates";
  return (
    <>
      <ChoiceGroup
        legend="Template library view"
        value={source}
        onChange={onSourceChange}
        className="row tpl-source-tabs"
        optionClassName="tpl-tab"
        style={{
          gap: 4,
          marginBottom: 10,
          borderBottom: "1px solid var(--pw-border)",
        }}
        options={TEMPLATE_SOURCES.map((entry) => ({
          value: entry.id,
          className: source === entry.id ? "is-active" : undefined,
          label: (
            <>
              {entry.label}
              {entry.id === "favorited" && stats?.favorites ? (
                <span className="tpl-tab-count">{stats.favorites}</span>
              ) : null}
            </>
          ),
        }))}
      />
      <p className="muted tpl-source-description" role="status">
        <strong>{sourceEntry.label}:</strong> {sourceEntry.hint}
      </p>
      <div className="tpl-filter-row">
        <div className="field tpl-template-search">
          <label className="field-label" htmlFor="tpl-template-search">
            {searchLabel}
          </label>
          <div className="row tpl-template-search-controls">
            <input
              id="tpl-template-search"
              type="search"
              className="input"
              placeholder={
                savedBlocksMode
                  ? "Search by name, kind, or record ID…"
                  : "Search by name or subject…"
              }
              value={query}
              maxLength={200}
              autoComplete="off"
              aria-describedby="tpl-template-search-hint"
              onCompositionStart={() => onQueryCompositionChange?.(true)}
              onCompositionEnd={(event) => {
                onQueryCompositionChange?.(false);
                onQueryChange(event.currentTarget.value);
              }}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                ) {
                  return;
                }
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  onQueryChange("");
                }
              }}
            />
            {query ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onQueryChange("")}
              >
                Clear search
              </button>
            ) : null}
          </div>
          <div id="tpl-template-search-hint" className="field-hint">
            {savedBlocksMode
              ? "Saved blocks filter immediately by name, kind, or complete record ID."
              : "Template results update after a short typing pause."}{" "}
            Maximum 200 characters.
          </div>
        </div>
        {!savedBlocksMode ? (
          <div
            className="chips goal-rail"
            role="group"
            aria-labelledby="tpl-goal-filter-label"
            aria-describedby="tpl-goal-filter-hint"
          >
            <span id="tpl-goal-filter-label" className="field-label">
              Filter by goal
            </span>
            <button
              type="button"
              data-goal="__all"
              className={`chip${goalFilter === "" ? " is-active" : ""}`}
              onClick={() => onGoalChange("")}
              aria-pressed={goalFilter === ""}
            >
              All goals
            </button>
            <InlineHelp text="Goals classify what a template is for (welcome onboarding, newsletter, announcement, re-engagement, etc). Moosewave uses the goal to suggest defaults like double opt-in for transactional or send-time optimization for newsletters." />
            {TEMPLATE_GOAL_ORDER.map((goal) => {
              const count = goalCountMap.get(goal) ?? 0;
              const selected = goalFilter === goal;
              const unavailable = count === 0;
              return (
                <button
                  key={goal}
                  type="button"
                  data-goal={goal}
                  className={`chip goal-pill${selected ? " is-active" : ""}${unavailable ? " pw-discoverable-unavailable" : ""}`}
                  onClick={() => {
                    if (!unavailable) onGoalChange(goal);
                  }}
                  aria-disabled={unavailable}
                  aria-pressed={selected}
                  aria-label={`${TEMPLATE_GOAL_LABELS[goal]}, ${count.toLocaleString()} template${count === 1 ? "" : "s"}${selected ? ", selected" : ""}${unavailable ? ", unavailable for this view" : ""}`}
                >
                  <span className="goal-pill-dot" aria-hidden="true" />
                  {TEMPLATE_GOAL_LABELS[goal]}
                  <span className="tpl-tab-count">
                    {count.toLocaleString()}
                  </span>
                </button>
              );
            })}
            <span
              id="tpl-goal-filter-hint"
              className="field-hint tpl-goal-filter-hint"
            >
              A zero count means the catalog reported no available templates for
              that goal. Zero-count choices stay focusable so the reason remains
              discoverable.
            </span>
          </div>
        ) : (
          <div className="notice" role="note">
            Goal filters apply to complete templates, not reusable saved blocks.
          </div>
        )}
      </div>
      {!savedBlocksMode ? (
        <div
          className="tpl-discovery-preference-controls"
          aria-label="Catalog display preferences"
        >
          <label>
            <span className="field-label">Lifecycle</span>
            <select
              value={lifecycle}
              onChange={(event) =>
                onLifecycleChange(
                  event.target.value as CampaignTemplateDiscoveryLifecycle,
                )
              }
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">Active and archived</option>
            </select>
          </label>
          <label>
            <span className="field-label">Sort by</span>
            <select
              value={sort}
              onChange={(event) =>
                onSortChange(
                  event.target.value as CampaignTemplateDiscoverySort,
                )
              }
            >
              <option value="recommended">Recommended</option>
              <option value="name">Name</option>
              <option value="most_used">Most used</option>
            </select>
          </label>
          <div>
            <span className="field-label">Layout</span>
            <div
              className="tpl-discovery-view-switch"
              role="group"
              aria-label="Catalog layout"
            >
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={view === "grid"}
                onClick={() => onViewChange("grid")}
              >
                Cards
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={view === "compact"}
                onClick={() => onViewChange("compact")}
              >
                Compact
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
