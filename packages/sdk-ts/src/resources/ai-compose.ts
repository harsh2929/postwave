// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

/**
 * CampaignDraft is the fully-formed broadcast draft returned by the
 * AI compose endpoints. All fields are best-effort — the voice service
 * may omit any of them depending on the brief.
 */
export interface CampaignDraft {
  name?: string;
  subject?: string;
  body?: string;
  preview_text?: string;
}

/** Request body for POST /api/v1/ai/compose/broadcast. */
export interface ComposeBroadcastInput {
  /** The user's 1-line prompt. Required. */
  brief: string;
  /**
   * Number of *alternate* subject-line variants to generate alongside
   * the primary draft. Bounded server-side to [0,4]; default 2.
   */
  variant_count?: number;
  /** Optional tone override ("witty", "formal", "urgent"). */
  tone?: string;
  /** Optional free-form context about the recipients. */
  audience?: string;
}

/** Response from POST /api/v1/ai/compose/broadcast. */
export interface ComposeBroadcastOutput {
  primary: CampaignDraft;
  subject_variants: string[];
  generated_at: string;
}

/** Request body for POST /api/v1/ai/compose/variants. */
export interface ComposeVariantsInput {
  /** The existing primary subject — used as the anchor. Required. */
  subject: string;
  /** The existing body — used as semantic context. */
  body?: string;
  /**
   * Number of alternates to generate. Bounded server-side to [1,5];
   * default 3.
   */
  variant_count?: number;
}

/** Response from POST /api/v1/ai/compose/variants. */
export interface ComposeVariantsOutput {
  subject_variants: string[];
  generated_at: string;
}

/**
 * AI compose surface — turns a 1-line brief into a campaign draft plus
 * subject-line variants. Both endpoints require the write:campaigns scope.
 */
export class AIComposeResource extends Resource {
  /** Generate a primary draft + subject variants from a brief. */
  composeBroadcast(input: ComposeBroadcastInput): Promise<ComposeBroadcastOutput> {
    return this.client.request("POST", "/api/v1/ai/compose/broadcast", {
      body: input,
    });
  }

  /** Generate additional subject variants for an existing draft. */
  composeVariants(input: ComposeVariantsInput): Promise<ComposeVariantsOutput> {
    return this.client.request("POST", "/api/v1/ai/compose/variants", {
      body: input,
    });
  }
}
