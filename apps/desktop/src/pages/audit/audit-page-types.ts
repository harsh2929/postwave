import type {
  ActionCategory,
  ActorType,
  DayRange,
} from "../../components/audit/AuditFilters";

export interface PersistedAuditFilters {
  actorType?: ActorType;
  actorLabel?: string;
  actionQuery?: string;
  resourceType?: string;
  resourceId?: string;
  days?: DayRange;
  category?: ActionCategory;
}

export interface AuditFilterArgs {
  actorType?: string;
  actorLabel?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  since?: string;
}

export type AuditViewMode = "list" | "timeline" | "heatmap" | "calendar";

export type AuditFacetField = "actor" | "ip" | "resource";

export interface AuditExcludeFacet {
  field: AuditFacetField;
  value: string;
}

export type AuditTimeFacet =
  | { kind: "day"; dateIso: string }
  | { kind: "dowHour"; dow: number; hour: number };

export type AuditCountConfidence = "exact" | "approximate";
