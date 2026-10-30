// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

const EXPORTS_PATH = "/api/v1/exports";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const WORKSPACE_EXPORT_RESOURCES = [
  { value: "subscribers", label: "Subscribers" },
  { value: "campaigns", label: "Campaigns" },
  { value: "automations", label: "Automations" },
  { value: "audit_log", label: "Audit log" },
  { value: "lists", label: "Lists & memberships" },
  { value: "tags", label: "Tags & memberships" },
  { value: "events", label: "Recent events" },
  { value: "templates", label: "Templates" },
  { value: "segments", label: "Segments" },
  { value: "forms", label: "Forms" },
  { value: "suppressions", label: "Suppressions" },
  { value: "consent", label: "Consent records" },
] as const;

export type WorkspaceExportResource =
  (typeof WORKSPACE_EXPORT_RESOURCES)[number]["value"];
export type WorkspaceExportStatus =
  | "queued"
  | "running"
  | "ready"
  | "failed"
  | "expired";

const RESOURCE_SET = new Set<string>(
  WORKSPACE_EXPORT_RESOURCES.map((resource) => resource.value),
);
const STATUS_SET = new Set<WorkspaceExportStatus>([
  "queued",
  "running",
  "ready",
  "failed",
  "expired",
]);

export class WorkspaceExportContractError extends Error {
  constructor(message = "Workspace export response did not match its contract.") {
    super(message);
    this.name = "WorkspaceExportContractError";
  }
}

export interface WorkspaceExport {
  id: string;
  status: WorkspaceExportStatus;
  include: WorkspaceExportResource[];
  requestedByEmail: string;
  bytesTotal: number;
  rowsTotal: number;
  downloadPath: string;
  expiresAt: string | null;
  error: string;
  createdAt: string;
}

export interface WorkspaceExportCreateReceipt {
  id: string;
  status: "queued";
  include: WorkspaceExportResource[];
}

interface ReadOptions {
  signal?: AbortSignal;
  fresh?: boolean;
}

export async function listWorkspaceExports(
  options: ReadOptions = {},
): Promise<WorkspaceExport[]> {
  const response = record(
    await api.get<unknown>(EXPORTS_PATH, readOptions(options)),
    "workspace exports response",
  );
  if (!Array.isArray(response.exports) || response.exports.length > 200) {
    throw contract("exports must be an array with no more than 200 rows");
  }
  const seen = new Set<string>();
  return response.exports.map((value, index) => {
    const parsed = parseWorkspaceExport(value, `exports[${index}]`);
    if (seen.has(parsed.id)) throw contract("exports contains duplicate ids");
    seen.add(parsed.id);
    return parsed;
  });
}

export async function getWorkspaceExport(
  id: string,
  options: ReadOptions = {},
): Promise<WorkspaceExport> {
  const safeID = uuid(id, "export id");
  return parseWorkspaceExport(
    await api.get<unknown>(`${EXPORTS_PATH}/${encodeURIComponent(safeID)}`, readOptions(options)),
    "workspace export response",
  );
}

export async function createWorkspaceExport(
  include: readonly WorkspaceExportResource[],
  options: { signal?: AbortSignal } = {},
): Promise<WorkspaceExportCreateReceipt> {
  if (!Array.isArray(include) || include.length === 0) {
    throw contract("at least one export resource must be selected");
  }
  const selected = parseResources(include, "include");
  const response = record(
    await api.post<unknown>(
      EXPORTS_PATH,
      { include: selected },
      {
        signal: options.signal,
        requireOnline: true,
        maxAttempts: 1,
      },
    ),
    "workspace export create response",
  );
  const status = text(response.status, "status", 16);
  if (status !== "queued") throw contract("create status must be queued");
  return {
    id: uuid(response.id, "id"),
    status,
    include: parseResources(response.include, "include"),
  };
}

/**
 * Performs the step-up/readiness HEAD preflight before browser navigation.
 * The following GET streams directly to disk and rechecks the same tenant,
 * role, object key, status and expiry server-side.
 */
