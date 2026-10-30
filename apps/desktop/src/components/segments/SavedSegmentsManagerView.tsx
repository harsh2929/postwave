import { type DragEvent, type FormEvent, type ReactElement } from "react";

import { type SavedSegment } from "../../lib/api-client";
import { fmtRelative } from "../../lib/format-date";
import { ConfirmModal } from "../ConfirmModal";
import {
  type SavedSegmentsController,
  UNFILED,
} from "./useSavedSegmentsController";

const ROW_GRID = "110px 1.4fr 130px 150px 150px";
const WRITE_GUIDANCE_ID = "saved-segments-write-guidance";
const FOLDER_GUIDANCE_ID = "saved-segments-folder-guidance";
const NEW_FOLDER_GUIDANCE_ID = "saved-segments-new-folder-guidance";

export function SavedSegmentsManagerView({
  controller,
}: {
  controller: SavedSegmentsController;
}): ReactElement {
  return (
    <section
      className="card"
      style={{ padding: 16, marginTop: 16 }}
      aria-busy={controller.loading}
    >
      <ManagerHeader controller={controller} />
      {!controller.canMutate ? (
        <div
          id={WRITE_GUIDANCE_ID}
          className="muted"
          role="status"
          style={{ fontSize: 11, marginTop: 8 }}
        >
          Viewer access is read-only. You can review, count, and use saved
          segments, but you can&apos;t reorganize or change them.
        </div>
      ) : null}
      <FolderStrip controller={controller} />
      {controller.folderError ? (
        <div id={FOLDER_GUIDANCE_ID} className="notice" role="alert">
          <span>
            Folder organization is unavailable: {controller.folderError}.
            Pinning, sharing, and counts are still available.
          </span>
        </div>
      ) : controller.canMutate && !controller.folderControlsEnabled ? (
        <div
          id={FOLDER_GUIDANCE_ID}
          className="muted"
          role="status"
          style={{ fontSize: 11, marginTop: 8 }}
        >
          Folder controls are unavailable until saved-segment folders finish
          loading.
        </div>
      ) : null}
      {controller.error ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load saved segments: {controller.error}</span>
        </div>
      ) : null}
      <SegmentsContent controller={controller} />
      <FolderModals controller={controller} />
    </section>
  );
}

