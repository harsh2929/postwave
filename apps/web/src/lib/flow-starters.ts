// SPDX-License-Identifier: AGPL-3.0-only
//
// Starter-flow gallery (FLOW-032 / FLOW-036). "New flow" previously always
// created a blank "Untitled flow" with a single send_email node; every common
// journey (welcome, nurture, win-back, abandoned-cart) had to be built from
// scratch. These pure builders seed a working graph (trigger + steps + wiring)
// the operator can immediately edit. DOM-free so they unit-test in node.
//
// Ids are generated per-build so two flows created from the same starter don't
// collide. The backend rejects an empty graph, so even "blank" seeds one node.

import type { FlowInput, FlowNode } from "./flows-api";

export interface FlowStarter {
  key: string;
  name: string;
  description: string;
  /** Build a fresh FlowInput (draft) — new ids each call. */
  build: () => FlowInput;
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Wire a linear chain of nodes into a draft FlowInput. */
function linear(
  name: string,
  trigger: Record<string, unknown> | null,
  nodes: FlowNode[],
): FlowInput {
  const edges = nodes
    .slice(0, -1)
    .map((n, i) => ({ from: n.id, to: nodes[i + 1].id }));
  return {
    name,
    status: "draft",
    entry_id: nodes[0]?.id,
    triggers: trigger ? [trigger as { type: string }] : [],
    nodes,
    edges,
  };
}

const days = (d: number) => d * 86400;

export const FLOW_STARTERS: FlowStarter[] = [
  {
    key: "blank",
    name: "Blank flow",
    description: "Start from an empty canvas with a single email step.",
    build: () => {
      const step = id("step");
      return {
        name: "Untitled flow",
        status: "draft",
        entry_id: step,
        nodes: [{ id: step, type: "send_email" }],
      };
    },
  },
  {
    key: "welcome",
    name: "Welcome series",
    description:
      "Greet new subscribers when they join a list, then follow up after a short wait.",
    build: () => {
      const welcome = id("email");
      const wait = id("wait");
      const followup = id("email");
      return linear("Welcome series", { type: "list_joined" }, [
        { id: welcome, type: "send_email" },
        { id: wait, type: "wait", duration_seconds: days(2) },
        { id: followup, type: "send_email" },
      ]);
    },
  },
  {
    key: "nurture",
    name: "Nurture sequence",
    description:
      "Educate subscribers over a week with spaced emails after they enter a segment.",
    build: () => {
      const e1 = id("email");
      const w1 = id("wait");
      const e2 = id("email");
      const w2 = id("wait");
      const e3 = id("email");
      return linear("Nurture sequence", { type: "segment_joined" }, [
        { id: e1, type: "send_email" },
        { id: w1, type: "wait", duration_seconds: days(3) },
        { id: e2, type: "send_email" },
        { id: w2, type: "wait", duration_seconds: days(4) },
        { id: e3, type: "send_email" },
      ]);
    },
  },
  {
    key: "winback",
    name: "Win-back",
    description:
      "Re-engage lapsed subscribers with a wait, an offer email, then a final nudge.",
    build: () => {
      const wait = id("wait");
      const offer = id("email");
      const w2 = id("wait");
      const nudge = id("email");
      const flow = linear("Win-back", { type: "segment_joined" }, [
        { id: wait, type: "wait", duration_seconds: days(7) },
        { id: offer, type: "send_email" },
        { id: w2, type: "wait", duration_seconds: days(3) },
        { id: nudge, type: "send_email" },
      ]);
      // Win-back should re-run after a cooldown, not once-ever.
      return {
        ...flow,
        re_enrollment: "cooldown",
        re_enrollment_cooldown_hours: 720,
      };
    },
  },
  {
    key: "abandoned_cart",
    name: "Abandoned cart",
    description:
      "Draft a cart reminder and follow-up after checkout starts. Add a purchase check and coupon before using it.",
    build: () => {
      const wait = id("wait");
      const remind = id("email");
      const w2 = id("wait");
      const coupon = id("email");
      const flow = linear(
        "Abandoned cart",
        { type: "product_event", event_name: "checkout_started" },
        [
          { id: wait, type: "wait", duration_seconds: 3600 },
          { id: remind, type: "send_email" },
          { id: w2, type: "wait", duration_seconds: days(1) },
          { id: coupon, type: "send_email" },
        ],
      );
      // Abandoned cart fires on every matching event.
      return { ...flow, re_enrollment: "always" };
    },
  },
];

export function getFlowStarter(key: string): FlowStarter | undefined {
  return FLOW_STARTERS.find((s) => s.key === key);
}
