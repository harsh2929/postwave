/**
 * lib/human-reach-api.ts — human-engaged reach.
 *
 * `/api/v1/analytics/human-engaged-reach` was reached by desktop and by no web
 * file.
 *
 * THIS ENDPOINT EXPLAINS ITS OWN EPISTEMICS, AND THE CLIENT'S JOB IS TO PASS
 * THAT ON. It ships:
 *
 *   headline      a finished sentence, e.g. "human-engaged reach floor: 0"
 *   methodology   a paragraph stating that the figure is a FLOOR, not an
 *                 estimate, because "absence of evidence is not evidence"
 *   unknown_band  recipients whose interactions could not be classified —
 *                 never allocated to the human or machine totals
 *   shadow_mode / mixed_classifier_versions
 *                 flags that qualify the whole reading
 *
 * A UI that renders `human_engaged_reach_floor` as "reach" turns a deliberate
 * lower bound into an apparent measurement, which is exactly the claim the
 * server went to the trouble of refusing to make.
 */
import { api } from "@/lib/api";
import {
  requireReleasedReachPayload,
  type ClassifierVersionCoverage,
} from "@/lib/human-engaged-reach";

export interface HumanEngagedReach {
  /** A finished sentence from the server. Render verbatim. */
  headline: string;
  /** The server's written explanation of what the number is and is not. */
  methodology: string;
  window_start?: string;
  window_end?: string;
  generated_at?: string;
  provider_accepted_recipients: number;
  human_engaged_reach_floor: number;
  /** Unclassified recipients — never counted as human or machine. */
  unknown_band: number;
  human_engaged_reach_upper_bound: number;
  machine_only_recipients: number;
  no_interaction_recipients: number;
  machine_by_subtype: Record<string, number>;
  classifier_version: string;
  methodology_version: string;
  registry_version: string;
  configuration_hash: string;
  classifier_version_coverage: ClassifierVersionCoverage[];
  /** True when more than one classifier version contributed to the window. */
  mixed_classifier_versions: boolean;
  /** True when the classifier ran without affecting anything. */
  shadow_mode: boolean;
}

function num(v: unknown): number {
  return Number.isFinite(v) ? Number(v) : 0;
}

export async function getHumanEngagedReach(): Promise<HumanEngagedReach> {
  const res = await api.get<HumanEngagedReach>(
    "/api/v1/analytics/human-engaged-reach",
  );
  requireReleasedReachPayload(res);
  return {
    ...res,
    headline: typeof res?.headline === "string" ? res.headline : "",
    methodology: typeof res?.methodology === "string" ? res.methodology : "",
    provider_accepted_recipients: num(res?.provider_accepted_recipients),
    human_engaged_reach_floor: num(res?.human_engaged_reach_floor),
    unknown_band: num(res?.unknown_band),
    human_engaged_reach_upper_bound: num(res?.human_engaged_reach_upper_bound),
    machine_only_recipients: num(res?.machine_only_recipients),
    no_interaction_recipients: num(res?.no_interaction_recipients),
    machine_by_subtype:
      res?.machine_by_subtype &&
      typeof res.machine_by_subtype === "object" &&
      !Array.isArray(res.machine_by_subtype)
        ? res.machine_by_subtype
        : {},
    classifier_version_coverage: res.classifier_version_coverage,
    mixed_classifier_versions: res?.mixed_classifier_versions === true,
    shadow_mode: res?.shadow_mode === true,
  };
}
