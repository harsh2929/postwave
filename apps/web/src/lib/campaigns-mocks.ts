// SPDX-License-Identifier: AGPL-3.0-only
//
// In-memory campaign fixtures. Loaded only when NEXT_PUBLIC_USE_MOCKS=1 so
// production campaign API wrappers do not carry demo state in the main bundle.

import type {
  Campaign,
  CampaignQueueResponse,
  CreateCampaignABTestInput,
  CreateCampaignABTestResponse,
  CreateCampaignInput,
  UpdateCampaignInput,
} from "./campaigns-api";

let mockCampaigns: Campaign[] = [
  {
    id: "camp_demo_1",
    tenant_id: "demo",
    name: "May product note",
    subject: "A faster way to shape next week",
    status: "draft",
    body_html:
      '<p>Hey there,</p><p>Here are the three things worth knowing this week.</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
    // A draft with no from address is a draft you cannot send: the pre-send
    // checklist fails `from_address` and `sendGateDisabled` keeps Send off.
    // The fixture used to omit it, so the ONLY reachable state of the send
    // confirmation in mock mode was "blocked", and nothing downstream of the
    // gate — the advisory banners, the enabled Send button — was reachable at
    // all. Setting a from address exercises the gate's pass branch; it does
    // not weaken the gate, which still reads the same field.
    from_name: "Moosewave Demo",
    delivery_settings: { from_email: "hello@demo.postwave.local" },
    created_at: "2026-05-01T10:00:00Z",
    updated_at: "2026-05-02T11:30:00Z",
  },
  {
    id: "camp_demo_semantic",
    tenant_id: "demo",
    name: "Semantic authoring demo",
    subject: "A lossless semantic campaign",
    status: "draft",
    source_mode: "semantic",
    content_schema_version: 2,
    editor_mode: "blocks",
    content_blocks: [
      {
        id: "title",
        type: "heading",
        role: "heading",
        version: 2,
        content: {
          heading: {
            level: 1,
            text: { runs: [{ kind: "text", text: "Hello from Moosewave" }] },
          },
        },
        conditions: [],
        localizations: {},
        provenance: { source: "user" },
      },
    ],
    fact_contract: { schema_version: 1, campaign_kind: "newsletter" },
    body_html:
      '<h1>Hello from Moosewave</h1><p>This preview is a server projection of the semantic source.</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
    from_name: "Moosewave Demo",
    delivery_settings: { from_email: "hello@demo.postwave.local" },
    created_at: "2026-05-03T09:00:00Z",
    updated_at: "2026-05-03T09:15:00Z",
  },
  {
    id: "camp_demo_sent",
    tenant_id: "demo",
    name: "Delivered product signal",
    subject: "A delivered weekly signal",
    status: "sent",
    body_html:
      '<h1>Delivered product signal</h1><p>This deterministic sent campaign exercises post-send actions.</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
    from_name: "Moosewave Demo",
    delivery_settings: { from_email: "hello@demo.postwave.local" },
    sent_at: "2026-05-04T09:00:00Z",
    created_at: "2026-05-03T10:00:00Z",
    updated_at: "2026-05-04T09:00:00Z",
  },
];

export function mockListCampaigns(): Campaign[] {
  return mockCampaigns;
}

export function mockCountCampaigns(query = "") {
	const needle = query.trim().toLowerCase();
	const rows = needle
	  ? mockCampaigns.filter(
		  (campaign) =>
			campaign.name.toLowerCase().includes(needle) ||
			campaign.subject.toLowerCase().includes(needle),
		)
	  : mockCampaigns;
	return {
	  total: rows.length,
	  by_status: rows.reduce<Record<string, number>>((out, campaign) => {
		out[campaign.status] = (out[campaign.status] ?? 0) + 1;
		return out;
	  }, {}),
	};
}

export function mockGetCampaign(id: string): Campaign {
  const found = mockCampaigns.find((c) => c.id === id);
  if (!found) throw new Error("Campaign not found");
  return found;
}

