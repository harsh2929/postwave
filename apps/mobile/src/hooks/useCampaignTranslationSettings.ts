/**
 * hooks/useCampaignTranslationSettings.ts — the tenant translation settings
 * and terminology dictionary, behind the campaign translations card.
 *
 * Reads (settings viewer / dictionary viewer) are enabled only while the
 * settings sheet is open — sheet queries never run for a card nobody opened.
 * Writes (PUT settings, dictionary upsert/delete — all ADMIN) and the LLM
 * preview (ADMIN, paid) are mutations; the preview is press-driven and never
 * cached, a stale rendering of a dictionary that has since changed misleads.
 *
 * ONLINE-ONLY writes: workspace-wide policy + shared dictionary rows (see
 * api/campaignTranslationSettingsApi for the replay hazard).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteTranslationDictionaryEntry,
  getTranslationSettings,
  listTranslationDictionary,
  previewTranslationRender,
  putTranslationSettings,
  upsertTranslationDictionaryEntry,
  type PutTranslationSettingsBody,
  type UpsertDictionaryEntryBody,
} from "@/api/campaignTranslationSettingsApi";
import { checkedApiResult } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  readDictionaryEntries,
  readTranslationPreview,
  readTranslationSettings,
  type TranslationDictionaryEntry,
  type TranslationPreviewReading,
  type TranslationSettingsReading,
} from "@/lib/campaignTranslationSettings";

const SETTINGS_KEY = "translation-settings";
const DICTIONARY_KEY = "translation-dictionary";

export function useTranslationSettings(options: { enabled: boolean }) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [SETTINGS_KEY, gate.tenantId],
    enabled: options.enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<TranslationSettingsReading | null> => {
      const res = await checkedApiResult(getTranslationSettings());
      return readTranslationSettings(res.data);
    },
  });
}

export function useTranslationDictionary(options: { enabled: boolean }) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [DICTIONARY_KEY, gate.tenantId],
    enabled: options.enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<TranslationDictionaryEntry[]> => {
      const res = await checkedApiResult(listTranslationDictionary());
      return readDictionaryEntries(res.data);
    },
  });
}

/** PUT the partial settings body. Admin. */
export function useTranslationSettingsWrite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: PutTranslationSettingsBody): Promise<void> => {
      await checkedApiResult(putTranslationSettings(body));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [SETTINGS_KEY] });
    },
  });
}

/** Upsert one dictionary entry (keyed by term server-side). Admin. */
export function useTranslationDictionaryUpsert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpsertDictionaryEntryBody): Promise<void> => {
      await checkedApiResult(upsertTranslationDictionaryEntry(body));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [DICTIONARY_KEY] });
    },
  });
}

/** Delete one dictionary entry by id. Admin, destructive. */
export function useTranslationDictionaryDelete() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await checkedApiResult(deleteTranslationDictionaryEntry(id));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [DICTIONARY_KEY] });
    },
  });
}

/** POST /translations/preview — the LLM round-trip, press-driven. Admin. */
export function useTranslationPreview() {
  return useMutation({
    mutationFn: async (input: {
      body: string;
      locale: string;
    }): Promise<TranslationPreviewReading> => {
      const res = await checkedApiResult(previewTranslationRender(input));
      const reading = readTranslationPreview(res.data);
      if (!reading) {
        throw new Error("The translator answered in an unexpected shape.");
      }
      return reading;
    },
  });
}
