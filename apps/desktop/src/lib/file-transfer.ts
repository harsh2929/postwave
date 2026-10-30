import { invoke } from "@tauri-apps/api/core";

import {
  registerTransferActions,
  startTransfer,
  updateTransfer,
} from "./file-transfer-history";
import type {
  DownloadUrlResult,
  DownloadUrlOptions,
  FileTypeFilter,
  ImportFilesResult,
  ImportPolicy,
  PickedFileMetadataResult,
  SaveFileOptions,
  SaveFileResult,
  TransferProgress,
  UploadTransferHandle,
} from "./file-transfer-types";
import { isTauri, tauriApi } from "./tauri";

const NATIVE_CHUNK_BYTES = 256 * 1024;
const DEFAULT_DOWNLOAD_LIMIT = 2 * 1024 * 1024 * 1024;
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  csv: "text/csv",
  json: "application/json",
  jsonl: "application/x-ndjson",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  txt: "text/plain",
};

interface NativeBeginResponse {
  transferId: string;
  collision: boolean;
}

interface NativeWriteResponse {
  writtenBytes: number;
  expectedBytes: number;
}

interface InternalSaveOptions extends SaveFileOptions {
  historyId?: string;
}

export async function saveFile(
  options: SaveFileOptions,
): Promise<SaveFileResult> {
  return saveFileInternal(options);
}

async function saveFileInternal(
  options: InternalSaveOptions,
): Promise<SaveFileResult> {
  const suggestedName = sanitizeSuggestedFilename(options.suggestedName);
  const blob = toBlob(options.data, options.mimeType);
  const id =
    options.historyId ??
    startTransfer({
      direction: "export",
      label: options.label,
      fileName: suggestedName ?? "File",
      privacy: options.privacy,
      status: "saving",
      totalBytes: blob.size,
    });

  if (!suggestedName) {
    updateTransfer(id, { status: "failed", errorCode: "invalid_filename" });
    return failure(id, "invalid_filename", "Choose a valid file name.");
  }

  const controller = new AbortController();
  const relayAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  registerTransferActions(id, { cancel: () => controller.abort() });

  const retry = async (): Promise<void> => {
    await saveFile({ ...options, signal: undefined });
  };
  let nativeTransferId: string | null = null;
  try {
    if (options.signal?.aborted) throw abortError();
    if (!isTauri()) {
      startBrowserDownload(blob, suggestedName);
      reportProgress(id, blob.size, blob.size, "saving", options.onProgress);
      updateTransfer(id, { status: "completed" });
      registerTransferActions(id, {});
      return {
        ok: true,
        status: "download_started",
        transferId: id,
        collision: false,
      };
    }

    const { save } = await import("@tauri-apps/plugin-dialog");
    const filters = normalizeFilters(options.filters, suggestedName);
    const selectedPath = await save({
      title: `Save ${options.label}`,
      defaultPath: suggestedName,
      filters: filters.map((filter) => ({
        name: filter.name,
        extensions: [...filter.extensions],
      })),
    });
    if (selectedPath == null) {
      updateTransfer(id, { status: "cancelled", errorCode: undefined });
      registerTransferActions(id, { retry });
      return { ok: true, status: "cancelled", transferId: id };
    }
    if (typeof selectedPath !== "string") {
      throw new Error("picker_failed");
    }
    if (controller.signal.aborted) throw abortError();

    const begun = await invoke<NativeBeginResponse>("transfer_begin_save", {
      request: { targetPath: selectedPath, expectedBytes: blob.size },
    });
    nativeTransferId = begun.transferId;
    updateTransfer(id, { collision: begun.collision });
    registerTransferActions(id, {
      cancel: async () => {
        controller.abort();
        await cancelNativeSave(begun.transferId);
      },
    });

    let offset = 0;
    for await (const chunk of blobChunks(blob, controller.signal)) {
      const written = await invoke<NativeWriteResponse>(
        "transfer_write_chunk",
        {
          transferId: begun.transferId,
          offset,
          chunk: Array.from(chunk),
        },
      );
      offset = written.writtenBytes;
      reportProgress(
        id,
        offset,
        written.expectedBytes,
        "saving",
        options.onProgress,
      );
    }
    if (controller.signal.aborted) throw abortError();
    await invoke<void>("transfer_finish_save", {
      transferId: begun.transferId,
    });
    nativeTransferId = null;
    updateTransfer(id, { status: "completed", bytesTransferred: blob.size });
    registerTransferActions(id, {
      reveal: async () => {
        await invoke<void>("transfer_reveal_saved", {
          transferId: begun.transferId,
        });
      },
    });
    return {
      ok: true,
      status: "saved",
      transferId: id,
      collision: begun.collision,
    };
  } catch (error) {
    if (nativeTransferId) await cancelNativeSave(nativeTransferId);
    if (isAbort(error) || controller.signal.aborted) {
      updateTransfer(id, { status: "cancelled", errorCode: "cancelled" });
      registerTransferActions(id, { retry });
      return failure(id, "cancelled", "The file transfer was cancelled.");
    }
    const pickerFailed =
      error instanceof Error && error.message === "picker_failed";
    const code = pickerFailed ? "picker_failed" : "write_failed";
    updateTransfer(id, { status: "failed", errorCode: code });
    registerTransferActions(id, { retry });
    return failure(
      id,
      code,
      pickerFailed
        ? "The system file picker did not return a usable destination."
        : "Moosewave could not save the file. Choose Retry or another destination.",
    );
  } finally {
    options.signal?.removeEventListener("abort", relayAbort);
  }
}