export function mockCreateCampaign(input: CreateCampaignInput): Campaign {
  const now = new Date().toISOString();
  const campaign: Campaign = {
    id: `camp_demo_${mockCampaigns.length + 1}`,
    tenant_id: "demo",
    name: input.name,
    subject: input.subject,
    status: input.scheduled_at ? "scheduled" : "draft",
    campaign_type: input.campaign_type,
    editor_mode: input.editor_mode,
    preview_text: input.preview_text,
    body_html: input.body_html,
    body_mjml: input.body_mjml,
    plain_text: input.plain_text,
    from_name: input.from_name,
    reply_to: input.reply_to,
    content_blocks: input.content_blocks,
    reusable_section_ids: input.reusable_section_ids,
    variants: input.variants,
    tracking_settings: input.tracking_settings,
    delivery_settings: input.delivery_settings,
    segment_id: input.segment_id,
    scheduled_at: input.scheduled_at,
    created_at: now,
    updated_at: now,
  };
  mockCampaigns = [campaign, ...mockCampaigns];
  return campaign;
}

export async function mockCreateCampaignABTest(
  input: CreateCampaignABTestInput,
): Promise<CreateCampaignABTestResponse> {
  const subjects = input.subject_variants
    .map((value) => value.trim())
    .filter(Boolean);
  if (!input.name.trim()) throw new Error("name is required");
  if (subjects.length < 2) {
    throw new Error("at least 2 subject variants required");
  }
  if (!input.audience_list_id && !input.audience_segment_id) {
    throw new Error("an audience is required");
  }

  const parent = mockCreateCampaign({
    name: input.name.trim(),
    subject: subjects[0],
    campaign_type: "ab_test",
    editor_mode: "blocks",
    body_html: input.body_html,
    body_mjml: input.body_mjml,
    plain_text: input.plain_text,
    preview_text: input.preview_text,
    from_name: input.from_name,
    reply_to: input.reply_to,
    tracking_settings: input.tracking_settings,
    delivery_settings: {
      ...input.delivery_settings,
      ab_test: {
        is_parent: true,
        variant_count: subjects.length,
        total_variants: subjects.length,
        split_percentage:
          input.split_percentage && input.split_percentage > 0
            ? input.split_percentage
            : Math.floor(100 / subjects.length),
      },
    },
    segment_id: input.audience_segment_id,
    variants: subjects.map((subject, index) => ({
      variant_label: String.fromCharCode(65 + index),
      subject,
      weight: 100 / subjects.length,
    })),
  });
  parent.list_id = input.audience_list_id;

  const canonicalVariants = subjects.map((subject, index) => {
    const label = String.fromCharCode(65 + index);
    return {
      id: `var_${parent.id}_${label}`,
      campaign_id: parent.id,
      variant_label: label,
      subject,
      from_name: input.from_name,
      body_mjml: input.body_mjml,
      body_html: input.body_html,
      weight: 100 / subjects.length,
      created_at: parent.created_at,
    };
  });

  const children = subjects.map((subject, index) => {
    const label = String.fromCharCode(65 + index);
    const child = mockCreateCampaign({
      name: `${input.name.trim()} — variant ${label}`,
      subject,
      campaign_type: "ab_test",
      editor_mode: "blocks",
      body_html: input.body_html,
      body_mjml: input.body_mjml,
      plain_text: input.plain_text,
      preview_text: input.preview_text,
      from_name: input.from_name,
      reply_to: input.reply_to,
      tracking_settings: input.tracking_settings,
      delivery_settings: {
        ...input.delivery_settings,
        ab_test: {
          parent_id: parent.id,
          variant_id: label,
          canonical_variant_id: canonicalVariants[index].id,
          variant_index: index,
          total_variants: subjects.length,
          axis_subject: subject,
          axis_from_name: input.from_name ?? "",
        },
      },
      segment_id: input.audience_segment_id,
    });
    child.list_id = input.audience_list_id;
    return child;
  });

  const { mockRegisterCreatedABTest } = await import("./abtests-mocks");
  mockRegisterCreatedABTest(parent.id, canonicalVariants);

  return { parent, children };
}

