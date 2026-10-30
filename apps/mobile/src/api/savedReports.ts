/**
 * api/savedReports.ts — the four reporting routes a phone should call, and no
 * others.
 *
 * Scopes read from apps/api/internal/reporting/reporting.go:120-133, not from
 * openapi.json:
 *
 *   GET  /api/v1/reporting/definitions            ScopeReadReports  (:126)
 *   GET  /api/v1/reporting/runs                   ScopeReadReports  (:130)
 *   GET  /api/v1/reporting/runs/{id}/export.json  ScopeReadReports  (:133)
 *   POST /api/v1/reporting/definitions/{id}/runs  ScopeAdmin        (:129)
 *
 * `POST /api/v1/reporting/definitions` (ScopeAdmin, :127) is deliberately NOT
 * wrapped: authoring a metric definition is desk work and a phone client that
 * could create one would be inviting it.
 *
 * The export route answers `application/json` with a
 * `Content-Disposition: attachment` header (reporting.go:327-328). The
 * attachment header is irrelevant to a JSON client — the body is still JSON
 * and is parsed normally — but it is why this is the SHAREABLE artefact rather
 * than the run row: `RunResultToJSON` (export.go:16-37) is the server's own
 * canonical serialisation, so a receipt copied from a phone and one downloaded
 * from the web admin are byte-comparable documents.
 *
 * `export.csv` is deliberately not called: it answers `text/csv`, which the
 * shared JSON client would have to be taught to pass through, and the JSON
 * export carries the same rows.
 */
import {
  parseDefinitions,
  parseRun,
  parseRuns,
  type SavedReportDefinition,
  type SavedReportRun,
} from "@/lib/savedReports";

import { rawRequest, type AIApiError } from "./request";

/**
 * How many definitions and runs a phone reads.
 *
 * The server would give 200 definitions and 100 runs unasked
 * (`ReadParamsWithDefault`, reporting.go:188 and :258). A phone showing a
 * saved-report shortlist needs neither, and every row not fetched is a row not
 * paid for over cellular.
 */
export const SAVED_REPORTS_PAGE_SIZE = 25;
export const SAVED_REPORT_RUNS_PAGE_SIZE = 50;

export class SavedReportError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "SavedReportError";
    this.status = error.status;
    this.code = error.code;
  }
}

async function reportRequest<T>(
  method: string,
  path: string,
  label: string,
  body?: unknown,
): Promise<T | null> {
  const res = await rawRequest<T>(method, path, body);
  if (res.error) throw new SavedReportError(res.error, label);
  return res.data;
}

export async function listSavedReportDefinitions(): Promise<
  SavedReportDefinition[]
> {
  const raw = await reportRequest<unknown>(
    "GET",
    `/api/v1/reporting/definitions?limit=${SAVED_REPORTS_PAGE_SIZE}`,
    "Loading saved reports",
  );
  return parseDefinitions(raw);
}

/**
 * Recent runs, TENANT-WIDE.
 *
 * There is no per-definition runs route — `ListRuns` (reporting.go:250) takes
 * no definition filter — so the client reads one page and matches locally with
 * `latestRunFor`. That is why the page size here is larger than the definition
 * page: a workspace with 20 definitions needs enough run history for most of
 * them to find their own latest.
 */
export async function listSavedReportRuns(): Promise<SavedReportRun[]> {
  const raw = await reportRequest<unknown>(
    "GET",
    `/api/v1/reporting/runs?limit=${SAVED_REPORT_RUNS_PAGE_SIZE}`,
    "Loading report runs",
  );
  return parseRuns(raw);
}

/**
 * Run a saved definition.
 *
 * The 202 is misleading and the caller must not repeat it: `RunDefinition`
 * executes the preview inline and inserts the row already `completed`
 * (reporting/repo.go:234-270). The parsed run is therefore a FINISHED run,
 * which is why this returns it rather than void.
 */
export async function runSavedReport(
  definitionId: string,
): Promise<SavedReportRun | null> {
  const id = (definitionId ?? "").trim();
  if (!id) throw new Error("A report id is required to run it.");
  const raw = await reportRequest<unknown>(
    "POST",
    `/api/v1/reporting/definitions/${encodeURIComponent(id)}/runs`,
    "Running the report",
    {},
  );
  return parseRun(raw);
}

/** The server's canonical JSON export of one completed run. */
export async function fetchSavedReportExport(
  runId: string,
): Promise<unknown> {
  const id = (runId ?? "").trim();
  if (!id) throw new Error("A run id is required to export it.");
  return reportRequest<unknown>(
    "GET",
    `/api/v1/reporting/runs/${encodeURIComponent(id)}/export.json`,
    "Exporting the run",
  );
}
