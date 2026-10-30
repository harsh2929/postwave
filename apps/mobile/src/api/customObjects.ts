/**
 * api/customObjects.ts — the two READ routes of the custom-objects surface.
 *
 * ROUTES (apps/api/internal/customobjects/handlers.go:44-59, and the generated
 * policy manifest):
 *
 *   GET /api/v1/custom-objects/types              read · session viewer
 *   GET /api/v1/custom-objects/types/{id}/records read · session viewer
 *
 * THE WRITES ARE NOT HERE AND WILL NOT BE. Creating, editing and deleting a
 * TYPE are admin routes that the mobile ledger records as deliberately absent —
 * "changing a definition retypes data across everything that uses it". Record
 * upsert/delete are admin too. This module exposes reads only.
 *
 * THE ONE URL RULE. `ListRecords` rejects every query parameter except `limit`
 * (handlers.go:190-201), and rejects `property`/`value` with a specific code
 * because exact property values are customer data that must never enter URLs,
 * access logs or referrer headers. Filtering therefore belongs to the POST
 * search route and is not offered here — this module sends `limit` and nothing
 * else, so the phone cannot be the thing that leaks a value into a log line.
 */
import {
  parseCustomObjectRecords,
  parseCustomObjectTypes,
  type CustomObjectRecordsPage,
  type CustomObjectType,
} from "@/lib/customObjectRecords";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

/**
 * How many records one phone screen reads.
 *
 * The server's own default is 100 (`defaultRecordPageSize`,
 * input_validation.go:37) and its ceiling 500 (`parseRecordLimit`,
 * handlers.go:411-429). 25 is a deliberate reduction for the same reason the
 * commerce order list uses it: this is a look-up, not a browse, and every row
 * not fetched is a row not paid for over cellular.
 */
export const CUSTOM_OBJECT_RECORDS_PAGE_SIZE = 25;

/** Keeps the HTTP status and code so the UI can tell a 400 from a 403. */
export class CustomObjectsRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "CustomObjectsRequestError";
  }
}

async function customObjectsRequest<T>(
  path: string,
  label: string,
): Promise<T | null> {
  const res = await rawRequest<T>("GET", path);
  if (res.error) throw new CustomObjectsRequestError(res.error, label);
  return res.data;
}

export async function listCustomObjectTypes(): Promise<CustomObjectType[]> {
  const raw = await customObjectsRequest<unknown>(
    "/api/v1/custom-objects/types",
    "Loading object types",
  );
  return parseCustomObjectTypes(raw);
}

export async function listCustomObjectRecords(
  typeId: string,
  limit: number = CUSTOM_OBJECT_RECORDS_PAGE_SIZE,
): Promise<CustomObjectRecordsPage> {
  const id = (typeId ?? "").trim();
  if (!id) throw new Error("An object type is required to read its records.");
  const params = new URLSearchParams({ limit: String(limit) });
  const raw = await customObjectsRequest<unknown>(
    `/api/v1/custom-objects/types/${encodeURIComponent(id)}/records?${params.toString()}`,
    "Loading records",
  );
  return parseCustomObjectRecords(raw);
}