export async function downloadUrlToFile(
  options: DownloadUrlOptions,
): Promise<DownloadUrlResult> {
  const suggestedName =
    sanitizeSuggestedFilename(options.suggestedName) ?? "postwave-export.bin";
  const id = startTransfer({
    direction: "download",
    label: options.label,
    fileName: suggestedName,
    privacy: options.privacy,
    status: "downloading",
  });
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  const retry = async (): Promise<void> => {
    await downloadUrlToFile({ ...options, signal: undefined });
  };
  registerTransferActions(id, { cancel: () => controller.abort() });
  let responseReceived = false;

  try {
    const safeUrl = safeDownloadUrl(options.url);
    if (!safeUrl) throw new Error("unsafe_download_url");
    const response = await fetch(safeUrl, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    responseReceived = true;
    if (!response.ok || !safeDownloadUrl(response.url || safeUrl)) {
      throw new Error("download_response_rejected");
    }
    const responseHeaders = captureResponseHeaders(
      response.headers,
      options.captureResponseHeaders,
    );
    const maximum = options.maxBytes ?? DEFAULT_DOWNLOAD_LIMIT;
    const advertised = parseContentLength(
      response.headers.get("content-length"),
    );
    if (advertised !== null && advertised > maximum) {
      throw new Error("download_too_large");
    }
    const chunks: ArrayBuffer[] = [];
    let received = 0;
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value.byteLength;
        if (received > maximum) {
          await reader.cancel();
          throw new Error("download_too_large");
        }
        chunks.push(copyBuffer(next.value));
        reportProgress(
          id,
          received,
          advertised,
          "downloading",
          options.onProgress,
        );
      }
    } else {
      const buffer = await response.arrayBuffer();
      received = buffer.byteLength;
      if (received > maximum) throw new Error("download_too_large");
      chunks.push(buffer);
    }
    const responseName = contentDispositionFilename(
      response.headers.get("content-disposition"),
    );
    const fileName = responseName ?? suggestedName;
    updateTransfer(id, {
      fileName,
      totalBytes: received,
      bytesTransferred: received,
    });
    const saved = await saveFileInternal({
      ...options,
      data: new Blob(chunks, {
        type:
          response.headers.get("content-type") ??
          options.mimeType ??
          "application/octet-stream",
      }),
      suggestedName: fileName,
      signal: controller.signal,
      historyId: id,
    });
    return { ...saved, responseHeaders };
  } catch (error) {
    if (isAbort(error) || controller.signal.aborted) {
      updateTransfer(id, { status: "cancelled", errorCode: "cancelled" });
      registerTransferActions(id, { retry });
      return failure(id, "cancelled", "The download was cancelled.");
    }
    if (
      options.allowExternalFallback !== false &&
      !responseReceived &&
      error instanceof TypeError &&
      safeDownloadUrl(options.url)
    ) {
      try {
        await tauriApi.openUrl(options.url);
        updateTransfer(id, { status: "delegated", errorCode: undefined });
        registerTransferActions(id, { retry });
        return {
          ok: true,
          status: "download_started",
          transferId: id,
          collision: false,
        };
      } catch {
        // Fall through to the privacy-safe failure state.
      }
    }
    updateTransfer(id, { status: "failed", errorCode: "download_failed" });
    registerTransferActions(id, { retry });
    return failure(
      id,
      "download_failed",
      "Moosewave could not download this file. Check connectivity and try again.",
    );
  } finally {
    options.signal?.removeEventListener("abort", relayAbort);
  }
}

