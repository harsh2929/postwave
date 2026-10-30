import { type ReactElement, useState } from "react";

import type {
  AssetFilter,
  AssetFolder,
  AssetReferrer,
  AssetTagCount,
} from "../../lib/api-client";
import { asNonEmptyString } from "../../lib/library-filters";
import { HERO } from "../../lib/heroAssets";
import { HeroEmptyState } from "../HeroEmptyState";
import { Modal, ModalFooter } from "../Modal";

export function LibraryFolderFilters({
  active,
  folders,
  canMutate,
  onChange,
  onCreate,
  onRename,
  onDelete,
}: {
  active: string;
  folders: AssetFolder[];
  canMutate: boolean;
  onChange: (folder: string) => void;
  onCreate: () => void;
  onRename: (folder: AssetFolder) => void;
  onDelete: (folder: AssetFolder) => void;
}): ReactElement | null {
  if (!canMutate && folders.length === 0) return null;
  const selectedFolder = folders.find((folder) => folder.id === active) ?? null;
  return (
    <div className="lib-taxonomy-row">
      <span className="lib-taxonomy-label" aria-hidden="true">
        Folders
      </span>
      <div className="lib-taxonomy-content">
        <div className="chips" role="group" aria-label="Filter by folder">
          <button
            type="button"
            className={`chip${active === "" ? " is-active" : ""}`}
            onClick={() => onChange("")}
            aria-pressed={active === ""}
            aria-label="All folders, show every filed and unfiled asset"
          >
            All
          </button>
          <button
            type="button"
            className={`chip${active === "root" ? " is-active" : ""}`}
            onClick={() => onChange(active === "root" ? "" : "root")}
            aria-pressed={active === "root"}
            aria-label="Uncategorised, show only assets not filed in a folder"
          >
            Uncategorised
          </button>
          {folders.map((folder) => {
            const selected = active === folder.id;
            return (
              <button
                key={folder.id}
                type="button"
                className={`chip${selected ? " is-active" : ""}`}
                onClick={() => onChange(selected ? "" : folder.id)}
                aria-pressed={selected}
                aria-label={`${folder.name}, ${folder.assetCount} asset${folder.assetCount === 1 ? "" : "s"}`}
              >
                {folder.name}
                <span className="tpl-tab-count">{folder.assetCount}</span>
              </button>
            );
          })}
          {canMutate ? (
            <button
              type="button"
              className="chip lib-new-folder-chip"
              onClick={onCreate}
            >
              + New folder
            </button>
          ) : null}
        </div>
        {canMutate && selectedFolder ? (
          <div
            className="lib-folder-actions"
            role="group"
            aria-label={`${selectedFolder.name} folder actions`}
          >
            <span
              className="lib-folder-actions-context"
              title={selectedFolder.name}
            >
              Managing <strong>{selectedFolder.name}</strong>
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onRename(selectedFolder)}
              aria-label={`Rename folder ${selectedFolder.name}`}
            >
              Rename
            </button>
            <button
              type="button"
              className="btn btn-sm lib-folder-delete"
              onClick={() => onDelete(selectedFolder)}
              aria-label={`Delete folder ${selectedFolder.name}`}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function LibraryTagFilters({
  active,
  tags,
  onChange,
}: {
  active: string;
  tags: AssetTagCount[];
  onChange: (tag: string) => void;
}): ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  if (tags.length === 0) return null;
  const preview = tags.slice(0, 24);
  const activeBeyondPreview = tags
    .slice(24)
    .find((entry) => entry.tag === active);
  const visibleTags = expanded
    ? tags
    : activeBeyondPreview
      ? [...preview, activeBeyondPreview]
      : preview;
  return (
    <div className="lib-taxonomy-row">
      <span className="lib-taxonomy-label" aria-hidden="true">
        Tags
      </span>
      <div className="chips" role="group" aria-label="Filter by tag">
        <button
          type="button"
          className={`chip${active === "" ? " is-active" : ""}`}
          onClick={() => onChange("")}
          aria-pressed={active === ""}
          aria-label="All tags, show assets regardless of tag"
        >
          All
        </button>
        {visibleTags.map((entry) => {
          const selected = active === entry.tag;
          return (
            <button
              key={entry.tag}
              type="button"
              className={`chip${selected ? " is-active" : ""}`}
              onClick={() => onChange(selected ? "" : entry.tag)}
              aria-pressed={selected}
              aria-label={`${entry.tag}, ${entry.count} tagged asset${entry.count === 1 ? "" : "s"}`}
            >
              {entry.tag}
              <span className="tpl-tab-count">{entry.count}</span>
            </button>
          );
        })}
        {tags.length > 24 ? (
          <span className="lib-taxonomy-overflow">
            <span className="muted small" role="status" aria-live="polite">
              {expanded
                ? `Showing all ${tags.length} loaded tags.`
                : `Showing ${preview.length} of ${tags.length} loaded tags${activeBeyondPreview ? "; the active tag is also kept visible" : ""}.`}
            </span>
            <button
              type="button"
              className="btn btn-sm lib-taxonomy-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? "Show fewer tags" : `Show all ${tags.length} tags`}
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function LibraryEmptyState({
  query,
  filter,
  hasAdditionalFilters,
  canUpload,
  onUpload,
  onResetFilters,
}: {
  query: string;
  filter: AssetFilter;
  hasAdditionalFilters: boolean;
  canUpload: boolean;
  onUpload: () => void;
  onResetFilters: () => void;
}): ReactElement {
  const filtered = query.length > 0 || filter !== "all" || hasAdditionalFilters;
  if (filtered) {
    return (
      <div className="list-empty">
        <div className="empty-state">
          <div className="empty-state-icon">·</div>
          <h3>Nothing matches</h3>
          <p>Try clearing the search, smart filter, folder, or tag.</p>
          <button type="button" className="btn" onClick={onResetFilters}>
            Clear all filters
          </button>
        </div>
      </div>
    );
  }
  return (
    <HeroEmptyState
      tone="blush"
      eyebrow="Library"
      title="Your image library, ready when the editor calls."
      subtitle="Add PNG, JPEG, GIF, or WebP images up to 10 MiB for reuse across your workspace."
      primaryCta={
        canUpload ? { label: "Upload", onClick: onUpload } : undefined
      }
      imageSrc={HERO.assets}
      imageAlt="A grid of nine abstract photographs"
    />
  );
}

export function DeleteAssetConfirmModal({
  confirm,
  onClose,
  onConfirm,
}: {
  confirm: { ids: string[]; usage: AssetReferrer[] } | null;
  onClose: () => void;
  onConfirm: (ids: string[]) => void;
}): ReactElement {
  return (
    <Modal
      open={!!confirm}
      onClose={onClose}
      title="Delete despite usage?"
      description={
        confirm
          ? `${confirm.usage.length} campaign, template, or form record${confirm.usage.length === 1 ? "" : "s"} report a reference to this asset.`
          : ""
      }
    >
      {confirm ? (
        <>
          <p className="muted small">
            This removes the asset from the Library but does not repair the
            reported references. Current or previously delivered content may
            continue loading the remote object only while this deployment
            retains it; a later purge can break those images. Review every use
            before continuing.
          </p>
          <div className="lib-delete-usage-list">
            {confirm.usage.slice(0, 50).map((referrer) => (
              <div
                key={`${referrer.kind}-${referrer.id}`}
                className="lib-quicklook-usage-row"
              >
                <span className="lib-quicklook-usage-kind">
                  {referrer.kind}
                </span>
                <span>{asNonEmptyString(referrer.name, "(unnamed)")}</span>
              </div>
            ))}
            {confirm.usage.length > 50 ? (
              <div className="muted small">
                +{confirm.usage.length - 50} more…
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      <ModalFooter>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        {confirm ? (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => onConfirm(confirm.ids)}
          >
            Delete anyway
          </button>
        ) : null}
      </ModalFooter>
    </Modal>
  );
}
