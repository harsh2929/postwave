/**
 * hooks/useFormDetailQueries.ts — the form-detail screen's four reads, split
 * from the route at its complexity budget. The `enabled` clauses are the
 * content here: everything is gated on the online session + tenant + id, and
 * the two PII-adjacent reads (submissions, embed) additionally on an admin
 * role — we do not ASK for PII the role cannot have.
 */
import { useQuery } from "@tanstack/react-query";

import {
  getForm,
  getFormAnalytics,
  getFormEmbed,
  listFormSubmissions,
} from "@/api/forms";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export const FORM_DETAIL_WINDOW_DAYS = 30;

export function useFormDetailQueries(
  id: string | undefined,
  gate: OnlineQueryGate,
  isAdmin: boolean,
) {
  const baseEnabled = gate.enabled && Boolean(gate.tenantId && id);
  const form = useQuery({
    queryKey: ["form", gate.tenantId, id],
    queryFn: () => getForm(id ?? ""),
    enabled: baseEnabled,
  });
  const analytics = useQuery({
    queryKey: ["form-analytics", gate.tenantId, id, FORM_DETAIL_WINDOW_DAYS],
    queryFn: () => getFormAnalytics(id ?? "", FORM_DETAIL_WINDOW_DAYS),
    enabled: baseEnabled,
  });
  const submissions = useQuery({
    enabled: baseEnabled && isAdmin,
    queryKey: ["form-submissions", gate.tenantId, id],
    queryFn: () => listFormSubmissions(id ?? "", 15),
  });
  const embed = useQuery({
    enabled: baseEnabled && isAdmin,
    queryKey: ["form-embed", gate.tenantId, id],
    queryFn: () => getFormEmbed(id ?? ""),
  });
  return { form, analytics, submissions, embed };
}
