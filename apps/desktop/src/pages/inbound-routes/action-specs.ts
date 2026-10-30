import type { InboundRouteAction } from "../../lib/api-client";

export type InboundActionKind = InboundRouteAction["kind"];

export interface InboundActionKindSpec {
  value: InboundActionKind;
  label: string;
  description: string;
  fields: Array<{
    key: keyof InboundRouteAction;
    label: string;
    placeholder?: string;
    required?: boolean;
    helpText?: string;
  }>;
}

export const INBOUND_ACTION_KINDS: InboundActionKindSpec[] = [
  {
    value: "tag",
    label: "Tag",
    description: "Add a tag to the inbound email row for downstream filtering.",
    fields: [
      {
        key: "tag",
        label: "Tag",
        placeholder: "inbound-support",
        required: true,
      },
    ],
  },
  {
    value: "automation_trigger",
    label: "Trigger automation",
    description:
      "Fire an event for automations configured with the same event type.",
    fields: [
      {
        key: "event_type",
        label: "Event type",
        placeholder: "inbound.support",
        required: true,
        helpText:
          "Configure the matching automation under Automations → triggers.",
      },
    ],
  },
  {
    value: "webhook",
    label: "Webhook",
    description:
      "POST the parsed envelope to an HTTPS endpoint. Private and loopback destinations are rejected by the server.",
    fields: [
      {
        key: "url",
        label: "URL",
        placeholder: "https://hooks.example.com/inbound",
        required: true,
        helpText: "Use HTTPS for every production destination.",
      },
    ],
  },
  {
    value: "forward",
    label: "Forward",
    description:
      "Re-send the email to another address using the tenant's default sending identity.",
    fields: [
      {
        key: "to",
        label: "Forward to",
        placeholder: "team@example.com",
        required: true,
      },
    ],
  },
  {
    value: "store_only",
    label: "Store only",
    description:
      "Store the inbound email without another side effect; useful as a terminal rule.",
    fields: [],
  },
];

export function inboundActionKindSpec(
  kind: InboundActionKind,
): InboundActionKindSpec {
  return (
    INBOUND_ACTION_KINDS.find((candidate) => candidate.value === kind) ??
    INBOUND_ACTION_KINDS[0]!
  );
}
