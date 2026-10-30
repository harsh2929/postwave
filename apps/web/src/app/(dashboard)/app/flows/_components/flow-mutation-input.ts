// SPDX-License-Identifier: AGPL-3.0-only

import type {
  FlowGraph,
  FlowInput,
  FlowStatus,
  ReEnrollment,
} from "@/lib/flows-api";

export interface FlowMutationState {
  name: string;
  reEnrollment: ReEnrollment;
  cooldownHours: number;
  graph: FlowGraph;
  status?: FlowStatus;
}

/** One mutation contract shared by Save and legacy-status Pause. */
export function buildFlowMutationInput({
  name,
  reEnrollment,
  cooldownHours,
  graph,
  status,
}: FlowMutationState): FlowInput {
  if (
    reEnrollment === "cooldown" &&
    (!Number.isInteger(cooldownHours) || cooldownHours <= 0)
  ) {
    throw new Error("Cooldown hours must be a positive whole number.");
  }

  return {
    ...(status ? { status } : {}),
    name,
    re_enrollment: reEnrollment,
    ...(reEnrollment === "cooldown"
      ? { re_enrollment_cooldown_hours: cooldownHours }
      : {}),
    entry_id: graph.entry_id,
    triggers: graph.triggers,
    nodes: graph.nodes,
    edges: graph.edges,
    goals: graph.goals,
  };
}
