/**
 * AssetPicker — modal that wraps the Library grid so any consumer
 * can pick an asset and get the URL back. Originally specced for
 * Library PR 2 but built here to unblock Referrals PR 2 (reward
 * art); the same component is reused elsewhere as the picker
 * lands across the rest of the ecosystem.
 *
 * Lean by design: search box + flat grid + single-select + Cancel/
 * Insert footer. No smart filters, no density toggle — the picker
 * is "pick a thing" not "manage things"; users go to /assets for
 * the rich Library.
 */

import {
  type Dispatch,
  type MutableRefObject,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { type Asset, apiSendTimeAssets as api } from "../../lib/api-client";
import {
  beginUploadTransfer,
  fileToBase64,
  pickImportFiles,
} from "../../lib/file-transfer";
import type { ImportPolicy } from "../../lib/file-transfer-types";
import {
  ASSET_IMAGE_EXTENSIONS,
  ASSET_PICKER_LIMIT,
  ASSET_UPLOAD_MAX_BYTES,
  decodeAsset,
  decodeAssetList,
} from "../../lib/asset-runtime";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { useCanWrite } from "../../lib/store";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { AssetThumb } from "./AssetThumb";
import "../../styles-asset-picker.css";

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (asset: Asset) => void;
  /** Optional initial search query — e.g. consumers can prefill
   *  with the field name to bias the picker ("logo", "header"). */
  initialQuery?: string;
}

const ASSET_PICKER_IMPORT_POLICY: ImportPolicy = {
  label: "asset image",
  privacy: "personal",
  extensions: [...ASSET_IMAGE_EXTENSIONS],
  maxBytes: ASSET_UPLOAD_MAX_BYTES,
};

interface PickerContentProps {
  rows: Asset[] | null;
  query: string;
  loading: boolean;
  choosingFile: boolean;
  uploading: boolean;
  error: string | null;
  canWrite: boolean;
  resultsMatchQuery: boolean;
  resultsActionable: boolean;
  pickerBusy: boolean;
  selectedId: string | null;
  focusedId: string | null;
  searchId: string;
  resultsLabelId: string;
  resultsStatusId: string;
  statusText: string;
  onQueryChange: (value: string) => void;
  onChooseUpload: () => void;
  onRetry: () => void;
  onFocusOption: (id: string) => void;
  onSelectOption: (id: string) => void;
  onOptionKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    id: string,
  ) => void;
  onInsertAsset: (asset: Asset) => void;
  registerOption: (id: string, element: HTMLButtonElement | null) => void;
}