function captureResponseHeaders(
  headers: Headers,
  requested: readonly string[] | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!requested?.length) return undefined;
  const captured: Record<string, string> = {};
  for (const rawName of requested.slice(0, 32)) {
    const name = rawName.trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(name)) continue;
    const value = headers.get(name);
    if (value !== null) captured[name] = value;
  }
  return Object.freeze(captured);
}

export async function pickImportFiles(
  policy: ImportPolicy,
): Promise<ImportFilesResult> {
  const id = startTransfer({
    direction: "import",
    label: policy.label,
    fileName: "Selected file",
    privacy: policy.privacy,
    status: "picking",
  });
  try {
    const files = isTauri()
      ? await pickNativeFiles(policy, id)
      : await pickWebFiles(policy);
    if (files.length === 0) {
      updateTransfer(id, { status: "cancelled" });
      return {
        ok: true,
        files: [],
        source: isTauri() ? "native" : "web",
        cancelled: true,
      };
    }
    const validated = validateImportFiles(
      files,
      policy,
      isTauri() ? "native" : "web",
    );
    if (!validated.ok) {
      updateTransfer(id, { status: "failed", errorCode: validated.code });
      return validated;
    }
    const total = validated.files.reduce((sum, file) => sum + file.size, 0);
    updateTransfer(id, {
      status: "completed",
      fileName:
        validated.files.length === 1
          ? validated.files[0]!.name
          : `${validated.files.length} files`,
      bytesTransferred: total,
      totalBytes: total,
    });
    return validated;
  } catch {
    updateTransfer(id, { status: "failed", errorCode: "picker_failed" });
    return {
      ok: false,
      code: "picker_failed",
      message: "Moosewave could not open or read the selected file.",
    };
  }
}

/** Pick only local metadata; bytes never cross IPC or enter renderer memory. */
export async function pickFileMetadata(
  policy: ImportPolicy,
): Promise<PickedFileMetadataResult> {
  const source = isTauri() ? "native" : "web";
  const id = startTransfer({
    direction: "import",
    label: policy.label,
    fileName: "Selected file",
    privacy: policy.privacy,
    status: "picking",
  });
  let nativePath: string | null = null;
  try {
    let metadata: { name: string; size: number; type: string } | null = null;
    if (isTauri()) {
      const [{ open }, { stat }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);
      const selected = await open({
        title: `Choose ${policy.label}`,
        multiple: false,
        directory: false,
        filters:
          policy.extensions.length > 0
            ? [
                {
                  name: policy.label,
                  extensions: policy.extensions.map(normalizeExtension),
                },
              ]
            : [],
      });
      if (typeof selected === "string") {
        nativePath = selected;
        const info = await stat(selected);
        const name = basename(selected);
        metadata = {
          name,
          size: info.size,
          type: MIME_BY_EXTENSION[extensionOf(name)] ?? "",
        };
      }
    } else {
      const file = (await pickWebFiles(policy))[0];
      if (file)
        metadata = { name: file.name, size: file.size, type: file.type };
    }
    if (!metadata) {
      updateTransfer(id, { status: "cancelled" });
      return { ok: true, file: null, source, cancelled: true };
    }
    const validation = validateFileMetadata(metadata, policy);
    if (validation) {
      updateTransfer(id, { status: "failed", errorCode: validation.code });
      return validation;
    }
    updateTransfer(id, {
      status: "completed",
      fileName: metadata.name,
      bytesTransferred: metadata.size,
      totalBytes: metadata.size,
    });
    return { ok: true, file: metadata, source };
  } catch {
    updateTransfer(id, { status: "failed", errorCode: "picker_failed" });
    return invalid(
      "picker_failed",
      "Moosewave could not inspect the selected file.",
    );
  } finally {
    if (nativePath) await revokeNativePickerPath(nativePath);
  }
}

