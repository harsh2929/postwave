// SPDX-License-Identifier: AGPL-3.0-only
//
// Anonymous public status endpoint. This deliberately omits credentials so
// public status responses are never keyed by dashboard cookies.

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";

export interface PublicStatusServiceSummary {
  service: string;
  status: "ok" | "degraded" | "down";
  uptime_30d: number;
  last_pinged_at: string;
  latency_ms: number;
  http_status?: number;
}

export interface PublicStatusIncident {
  id: string;
  title: string;
  description?: string;
  severity: "minor" | "major" | "critical";
  status: "investigating" | "identified" | "monitoring" | "resolved";
  affected_services: string[];
  started_at: string;
  resolved_at?: string;
}

export interface PublicStatusHistoryDay {
  day: string;
  uptime: number;
  incidents: number;
}

export interface PublicStatus {
  overall_status: "ok" | "degraded" | "down";
  services: PublicStatusServiceSummary[];
  active_incidents: PublicStatusIncident[];
  recent_incidents: PublicStatusIncident[];
  history_90d: Record<string, PublicStatusHistoryDay[]>;
  generated_at: string;
}

const EMPTY_STATUS: PublicStatus = {
  // An unavailable status API is itself an outage signal. Never fabricate
  // an all-green banner precisely when the source of truth cannot be reached.
  overall_status: "down",
  services: [],
  active_incidents: [],
  recent_incidents: [],
  history_90d: {},
  generated_at: "",
};

export async function fetchPublicStatus(): Promise<PublicStatus> {
  if (isMockModeEnabled()) return mockPublicStatus();
  try {
    const data = await api.get<Partial<PublicStatus>>("/api/public/status", {
      credentials: "omit",
      cache: typeof window === "undefined" ? "force-cache" : "default",
      ...(typeof window === "undefined" ? { next: { revalidate: 30 } } : {}),
      // This anonymous page is itself an outage surface. Do one bounded probe
      // and render the explicit down state promptly instead of adding generic
      // retry backoff to document TTFB when the status API is unavailable.
      maxAttempts: 1,
      timeoutMs: 500,
      requireOnline: true,
    });
    return normalizePublicStatus(data);
  } catch {
    // Status page must always render. If the API is unreachable, show an empty
    // snapshot rather than a 5xx error page.
    return EMPTY_STATUS;
  }
}

/** Treat the anonymous endpoint as untrusted input. A malformed partial
 * snapshot should degrade into the explicit unknown UI, never crash the
 * status page or manufacture a green claim. */
export function normalizePublicStatus(value: unknown): PublicStatus {
  const data = asRecord(value);
  if (!data || !isOverallStatus(data.overall_status)) {
    return emptyPublicStatus();
  }

  const services = Array.isArray(data.services)
    ? data.services.slice(0, 100).flatMap((item) => {
        const service = asRecord(item);
        if (
          !service ||
          typeof service.service !== "string" ||
          !service.service.trim() ||
          !isServiceStatus(service.status)
        ) {
          return [];
        }
        return [
          {
            service: service.service.trim().slice(0, 160),
            status: service.status,
            uptime_30d: boundedNumber(service.uptime_30d, 0, 1),
            last_pinged_at: stringValue(service.last_pinged_at),
            latency_ms: boundedNumber(service.latency_ms, 0, 3_600_000),
            ...(Number.isFinite(service.http_status)
              ? {
                  http_status: Math.round(
                    boundedNumber(service.http_status, 0, 999),
                  ),
                }
              : {}),
          },
        ];
      })
    : [];

  const normalizeIncidents = (input: unknown): PublicStatusIncident[] =>
    Array.isArray(input)
      ? input.slice(0, 100).flatMap((item) => {
          const incident = asRecord(item);
          if (
            !incident ||
            typeof incident.id !== "string" ||
            typeof incident.title !== "string" ||
            !isIncidentSeverity(incident.severity) ||
            !isIncidentStatus(incident.status)
          ) {
            return [];
          }
          return [
            {
              id: incident.id.slice(0, 200),
              title: incident.title.slice(0, 500),
              ...(typeof incident.description === "string"
                ? { description: incident.description.slice(0, 5_000) }
                : {}),
              severity: incident.severity,
              status: incident.status,
              affected_services: Array.isArray(incident.affected_services)
                ? incident.affected_services
                    .filter(
                      (service): service is string =>
                        typeof service === "string" && Boolean(service.trim()),
                    )
                    .slice(0, 100)
                    .map((service) => service.trim().slice(0, 160))
                : [],
              started_at: stringValue(incident.started_at),
              ...(typeof incident.resolved_at === "string"
                ? { resolved_at: incident.resolved_at }
                : {}),
            },
          ];
        })
      : [];

  const history_90d: PublicStatus["history_90d"] = {};
  const rawHistory = asRecord(data.history_90d);
  if (rawHistory) {
    for (const [service, input] of Object.entries(rawHistory).slice(0, 100)) {
      if (!Array.isArray(input)) continue;
      history_90d[service.slice(0, 160)] = input
        .slice(-90)
        .flatMap((item): PublicStatusHistoryDay[] => {
          const day = asRecord(item);
          if (!day || typeof day.day !== "string") return [];
          return [
            {
              day: day.day.slice(0, 32),
              uptime: boundedNumber(day.uptime, 0, 1),
              incidents: Math.round(boundedNumber(day.incidents, 0, 1_000_000)),
            },
          ];
        });
    }
  }

  return {
    overall_status: data.overall_status,
    services,
    active_incidents: normalizeIncidents(data.active_incidents),
    recent_incidents: normalizeIncidents(data.recent_incidents),
    history_90d,
    generated_at: stringValue(data.generated_at),
  };
}