export function mockUpdateCampaign(
  id: string,
  patch: UpdateCampaignInput,
): Campaign {
  const now = new Date().toISOString();
  let next: Campaign | undefined;
  mockCampaigns = mockCampaigns.map((campaign) => {
    if (campaign.id !== id) return campaign;
    next = { ...campaign, ...patch, updated_at: now };
    return next;
  });
  if (!next) throw new Error("Campaign not found");
  return next;
}

export function mockDeleteCampaign(id: string): void {
  mockCampaigns = mockCampaigns.filter((campaign) => campaign.id !== id);
}

export function mockSendCampaign(
  id: string,
): Campaign | CampaignQueueResponse {
  const now = new Date().toISOString();
  const found = mockCampaigns.find((campaign) => campaign.id === id);
  if (!found) throw new Error("Campaign not found");
  const updated: Campaign = { ...found, status: "sending", updated_at: now };
  mockCampaigns = mockCampaigns.map((campaign) =>
    campaign.id === id ? updated : campaign,
  );
  return updated;
}

export function mockTransitionCampaign(
	id: string,
	action: "pause" | "resume" | "cancel",
): Campaign {
	const status = action === "pause" ? "paused" : action === "resume" ? "sending" : "cancelled";
	return mockUpdateCampaign(id, { status });
}

export function mockSendCampaignTest(toEmail: string): {
  message_id: string;
  to: string;
  accepted_at: string;
} {
  return {
    message_id: "mock",
    to: toEmail,
    accepted_at: new Date().toISOString(),
  };
}

export function mockCloneCampaign(
  id: string,
  name?: string,
): { id: string; name: string } {
  const src = mockCampaigns.find((c) => c.id === id);
  const now = new Date().toISOString();
  const clone: Campaign = {
    ...(src ?? mockCampaigns[0]),
    id: `camp_demo_${mockCampaigns.length + 1}`,
    name: name?.trim() || `Copy of ${src?.name ?? "campaign"}`,
    status: "draft",
    scheduled_at: null,
    sent_at: null,
    created_at: now,
    updated_at: now,
  };
  mockCampaigns = [clone, ...mockCampaigns];
  return { id: clone.id, name: clone.name };
}

export function mockSendPreview(id: string) {
  const src = mockCampaigns.find((c) => c.id === id);
  const recipients = 1240;
  const suppressed = 18;
  const kind = src?.list_id ? "list" : src?.segment_id ? "segment" : "workspace";
  const label =
    kind === "list"
      ? "Newsletter"
      : kind === "segment"
        ? "Engaged subscribers"
        : undefined;
  return {
    campaign_id: id,
    audience_kind: kind,
    audience_label: label,
    segment_label: kind === "segment" ? label : undefined,
    recipients,
    suppressed_excluded: suppressed,
    deliverable: recipients - suppressed,
    tier_cap_today: -1,
    tier_cap_remaining: -1,
    tier_cap_remaining_after: -1,
    over_cap: false,
    counted_at: new Date().toISOString(),
  };
}

export function mockCampaignChecklist(id: string) {
  const src = mockCampaigns.find((c) => c.id === id);
  const hasFrom =
    typeof src?.delivery_settings?.from_email === "string" &&
    (src.delivery_settings.from_email as string).includes("@");
  return {
    campaign_id: id,
    ready: hasFrom,
    checks: [
      {
        key: "from_address",
        label: "From address",
        status: hasFrom ? ("pass" as const) : ("fail" as const),
        detail: hasFrom
          ? "A verified from address is set."
          : "Set a verified from address before sending.",
      },
      {
        key: "subject",
        label: "Subject line",
        status: src?.subject ? ("pass" as const) : ("fail" as const),
        detail: src?.subject ? src.subject : "Subject is empty.",
      },
      {
        key: "body",
        label: "Email body",
        status: src?.body_html ? ("pass" as const) : ("warn" as const),
        detail: src?.body_html ? "Body content present." : "Body looks empty.",
      },
      {
        key: "unsubscribe",
        label: "Unsubscribe link",
        status: src?.body_html?.includes("unsubscribe")
          ? ("pass" as const)
          : ("warn" as const),
        detail: "An unsubscribe link keeps you compliant.",
      },
      {
        key: "recipients",
        label: "Recipients",
        status: "pass" as const,
        detail: "1,222 deliverable recipients.",
      },
    ],
  };
}