export function acceptDroppedFiles(
  files: FileList | readonly File[],
  policy: ImportPolicy,
): ImportFilesResult {
  const validated = validateImportFiles(Array.from(files), policy, "drop");
  const id = startTransfer({
    direction: "import",
    label: policy.label,
    fileName:
      validated.ok && validated.files.length === 1
        ? validated.files[0]!.name
        : "Dropped files",
    privacy: policy.privacy,
    status: validated.ok ? "completed" : "failed",
    totalBytes: validated.ok
      ? validated.files.reduce((sum, file) => sum + file.size, 0)
      : null,
  });
  if (validated.ok) {
    const total = validated.files.reduce((sum, file) => sum + file.size, 0);
    updateTransfer(id, { bytesTransferred: total });
  } else {
    updateTransfer(id, { errorCode: validated.code });
  }
  return validated;
}

export function validateImportFiles(
  files: readonly File[],
  policy: ImportPolicy,
  source: "native" | "web" | "drop" = "web",
): ImportFilesResult {
  const maxFiles = policy.maxFiles ?? 1;
  if (files.length > maxFiles) {
    return invalid(
      "too_many_files",
      `Choose no more than ${maxFiles} file${maxFiles === 1 ? "" : "s"}.`,
    );
  }
  let total = 0;
  for (const file of files) {
    const error = validateFileMetadata(file, policy);
    if (error) return error;
    total += file.size;
  }
  if (total > (policy.maxTotalBytes ?? policy.maxBytes * maxFiles)) {
    return invalid(
      "total_too_large",
      "The selected files are too large to process together.",
    );
  }
  return { ok: true, files: [...files], source };
}

function validateFileMetadata(
  file: { name: string; size: number; type: string },
  policy: ImportPolicy,
): Extract<ImportFilesResult, { ok: false }> | null {
  if (
    basename(file.name) !== file.name ||
    sanitizeSuggestedFilename(file.name) !== file.name.normalize("NFKC")
  ) {
    return invalid("invalid_name", "One selected file has an invalid name.");
  }
  const extension = extensionOf(file.name);
  const allowedExtensions = policy.extensions.map(normalizeExtension);
  if (
    allowedExtensions.length > 0 &&
    (!extension || !allowedExtensions.includes(extension))
  ) {
    return invalid(
      "invalid_type",
      `Choose ${humanExtensions(allowedExtensions)} file${(policy.maxFiles ?? 1) === 1 ? "" : "s"}.`,
    );
  }
  if (
    file.type &&
    file.type !== "application/octet-stream" &&
    policy.mimeTypes?.length &&
    !policy.mimeTypes.includes(file.type)
  ) {
    return invalid(
      "invalid_type",
      "The selected file type does not match its expected format.",
    );
  }
  if (!policy.allowEmpty && file.size === 0) {
    return invalid("empty_file", "The selected file is empty.");
  }
  if (file.size > policy.maxBytes) {
    return invalid(
      "file_too_large",
      `Choose a file smaller than ${formatBytes(policy.maxBytes)}.`,
    );
  }
  return null;
}

