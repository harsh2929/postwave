export type TransferPrivacy = "public" | "personal" | "confidential";
export type TransferDirection = "import" | "upload" | "download" | "export";
export type TransferStatus =
  | "picking"
  | "reading"
  | "downloading"
  | "saving"
  | "uploading"
  | "completed"
  | "delegated"
  | "failed"
  | "cancelled";

export interface TransferRecord {
  id: string;
  direction: TransferDirection;
  label: string;
  /** Privacy-safe display name; absolute paths and remote URLs are forbidden. */
  fileName: string;
  privacy: TransferPrivacy;
  status: TransferStatus;
  bytesTransferred: number;
  totalBytes: number | null;
  startedAt: number;
  updatedAt: number;
  errorCode?: string;
  collision?: boolean;
}

export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number | null;
  phase: Extract<
    TransferStatus,
    "reading" | "downloading" | "saving" | "uploading"
  >;
}

export interface FileTypeFilter {
  name: string;
  extensions: readonly string[];
}

export interface ImportPolicy {
  label: string;
  privacy: TransferPrivacy;
  extensions: readonly string[];
  mimeTypes?: readonly string[];
  maxBytes: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  allowEmpty?: boolean;
}

export type ImportFilesResult =
  | { ok: true; files: File[]; source: "native" | "web" | "drop" }
  | { ok: true; files: []; source: "native" | "web"; cancelled: true }
  | {
      ok: false;
      code:
        | "invalid_name"
        | "invalid_type"
        | "empty_file"
        | "file_too_large"
        | "too_many_files"
        | "total_too_large"
        | "read_failed"
        | "picker_failed";
      message: string;
    };

export type PickedFileMetadataResult =
  | {
      ok: true;
      file: { name: string; size: number; type: string };
      source: "native" | "web";
    }
  | { ok: true; file: null; source: "native" | "web"; cancelled: true }
  | Extract<ImportFilesResult, { ok: false }>;

export interface SaveFileOptions {
  data: Blob | Uint8Array | string;
  suggestedName: string;
  label: string;
  privacy: TransferPrivacy;
  mimeType?: string;
  filters?: readonly FileTypeFilter[];
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}

export type SaveFileResult =
  | {
      ok: true;
      status: "saved" | "download_started";
      transferId: string;
      collision: boolean;
    }
  | { ok: true; status: "cancelled"; transferId: string }
  | {
      ok: false;
      transferId: string;
      code:
        | "invalid_filename"
        | "cancelled"
        | "picker_failed"
        | "write_failed"
        | "download_failed";
      message: string;
    };

export type DownloadUrlResult = SaveFileResult & {
  /**
   * Explicitly requested response headers, normalized to lowercase. The
   * transfer history never persists these values.
   */
  responseHeaders?: Readonly<Record<string, string>>;
};

export interface DownloadUrlOptions extends Omit<
  SaveFileOptions,
  "data" | "suggestedName"
> {
  url: string;
  suggestedName: string;
  maxBytes?: number;
  allowExternalFallback?: boolean;
  /** Capture only the named response headers for operation-specific truth. */
  captureResponseHeaders?: readonly string[];
}

export interface UploadTransferHandle {
  id: string;
  progress(bytesTransferred: number, totalBytes?: number): void;
  complete(): void;
  fail(code?: string): void;
  cancel(): void;
}
