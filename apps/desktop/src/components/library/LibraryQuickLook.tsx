/**
 * LibraryQuickLook — centered preview modal for one asset.
 *
 * Apple Finder / Photos pattern: dimmed backdrop, image fills, metadata
 * below, prev/next nav between assets in the current visible list, alt
 * text editable inline. Esc closes; Cmd+C copies URL; ← / → navigate.
 *
 * Stateless w.r.t. the asset list — the page passes the current index
 * and the navigation callbacks.
 */

import {
  type Dispatch,
  type ReactElement,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type Asset,
  type AssetFolder,
  type AssetReferrer,
  apiSendTimeAssets as api,
} from "../../lib/api-client";
import {
  asCount,
  asNonEmptyString,
  fmtBytes,
  fmtDims,
  fmtRelDate,
} from "../../lib/library-filters";
import { writeClipboardText } from "../../lib/clipboard";
import { useCanWrite } from "../../lib/store";
import { tauriApi } from "../../lib/tauri";
import { useSlideoverBehavior } from "../../hooks/useSlideoverBehavior";
import {
  decodeAsset,
  decodeMutationReceipt,
  decodeVersionedTags,
  publicAssetDeliveryUrl,
} from "../../lib/asset-runtime";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { toast } from "../Toast";
import { AssetThumb } from "./AssetThumb";

interface Props {
  asset: Asset;
  usage: AssetReferrer[];
  usageState?: "idle" | "loading" | "ready" | "error";
  usageError?: string | null;
  /** index in the visible list, used for prev/next button enable */
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onAltTextChanged: (id: string, altText: string, version: number) => void;
  onRequestDelete: () => void;
  /** Workstream 4 (Mailchimp parity polish): called after the tag set
   *  changes (add/remove) so the parent can refetch the chip row. */
  onTagsChanged?: (id: string, tags: string[], version: number) => void;
  /** Mailchimp-parity follow-up: the workspace's folder list (so the
   *  "Move to folder…" dropdown can render every choice without
   *  fetching). Omit to hide the folder reassignment affordance. */
  folders?: AssetFolder[];
  /** Called after a successful move so the parent can update the
   *  cached row + refresh chip counts. `folderId` is null when the
   *  asset moved back to the Uncategorised bucket. */
  onFolderChanged?: (
    id: string,
    folderId: string | null,
    version: number,
  ) => void;
}

