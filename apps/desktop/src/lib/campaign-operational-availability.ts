/**
 * Campaign scheduling stays unavailable in client builds until the server has
 * a release-qualified, recoverable scheduler contract. Keep this shared with
 * every desktop schedule entry point so one surface cannot overstate what the
 * delivery system can currently guarantee.
 */
export const CAMPAIGN_SCHEDULING_AVAILABLE: boolean = false;

export const CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON =
  "Scheduling is temporarily unavailable while durable delivery and recovery are being verified. You can keep drafting and reviewing this campaign.";
