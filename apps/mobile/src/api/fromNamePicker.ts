/**
 * api/fromNamePicker.ts — GET /api/v1/from-name-picker.
 *
 * Mounted read-scoped (routeauth manifest: session_minimum_role "viewer",
 * api-key read:reports), so every signed-in role may read it — but the only
 * surface that renders it is the campaign identity sheet, which is already an
 * editor context. Parsing lives in lib/fromNamePicker so the rules are
 * node-testable; this module is only the URL and the envelope.
 */
import {
  parseFromNameSuggestions,
  type FromNameSuggestion,
} from "@/lib/fromNamePicker";

import { checkedApiResult, rawRequest } from "./request";

export async function fetchFromNameSuggestions(): Promise<
  FromNameSuggestion[]
> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", "/api/v1/from-name-picker"),
  );
  return parseFromNameSuggestions(res.data);
}