function emptyPublicStatus(): PublicStatus {
  return {
    ...EMPTY_STATUS,
    services: [],
    active_incidents: [],
    recent_incidents: [],
    history_90d: {},
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boundedNumber(value: unknown, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : 0;
}

function isOverallStatus(
  value: unknown,
): value is PublicStatus["overall_status"] {
  return value === "ok" || value === "degraded" || value === "down";
}

function isServiceStatus(
  value: unknown,
): value is PublicStatusServiceSummary["status"] {
  return value === "ok" || value === "degraded" || value === "down";
}

function isIncidentSeverity(
  value: unknown,
): value is PublicStatusIncident["severity"] {
  return value === "minor" || value === "major" || value === "critical";
}

function isIncidentStatus(
  value: unknown,
): value is PublicStatusIncident["status"] {
  return (
    value === "investigating" ||
    value === "identified" ||
    value === "monitoring" ||
    value === "resolved"
  );
}

/** Dense deterministic demo data for qualifying every public status surface.
 * Dates track the current day so relative timestamps remain credible. */
function mockPublicStatus(): PublicStatus {
  const now = Date.now();
  const generatedAt = new Date(now - 24_000).toISOString();
  const serviceConfigs: Array<{
    service: string;
    status: PublicStatusServiceSummary["status"];
    uptime: number;
    latency: number;
  }> = [
    { service: "API", status: "ok", uptime: 0.9999, latency: 82 },
    { service: "Web app", status: "ok", uptime: 1, latency: 118 },
    { service: "Email sending", status: "ok", uptime: 0.9997, latency: 147 },
    {
      service: "Deliverability checks",
      status: "degraded",
      uptime: 0.9876,
      latency: 364,
    },
    { service: "Automations", status: "ok", uptime: 0.9994, latency: 96 },
  ];

  const history_90d: PublicStatus["history_90d"] = {};
  for (const config of serviceConfigs) {
    history_90d[config.service] = Array.from({ length: 90 }, (_, index) => {
      const date = new Date(now - (89 - index) * 86_400_000);
      const isDeliverabilityEvent =
        config.service === "Deliverability checks" && index >= 87;
      const isHistoricalBlip = index === 38 && config.service === "API";
      return {
        day: date.toISOString().slice(0, 10),
        uptime: isDeliverabilityEvent
          ? 0.94 + index / 10_000
          : isHistoricalBlip
            ? 0.982
            : config.uptime,
        incidents: isDeliverabilityEvent || isHistoricalBlip ? 1 : 0,
      };
    });
  }

  return {
    overall_status: "degraded",
    generated_at: generatedAt,
    services: serviceConfigs.map((config, index) => ({
      service: config.service,
      status: config.status,
      uptime_30d: config.uptime,
      last_pinged_at: new Date(now - (18 + index * 7) * 1_000).toISOString(),
      latency_ms: config.latency,
      http_status: 200,
    })),
    active_incidents: [
      {
        id: "incident_deliverability_latency",
        title: "Some inbox-placement checks are completing slowly",
        description:
          "New checks are still processing. Results may arrive later than usual while we drain the delayed queue.",
        severity: "minor",
        status: "monitoring",
        affected_services: ["Deliverability checks"],
        started_at: new Date(now - 52 * 60_000).toISOString(),
      },
    ],
    recent_incidents: [
      {
        id: "incident_api_latency_resolved",
        title: "Elevated API latency in the Asia-Pacific region",
        description: "Traffic was rebalanced and latency returned to normal.",
        severity: "minor",
        status: "resolved",
        affected_services: ["API"],
        started_at: new Date(now - 11 * 86_400_000).toISOString(),
        resolved_at: new Date(
          now - 11 * 86_400_000 + 41 * 60_000,
        ).toISOString(),
      },
    ],
    history_90d,
  };
}