export function beginUploadTransfer(
  file: File,
  options: {
    label: string;
    privacy: SaveFileOptions["privacy"];
    cancel?: () => void | Promise<void>;
    retry?: () => void | Promise<void>;
  },
): UploadTransferHandle {
  const id = startTransfer({
    direction: "upload",
    label: options.label,
    fileName: file.name,
    privacy: options.privacy,
    status: "uploading",
    totalBytes: file.size,
  });
  registerTransferActions(id, { cancel: options.cancel, retry: options.retry });
  return {
    id,
    progress(bytesTransferred, totalBytes = file.size) {
      updateTransfer(id, { status: "uploading", bytesTransferred, totalBytes });
    },
    complete() {
      updateTransfer(id, { status: "completed", bytesTransferred: file.size });
      registerTransferActions(id, {});
    },
    fail(code = "upload_failed") {
      updateTransfer(id, { status: "failed", errorCode: code });
      registerTransferActions(id, { retry: options.retry });
    },
    cancel() {
      void options.cancel?.();
      updateTransfer(id, { status: "cancelled", errorCode: "cancelled" });
      registerTransferActions(id, { retry: options.retry });
    },
  };
}

/** Read an already picker-validated file without FileReader/data-URL copies. */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const step = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

export async function fileToDataUrl(file: File): Promise<string> {
  const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.type)
    ? file.type
    : "application/octet-stream";
  return `data:${mime};base64,${await fileToBase64(file)}`;
}

export function sanitizeSuggestedFilename(raw: string): string | null {
  let name = basename(raw.normalize("NFKC"))
    .replace(/[\u0000-\u001f\u007f\p{Cf}]/gu, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!name || name === "." || name === "..") return null;
  if (name.startsWith(".")) name = `file${name}`;
  const stem = name.split(".")[0]?.toUpperCase() ?? "";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) name = `_${name}`;
  if (name.length > 180) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = `${name.slice(0, 180 - extension.length)}${extension}`;
  }
  return name;
}

async function pickNativeFiles(
  policy: ImportPolicy,
  historyId: string,
): Promise<File[]> {
  const [{ open }, { readFile, stat }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const selected = await open({
    title: `Choose ${policy.label}`,
    multiple: (policy.maxFiles ?? 1) > 1,
    directory: false,
    filters:
      policy.extensions.length > 0
        ? [
            {
              name: policy.label,
              extensions: policy.extensions.map(normalizeExtension),
            },
          ]
        : [],
  });
  if (selected == null) return [];
  const paths = Array.isArray(selected) ? selected : [selected];
  const files: File[] = [];
  let total = 0;
  try {
    if (paths.length > (policy.maxFiles ?? 1)) {
      throw new Error("too_many_files");
    }
    for (const path of paths) {
      if (typeof path !== "string") throw new Error("invalid_path");
      const name = basename(path);
      if (!sanitizeSuggestedFilename(name)) throw new Error("invalid_name");
      const metadata = await stat(path);
      total += metadata.size;
      if (
        metadata.size > policy.maxBytes ||
        total >
          (policy.maxTotalBytes ?? policy.maxBytes * (policy.maxFiles ?? 1))
      ) {
        throw new Error("file_too_large");
      }
      updateTransfer(historyId, {
        status: "reading",
        fileName: name,
        totalBytes: total,
      });
      const bytes = await readFile(path);
      const copied = copyBuffer(bytes);
      files.push(
        new File([copied], name, {
          type: MIME_BY_EXTENSION[extensionOf(name)] ?? "",
        }),
      );
      updateTransfer(historyId, { bytesTransferred: total });
    }
  } finally {
    await Promise.all(
      paths
        .filter((path): path is string => typeof path === "string")
        .map(revokeNativePickerPath),
    );
  }
  return files;
}

async function revokeNativePickerPath(path: string): Promise<void> {
  try {
    await invoke<void>("transfer_revoke_picker_path", { path });
  } catch {
    // Scope is process-local and disappears on exit; old shells can still
    // complete the operation safely even when they cannot revoke eagerly.
  }
}

function pickWebFiles(policy: ImportPolicy): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = [
      ...policy.extensions.map(
        (extension) => `.${normalizeExtension(extension)}`,
      ),
      ...(policy.mimeTypes ?? []),
    ].join(",");
    input.multiple = (policy.maxFiles ?? 1) > 1;
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    const finish = (files: File[]): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener(
      "change",
      () => finish(Array.from(input.files ?? [])),
      { once: true },
    );
    input.addEventListener("cancel", () => finish([]), { once: true });
    input.click();
  });
}

