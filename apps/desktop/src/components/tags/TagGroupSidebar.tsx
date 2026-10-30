/**
 * TagGroupSidebar — left-rail group navigator for the Tags page.
 *
 * Lists tag_groups + a synthetic "All tags" entry at top and an
 * "Ungrouped" bucket at the bottom. Selecting a row drives the page's
 * groupFilter state, which is forwarded to the catalogue list filter.
 *
 * Counts are derived from the in-memory tag rows so we avoid an extra
 * round-trip — the catalogue is small, so a single re-tally per render
 * is cheaper than another HTTP call.
 */

import { type ReactElement } from "react";

import type { Tag, TagGroup } from "../../lib/api-client";
import { tagColorPresentation } from "./tagColorPresentation";

/** Sentinel value for the "Ungrouped" bucket. The Go handler treats
 *  group_id=none as IS NULL. */
export const GROUP_FILTER_UNGROUPED = "none";
/** Sentinel for "All tags" — no filter, surfaces everything. */
export const GROUP_FILTER_ALL = "";

interface Props {
  groups: TagGroup[];
  tags: Tag[];
  selected: string;
  onSelect: (groupId: string) => void;
  onManage?: () => void;
  canManage?: boolean;
  unavailableReason?: string | null;
  remoteError?: string | null;
  remoteLoading?: boolean;
  onRetry?: () => void;
}

export function TagGroupSidebar({
  groups,
  tags,
  selected,
  onSelect,
  onManage,
  canManage,
  unavailableReason,
  remoteError,
  remoteLoading,
  onRetry,
}: Props): ReactElement {
  const total = tags.length;
  const ungrouped = tags.filter((t) => !t.group_id).length;
  const countByGroup = new Map<string, number>();
  for (const t of tags) {
    if (!t.group_id) continue;
    countByGroup.set(t.group_id, (countByGroup.get(t.group_id) ?? 0) + 1);
  }

  return (
    <aside className="tag-group-sidebar" aria-label="Tag groups">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "var(--pw-fg-muted)",
          }}
        >
          Groups
        </h3>
        {onManage ? (
          <button
            type="button"
            className={`btn btn-sm btn-ghost${canManage ? "" : " pw-discoverable-unavailable"}`}
            onClick={() => {
              if (canManage) onManage();
            }}
            aria-label="Create, rename, or delete tag groups"
            aria-disabled={!canManage || undefined}
            aria-describedby={!canManage ? "tag-groups-unavailable" : undefined}
            style={{ padding: "2px 6px", fontSize: 11 }}
          >
            Manage
          </button>
        ) : null}
      </div>

      <label className="visually-hidden" htmlFor="tag-group-select">
        Filter by tag group
      </label>
      <select
        id="tag-group-select"
        className="input tag-group-select"
        value={selected}
        onChange={(event) => onSelect(event.target.value)}
        disabled={Boolean(unavailableReason)}
      >
        <option value={GROUP_FILTER_ALL}>All tags ({total})</option>
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            {group.name} ({countByGroup.get(group.id) ?? 0})
          </option>
        ))}
        <option value={GROUP_FILTER_UNGROUPED}>No group ({ungrouped})</option>
      </select>

      <ul className="tag-group-list">
        <SidebarRow
          label="All tags"
          count={total}
          active={selected === GROUP_FILTER_ALL}
          onClick={() => onSelect(GROUP_FILTER_ALL)}
        />
        {!unavailableReason &&
          groups.map((g) => (
            <SidebarRow
              key={g.id}
              label={g.name}
              count={countByGroup.get(g.id) ?? 0}
              color={g.color}
              active={selected === g.id}
              onClick={() => onSelect(g.id)}
            />
          ))}
        {!unavailableReason ? (
          <SidebarRow
            label="No group"
            count={ungrouped}
            active={selected === GROUP_FILTER_UNGROUPED}
            onClick={() => onSelect(GROUP_FILTER_UNGROUPED)}
            dim
          />
        ) : null}
      </ul>
      {unavailableReason ? (
        <div
          id="tag-groups-unavailable"
          className="tag-group-status"
          role="status"
        >
          <strong>Groups unavailable</strong>
          <span>{unavailableReason}</span>
          {remoteError ? (
            <span>
              Server check failed. {remoteLoading ? "Retrying…" : ""}
              {onRetry && !remoteLoading ? (
                <button type="button" className="link" onClick={onRetry}>
                  Retry check
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {!unavailableReason && remoteError ? (
        <div className="tag-group-status" role="alert">
          <strong>Groups may be stale</strong>
          <span>
            Last verified groups remain visible; no empty state was inferred.
            {remoteLoading ? " Retrying…" : ""}
            {onRetry && !remoteLoading ? (
              <button type="button" className="link" onClick={onRetry}>
                Retry
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
    </aside>
  );
}

interface RowProps {
  label: string;
  count: number;
  color?: string;
  active: boolean;
  onClick: () => void;
  dim?: boolean;
}

function SidebarRow({
  label,
  count,
  color,
  active,
  onClick,
  dim,
}: RowProps): ReactElement {
  const colorPresentation = tagColorPresentation(color);
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={`tag-group-row${active ? " is-active" : ""}`}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          border: 0,
          background: active ? "var(--pw-bg-elev-2)" : "transparent",
          color: dim ? "var(--pw-fg-muted)" : "inherit",
          textAlign: "left",
          borderRadius: 4,
          cursor: "pointer",
          fontSize: 13,
          fontStyle: dim ? "italic" : "normal",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dim
              ? "transparent"
              : color
                ? colorPresentation.background
                : "var(--pw-fg-subtle)",
            border: dim ? "1px dashed currentColor" : "none",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            flex: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={label}
        >
          {label}
        </span>
        {colorPresentation.legacy ? (
          <span
            className="tags-row-badge tags-row-badge-legacy"
            title={`Stored colour ${JSON.stringify(color)} is unsupported and shown as neutral slate.`}
          >
            Legacy
          </span>
        ) : null}
        <span className="tabular muted" style={{ fontSize: 11, opacity: 0.7 }}>
          {count.toLocaleString()}
        </span>
      </button>
    </li>
  );
}
