// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface VoiceDriftResponse {
  score: number;
  severity: "ok" | "warn" | "critical";
  reason?: string;
  components?: Record<string, number>;
  suggestions?: string[];
}

/**
 * Voice drift — pre-send fidelity check. Given a draft body + the
 * tenant's voice profile id (optional; defaults to the active
 * profile), returns a 0..100 score and a severity. Non-blocking by
 * design: callers may use this advisory signal to surface a warning
 * but should not gate sends on it.
 *
 * Runs heuristic-only when the voice service has no embedding
 * client configured.
 */
export class VoiceDriftResource extends Resource {
  check(input: {
    html: string;
    text?: string;
    profile_id?: string;
  }): Promise<VoiceDriftResponse> {
    return this.client.request("POST", "/api/v1/voice/drift", { body: input });
  }
}
