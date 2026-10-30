import type { ReactElement } from "react";

import { fmtDate } from "../../lib/format-date";
import type { TagDisplayRow } from "./tagPageModel";
import { tagColorPresentation } from "../../components/tags/tagColorPresentation";
import type { TagsPageController } from "./useTagsPageController";

type RegisteredRow = Extract<TagDisplayRow, { kind: "tag" }>;
type OrphanRow = Extract<TagDisplayRow, { kind: "orphan" }>;

export function TagCatalogRows({
  controller,
}: {
  controller: TagsPageController;
}): ReactElement {
  return (
    <>
      {controller.pageRows.map((row, index) =>
        row.kind === "orphan" ? (
          <TagOrphanRow
            key={`orphan:${row.name}:${index}`}
            row={row}
            controller={controller}
          />
        ) : (
          <TagRegisteredRow
            key={row.tag.id}
            row={row}
            controller={controller}
          />
        ),
      )}
    </>
  );
}

function TagOrphanRow({
  row,
  controller,
}: {
  row: OrphanRow;
  controller: TagsPageController;
}): ReactElement {
  const availabilityDescription = `tags-orphan-explanation${
    controller.writeUnavailableReason ? " tags-write-availability" : ""
  }`;
  const register = (): void => {
    if (controller.canMutate) controller.setRegisterTarget(row.name);
  };
  return (
    <tr className="tag-row-orphan">
      <td className="tags-cell-select">
        <input
          type="checkbox"
          aria-label={`Orphan tag ${row.name} cannot be selected`}
          disabled
        />
      </td>
      <th scope="row">
        <button
          type="button"
          className={`tag-row-primary${controller.canMutate ? "" : " pw-discoverable-unavailable"}`}
          onClick={register}
          aria-disabled={!controller.canMutate || undefined}
          aria-describedby={availabilityDescription}
        >
          <span className="tag-swatch tag-swatch-orphan" aria-hidden="true" />
          <span>{row.name}</span>
          <span className="tags-row-badge">Orphan</span>
        </button>
      </th>
      <td className="tabular">{row.usage.subscribers.toLocaleString()}</td>
      <td className="muted tabular">—</td>
      <td className="tags-cell-actions">
        <button
          type="button"
          className={`btn btn-sm btn-primary${controller.canMutate ? "" : " pw-discoverable-unavailable"}`}
          onClick={register}
          aria-disabled={!controller.canMutate || undefined}
          aria-describedby={availabilityDescription}
        >
          Register
        </button>
      </td>
    </tr>
  );
}

function TagRegisteredRow({
  row,
  controller,
}: {
  row: RegisteredRow;
  controller: TagsPageController;
}): ReactElement {
  const selected = controller.deletion.selected.has(row.tag.id);
  const color = tagColorPresentation(row.tag.color);
  const toggleSelected = (): void => {
    const next = new Set(controller.deletion.selected);
    if (next.has(row.tag.id)) next.delete(row.tag.id);
    else next.add(row.tag.id);
    controller.deletion.setSelected(next);
  };
  return (
    <tr className={selected ? "is-selected" : undefined}>
      <td className="tags-cell-select">
        <input
          type="checkbox"
          aria-label={`Select ${row.name}`}
          checked={selected}
          disabled={!controller.canMutate}
          onChange={toggleSelected}
        />
      </td>
      <th scope="row">
        <button
          type="button"
          className="tag-row-primary"
          onClick={() => controller.detailRoute.openDetail(row.tag)}
          aria-label={`Open tag ${row.name || "Unnamed tag"}`}
        >
          <span
            className="tag-swatch"
            style={{ background: color.background }}
            aria-hidden="true"
          />
          <span>{row.name || <em className="muted">Unnamed tag</em>}</span>
          {color.legacy ? (
            <span
              className="tags-row-badge tags-row-badge-legacy"
              title={`Stored colour ${JSON.stringify(row.tag.color)} is unsupported and shown as neutral slate.`}
            >
              Legacy colour
            </span>
          ) : null}
        </button>
      </th>
      <td className="tabular">
        {controller.usageAvailable ? (
          (row.usage?.subscribers ?? 0).toLocaleString()
        ) : (
          <span className="muted" aria-label="Subscriber count unavailable">
            —
          </span>
        )}
      </td>
      <td className="muted tabular">
        {row.tag.created_at ? fmtDate(row.tag.created_at) : "—"}
      </td>
      <td className="tags-cell-actions">
        <div className="list-row-actions">
          <UnavailableAction
            label="Merge"
            ariaLabel={`Merge ${row.name}`}
            describedBy="tags-merge-availability"
          />
          <button
            type="button"
            className={`btn btn-sm btn-ghost list-row-action${controller.canMutate ? "" : " pw-discoverable-unavailable"}`}
            onClick={() => {
              if (controller.canMutate) controller.edit.openEdit(row.tag);
            }}
            aria-disabled={!controller.canMutate || undefined}
            aria-describedby={
              controller.canMutate ? undefined : "tags-write-availability"
            }
            aria-label={`Edit ${row.name}`}
          >
            Edit
          </button>
          <UnavailableAction
            label="Delete"
            ariaLabel={`Delete ${row.name}`}
            describedBy="tags-delete-availability"
          />
        </div>
      </td>
    </tr>
  );
}

function UnavailableAction({
  label,
  ariaLabel,
  describedBy,
}: {
  label: string;
  ariaLabel: string;
  describedBy: string;
}): ReactElement {
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost list-row-action pw-discoverable-unavailable"
      aria-label={ariaLabel}
      aria-disabled="true"
      aria-describedby={describedBy}
      onClick={(event) => event.preventDefault()}
    >
      {label}
    </button>
  );
}