interface PickerUploadOptions {
  canWrite: boolean;
  query: string;
  requestIdRef: MutableRefObject<number>;
  setRows: Dispatch<SetStateAction<Asset[] | null>>;
  setRowsQuery: Dispatch<SetStateAction<string | null>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setFocusedId: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

function getPickerStatusText({
  choosingFile,
  uploading,
  loading,
  rows,
  error,
  resultsMatchQuery,
  selectedId,
}: Pick<
  PickerContentProps,
  | "choosingFile"
  | "uploading"
  | "loading"
  | "rows"
  | "error"
  | "resultsMatchQuery"
  | "selectedId"
>): string {
  if (choosingFile) {
    return "Opening the native image picker. Closing and insertion are temporarily unavailable.";
  }
  if (uploading) {
    return "Uploading an image. Closing and insertion are unavailable until it finishes.";
  }
  if (loading && rows) {
    return "Refreshing Library images. Previous results are visible but unavailable until the refresh finishes.";
  }
  if (loading) return "Loading Library images.";
  if (error && rows) {
    if (!resultsMatchQuery) {
      return "The visible results belong to a previous search and cannot be inserted.";
    }
    return `${rows.length} previously verified result${rows.length === 1 ? "" : "s"} shown. The refresh failed, so these results may be stale.`;
  }
  if (error) return "Library images could not be loaded.";
  if (rows) {
    return `${rows.length} verified result${rows.length === 1 ? "" : "s"}${selectedId ? "; one selected" : ""}.`;
  }
  return "Loading Library images.";
}

function PickerContent({
  rows,
  query,
  loading,
  choosingFile,
  uploading,
  error,
  canWrite,
  resultsMatchQuery,
  resultsActionable,
  pickerBusy,
  selectedId,
  focusedId,
  searchId,
  resultsLabelId,
  resultsStatusId,
  statusText,
  onQueryChange,
  onChooseUpload,
  onRetry,
  onFocusOption,
  onSelectOption,
  onOptionKeyDown,
  onInsertAsset,
  registerOption,
}: PickerContentProps): ReactElement {
  const hardError = Boolean(error && !rows);
  return (
    <div className="asset-picker">
      <div className="asset-picker-query-row">
        <div className="asset-picker-search-field">
          <label htmlFor={searchId}>Search Library</label>
          <input
            id={searchId}
            type="search"
            className="input"
            placeholder="Search by filename"
            value={query}
            disabled={pickerBusy}
            aria-describedby={resultsStatusId}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        {canWrite ? (
          <button
            type="button"
            className="btn asset-picker-upload"
            aria-describedby={resultsStatusId}
            disabled={pickerBusy}
            onClick={onChooseUpload}
          >
            {choosingFile
              ? "Opening…"
              : uploading
                ? "Uploading…"
                : "Upload image…"}
          </button>
        ) : null}
      </div>

      {error ? (
        <div
          className={`asset-picker-error${hardError ? " is-hard" : ""}`}
          role="alert"
        >
          <div>
            <strong>
              {hardError
                ? "Couldn’t load the Library"
                : "Couldn’t refresh the Library"}
            </strong>
            <p>
              {error}
              {rows
                ? resultsMatchQuery
                  ? " Previously verified results remain visible and may be stale."
                  : " Visible results belong to the previous search and are unavailable."
                : ""}
            </p>
          </div>
          <button
            type="button"
            className="btn"
            onClick={onRetry}
            disabled={loading || pickerBusy}
          >
            Retry
          </button>
        </div>
      ) : null}

      <div className="asset-picker-results-heading">
        <span id={resultsLabelId}>Library images</span>
        <span aria-hidden="true">
          {rows && resultsMatchQuery
            ? `${rows.length} shown`
            : loading
              ? "Refreshing"
              : "Unavailable"}
        </span>
      </div>
      <p
        id={resultsStatusId}
        className="asset-picker-status"
        role="status"
        aria-live="polite"
      >
        {statusText}
      </p>

      {!hardError && rows?.length ? (
        <div
          className="asset-picker-grid"
          role="listbox"
          aria-labelledby={resultsLabelId}
          aria-describedby={resultsStatusId}
          aria-multiselectable="false"
          aria-busy={loading || pickerBusy ? "true" : undefined}
          tabIndex={resultsActionable ? -1 : 0}
        >
          {rows.map((asset) => {
            const selected = asset.id === selectedId;
            const tabStop = asset.id === (focusedId ?? rows[0]?.id);
            return (
              <button
                key={asset.id}
                ref={(element) => registerOption(asset.id, element)}
                type="button"
                role="option"
                className={`asset-picker-tile${selected ? " is-selected" : ""}`}
                disabled={!resultsActionable}
                tabIndex={resultsActionable && tabStop ? 0 : -1}
                aria-selected={selected}
                aria-disabled={!resultsActionable}
                aria-label={`${asset.filename}${selected ? ", selected" : ""}`}
                onFocus={() => onFocusOption(asset.id)}
                onClick={() => onSelectOption(asset.id)}
                onKeyDown={(event) => onOptionKeyDown(event, asset.id)}
                onDoubleClick={() => onInsertAsset(asset)}
              >
                <span className="asset-picker-thumb">
                  <AssetThumb
                    url={asset.url}
                    mime={asset.mime}
                    alt={asset.filename}
                    loading="lazy"
                  />
                </span>
                <span className="asset-picker-name">{asset.filename}</span>
                {selected ? (
                  <span
                    className="asset-picker-selected-mark"
                    aria-hidden="true"
                  >
                    ✓ Selected
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : !hardError ? (
        <div
          className="asset-picker-grid"
          role="region"
          aria-labelledby={resultsLabelId}
          aria-describedby={resultsStatusId}
          aria-busy={loading || pickerBusy ? "true" : undefined}
        >
          <div className="asset-picker-placeholder">
            {loading
              ? "Loading verified images…"
              : query
                ? `No images match “${query}”.`
                : "Your Library is empty. Upload an image to start."}
          </div>
        </div>
      ) : null}
      {rows && resultsMatchQuery && rows.length >= ASSET_PICKER_LIMIT ? (
        <p className="asset-picker-ceiling">
          Showing the first {ASSET_PICKER_LIMIT} verified matches. Refine the
          filename search to find assets beyond this limit.
        </p>
      ) : null}
      {!canWrite ? (
        <p className="asset-picker-permission">
          Your role can choose existing images but cannot upload new ones.
        </p>
      ) : null}
    </div>
  );
}

function usePickerUpload({
  canWrite,
  query,
  requestIdRef,
  setRows,
  setRowsQuery,
  setSelectedId,
  setFocusedId,
  setError,
}: PickerUploadOptions) {
  const [choosingFile, setChoosingFile] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!uploading) return;
    return registerLifecycleGuard({
      id: "asset-picker-upload",
      label: "Asset picker upload",
      inspect: () => ({
        level: "blocking",
        detail: "An asset upload is still in progress.",
        canDiscard: false,
        canRecover: false,
      }),
    });
  }, [uploading]);

  const onUpload = useCallback(
    async (file: File): Promise<void> => {
      if (!canWrite || uploadRef.current) {
        return uploadRef.current ?? Promise.resolve();
      }
      const transfer = beginUploadTransfer(file, {
        label: "Asset picker upload",
        privacy: "personal",
        retry: () => onUpload(file),
      });
      setUploading(true);
      const operation = (async (): Promise<void> => {
        try {
          const b64 = await fileToBase64(file);
          transfer.progress(Math.round(file.size * 0.5));
          const response = await api.uploadAsset({
            filename: file.name,
            mime: file.type || "application/octet-stream",
            content_base64: b64,
          });
          if (response.error) {
            transfer.fail("asset_upload_failed");
            toast.error(`Upload failed: ${response.error.message}`);
            return;
          }
          const uploaded = decodeAsset(response.data);
          if (!uploaded.ok) {
            transfer.fail("asset_upload_invalid_response");
            toast.error(`Upload response was invalid: ${uploaded.error}`);
            return;
          }
          const pinUploaded = (items: Asset[]): Asset[] =>
            [
              uploaded.value,
              ...items.filter((asset) => asset.id !== uploaded.value.id),
            ].slice(0, ASSET_PICKER_LIMIT);

          setRows((current) => pinUploaded(current ?? []));
          setRowsQuery(query);
          setSelectedId(uploaded.value.id);
          setFocusedId(uploaded.value.id);
          setError(null);
          transfer.complete();
          toast.success("Uploaded and selected — insert when ready.");

          const requestId = ++requestIdRef.current;
          try {
            const list = await api.listAssets({
              q: query,
              limit: ASSET_PICKER_LIMIT,
            });
            if (requestId !== requestIdRef.current) return;
            if (list.error) {
              setError(list.error.message);
              return;
            }
            const decoded = decodeAssetList(list.data);
            if (!decoded.ok) {
              setError(
                `The refreshed asset list was invalid (${decoded.error}).`,
              );
              return;
            }
            setRows(pinUploaded(decoded.value.items));
            setRowsQuery(query);
          } catch (refreshError) {
            if (requestId === requestIdRef.current) {
              setError(
                refreshError instanceof Error
                  ? refreshError.message
                  : "The uploaded asset is ready, but the Library refresh failed.",
              );
            }
          }
        } catch {
          transfer.fail("asset_upload_failed");
          toast.error("Upload failed while reading the selected file.");
        }
      })();
      uploadRef.current = operation;
      try {
        await operation;
      } finally {
        if (uploadRef.current === operation) uploadRef.current = null;
        setUploading(false);
      }
    },
    [
      canWrite,
      query,
      requestIdRef,
      setError,
      setFocusedId,
      setRows,
      setRowsQuery,
      setSelectedId,
    ],
  );

  const chooseUpload = useCallback(async (): Promise<void> => {
    if (choosingFile || uploading) return;
    setChoosingFile(true);
    try {
      const picked = await pickImportFiles(ASSET_PICKER_IMPORT_POLICY);
      if (!picked.ok) {
        toast.error(picked.message);
        return;
      }
      if (picked.files[0]) await onUpload(picked.files[0]);
    } catch (pickerError) {
      toast.error(
        pickerError instanceof Error
          ? `Couldn’t open the image picker: ${pickerError.message}`
          : "Couldn’t open the image picker.",
      );
    } finally {
      setChoosingFile(false);
    }
  }, [choosingFile, onUpload, uploading]);

  return { choosingFile, uploading, uploadRef, chooseUpload };
}

export function AssetPicker({
  open,
  onClose,
  onPick,
  initialQuery,
}: Props): ReactElement {
  const [rows, setRows] = useState<Asset[] | null>(null);
  const [rowsQuery, setRowsQuery] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const canWrite = useCanWrite();
  const searchId = useId();
  const resultsLabelId = useId();
  const resultsStatusId = useId();

  // Monotonic request id — guards against out-of-order responses (a slow
  // fetch for "lo" must not clobber the result for "logo") and against
  // in-flight responses landing after the modal closed.
  const reqIdRef = useRef(0);
  const tileRefs = useRef(new Map<string, HTMLButtonElement>());
  const { choosingFile, uploading, uploadRef, chooseUpload } = usePickerUpload({
    canWrite,
    query,
    requestIdRef: reqIdRef,
    setRows,
    setRowsQuery,
    setSelectedId,
    setFocusedId,
    setError,
  });

  const requestClose = useCallback((): void => {
    if (choosingFile || uploadRef.current) return;
    onClose();
  }, [choosingFile, onClose]);

  useEffect(() => {
    if (!open) {
      reqIdRef.current += 1;
      setRows(null);
      setRowsQuery(null);
      setSelectedId(null);
      setFocusedId(null);
      setError(null);
      setLoading(false);
      return;
    }
    setQuery(initialQuery ?? "");
    setSelectedId(null);
    setFocusedId(null);
  }, [initialQuery, open]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    // Debounce the search fetch (~300ms) so the picker doesn't fire a
    // 100-row request per keystroke.
    const timer = window.setTimeout(() => {
      const reqId = ++reqIdRef.current;
      void (async () => {
        try {
          const res = await api.listAssets({
            q: query,
            limit: ASSET_PICKER_LIMIT,
          });
          if (reqId !== reqIdRef.current) return;
          if (res.error) {
            setError(res.error.message);
            return;
          }
          const decoded = decodeAssetList(res.data);
          if (!decoded.ok) {
            setError(
              `The server returned an invalid asset list (${decoded.error}).`,
            );
            return;
          }
          setRows(decoded.value.items);
          setRowsQuery(query);
          setSelectedId((current) =>
            decoded.value.items.some((asset) => asset.id === current)
              ? current
              : null,
          );
          setFocusedId((current) => {
            if (decoded.value.items.some((asset) => asset.id === current))
              return current;
            return decoded.value.items[0]?.id ?? null;
          });
        } catch (loadError) {
          if (reqId === reqIdRef.current) {
            setError(
              loadError instanceof Error
                ? loadError.message
                : "The asset request failed.",
            );
          }
        } finally {
          if (reqId === reqIdRef.current) setLoading(false);
        }
      })();
    }, 300);
    return () => {
      // Invalidate any in-flight response and cancel the pending fetch.
      reqIdRef.current++;
      window.clearTimeout(timer);
    };
  }, [open, query, reloadToken]);

  const resultsMatchQuery = rowsQuery === query;
  const pickerBusy = choosingFile || uploading;
  const resultsActionable =
    rows !== null && resultsMatchQuery && !loading && !pickerBusy;

  const focusOption = useCallback((id: string): void => {
    setFocusedId(id);
    setSelectedId(id);
    window.requestAnimationFrame(() => tileRefs.current.get(id)?.focus());
  }, []);

  const onOptionKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    id: string,
  ): void => {
    if (!resultsActionable || !rows?.length) return;
    const currentIndex = Math.max(
      0,
      rows.findIndex((asset) => asset.id === id),
    );
    let targetIndex: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        targetIndex = Math.min(rows.length - 1, currentIndex + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        targetIndex = Math.max(0, currentIndex - 1);
        break;
      case "Home":
        targetIndex = 0;
        break;
      case "End":
        targetIndex = rows.length - 1;
        break;
      case " ":
      case "Enter":
        event.preventDefault();
        setFocusedId(id);
        setSelectedId(id);
        return;
      default:
        return;
    }
    event.preventDefault();
    const target = rows[targetIndex];
    if (target) focusOption(target.id);
  };

  const retryLoad = (): void => {
    if (loading) return;
    setError(null);
    setLoading(true);
    setReloadToken((value) => value + 1);
  };

  const submit = (): void => {
    if (!resultsActionable) return;
    const a = (rows ?? []).find((x) => x.id === selectedId);
    if (!a) return;
    onPick(a);
    requestClose();
  };

  const statusText = getPickerStatusText({
    choosingFile,
    uploading,
    loading,
    rows,
    error,
    resultsMatchQuery,
    selectedId,
  });
  const onQueryChange = (value: string): void => {
    setLoading(true);
    setError(null);
    setSelectedId(null);
    setFocusedId(null);
    setQuery(value);
  };
  const onSelectOption = (id: string): void => {
    setFocusedId(id);
    setSelectedId(id);
  };
  const onInsertAsset = (asset: Asset): void => {
    if (!resultsActionable || uploadRef.current) return;
    setSelectedId(asset.id);
    onPick(asset);
    requestClose();
  };
  const registerOption = (
    id: string,
    element: HTMLButtonElement | null,
  ): void => {
    if (element) tileRefs.current.set(id, element);
    else tileRefs.current.delete(id);
  };

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title="Pick an image"
      description="Choose a verified Library image. Delivery access depends on the destination and workspace configuration."
      size="lg"
      closeOnBackdrop={!pickerBusy}
      closeOnEscape={!pickerBusy}
      closeDisabled={pickerBusy}
    >
      <PickerContent
        rows={rows}
        query={query}
        loading={loading}
        choosingFile={choosingFile}
        uploading={uploading}
        error={error}
        canWrite={canWrite}
        resultsMatchQuery={resultsMatchQuery}
        resultsActionable={resultsActionable}
        pickerBusy={pickerBusy}
        selectedId={selectedId}
        focusedId={focusedId}
        searchId={searchId}
        resultsLabelId={resultsLabelId}
        resultsStatusId={resultsStatusId}
        statusText={statusText}
        onQueryChange={onQueryChange}
        onChooseUpload={() => void chooseUpload()}
        onRetry={retryLoad}
        onFocusOption={setFocusedId}
        onSelectOption={onSelectOption}
        onOptionKeyDown={onOptionKeyDown}
        onInsertAsset={onInsertAsset}
        registerOption={registerOption}
      />

      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={requestClose}
          disabled={pickerBusy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!selectedId || !resultsActionable}
          onClick={submit}
        >
          Insert
        </button>
      </ModalFooter>
    </Modal>
  );
}
