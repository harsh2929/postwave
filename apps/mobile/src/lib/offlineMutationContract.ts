export const OFFLINE_MUTATION_KEYS = {
  campaignUpdate: ["campaign", "update"] as const,
  sequenceCreate: ["sequence", "create"] as const,
  sequenceSave: ["sequence", "save"] as const,
  /**
   * The GENERIC queued write (NATIVE#1). One key for every route shape
   * allowlisted by lib/offlineQueueSafety.ts, so a screen opts into offline
   * support by using this mutationKey + offlineSafeMutationMeta rather than by
   * adding another bespoke executor.
   */
  entityWrite: ["offline", "entity-write"] as const,
};

export interface OfflineMutationAuthScope {
  baseUrl: string;
  tenantId: string;
  principalId: string;
  role: string;
  queuedAt: number;
  expiresAt: number;
  /**
   * The server's context epoch when this write was queued.
   *
   * Optional: a record persisted by a build that predates the field has none,
   * and the app may not have seen a response carrying the header yet (launched
   * offline). Absent on either side means "cannot tell", never "changed" —
   * refusing on an unknown would dead-letter the whole queue on every cold
   * start, which is the work the queue exists to protect.
   */
  contextEpoch?: string;
}
