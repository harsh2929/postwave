/**
 * hooks/useVoiceTemplates.ts — read + write the shared template library.
 *
 * The list read is `read:campaigns` (viewer and above); delete is `admin`;
 * generate is `write:campaigns` (editor) and spends AI budget, so it is a
 * mutation the operator presses, never a query that fires on mount.
 *
 * The category filter is applied CLIENT-SIDE (lib/filterVoiceTemplates) over a
 * single unfiltered fetch. The server does accept ?category=, but the library
 * is a bounded starter set and re-fetching per chip would turn a filter tap
 * into a round trip — and, on a flaky phone link, into an empty list that
 * looks like "this category has nothing".
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteVoiceTemplate,
  generateVoiceTemplate,
  listVoiceTemplates,
} from "@/api/voiceTemplates";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseGeneratedTemplate,
  parseVoiceTemplates,
  voiceTemplateWriteErrorMessage,
  voiceTemplatesErrorMessage,
  type GeneratedTemplate,
  type TemplateGenerateBody,
  type VoiceTemplateWire,
} from "@/lib/voiceTemplates";

export function useVoiceTemplates(enabled = true) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["voice-templates", gate.tenantId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    // A starter library changes when an admin edits it, not minute to minute.
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<VoiceTemplateWire[]> => {
      const res = await listVoiceTemplates();
      if (res.error) {
        throw new Error(
          voiceTemplatesErrorMessage(res.error.status, res.error.message),
        );
      }
      return parseVoiceTemplates(res.data);
    },
  });
}

export function useGenerateVoiceTemplate() {
  return useMutation({
    mutationFn: async (
      body: TemplateGenerateBody,
    ): Promise<GeneratedTemplate> => {
      const res = await generateVoiceTemplate(body);
      if (res.error) {
        throw new Error(
          voiceTemplateWriteErrorMessage(res.error.status, res.error.message),
        );
      }
      const parsed = parseGeneratedTemplate(res.data);
      if (!parsed) {
        // A 200 with nothing usable is a failure, not an empty draft.
        throw new Error("The generator returned nothing usable.");
      }
      return parsed;
    },
  });
}

export function useDeleteVoiceTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await deleteVoiceTemplate(id);
      if (res.error) {
        throw new Error(
          voiceTemplateWriteErrorMessage(res.error.status, res.error.message),
        );
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["voice-templates"] });
    },
  });
}