export async function authorizeWorkspaceExportDownload(
  exportRecord: WorkspaceExport,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const safe = parseWorkspaceExport(
    {
      id: exportRecord.id,
      status: exportRecord.status,
      include: exportRecord.include,
      requested_by_email: exportRecord.requestedByEmail,
      bytes_total: exportRecord.bytesTotal,
      rows_total: exportRecord.rowsTotal,
      download_path: exportRecord.downloadPath,
      download_url: exportRecord.downloadPath,
      expires_at: exportRecord.expiresAt ?? "",
      error: exportRecord.error,
      created_at: exportRecord.createdAt,
    },
    "workspace export download",
  );
  if (safe.status !== "ready" || safe.downloadPath === "") {
    throw contract("export is not ready to download");
  }
  await api.head<void>(safe.downloadPath, {
    signal: options.signal,
    requireOnline: true,
    maxAttempts: 1,
    cache: "no-store",
  });
  return safe.downloadPath;
}

export function parseWorkspaceExport(
  value: unknown,
  label = "workspace export",
): WorkspaceExport {
  const row = record(value, label);
  const id = uuid(row.id, `${label}.id`);
  const statusRaw = text(row.status, `${label}.status`, 16);
  if (!STATUS_SET.has(statusRaw as WorkspaceExportStatus)) {
    throw contract(`${label}.status is unsupported`);
  }
  const status = statusRaw as WorkspaceExportStatus;
  const pathField = nullableText(
    row.download_path,
    `${label}.download_path`,
    256,
  );
  const urlField = nullableText(
    row.download_url,
    `${label}.download_url`,
    256,
  );
  if (pathField !== "" && urlField !== "" && pathField !== urlField) {
    throw contract(`${label} download route fields disagree`);
  }
  const downloadPath = nullableText(
    pathField || urlField,
    `${label}.download_path`,
    256,
  );
  const expectedPath = `${EXPORTS_PATH}/${encodeURIComponent(id)}/download`;
  if (downloadPath !== "" && downloadPath !== expectedPath) {
    throw contract(`${label}.download_path is not the authenticated export route`);
  }
  if (status !== "ready" && downloadPath !== "") {
    throw contract(`${label}.download_path is present before the export is ready`);
  }
  const expiresRaw = nullableText(row.expires_at, `${label}.expires_at`, 64);
  if (downloadPath !== "" && expiresRaw === "") {
    throw contract(`${label}.expires_at is required for a downloadable export`);
  }
  return {
    id,
    status,
    include: parseResources(row.include, `${label}.include`),
    requestedByEmail: nullableText(
      row.requested_by_email,
      `${label}.requested_by_email`,
      320,
    ),
    bytesTotal: integer(row.bytes_total, `${label}.bytes_total`),
    rowsTotal: integer(row.rows_total, `${label}.rows_total`),
    downloadPath,
    expiresAt:
      expiresRaw === "" ? null : timestamp(expiresRaw, `${label}.expires_at`),
    error: nullableText(row.error, `${label}.error`, 4_096),
    createdAt: timestamp(row.created_at, `${label}.created_at`),
  };
}

function parseResources(value: unknown, label: string): WorkspaceExportResource[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > WORKSPACE_EXPORT_RESOURCES.length
  ) {
    throw contract(`${label} must be a non-empty bounded resource array`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const resource = text(item, `${label}[${index}]`, 32);
    if (!RESOURCE_SET.has(resource)) throw contract(`${label} contains an unsupported resource`);
    if (seen.has(resource)) throw contract(`${label} contains duplicate resources`);
    seen.add(resource);
    return resource as WorkspaceExportResource;
  });
}

function readOptions(options: ReadOptions) {
  return {
    signal: options.signal,
    ...(options.fresh ? { cache: "no-store" as const, maxAttempts: 1 } : {}),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contract(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string") throw contract(`${label} must be a string`);
  if (new TextEncoder().encode(value).length > maxBytes) {
    throw contract(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function nullableText(value: unknown, label: string, maxBytes: number): string {
  if (value === null || value === undefined) return "";
  return text(value, label, maxBytes);
}

function uuid(value: unknown, label: string): string {
  const parsed = text(value, label, 36);
  if (!UUID_RE.test(parsed)) throw contract(`${label} must be a canonical UUID`);
  return parsed;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw contract(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!parsed || !Number.isFinite(Date.parse(parsed))) {
    throw contract(`${label} must be an ISO timestamp`);
  }
  return parsed;
}

function contract(message: string): WorkspaceExportContractError {
  return new WorkspaceExportContractError(message);
}