export function LibraryQuickLook(props: Props): ReactElement {
  const {
    asset,
    folders,
    index,
    onAltTextChanged,
    onClose,
    onFolderChanged,
    onNext,
    onPrev,
    onTagsChanged,
    total,
  } = props;
  const canMutate = useCanWrite();
  const displayUrl = publicAssetDeliveryUrl(asset.url);
  const initialAltText = asNonEmptyString(asset.altText, "");
  const [altDraft, setAltDraft] = useState(initialAltText);
  const [altBaseline, setAltBaseline] = useState(initialAltText);
  const [savingAlt, setSavingAlt] = useState(false);
  const [interactionStatus, setInteractionStatus] = useState("");
  const [gifPlaying, setGifPlaying] = useState(false);
  const altInputRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const restoreAltFocusRef = useRef(false);
  const restoreTagFocusRef = useRef(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Workstream 4 (Mailchimp parity polish): per-asset tag editor. The
  // initial set comes from the asset row when present; otherwise we
  // fetch on mount. Edits round-trip to the server immediately so
  // closing the modal doesn't drop pending changes.
  const [tags, setTags] = useState<string[]>(asset.tags ?? []);
  const [tagDraft, setTagDraft] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [currentVersion, setCurrentVersion] = useState(asset.version);
  const [tagLoadState, setTagLoadState] = useState<
    "ready" | "loading" | "error"
  >(asset.tags === undefined ? "loading" : "ready");
  const [tagLoadError, setTagLoadError] = useState<string | null>(null);
  const tagOperationRef = useRef<Promise<void> | null>(null);
  useEffect(() => {
    if (tagBusy || !restoreTagFocusRef.current) return;
    restoreTagFocusRef.current = false;
    tagInputRef.current?.focus();
  }, [tagBusy]);
  useEffect(() => {
    setTags(asset.tags ?? []);
    setTagDraft("");
    setTagLoadState(asset.tags === undefined ? "loading" : "ready");
    setTagLoadError(null);
  }, [asset.id, asset.tags]);
  useEffect(() => {
    if (asset.tags !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.getAssetTags(asset.id);
        if (cancelled) return;
        if (res.error) {
          setTagLoadState("error");
          setTagLoadError(res.error.message);
          return;
        }
        const decoded = decodeVersionedTags(res.data);
        if (!decoded.ok) {
          setTagLoadState("error");
          setTagLoadError(decoded.error);
          return;
        }
        setTags(decoded.value.tags);
        setCurrentVersion(decoded.value.version);
        setTagLoadState("ready");
      } catch (error) {
        if (!cancelled) {
          setTagLoadState("error");
          setTagLoadError(
            error instanceof Error ? error.message : "Tag request failed.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [asset.id, asset.tags]);

  const addTag = (): Promise<void> => {
    if (tagOperationRef.current) return tagOperationRef.current;
    const t = tagDraft.trim();
    if (!t) return Promise.resolve();
    setTagBusy(true);
    const operation = (async (): Promise<void> => {
      try {
        const res = await api.addAssetTag(asset.id, {
          tag: t,
          expected_version: currentVersion,
        });
        if (res.error) {
          toast.error(`Tag add failed: ${res.error.message}`);
          return;
        }
        const decoded = decodeVersionedTags(res.data);
        if (!decoded.ok) {
          toast.error(`Tag add failed: ${decoded.error}`);
          return;
        }
        const next = decoded.value.tags;
        setCurrentVersion(decoded.value.version);
        setTags(next);
        setTagDraft("");
        onTagsChanged?.(asset.id, next, decoded.value.version);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? `Tag add failed: ${error.message}`
            : "Tag add failed unexpectedly.",
        );
      } finally {
        setTagBusy(false);
      }
    })();
    tagOperationRef.current = operation;
    void operation.finally(() => {
      if (tagOperationRef.current === operation) tagOperationRef.current = null;
    });
    return operation;
  };
  // Mailchimp-parity follow-up: "Move to folder…" dropdown.
  // currentFolderId tracks the asset's folder state independently of
  // the prop so the select stays responsive while the network round
  // trips. Reset whenever the asset itself changes.
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(
    asset.folderId ?? null,
  );
  const [folderBusy, setFolderBusy] = useState(false);
  const folderOperationRef = useRef<Promise<void> | null>(null);
  const altOperationRef = useRef<Promise<void> | null>(null);
  const copyOperationRef = useRef<Promise<void> | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const altDirty = altDraft !== altBaseline;
  const draftDirty = altDirty || Boolean(tagDraft.trim());
  const busy = savingAlt || tagBusy || folderBusy || copyBusy;
  const requestClose = useCallback((): void => {
    if (
      busy ||
      tagOperationRef.current ||
      folderOperationRef.current ||
      altOperationRef.current ||
      copyOperationRef.current
    ) {
      return;
    }
    if (draftDirty && !window.confirm("Discard unsaved asset changes?")) return;
    onClose();
  }, [busy, draftDirty, onClose]);
  useSlideoverBehavior({
    open: true,
    onClose: requestClose,
    dialogRef,
    isolationRef: backdropRef,
    initialFocusRef: dialogRef,
    disableEscape: busy,
  });
  useEffect(() => {
    setCurrentFolderId(asset.folderId ?? null);
  }, [asset.id, asset.folderId]);
  useEffect(() => {
    if (!draftDirty && !busy) return;
    return registerLifecycleGuard({
      id: `asset-quick-look-${asset.id}`,
      label: "Asset Quick Look",
      inspect: () =>
        busy
          ? {
              level: "blocking",
              detail: "An asset update is still in progress.",
              canDiscard: false,
              canRecover: false,
            }
          : {
              level: "warning",
              detail: "This asset has unsaved field changes.",
            },
      discard: () => {
        setAltDraft(altBaseline);
        setTagDraft("");
      },
    });
  }, [altBaseline, draftDirty, asset.id, busy]);
  const moveToFolder = (next: string | null): Promise<void> => {
    if (folderOperationRef.current) return folderOperationRef.current;
    if (next === currentFolderId) return Promise.resolve();
    setFolderBusy(true);
    const operation = (async (): Promise<void> => {
      try {
        const res = await api.moveAssetToFolder(asset.id, next, currentVersion);
        if (res.error) {
          toast.error(`Move failed: ${res.error.message}`);
          return;
        }
        const acknowledgement = decodeMutationReceipt(res.data);
        if (!acknowledgement.ok) {
          toast.error(`Move failed: ${acknowledgement.error}`);
          return;
        }
        if (acknowledgement.value.id !== asset.id) {
          toast.error(
            "Move failed: the server acknowledged a different asset.",
          );
          return;
        }
        setCurrentVersion(acknowledgement.value.version);
        setCurrentFolderId(next);
        onFolderChanged?.(asset.id, next, acknowledgement.value.version);
        const name =
          next === null
            ? "Uncategorised"
            : (folders?.find((f) => f.id === next)?.name ?? "folder");
        toast.success(`Moved to ${name}`);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? `Move failed: ${error.message}`
            : "Move failed unexpectedly.",
        );
      } finally {
        setFolderBusy(false);
      }
    })();
    folderOperationRef.current = operation;
    void operation.finally(() => {
      if (folderOperationRef.current === operation) {
        folderOperationRef.current = null;
      }
    });
    return operation;
  };

  const removeTag = (tag: string): Promise<void> => {
    if (tagOperationRef.current) return tagOperationRef.current;
    setTagBusy(true);
    const operation = (async (): Promise<void> => {
      try {
        const res = await api.removeAssetTag(asset.id, tag, currentVersion);
        if (res.error) {
          toast.error(`Tag remove failed: ${res.error.message}`);
          return;
        }
        const acknowledgement = decodeMutationReceipt(res.data);
        if (!acknowledgement.ok) {
          toast.error(`Tag remove failed: ${acknowledgement.error}`);
          return;
        }
        if (acknowledgement.value.id !== asset.id) {
          toast.error(
            "Tag remove failed: the server acknowledged a different asset.",
          );
          return;
        }
        setCurrentVersion(acknowledgement.value.version);
        const next = tags.filter((candidate) => candidate !== tag);
        setTags(next);
        onTagsChanged?.(asset.id, next, acknowledgement.value.version);
        setInteractionStatus(
          `${tag} removed. ${next.length} tag${next.length === 1 ? "" : "s"} ${next.length === 1 ? "remains" : "remain"}.`,
        );
        restoreTagFocusRef.current = true;
      } catch (error) {
        toast.error(
          error instanceof Error
            ? `Tag remove failed: ${error.message}`
            : "Tag remove failed unexpectedly.",
        );
      } finally {
        setTagBusy(false);
      }
    })();
    tagOperationRef.current = operation;
    void operation.finally(() => {
      if (tagOperationRef.current === operation) tagOperationRef.current = null;
    });
    return operation;
  };

  // Each asset starts with a fresh, explicit edit baseline and a paused
  // animation. A GIF never begins moving merely because the user navigated.
  useEffect(() => {
    const nextAltText = asNonEmptyString(asset.altText, "");
    setAltDraft(nextAltText);
    setAltBaseline(nextAltText);
    setInteractionStatus("");
    setGifPlaying(false);
  }, [asset.id, asset.altText]);
  useEffect(() => {
    setCurrentVersion(asset.version);
  }, [asset.id, asset.version]);

  const copyUrl = useCallback(async (): Promise<void> => {
    if (copyOperationRef.current) return copyOperationRef.current;
    if (!displayUrl) {
      toast.error("Asset URL failed safety checks.");
      return;
    }
    setCopyBusy(true);
    const operation = (async (): Promise<void> => {
      const result = await writeClipboardText(displayUrl, {
        contentClass: "public",
        label: "Asset URL",
      });
      if (result.ok) toast.success("URL copied");
      else toast.error(result.message);
    })();
    copyOperationRef.current = operation;
    try {
      await operation;
    } finally {
      if (copyOperationRef.current === operation)
        copyOperationRef.current = null;
      setCopyBusy(false);
    }
  }, [displayUrl]);

  // Quick Look shortcuts only apply while this dialog owns focus. Text-entry
  // controls keep native arrows and copy; a nested confirmation owns focus and
  // therefore suspends navigation without a second dialog-stack subscription.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      const dialog = dialogRef.current;
      if (!dialog?.contains(document.activeElement)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      if (!busy && !draftDirty && event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        onPrev();
      } else if (
        !busy &&
        !draftDirty &&
        event.key === "ArrowRight" &&
        index < total - 1
      ) {
        event.preventDefault();
        onNext();
      } else if (
        (event.key === "c" || event.key === "C") &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        void copyUrl();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, copyUrl, draftDirty, index, onNext, onPrev, total]);

  const openInBrowser = async (): Promise<void> => {
    if (!displayUrl) return;
    try {
      await tauriApi.openUrl(displayUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open URL");
    }
  };

  const saveAltText = (): Promise<void> => {
    if (altOperationRef.current) return altOperationRef.current;
    if (altDraft === altBaseline) return Promise.resolve();
    const draftToSave = altDraft;
    setSavingAlt(true);
    const operation = (async (): Promise<void> => {
      try {
        const res = await api.patchAsset(asset.id, {
          alt_text: draftToSave,
          expected_version: currentVersion,
        });
        if (res.error) {
          toast.error(`Alt text save failed: ${res.error.message}`);
          return;
        }
        const decoded = decodeAsset(res.data);
        if (
          !decoded.ok ||
          decoded.value.id !== asset.id ||
          decoded.value.altText !== draftToSave
        ) {
          const detail = !decoded.ok
            ? decoded.error
            : decoded.value.id !== asset.id
              ? "asset id did not match"
              : "returned alt text did not match";
          toast.error(`Alt text save failed: ${detail}`);
          return;
        }
        toast.success("Alt text saved");
        setCurrentVersion(decoded.value.version);
        setAltBaseline(draftToSave);
        setInteractionStatus("Alt text saved.");
        onAltTextChanged(asset.id, draftToSave, decoded.value.version);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? `Alt text save failed: ${error.message}`
            : "Alt text save failed unexpectedly.",
        );
      } finally {
        restoreAltFocusRef.current = true;
        setSavingAlt(false);
      }
    })();
    altOperationRef.current = operation;
    void operation.finally(() => {
      if (altOperationRef.current === operation) altOperationRef.current = null;
    });
    return operation;
  };

  useEffect(() => {
    if (savingAlt || !restoreAltFocusRef.current) return;
    restoreAltFocusRef.current = false;
    altInputRef.current?.focus();
  }, [savingAlt]);

  const cancelAltText = (): void => {
    setAltDraft(altBaseline);
    setInteractionStatus("Alt text changes cancelled.");
    altInputRef.current?.focus();
  };

  return (
    <LibraryQuickLookView
      {...props}
      addTag={addTag}
      altDraft={altDraft}
      altInputRef={altInputRef}
      tagInputRef={tagInputRef}
      backdropRef={backdropRef}
      busy={busy}
      altDirty={altDirty}
      draftDirty={draftDirty}
      canMutate={canMutate}
      copyUrl={copyUrl}
      copyBusy={copyBusy}
      cancelAltText={cancelAltText}
      currentFolderId={currentFolderId}
      dialogRef={dialogRef}
      displayUrl={displayUrl}
      folderBusy={folderBusy}
      gifPlaying={gifPlaying}
      interactionStatus={interactionStatus}
      moveToFolder={moveToFolder}
      onClose={requestClose}
      openInBrowser={openInBrowser}
      removeTag={removeTag}
      saveAltText={saveAltText}
      savingAlt={savingAlt}
      setAltDraft={setAltDraft}
      setGifPlaying={setGifPlaying}
      setTagDraft={setTagDraft}
      tagBusy={tagBusy}
      tagLoadError={tagLoadError}
      tagLoadState={tagLoadState}
      tagDraft={tagDraft}
      tags={tags}
      titleId={titleId}
    />
  );
}

type LibraryQuickLookViewProps = Props & {
  addTag: () => Promise<void>;
  altDraft: string;
  altDirty: boolean;
  draftDirty: boolean;
  altInputRef: RefObject<HTMLInputElement | null>;
  tagInputRef: RefObject<HTMLInputElement | null>;
  backdropRef: RefObject<HTMLDivElement | null>;
  busy: boolean;
  canMutate: boolean;
  cancelAltText: () => void;
  copyUrl: () => Promise<void>;
  copyBusy: boolean;
  currentFolderId: string | null;
  dialogRef: RefObject<HTMLDivElement | null>;
  displayUrl: string | null;
  folderBusy: boolean;
  gifPlaying: boolean;
  interactionStatus: string;
  moveToFolder: (next: string | null) => Promise<void>;
  openInBrowser: () => Promise<void>;
  removeTag: (tag: string) => Promise<void>;
  saveAltText: () => Promise<void>;
  savingAlt: boolean;
  setAltDraft: Dispatch<SetStateAction<string>>;
  setGifPlaying: Dispatch<SetStateAction<boolean>>;
  setTagDraft: Dispatch<SetStateAction<string>>;
  tagBusy: boolean;
  tagLoadError: string | null;
  tagLoadState: "ready" | "loading" | "error";
  tagDraft: string;
  tags: string[];
  titleId: string;
};

function LibraryQuickLookView({
  addTag,
  altDraft,
  altDirty,
  draftDirty,
  altInputRef,
  tagInputRef,
  asset,
  backdropRef,
  busy,
  canMutate,
  cancelAltText,
  copyUrl,
  copyBusy,
  currentFolderId,
  dialogRef,
  displayUrl,
  folderBusy,
  folders,
  gifPlaying,
  index,
  interactionStatus,
  moveToFolder,
  onClose,
  onNext,
  onPrev,
  onRequestDelete,
  openInBrowser,
  removeTag,
  saveAltText,
  savingAlt,
  setAltDraft,
  setGifPlaying,
  setTagDraft,
  tagBusy,
  tagLoadError,
  tagLoadState,
  tagDraft,
  tags,
  titleId,
  total,
  usage,
  usageError,
  usageState = "ready",
}: LibraryQuickLookViewProps): ReactElement {
  const positionId = `${titleId}-position`;
  const statusId = `${titleId}-status`;
  const altHelpId = `${titleId}-alt-help`;
  const isAnimatedGif =
    asset.mime.split(";", 1)[0]?.trim().toLowerCase() === "image/gif";

  return (
    <div
      ref={backdropRef}
      className="lib-quicklook-backdrop"
      role="presentation"
      onClick={(e) => {
        // A completed click is the close boundary. Pointer-down would dismiss
        // on touch-scroll and before pointer cancellation can be observed.
        if (!busy && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="lib-quicklook"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={positionId}
        aria-busy={busy ? "true" : undefined}
        tabIndex={-1}
      >
        <p
          id={positionId}
          className="visually-hidden"
          aria-live="polite"
          aria-atomic="true"
        >
          Asset {index + 1} of {total}: {asset.filename}
        </p>
        <p
          id={statusId}
          className="visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {interactionStatus}
        </p>
        <button
          type="button"
          className="lib-quicklook-close"
          aria-label="Close (Esc)"
          onClick={onClose}
          disabled={busy}
        >
          ✕
        </button>
        <div
          className="lib-quicklook-scroll"
          role="region"
          aria-label="Asset preview and details"
        >
          <div className="lib-quicklook-img">
            {total > 1 ? (
              <>
                <button
                  type="button"
                  className="lib-quicklook-nav prev"
                  aria-label="Previous asset (←)"
                  onClick={() => {
                    if (!busy && !draftDirty) onPrev();
                  }}
                  disabled={busy || draftDirty || index <= 0}
                  style={{
                    opacity: busy || draftDirty || index <= 0 ? 0.4 : 1,
                  }}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="lib-quicklook-nav next"
                  aria-label="Next asset (→)"
                  onClick={() => {
                    if (!busy && !draftDirty) onNext();
                  }}
                  disabled={busy || draftDirty || index >= total - 1}
                  style={{
                    opacity: busy || draftDirty || index >= total - 1 ? 0.4 : 1,
                  }}
                >
                  ›
                </button>
              </>
            ) : null}
            {isAnimatedGif && !gifPlaying ? (
              <div
                className="lib-quicklook-motion-pause"
                role="group"
                aria-label={`Animated image preview for ${asNonEmptyString(asset.altText, asset.filename)}`}
              >
                <span className="lib-quicklook-motion-icon" aria-hidden="true">
                  GIF
                </span>
                <strong>Animated image paused</strong>
                <span>Play it only when you are ready for motion.</span>
                <button
                  type="button"
                  className="btn lib-quicklook-motion-button"
                  onClick={() => setGifPlaying(true)}
                >
                  Play animation
                </button>
              </div>
            ) : (
              <>
                <AssetThumb
                  url={asset.url}
                  alt={asNonEmptyString(asset.altText, asset.filename)}
                  mime={asset.mime}
                  allowAnimation={isAnimatedGif && gifPlaying}
                  fallback={
                    <span className="asset-thumb-broken">
                      Image unavailable
                    </span>
                  }
                />
                {isAnimatedGif ? (
                  <button
                    type="button"
                    className="btn lib-quicklook-motion-stop"
                    onClick={() => setGifPlaying(false)}
                  >
                    Stop animation
                  </button>
                ) : null}
              </>
            )}
          </div>

          <div className="lib-quicklook-meta">
            <div className="lib-quicklook-meta-row">
              <span id={titleId} className="lib-quicklook-meta-name">
                {asset.filename}
              </span>
              <span className="lib-quicklook-meta-fact">
                {fmtBytes(asset.bytes)}
              </span>
              <span className="lib-quicklook-meta-fact">
                {fmtDims(asset.width, asset.height)}
              </span>
              <span className="lib-quicklook-meta-fact">
                Uploaded {fmtRelDate(asset.createdAt)}
              </span>
              {asCount(asset.referencesCount) > 0 ? (
                <span className="lib-tile-used">
                  Used in {asCount(asset.referencesCount)}
                </span>
              ) : null}
            </div>

            <div className="lib-quicklook-alt">
              <label htmlFor={`alt-${asset.id}`}>
                Alt text (for accessibility)
              </label>
              <input
                id={`alt-${asset.id}`}
                ref={altInputRef}
                type="text"
                className="input"
                maxLength={1024}
                value={altDraft}
                onChange={(e) => setAltDraft(e.target.value)}
                placeholder={`Describe the image (e.g. "Spring sale hero — assorted produce")`}
                disabled={!canMutate || savingAlt}
                aria-describedby={altHelpId}
              />
              <span id={altHelpId} className="lib-quicklook-field-hint">
                {altDirty
                  ? "Unsaved. Choose Save alt text or Cancel changes. Leaving this field does not save."
                  : "Changes are saved only when you choose Save alt text."}
              </span>
              {canMutate && altDirty ? (
                <div className="row lib-quicklook-edit-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void saveAltText()}
                    disabled={savingAlt}
                  >
                    {savingAlt ? "Saving…" : "Save alt text"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={cancelAltText}
                    disabled={savingAlt}
                  >
                    Cancel changes
                  </button>
                </div>
              ) : null}
            </div>

            {/* Workstream 4 (Mailchimp parity polish): tag editor. */}
            <div className="lib-quicklook-alt">
              <label htmlFor={`tag-${asset.id}`}>Tags</label>
              <div
                className="chips"
                style={{ gap: 4, flexWrap: "wrap", marginBottom: 6 }}
              >
                {tagLoadState === "loading" ? (
                  <span className="muted" role="status">
                    Loading tags…
                  </span>
                ) : null}
                {tagLoadState === "error" ? (
                  <span className="muted" role="alert">
                    Tags unavailable: {tagLoadError}
                  </span>
                ) : null}
                {tags.map((t) => (
                  <span key={t} className="chip is-active" style={{ gap: 4 }}>
                    {t}
                    {canMutate ? (
                      <button
                        type="button"
                        className="lib-quicklook-tag-remove"
                        onClick={() => void removeTag(t)}
                        disabled={tagBusy}
                        aria-label={`Remove tag ${t}`}
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                ))}
                {tagLoadState === "ready" && tags.length === 0 ? (
                  <span
                    className="muted"
                    style={{ fontSize: 12, padding: "0 2px" }}
                  >
                    No tags yet
                  </span>
                ) : null}
              </div>
              {canMutate ? (
                <div className="row" style={{ gap: 6 }}>
                  <input
                    id={`tag-${asset.id}`}
                    ref={tagInputRef}
                    type="text"
                    className="input"
                    maxLength={64}
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addTag();
                      }
                    }}
                    placeholder='Add tag (e.g. "hero", "spring-sale")'
                    disabled={tagBusy}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void addTag()}
                    disabled={tagBusy || !tagDraft.trim()}
                  >
                    Add
                  </button>
                </div>
              ) : null}
            </div>

            {/* Mailchimp-parity follow-up: folder dropdown. Only rendered
             * when the parent supplied a folder list (so legacy callers
             * that don't pass `folders` keep working unchanged). */}
            {folders !== undefined ? (
              <div className="lib-quicklook-alt">
                <label htmlFor={`folder-${asset.id}`}>Folder</label>
                <select
                  id={`folder-${asset.id}`}
                  className="input"
                  value={currentFolderId ?? ""}
                  disabled={!canMutate || folderBusy}
                  onChange={(e) => {
                    const v = e.target.value;
                    void moveToFolder(v === "" ? null : v);
                  }}
                >
                  <option value="">(Uncategorised)</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {usageState === "loading" ? (
              <div className="lib-quicklook-usage" role="status">
                Loading usage…
              </div>
            ) : usageState === "error" ? (
              <div className="lib-quicklook-usage" role="alert">
                Usage unavailable: {usageError}
              </div>
            ) : usage.length > 0 ? (
              <div className="lib-quicklook-usage">
                <span className="lib-upload-status" style={{ marginBottom: 4 }}>
                  {usage.length} reported use
                  {usage.length === 1 ? "" : "s"}:
                </span>
                {usage.slice(0, 8).map((r) => (
                  <div
                    key={`${r.kind}-${r.id}`}
                    className="lib-quicklook-usage-row"
                  >
                    <span className="lib-quicklook-usage-kind">{r.kind}</span>
                    <span>{r.name}</span>
                  </div>
                ))}
                {usage.length > 8 ? (
                  <div className="lib-quicklook-usage-row">
                    <span className="lib-quicklook-usage-kind"></span>
                    <span>+{usage.length - 8} more…</span>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="lib-quicklook-actions">
              {displayUrl ? (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void copyUrl()}
                    disabled={busy}
                  >
                    {copyBusy ? "Copying…" : "Copy public URL"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void openInBrowser()}
                    disabled={busy}
                  >
                    Open in browser
                  </button>
                </>
              ) : (
                <span className="muted small">
                  Preview is available here, but this storage URL is not public.
                </span>
              )}
              <span className="lib-spacer" style={{ flex: 1 }} />
              {canMutate ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={onRequestDelete}
                  disabled={busy}
                >
                  Delete
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
