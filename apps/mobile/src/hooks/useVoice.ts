/**
 * hooks/useVoice.ts — voice-profile query + rebuild for the mounted backend
 * contract.
 *
 * Endpoints:
 *   GET  /api/v1/voice/profile        (read:campaigns)
 *   POST /api/v1/voice/profile/build  (write:campaigns + expensiveTenantLimit)
 *
 * The type below mirrors services/voice/internal/profile/types.go in full.
 * It used to declare 2 of the server's 8 payload sections, so six analytical
 * dimensions the backend already computes were fetched over the wire and
 * thrown away.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getBrandVoiceProfile,
  putBrandVoiceProfile,
} from "@/api/brandVoice";
import { getClient } from "@/api/client";
import { statusFromError } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import { loadOfflineCapableSnapshot } from "@/lib/offlineSnapshots";
import { projectVoiceProfileSnapshot } from "@/lib/sequenceSnapshot";
import {
  vaultGetJSON,
  vaultScopeForClient,
  vaultSetJSON,
} from "@/lib/secureVault";
import {
  brandVoiceErrorMessage,
  normalizeBrandVoiceProfile,
  type BrandVoiceProfile,
} from "@/lib/brandVoice";

export interface VoiceTermWeight {
  term: string;
  score?: number;
}

export interface VoicePhraseFreq {
  phrase: string;
  n?: number;
  count?: number;
}

export interface VoiceSampleWire {
  id?: string;
  source_type?: string;
  text?: string;
  tokens?: number;
  weight?: number;
}

export interface VoiceSourceStat {
  word_count?: number;
  item_count?: number;
  last_ingested_at?: string;
}

export type VoiceProfile = {
  tenant_id?: string;
  version?: number;
  generated_at: string;
  stylistic?: {
    avg_sentence_length?: number;
    sentence_length_variance?: number;
    avg_paragraph_length?: number;
    formality_score?: number;
    hedging_frequency?: number;
    passive_voice_pct?: number;
  };
  vocabulary?: {
    distinctive_terms?: VoiceTermWeight[];
    recurring_phrases?: VoicePhraseFreq[];
    idiom_markers?: string[];
    metaphor_patterns?: string[];
  };
  structural?: {
    opening_hook_style?: string;
    closing_pattern?: string;
    bullet_list_usage_rate?: number;
    markdown_style_hint?: string;
  };
  tonal: {
    humor: number;
    optimism: number;
    personal_vs_observational: number;
    directness: number;
    formality?: number;
    warmth?: number;
  };
  persona: {
    pronoun_usage?: Record<string, number>;
    self_disclosure_rate?: number;
    recurring_themes?: string[];
  };
  representative_samples?: VoiceSampleWire[];
  source_summary?: Record<string, VoiceSourceStat>;
  semantic_model?: string;
};

/**
 * Identity-scoped vault scope, or null when the session has no human
 * user/role boundary (api-key mode). Mirrors hooks/useSequences.
 */
function voiceSnapshotScope(gate: {
  baseUrl: string | null;
  tenantId: string | null;
  userId: string | null;
  effectiveRole: string | null;
}): string | null {
  const { baseUrl, tenantId, userId, effectiveRole } = gate;
  if (!baseUrl || !tenantId || !userId || !effectiveRole) return null;
  try {
    return vaultScopeForClient({
      baseUrl,
      tenantId,
      userId,
      role: effectiveRole,
    });
  } catch {
    return null;
  }
}

export interface VoiceProfilePayload {
  profile: VoiceProfile | null;
  /** True when this came from the vault rather than the network. */
  fromSnapshot: boolean;
}

/**
 * The measured profile, cold-offline capable.
 *
 * `null` profile means "no profile has been built yet" — a legitimate empty,
 * distinct from a fault. A 404/204 therefore resolves to a payload with a null
 * profile rather than throwing, and is NOT written to the vault: a workspace
 * that has not built a profile has nothing worth storing, and writing null
 * would be indistinguishable from having no snapshot at all.
 */
