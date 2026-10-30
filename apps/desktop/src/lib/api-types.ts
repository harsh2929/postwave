/**
 * api-types.ts — re-exports for the openapi-typescript codegen output.
 *
 * Moosewave is migrating its surface types away from the hand-written
 * interfaces in `api-client.ts` (16k+ LoC of drift-prone JSON typings)
 * toward a single source of truth: the OpenAPI 3.1 spec at
 * `packages/openapi/surfaces/openapi.yaml`. The generator
 * (`pnpm openapi:codegen`) writes
 * `packages/openapi/dist/types.ts`, which this file re-exports under
 * the canonical names callers used to import from `api-client.ts`.
 *
 * Migration strategy (p2-openapi-codegen):
 *   - Batch 1 (this file): subscribers, lists, campaigns, archive,
 *     and segment send-time insights. Generated types are exposed only
 *     under names and shapes that the runtime API actually implements.
 *   - Callers can opt in incrementally:
 *
 *         import { Subscriber } from "../lib/api-client";   // OLD
 *         import { Subscriber } from "../lib/api-types";    // NEW
 *
 *     Both work; once a page is fully migrated, the hand-written
 *     type in `api-client.ts` should be deleted in a follow-up PR.
 *   - The old types remain in place for now to keep the green build;
 *     deleting them in one shot would touch hundreds of files and
 *     conflict with adjacent in-flight work. See
 *     `packages/openapi/MIGRATION.md` for the full per-surface plan
 *     covering the remaining ~40 surfaces.
 *
 * IMPORTANT: do not hand-edit this file's *type bodies* — they are
 * sourced from `packages/openapi/dist/types.ts`. Add or change
 * surfaces by editing `packages/openapi/surfaces/openapi.yaml` and
 * running `pnpm openapi:codegen`. CI fails (`audit:openapi`) if the
 * spec is edited without regenerating.
 */

import type { components } from "@postwave/openapi/types";

/** Convenience re-export so callers can pull arbitrary schemas with
 *  `Schemas["Foo"]` without re-typing the deep `components.schemas`
 *  path. Lets us add new surfaces without changing the import shape. */
export type Schemas = components["schemas"];

// ---------------------------------------------------------------------
// Batch 1 — five typed surfaces.
// ---------------------------------------------------------------------

// Subscribers ---------------------------------------------------------
export type Subscriber = Schemas["Subscriber"];
export type SubscriberInput = Schemas["SubscriberInput"];
export type SubscriberPage = Schemas["SubscriberPage"];
export type SubscriberStatus = Schemas["SubscriberStatus"];
export type ConsentSource = Schemas["ConsentSource"];

// Lists ---------------------------------------------------------------
export type List = Schemas["List"];
export type ListPage = Schemas["ListPage"];
export type ListCreateInput = Schemas["ListCreateInput"];
export type ListUpdateInput = Schemas["ListUpdateInput"];
export type ListVisibility = Schemas["ListVisibility"];
export type ListOptin = Schemas["ListOptin"];

// Campaigns -----------------------------------------------------------
export type Campaign = Schemas["Campaign"];
export type CampaignCreateInput = Schemas["CampaignCreateInput"];
export type CampaignUpdateInput = Schemas["CampaignUpdateInput"];
export type CampaignReport = Schemas["CampaignReport"];
export type CampaignStatus = Schemas["CampaignStatus"];
export type CampaignPage = Schemas["CampaignPage"];
export type CampaignSendInput = Schemas["CampaignSendInput"];
export type SendTimeStrategy = Schemas["SendTimeStrategy"];

// Archive -------------------------------------------------------------
export type ArchiveEntry = Schemas["ArchiveEntry"];
export type ArchiveIssueSummary = Schemas["ArchiveIssueSummary"];
export type ArchivePage = Schemas["ArchivePage"];
export type PublicArchiveIndex = Schemas["PublicArchiveIndex"];
export type PublicArchiveEntry = Schemas["PublicArchiveEntry"];

// Segment send-time insights -----------------------------------------
export type SegmentBestSendTime = Schemas["SegmentBestSendTime"];
export type SegmentSendTimeHeatmap = Schemas["SegmentSendTimeHeatmap"];

// Tenant send-time optimization compatibility ------------------------
export type SendTimeOptSettings = Schemas["SendTimeOptSettings"];
export type SendTimeOptSettingsInput = Schemas["SendTimeOptSettingsInput"];
export type SendTimeOptHeatmap = Schemas["SendTimeOptHeatmap"];
export type SendTimeOptHeatmapCell = Schemas["SendTimeOptHeatmapCell"];