async function* blobChunks(
  blob: Blob,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = blob.stream().getReader();
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const next = await reader.read();
      if (next.done) break;
      for (
        let offset = 0;
        offset < next.value.byteLength;
        offset += NATIVE_CHUNK_BYTES
      ) {
        if (signal.aborted) throw abortError();
        yield next.value.slice(offset, offset + NATIVE_CHUNK_BYTES);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function cancelNativeSave(transferId: string): Promise<void> {
  try {
    await invoke<void>("transfer_cancel_save", { transferId });
  } catch {
    // The original operation still reports its own failure; cancellation is best effort.
  }
}

function startBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function toBlob(value: SaveFileOptions["data"], mimeType?: string): Blob {
  if (value instanceof Blob) return value;
  if (typeof value === "string")
    return new Blob([value], { type: mimeType ?? "text/plain;charset=utf-8" });
  return new Blob([copyBuffer(value)], {
    type: mimeType ?? "application/octet-stream",
  });
}

function safeDownloadUrl(raw: string): string | null {
  if (raw.length > 8_192) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.toString();
    if (
      url.protocol === "http:" &&
      import.meta.env.DEV &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    ) {
      return url.toString();
    }
  } catch {
    // invalid
  }
  return null;
}

function contentDispositionFilename(header: string | null): string | null {
  if (!header || header.length > 2_048) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return sanitizeSuggestedFilename(decodeURIComponent(encoded.trim()));
    } catch {
      // Try the quoted legacy form below.
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(header)?.[1];
  const plain = quoted ?? /filename=([^;]+)/i.exec(header)?.[1];
  return plain ? sanitizeSuggestedFilename(plain.trim()) : null;
}

function normalizeFilters(
  filters: readonly FileTypeFilter[] | undefined,
  filename: string,
): FileTypeFilter[] {
  if (filters?.length) {
    return filters
      .map((filter) => ({
        name:
          filter.name
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .trim()
            .slice(0, 80) || "File",
        extensions: [
          ...new Set(filter.extensions.map(normalizeExtension).filter(Boolean)),
        ],
      }))
      .filter((filter) => filter.extensions.length > 0);
  }
  const extension = extensionOf(filename);
  return extension
    ? [{ name: `${extension.toUpperCase()} file`, extensions: [extension] }]
    : [];
}

function reportProgress(
  id: string,
  bytesTransferred: number,
  totalBytes: number | null,
  phase: TransferProgress["phase"],
  callback?: (progress: TransferProgress) => void,
): void {
  updateTransfer(id, { status: phase, bytesTransferred, totalBytes });
  try {
    callback?.({ bytesTransferred, totalBytes, phase });
  } catch {
    // Progress UI is observational and cannot be allowed to change whether
    // the underlying file operation succeeds or delegates externally.
  }
}

function failure(
  transferId: string,
  code: Extract<SaveFileResult, { ok: false }>["code"],
  message: string,
): Extract<SaveFileResult, { ok: false }> {
  return { ok: false, transferId, code, message };
}

function invalid(
  code: Extract<ImportFilesResult, { ok: false }>["code"],
  message: string,
): Extract<ImportFilesResult, { ok: false }> {
  return { ok: false, code, message };
}

function basename(raw: string): string {
  return raw.split(/[\\/]/).pop() ?? "";
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? normalizeExtension(filename.slice(dot + 1)) : "";
}

function normalizeExtension(extension: string): string {
  return extension
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 16);
}

function humanExtensions(extensions: readonly string[]): string {
  return extensions.map((extension) => `.${extension}`).join(" or ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function parseContentLength(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  return copied.buffer;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