export function useVoiceProfile() {
  const gate = useOnlineQueryGate();
  const scope = voiceSnapshotScope(gate);
  return useQuery({
    queryKey: [
      "voice-profile",
      gate.tenantId,
      gate.userId,
      gate.effectiveRole,
      gate.enabled ? "network" : "snapshot",
    ],
    enabled:
      (gate.enabled && Boolean(gate.tenantId)) ||
      (gate.canReadOfflineSnapshots && Boolean(scope)),
    networkMode: "always",
    queryFn: (): Promise<VoiceProfilePayload> =>
      loadOfflineCapableSnapshot<VoiceProfilePayload>({
        canUseNetwork: gate.enabled,
        loadNetwork: async () => {
          const { client } = getClient();
          try {
            const profile = await client.request<VoiceProfile>(
              "GET",
              "/api/v1/voice/profile",
            );
            return { profile, fromSnapshot: false };
          } catch (err) {
            // 404/204 = no profile yet (legitimately empty → null). ANY other
            // error (500 / timeout / offline) must surface as isError, not be
            // swallowed into a false "No voice profile yet" empty state.
            const status = statusFromError(err);
            if (status === 404 || status === 204) {
              return { profile: null, fromSnapshot: false };
            }
            throw err;
          }
        },
        readSnapshot: async () => {
          if (!scope) return null;
          const cached = await vaultGetJSON<VoiceProfile>("voice", "profile", {
            scope,
          });
          return cached ? { profile: cached, fromSnapshot: true } : null;
        },
        writeSnapshot: async (payload) => {
          if (!scope || payload.fromSnapshot || !payload.profile) return;
          const projected = projectVoiceProfileSnapshot(payload.profile);
          if (!projected) return;
          await vaultSetJSON("voice", "profile", projected, { scope });
        },
        networkAvailable: isProbablyOnline,
        unavailableMessage:
          "No saved copy of your voice profile is stored on this device yet.",
      }),
  });
}

/**
 * Human message for a failed profile build.
 *
 * The build route sits behind `expensiveTenantLimit`, so 429 is a real,
 * well-defined outcome rather than a fault: it means "you already asked
 * recently". Rendering it as a generic error invites the user to hammer the
 * button; naming it as a cooldown does not.
 */
export function voiceBuildErrorMessage(err: unknown): string {
  const status = statusFromError(err);
  if (status === 429) {
    return "Rebuild is rate-limited for this workspace. Wait a few minutes and try again.";
  }
  if (status === 403) {
    return "Your role can't rebuild the voice profile. Ask an admin.";
  }
  if (status === 404 || status === 501) {
    return "This deployment doesn't expose voice-profile builds.";
  }
  if (status === 503) {
    return "The voice service is unavailable right now. Try again shortly.";
  }
  return err instanceof Error && err.message
    ? err.message
    : "Couldn't start the rebuild.";
}

/**
 * POST /api/v1/voice/profile/build.
 *
 * Deliberately NOT queued for offline replay: a build is an expensive,
 * rate-limited server-side job, and silently firing one when the phone
 * reconnects hours later is not what the operator asked for. The caller
 * disables the affordance while the online gate is closed.
 */
export function useBuildVoiceProfile() {
  return useMutation({
    mutationFn: async (): Promise<void> => {
      const { client } = getClient();
      await client.request("POST", "/api/v1/voice/profile/build", {});
    },
  });
}

/* ------------------------------------------------------------------ *
 * Authored brand voice — GET/PUT /api/v1/voice/brand-profile
 *
 * Deliberately a SEPARATE query from useVoiceProfile: the two rows have
 * different owners (one is measured by the server, one is typed by an
 * operator), different scopes (read:campaigns vs admin to write), and
 * different empty meanings. Folding them into one query would make an
 * absent authored row look like a missing measurement.
 * ------------------------------------------------------------------ */

export const BRAND_VOICE_QUERY_KEY = "brand-voice-profile" as const;

export function useBrandVoiceProfile() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [BRAND_VOICE_QUERY_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<BrandVoiceProfile | null> => {
      const res = await getBrandVoiceProfile();
      // A 404 is "authored nothing yet" — a legitimate empty, already
      // separated from a transport fault by the api module.
      if (res.error) {
        const err = new Error(
          brandVoiceErrorMessage(res.error.status, res.error.message),
        );
        (err as Error & { status?: number }).status = res.error.status;
        throw err;
      }
      return normalizeBrandVoiceProfile(res.profile);
    },
  });
}

/**
 * PUT is a full replace, so the caller passes every array — including the
 * sample snippets it is not editing. See api/brandVoice.ts.
 */
export function useSaveBrandVoiceProfile() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      descriptors: string[];
      writingRules: string[];
      sampleSnippets: string[];
    }): Promise<BrandVoiceProfile | null> => {
      const res = await putBrandVoiceProfile({
        descriptors: input.descriptors,
        writing_rules: input.writingRules,
        sample_snippets: input.sampleSnippets,
      });
      if (res.error) {
        throw new Error(
          brandVoiceErrorMessage(res.error.status, res.error.message),
        );
      }
      return normalizeBrandVoiceProfile(res.data);
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: [BRAND_VOICE_QUERY_KEY, gate.tenantId],
      });
    },
  });
}