function ManagerHeader({
  controller,
}: {
  controller: SavedSegmentsController;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        marginBottom: 4,
      }}
    >
      <div>
        <div className="section-title">Saved segment bookmarks</div>
        <div className="muted" style={{ fontSize: 11 }}>
          Pin, share, and file the saved segments used by broadcasts, sequences,
          and routines.
        </div>
      </div>
      <span className="spacer" style={{ flex: 1 }} />
      <button
        type="button"
        className="btn btn-sm"
        onClick={controller.refresh}
        disabled={controller.loading}
      >
        {controller.loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

function FolderStrip({
  controller,
}: {
  controller: SavedSegmentsController;
}): ReactElement {
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (
      !controller.folderControlsEnabled ||
      controller.creatingFolder ||
      !controller.newFolderName.trim()
    ) {
      return;
    }
    void controller.createFolder();
  };
  const folderUnavailableReasonId = controller.folderControlsEnabled
    ? undefined
    : controller.canMutate
      ? FOLDER_GUIDANCE_ID
      : WRITE_GUIDANCE_ID;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
        margin: "10px 0",
      }}
    >
      <form
        onSubmit={submit}
        style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
      >
        <input
          className="input"
          style={{ width: 200, maxWidth: "100%", fontSize: 12 }}
          placeholder="New folder name…"
          aria-label="New folder name"
          aria-disabled={!controller.folderControlsEnabled || undefined}
          aria-describedby={folderUnavailableReasonId ?? NEW_FOLDER_GUIDANCE_ID}
          value={controller.newFolderName}
          readOnly={!controller.folderControlsEnabled}
          disabled={controller.creatingFolder}
          onChange={(event) => {
            if (controller.folderControlsEnabled) {
              controller.setNewFolderName(event.target.value);
            }
          }}
        />
        <button
          type="submit"
          className="btn btn-sm"
          disabled={controller.creatingFolder}
          aria-disabled={
            !controller.folderControlsEnabled ||
            !controller.newFolderName.trim()
          }
          aria-describedby={folderUnavailableReasonId ?? NEW_FOLDER_GUIDANCE_ID}
        >
          {controller.creatingFolder ? "Creating…" : "Add folder"}
        </button>
        <span
          id={NEW_FOLDER_GUIDANCE_ID}
          className="muted"
          style={{ flexBasis: "100%", fontSize: 11 }}
        >
          Enter a folder name, then choose Add folder.
        </span>
      </form>
      <div
        className="chips"
        style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
      >
        {controller.folders.map((folder) => (
          <span
            key={folder.id}
            className="badge"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            {folder.name}
            {controller.folderControlsEnabled ? (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  style={{ padding: "0 2px", fontSize: 10 }}
                  aria-label={`Rename folder ${folder.name}`}
                  onClick={() => controller.startRename(folder)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  style={{ padding: "0 2px", fontSize: 10 }}
                  aria-label={`Delete folder ${folder.name}`}
                  onClick={() => controller.startDelete(folder)}
                >
                  Delete
                </button>
              </>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function SegmentsContent({
  controller,
}: {
  controller: SavedSegmentsController;
}): ReactElement | null {
  if (controller.loading && controller.segments === null) {
    return (
      <div style={{ padding: 8 }} role="status" aria-label="Loading segments">
        {[0, 1, 2].map((index) => (
          <div key={index} className="skel-row" />
        ))}
      </div>
    );
  }
  if (controller.error && controller.segments === null) return null;
  if (controller.total === 0) {
    return (
      <div className="muted" style={{ fontSize: 12, padding: "8px 0" }}>
        No saved segments yet. Save one from the segment builder, then pin or
        file it here.
      </div>
    );
  }
  return <SegmentList controller={controller} />;
}

function SegmentList({
  controller,
}: {
  controller: SavedSegmentsController;
}): ReactElement {
  return (
    <div className="list">
      <div className="list-header" style={{ gridTemplateColumns: ROW_GRID }}>
        <div>Actions</div>
        <div>Name</div>
        <div>Members</div>
        <div>Sharing</div>
        <div>Folder</div>
      </div>
      {controller.pinned.length > 0 ? (
        <>
          <GroupLabel>
            {controller.canMutate
              ? "Pinned · drag or use arrow keys to reorder"
              : "Pinned"}
          </GroupLabel>
          {controller.pinned.map((segment, index) => (
            <SavedSegmentRow
              key={segment.id}
              controller={controller}
              segment={segment}
              draggable
              reorderIndex={index}
            />
          ))}
        </>
      ) : null}
      {controller.groups.map((group) => (
        <div key={group.key}>
          <GroupLabel>{group.label}</GroupLabel>
          {group.rows.map((segment) => (
            <SavedSegmentRow
              key={segment.id}
              controller={controller}
              segment={segment}
              draggable={false}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function GroupLabel({ children }: { children: string }): ReactElement {
  return (
    <div
      className="muted"
      style={{
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        padding: "8px 8px 2px",
      }}
    >
      {children}
    </div>
  );
}

function SavedSegmentRow({
  controller,
  segment,
  draggable,
  reorderIndex,
}: {
  controller: SavedSegmentsController;
  segment: SavedSegment;
  draggable: boolean;
  reorderIndex?: number;
}): ReactElement {
  const busy = controller.busyIds.has(segment.id);
  const writeUnavailable = !controller.canMutate;
  const folderUnavailable = !controller.folderControlsEnabled;
  return (
    <div
      className="list-row"
      style={{
        gridTemplateColumns: ROW_GRID,
        alignItems: "center",
      }}
      role="group"
      aria-label={`Saved segment ${segment.name || "Unnamed"}`}
    >
      <RowActions
        controller={controller}
        segment={segment}
        draggable={draggable}
        busy={busy}
        writeUnavailable={writeUnavailable}
        reorderIndex={reorderIndex}
      />
      <SegmentName segment={segment} />
      <CountBadge controller={controller} segment={segment} />
      <select
        className="input"
        style={{ fontSize: 11, padding: "2px 6px" }}
        aria-label={`Sharing for ${segment.name || "segment"}`}
        aria-disabled={writeUnavailable || undefined}
        aria-describedby={writeUnavailable ? WRITE_GUIDANCE_ID : undefined}
        value={segment.visibility_scope}
        disabled={busy}
        onPointerDown={(event) => {
          if (writeUnavailable) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (writeUnavailable) event.preventDefault();
        }}
        onChange={(event) => {
          if (!writeUnavailable) {
            void controller.setScope(segment, event.target.value);
          }
        }}
      >
        <option value="personal">Only me</option>
        <option value="workspace">Workspace</option>
      </select>
      <select
        className="input"
        style={{ fontSize: 11, padding: "2px 6px" }}
        aria-label={`Folder for ${segment.name || "segment"}`}
        aria-disabled={folderUnavailable || undefined}
        aria-describedby={
          folderUnavailable
            ? controller.canMutate
              ? FOLDER_GUIDANCE_ID
              : WRITE_GUIDANCE_ID
            : undefined
        }
        value={segment.folder_id ?? UNFILED}
        disabled={busy}
        onPointerDown={(event) => {
          if (folderUnavailable) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (folderUnavailable) event.preventDefault();
        }}
        onChange={(event) => {
          if (!folderUnavailable) {
            void controller.setFolder(segment, event.target.value);
          }
        }}
      >
        <option value={UNFILED}>Unfiled</option>
        {controller.folders.map((folder) => (
          <option key={folder.id} value={folder.id}>
            {folder.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function RowActions({
  controller,
  segment,
  draggable,
  busy,
  writeUnavailable,
  reorderIndex,
}: {
  controller: SavedSegmentsController;
  segment: SavedSegment;
  draggable: boolean;
  busy: boolean;
  writeUnavailable: boolean;
  reorderIndex?: number;
}): ReactElement {
  const reorderEnabled = draggable && controller.canMutate && !busy;
  const onDragStart = (event: DragEvent<HTMLButtonElement>): void => {
    controller.startDrag(segment.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", segment.id);
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        style={{
          padding: 4,
          color: segment.is_pinned ? "var(--pw-accent)" : "var(--pw-fg-muted)",
        }}
        aria-label={segment.is_pinned ? "Unpin segment" : "Pin segment"}
        aria-pressed={segment.is_pinned}
        aria-disabled={writeUnavailable || undefined}
        aria-describedby={writeUnavailable ? WRITE_GUIDANCE_ID : undefined}
        disabled={busy}
        onClick={() => {
          if (!writeUnavailable) void controller.togglePin(segment);
        }}
      >
        <PinIcon filled={segment.is_pinned} />
        <span>{segment.is_pinned ? "Unpin" : "Pin"}</span>
      </button>
      {draggable ? (
        <>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ padding: "0 3px", cursor: "grab" }}
            aria-label={`Drag ${segment.name || "segment"} to reorder`}
            aria-disabled={!reorderEnabled || undefined}
            aria-describedby={
              !controller.canMutate ? WRITE_GUIDANCE_ID : undefined
            }
            disabled={busy}
            draggable={reorderEnabled}
            onDragStart={onDragStart}
            onDragEnd={controller.endDrag}
            onDragOver={(event) => {
              if (reorderEnabled) event.preventDefault();
            }}
            onDrop={(event) => {
              if (!reorderEnabled) return;
              event.preventDefault();
              controller.dropOn(segment.id);
            }}
          >
            Drag
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ padding: "0 3px" }}
            aria-label={`Move ${segment.name || "segment"} up`}
            aria-disabled={!reorderEnabled || reorderIndex === 0 || undefined}
            aria-describedby={
              !controller.canMutate ? WRITE_GUIDANCE_ID : undefined
            }
            disabled={busy}
            onClick={() => {
              if (reorderEnabled && reorderIndex !== 0) {
                controller.movePinned(segment.id, -1);
              }
            }}
          >
            Up
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ padding: "0 3px" }}
            aria-label={`Move ${segment.name || "segment"} down`}
            aria-disabled={
              !reorderEnabled ||
              reorderIndex === controller.pinned.length - 1 ||
              undefined
            }
            aria-describedby={
              !controller.canMutate ? WRITE_GUIDANCE_ID : undefined
            }
            disabled={busy}
            onClick={() => {
              if (
                reorderEnabled &&
                reorderIndex !== controller.pinned.length - 1
              ) {
                controller.movePinned(segment.id, 1);
              }
            }}
          >
            Down
          </button>
        </>
      ) : null}
    </div>
  );
}

function SegmentName({ segment }: { segment: SavedSegment }): ReactElement {
  return (
    <div
      style={{
        overflowWrap: "anywhere",
        fontWeight: 500,
      }}
    >
      {segment.name || <em className="muted">Unnamed</em>}
      {segment.description ? (
        <div
          className="muted"
          style={{
            fontSize: 11,
            fontWeight: 400,
            overflowWrap: "anywhere",
          }}
        >
          {segment.description}
        </div>
      ) : null}
    </div>
  );
}

function CountBadge({
  controller,
  segment,
}: {
  controller: SavedSegmentsController;
  segment: SavedSegment;
}): ReactElement {
  const counting = controller.countingIds.has(segment.id);
  const hasCount = typeof segment.last_count === "number";
  const countLabel = counting
    ? "…"
    : hasCount
      ? segment.last_count!.toLocaleString()
      : "—";
  const memberWord =
    hasCount && segment.last_count === 1 ? "member" : "members";
  return (
    <button
      type="button"
      className="badge"
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 4,
        justifySelf: "start",
        cursor: counting ? "default" : "pointer",
        fontVariantNumeric: "tabular-nums",
        background: "transparent",
        border: "1px solid var(--pw-border)",
      }}
      aria-label={`Member count for ${segment.name || "segment"}${
        hasCount ? `: ${segment.last_count}` : ": not evaluated"
      }. Refresh.`}
      aria-busy={counting}
      disabled={counting}
      onClick={() => void controller.refreshCount(segment)}
    >
      <span style={{ fontWeight: 600 }} aria-live="polite">
        {counting
          ? "Refreshing…"
          : hasCount
            ? `${countLabel} ${memberWord}`
            : "Count members"}
      </span>
      {segment.last_evaluated_at && !counting ? (
        <span className="muted" style={{ fontSize: 10 }}>
          {fmtRelative(segment.last_evaluated_at)}
        </span>
      ) : null}
    </button>
  );
}

function FolderModals({
  controller,
}: {
  controller: SavedSegmentsController;
}): ReactElement {
  return (
    <>
      <ConfirmModal
        open={controller.renameTarget != null}
        title="Rename folder"
        description={
          controller.renameTarget
            ? `Rename "${controller.renameTarget.name}".`
            : ""
        }
        confirmLabel="Rename"
        busy={controller.renamingFolder}
        onClose={controller.closeRename}
        onConfirm={async () => {
          await controller.renameFolder();
        }}
      >
        <input
          className="input"
          aria-label="New folder name"
          value={controller.renameValue}
          disabled={controller.renamingFolder}
          onChange={(event) => controller.setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void controller.renameFolder();
          }}
        />
      </ConfirmModal>
      <ConfirmModal
        open={controller.renameDiscardConfirmOpen}
        title="Discard folder rename?"
        description="The changed saved-segment folder name will be lost."
        confirmLabel="Discard rename"
        danger
        busy={controller.renamingFolder}
        onClose={controller.closeRenameDiscard}
        onConfirm={controller.discardRenameDraft}
      />
      <ConfirmModal
        open={controller.deleteFolderTarget != null}
        title="Delete folder"
        description={
          controller.deleteFolderTarget
            ? `Delete folder "${controller.deleteFolderTarget.name}"? Its saved segments aren't deleted — they're just unfiled.`
            : ""
        }
        confirmLabel="Delete folder"
        danger
        busy={controller.deletingFolder}
        onClose={controller.closeDelete}
        onConfirm={controller.deleteFolder}
      />
    </>
  );
}

function PinIcon({ filled }: { filled: boolean }): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14l-1.5-3V8a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v6L5 17z" />
    </svg>
  );
}
