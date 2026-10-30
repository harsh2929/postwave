/**
 * hooks/useFirewallAdmin.ts — the events and stats reads plus the two writes
 * behind the signup-firewall sheet.
 *
 * Reads are gated on `enabled` (the sheet being open) as well as the online
 * gate: the card on the Settings screen shows the settings row alone, and
 * twenty events plus two counters are not fetched for a sheet nobody opened.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getFirewallEvents,
  getFirewallStats,
  putFirewallSettings,
  runFirewallDetect,
} from "@/api/firewallAdmin";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { FirewallSettingsPatch } from "@/lib/firewallAdmin";
import type { FirewallSettingsView } from "@/lib/platformConfig";

/** Mirrors the read key in hooks/usePlatformConfig.ts, which is not exported. */
const SETTINGS_KEY = "mobile-firewall-settings";
const EVENTS_KEY = "mobile-firewall-events";
const STATS_KEY = "mobile-firewall-stats";
/** Desktop's EVENTS_LIMIT; one screen of the newest, not the whole log. */
export const FIREWALL_EVENTS_LIMIT = 20;

export function useFirewallEventsQuery(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [EVENTS_KEY, gate.tenantId, FIREWALL_EVENTS_LIMIT],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    // A live diagnostic — short staleness, but not a poll; the operator
    // pulls the sheet again deliberately.
    staleTime: 15_000,
    queryFn: () => getFirewallEvents(FIREWALL_EVENTS_LIMIT),
  });
}

export function useFirewallStatsQuery(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [STATS_KEY, gate.tenantId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: 15_000,
    queryFn: getFirewallStats,
  });
}

function useInvalidateFirewall() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [SETTINGS_KEY, gate.tenantId] });
    void qc.invalidateQueries({ queryKey: [EVENTS_KEY, gate.tenantId] });
    void qc.invalidateQueries({ queryKey: [STATS_KEY, gate.tenantId] });
  };
}

export function useSaveFirewallSettings() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  const invalidate = useInvalidateFirewall();
  return useMutation<FirewallSettingsView, Error, FirewallSettingsPatch>({
    mutationFn: putFirewallSettings,
    onSuccess: (next) => {
      qc.setQueryData([SETTINGS_KEY, gate.tenantId], next);
      invalidate();
    },
  });
}

/**
 * The manual surge sweep. A flip changes the settings row AND writes no
 * event, so settings are invalidated on every outcome — the sheet must not
 * keep saying "Off" after the server just armed it.
 */
export function useRunFirewallDetect() {
  const invalidate = useInvalidateFirewall();
  return useMutation<{ flipped: boolean }, Error, void>({
    mutationFn: () => runFirewallDetect(),
    onSuccess: invalidate,
  });
}
