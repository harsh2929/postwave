/** Supported comparison windows for Dashboard aggregate statistics. */
export type DashboardRange = "7d" | "30d" | "90d";

/**
 * Aggregate evidence for the equally sized window immediately preceding the
 * selected Dashboard range.
 */
export interface DashboardPreviousWindow {
  subscribers_added?: number;
  subscribers_unsubbed?: number;
  campaigns_sent?: number;
  /** Gross sent-event count retained for volume reporting. */
  emails_sent?: number;
  opens_total?: number;
  clicks_total?: number;
  bounces_total?: number;
  /** Distinct campaign-recipient numerators for truthful previous rates. */
  unique_opens?: number;
  unique_clicks?: number;
  unique_bounces?: number;
  /** Preferred open/click denominator when it covers the numerator. */
  unique_delivered?: number;
  /** Open/click fallback and bounce-rate denominator. */
  unique_sent?: number;
}

export interface AuditEvent {
  id?: string;
  action?: string;
  actor?: string;
  at?: string;
  description?: string;
}

export interface DashboardStatsResponse {
  /** Legacy nested shape retained for forward compatibility. */
  subscribers?: {
    total?: number;
    delta_30d?: number;
  };
  open_rate?: {
    rate?: number;
    delta?: number;
  };
  campaigns_sent?: {
    this_month?: number;
    delta?: number;
  };
  active_sequences?: {
    count?: number;
    delta?: number;
  };
  inbox_health?: {
    score?: number;
    state?: string;
  } | null;
  recent_audit?: AuditEvent[];

  range?: DashboardRange;
  previous?: DashboardPreviousWindow;
  sparklines?: Record<string, number[]>;
  anomalies?: Record<string, boolean>;

  /** Gross sent-event volume retained for backwards-compatible reporting. */
  emails_sent_30d?: number;
  /** Distinct campaign-recipient numerators used by verified rates. */
  unique_opens_30d?: number;
  unique_clicks_30d?: number;
  unique_bounces_30d?: number;
  /** Preferred open/click denominator when it covers the numerator. */
  unique_delivered_30d?: number;
  /** Open/click fallback and bounce-rate denominator. */
  unique_sent_30d?: number;
  /** Count of active voice sequences in the workspace. */
  active_sequences_count?: number;

  /** Future server fields remain available to defensive runtime validation. */
  [key: string]: unknown;
}
