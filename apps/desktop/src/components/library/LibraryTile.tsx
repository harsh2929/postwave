/**
 * One asset in the native Library card collection.
 *
 * The primary button owns selection/open keyboard behavior. Preview, Copy and
 * Delete are real sibling buttons, never nested interactive descendants. Only
 * the active card's controls participate in Tab order; Arrow/Home/End move the
 * roving primary focus between cards.
 */

import { type ReactElement } from "react";

import { type Asset } from "../../lib/api-client";
import { asCount, asNonEmptyString, fmtBytes } from "../../lib/library-filters";
import { AssetThumb } from "./AssetThumb";

interface Props {
  asset: Asset;
  selected: boolean;
  focused: boolean;
  tabStop: boolean;
  onFocus: () => void;
  onActivate: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onPreview: () => void;
  onCopyUrl?: () => void;
  onDelete?: () => void;
}

export function LibraryTile({
  asset,
  selected,
  focused,
  tabStop,
  onFocus,
  onActivate,
  onDoubleClick,
  onKeyDown,
  onPreview,
  onCopyUrl,
  onDelete,
}: Props): ReactElement {
  const refs = asCount(asset.referencesCount);
  const altText = asNonEmptyString(asset.altText, asset.filename);
  const actionTabIndex = tabStop ? 0 : -1;
  const classes = ["lib-tile"];
  if (selected) classes.push("is-selected");
  if (focused) classes.push("is-focused");

  return (
    <li className={classes.join(" ")} data-asset-id={asset.id}>
      <button
        type="button"
        className="lib-tile-target"
        data-library-primary={asset.id}
        tabIndex={tabStop ? 0 : -1}
        aria-pressed={selected}
        aria-label={`${asset.filename}. ${selected ? "Selected" : "Not selected"}. Enter previews; Space toggles selection.`}
        onFocus={onFocus}
        onClick={onActivate}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
      >
        {selected ? (
          <span className="lib-tile-badge" aria-hidden="true">
            ✓
          </span>
        ) : null}
        <span className="lib-tile-thumb">
          <AssetThumb
            url={asset.url}
            alt={altText}
            mime={asset.mime}
            loading="lazy"
            draggable
            fallback={
              <span className="asset-thumb-broken">Image unavailable</span>
            }
          />
        </span>
        <span className="lib-tile-meta">
          <span className="lib-tile-name">{asset.filename}</span>
          <span className="lib-tile-sub">
            <span>{fmtBytes(asset.bytes)}</span>
            {refs > 0 ? (
              <span className="lib-tile-used">Used in {refs}</span>
            ) : (
              <span className="lib-tile-unused">No reported use</span>
            )}
          </span>
        </span>
      </button>
      <div
        className="lib-tile-actions"
        role="group"
        aria-label={`Actions for ${asset.filename}`}
      >
        <LibraryTileAction
          label={`Preview ${asset.filename}`}
          text="Preview"
          tabIndex={actionTabIndex}
          onClick={onPreview}
        />
        {onCopyUrl ? (
          <LibraryTileAction
            label={`Copy URL for ${asset.filename}`}
            text="Copy URL"
            tabIndex={actionTabIndex}
            onClick={onCopyUrl}
          />
        ) : null}
        {onDelete ? (
          <LibraryTileAction
            label={`Delete ${asset.filename}`}
            text="Delete"
            tabIndex={actionTabIndex}
            danger
            onClick={onDelete}
          />
        ) : null}
      </div>
    </li>
  );
}

function LibraryTileAction({
  label,
  text,
  tabIndex,
  danger,
  onClick,
}: {
  label: string;
  text: string;
  tabIndex: number;
  danger?: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={`lib-tile-action${danger ? " danger" : ""}`}
      tabIndex={tabIndex}
      aria-label={label}
      onClick={onClick}
    >
      {text}
    </button>
  );
}
