import { type ChangeEvent, type ReactElement, useEffect, useRef } from "react";

import { HeroEmptyState } from "../../components/HeroEmptyState";
import { HERO } from "../../lib/heroAssets";
import type { TagSortField } from "./tagRouteState";
import { TagCatalogRows } from "./TagCatalogRows";
import type { TagsPageController } from "./useTagsPageController";

export function TagCatalog({
  controller,
}: {
  controller: TagsPageController;
}): ReactElement {
  if (!controller.catalog.loading && controller.catalog.rows === null) {
    return <></>;
  }
  const trueEmpty =
    !controller.catalog.loading &&
    controller.catalog.rows?.length === 0 &&
    controller.orphanCount === 0 &&
    !controller.query &&
    controller.colorFilter === "all";
  if (trueEmpty) return <TagCatalogueHero controller={controller} />;

  return (
    <section aria-label="Tag catalogue">
      {controller.catalog.loading && controller.catalog.rows !== null ? (
        <div className="muted small tags-refresh-status" role="status">
          Refreshing the catalogue; last verified rows remain visible.
        </div>
      ) : null}
      <div
        className="tags-table-scroll"
        role="region"
        aria-label="Scrollable tag catalogue"
        // Keyboard users need a focus target for the intentionally scrollable table.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
      >
        <table className="tags-table">
          <caption className="visually-hidden">
            Registered and orphan tags. Sortable columns announce their current
            direction.
          </caption>
          <TagCatalogHeader controller={controller} />
          <tbody>
            <TagCatalogBody controller={controller} />
          </tbody>
        </table>
      </div>
      <TagPagination controller={controller} />
    </section>
  );
}

function TagCatalogHeader({
  controller,
}: {
  controller: TagsPageController;
}): ReactElement {
  const checkboxRef = useRef<HTMLInputElement | null>(null);
  const registered = controller.pageRows.filter((row) => row.kind === "tag");
  const selectedCount = registered.filter((row) =>
    row.kind === "tag" ? controller.deletion.selected.has(row.tag.id) : false,
  ).length;
  const allSelected =
    registered.length > 0 && selectedCount === registered.length;
  const mixed = selectedCount > 0 && !allSelected;

  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = mixed;
  }, [mixed]);

  const toggleVisible = (event: ChangeEvent<HTMLInputElement>): void => {
    const next = new Set(controller.deletion.selected);
    for (const row of registered) {
      if (row.kind !== "tag") continue;
      if (event.target.checked) next.add(row.tag.id);
      else next.delete(row.tag.id);
    }
    controller.deletion.setSelected(next);
  };

  return (
    <thead>
      <tr>
        <th scope="col" className="tags-cell-select">
          <input
            ref={checkboxRef}
            type="checkbox"
            aria-label="Select all registered tags on this page"
            checked={allSelected}
            disabled={!controller.canMutate || registered.length === 0}
            onChange={toggleVisible}
          />
        </th>
        <SortHeader field="name" label="Name" controller={controller} />
        <SortHeader
          field="subscribers"
          label="Subscribers"
          controller={controller}
        />
        <SortHeader field="created" label="Created" controller={controller} />
        <th scope="col" className="tags-cell-actions">
          <span className="visually-hidden">Actions</span>
        </th>
      </tr>
    </thead>
  );
}

function SortHeader({
  field,
  label,
  controller,
}: {
  field: TagSortField;
  label: string;
  controller: TagsPageController;
}): ReactElement {
  const active = controller.sortField === field;
  const direction = active ? controller.sortDirection : "asc";
  return (
    <th
      scope="col"
      aria-sort={
        active ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        className="tags-sort-button"
        onClick={() =>
          controller.setSort(
            field,
            active && direction === "asc" ? "desc" : "asc",
          )
        }
      >
        {label}
        <span aria-hidden="true">
          {active ? (direction === "asc" ? " ↑" : " ↓") : " ↕"}
        </span>
      </button>
    </th>
  );
}

function TagCatalogBody({
  controller,
}: {
  controller: TagsPageController;
}): ReactElement {
  if (controller.catalog.loading && controller.catalog.rows === null) {
    return (
      <tr>
        <td colSpan={5} className="tags-loading-cell">
          <span className="visually-hidden">Loading tags</span>
          {[0, 1, 2, 3, 4].map((index) => (
            <span key={index} className="skel-row" aria-hidden="true" />
          ))}
        </td>
      </tr>
    );
  }
  if (controller.pageRows.length === 0) {
    const constraints = [
      controller.query ? `search “${controller.query}”` : null,
      controller.colorFilter !== "all"
        ? `colour ${controller.colorFilter}`
        : null,
    ].filter(Boolean);
    return (
      <tr>
        <td colSpan={5} className="tags-empty-cell">
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true">
              ·
            </div>
            <h3>No tags match this view</h3>
            <p>
              {constraints.length > 0
                ? `Active constraints: ${constraints.join(" and ")}.`
                : "There are no rows on this page."}
            </p>
            <button
              type="button"
              className="btn"
              onClick={controller.resetView}
            >
              Reset all constraints
            </button>
          </div>
        </td>
      </tr>
    );
  }
  return <TagCatalogRows controller={controller} />;
}

function TagPagination({
  controller,
}: {
  controller: TagsPageController;
}): ReactElement {
  return (
    <nav
      className="pagination tags-pagination"
      aria-label="Tag catalogue pages"
    >
      <button
        type="button"
        className="btn btn-sm"
        disabled={controller.page <= 1}
        onClick={() => controller.setPage((page) => Math.max(1, page - 1))}
      >
        Previous
      </button>
      <span aria-live="polite">
        Page {controller.page} of {controller.totalPages}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={controller.page >= controller.totalPages}
        onClick={() =>
          controller.setPage((page) =>
            Math.min(controller.totalPages, page + 1),
          )
        }
      >
        Next
      </button>
    </nav>
  );
}

function TagCatalogueHero({
  controller,
}: {
  controller: TagsPageController;
}): ReactElement {
  return (
    <HeroEmptyState
      tone="mint"
      eyebrow="Audience"
      title="Label subscribers so segments write themselves."
      subtitle="Tags are the building blocks of every segment, sequence trigger, and personalization rule."
      primaryCta={
        controller.canMutate
          ? { label: "New tag", onClick: controller.create.openCreate }
          : undefined
      }
      imageSrc={HERO.tags}
      imageAlt="Color-coded paper tags with teal twine"
    />
  );
}
