/**
 * Read-only data used by the explicitly built local demo package.
 *
 * The real local API remains authoritative for operator data. These responses
 * are selected when a GET endpoint is empty or unavailable, which lets real
 * seeded subscribers/campaigns coexist with presentational records for
 * integrations that cannot be configured on a laptop (DMARC providers,
 * commerce, SCIM, warehouses, and similar surfaces). The campaign-template
 * catalogue is the one deliberate exception: the demo package promises its
 * complete 2,048-item library even when the local API has a smaller seed.
 * No mutation is ever intercepted.
 */

const DEMO_ISO = "2026-08-18T10:30:00.000Z";
const DEMO_TENANT_ID = "00000000-0000-4000-8000-000000000099";
const DEMO_HELPDESK_AS_OF = "2026-08-18T10:30:00.123456789Z";
const DEMO_HELPDESK_CONVERSATION_ID = "00000000-0000-4000-8000-000000000101";

const COLLECTION_KEYS = new Set([
  "items",
  "data",
  "results",
  "rows",
  "lists",
  "campaigns",
  "subscribers",
  "sequences",
  "automations",
  "forms",
  "templates",
  "assets",
  "collections",
  "webhooks",
  "events",
  "points",
  "series",
  "products",
  "orders",
  "reviews",
  "approvals",
  "incidents",
  "receipts",
  "messages",
  "conversations",
  "domains",
  "reports",
  "jobs",
  "runs",
  "rules",
  "alerts",
  "sinks",
  "requests",
  "integrations",
  "profiles",
  "schedules",
  "goals",
]);

const EXCLUDED_PATHS = [
  "/api/health",
  "/api/v1/health",
  "/api/v1/me",
  "/api/v1/auth/",
  "/api/v1/api-keys/me",
  "/api/v1/onboarding/",
];

const DEMO_AUTHORITATIVE_PATHS = new Set([
  "/api/v1/campaign-templates",
  "/api/v1/campaign-templates/search",
  "/api/v1/campaign-templates/stats",
  "/api/v1/campaign-templates/goals",
]);

const BARE_ARRAY_PATHS = [
  "/affiliates",
  "/conversions",
  "/check-links",
  "/auth-checks",
  "/commerce/integrations",
  "/landing-pages",
  "/form-variants",
  "/feed-sources",
  "/scoring/rules",
];

const RESOURCE_NAMES: Readonly<Record<string, readonly string[]>> = {
  tags: ["Product launch", "VIP customers", "Newsletter regulars"],
  lists: ["Launch waitlist", "Active customers", "Weekly digest"],
  automations: ["Welcome journey", "Trial conversion", "Win-back flow"],
  forms: ["Newsletter signup", "Demo request", "Product updates"],
  assets: ["Launch hero", "Customer story", "Product overview"],
  collections: ["Product catalogue", "Customer stories", "Upcoming events"],
  webhooks: ["Product events", "CRM updates", "Order notifications"],
  track: ["Trial started", "Feature adopted", "Plan upgraded"],
  referrals: ["Alex Morgan", "Priya Sharma", "Jordan Lee"],
  affiliates: ["Northstar Media", "Growth Works", "Inbox Weekly"],
  discounts: ["LAUNCH20", "WELCOME15", "ANNUAL25"],
  gifts: ["Team plan gift", "Creator annual", "Founder bundle"],
  commerce: ["Moosewave Pro", "Growth Toolkit", "Creator Plan"],
  reviews: ["Five-star onboarding", "Fast migration", "Helpful support"],
  retention: ["Annual plan save", "Pause offer", "Concierge follow-up"],
  migrations: ["Mailchimp import", "Klaviyo migration", "CSV backfill"],
  approvals: ["Launch campaign review", "Domain change", "Sequence activation"],
  incidents: [
    "Export request review",
    "Consent investigation",
    "Access follow-up",
  ],
  consent: ["Email marketing consent", "SMS opt-in", "Tracking preference"],
  sms: ["Launch reply", "Support follow-up", "Renewal reminder"],
  agency: ["Northstar Studio", "Acme Labs", "Orbit Commerce"],
  domains: [
    "mail.postwave.demo",
    "news.postwave.demo",
    "updates.postwave.demo",
  ],
  default: ["Signal launch", "Growth pulse", "Customer momentum"],
};

function resourceKey(pathname: string): string {
  const lowered = pathname.toLowerCase();
  for (const key of Object.keys(RESOURCE_NAMES)) {
    if (key !== "default" && lowered.includes(key)) return key;
  }
  if (lowered.includes("privacy")) return "incidents";
  if (lowered.includes("retention") || lowered.includes("winback")) {
    return "retention";
  }
  if (lowered.includes("domain") || lowered.includes("dmarc")) return "domains";
  return "default";
}

function demoRow(pathname: string, index: number): Record<string, unknown> {
  const key = resourceKey(pathname);
  const names = RESOURCE_NAMES[key] ?? RESOURCE_NAMES.default;
  const name = names[index - 1] ?? `Demo record ${index}`;
  return {
    id: `00000000-0000-4000-8000-00000000000${index}`,
    uuid: `00000000-0000-4000-8000-00000000000${index}`,
    sub_id: String(index),
    subscriber_id: String(index),
    campaign_id: `demo-campaign-${index}`,
    list_id: String(index),
    tag: name,
    name,
    label: name,
    title: name,
    subject: index === 1 ? "A launch worth opening" : `Demo message ${index}`,
    description:
      "A realistic, read-only record included for the Moosewave product demo.",
    display_name: ["Alex Morgan", "Priya Sharma", "Jordan Lee"][index - 1],
    email: ["alex@northstar.demo", "priya@acme.demo", "jordan@orbit.demo"][
      index - 1
    ],
    phone_e164: `+1415555011${index}`,
    phone: `+1 (415) 555-011${index}`,
    slug: `demo-${key}-${index}`,
    domain: `mail${index}.postwave.demo`,
    url: `https://postwave.demo/${key}/${index}`,
    endpoint_url: `https://hooks.postwave.demo/${key}/${index}`,
    keyword: ["LAUNCH", "DEMO", "UPDATES"][index - 1],
    code: ["LAUNCH20", "WELCOME15", "ANNUAL25"][index - 1],
    status: index === 2 ? "paused" : "active",
    state: "enabled",
    kind: index === 3 ? "scheduled" : "sent",
    reason: index === 2 ? "manual" : "subscriber_request",
    action: "reply_only",
    framework: "gdpr",
    channel: index === 3 ? "sms" : "email",
    type: "email",
    severity: index === 2 ? "warning" : "info",
    pace: "on_track",
    schedule: "daily",
    provider: ["HubSpot", "Shopify", "Snowflake"][index - 1],
    destination: ["CRM audience", "Customer catalogue", "Analytics warehouse"][
      index - 1
    ],
    variant_key: "A",
    current_step: 2,
    current_step_label: "Message 2",
    milestone: index,
    rank: index,
    enabled: true,
    verified: index !== 2,
    is_favorited: index === 1,
    require_approval: true,
    dedicated: false,
    connected: true,
    healthy: index !== 2,
    notify_slack: false,
    exit_on_goal: true,
    attested: true,
    created_at: DEMO_ISO,
    updated_at: DEMO_ISO,
    sent_at: DEMO_ISO,
    scheduled_at: DEMO_ISO,
    last_run_at: DEMO_ISO,
    last_polled_at: DEMO_ISO,
    computed_at: DEMO_ISO,
    occurred_at: DEMO_ISO,
    occurredAt: DEMO_ISO,
    received_at: DEMO_ISO,
    receivedAt: DEMO_ISO,
    event_name: name,
    eventName: name,
    subscriberId: String(index),
    subscriber_email: [
      "alex@northstar.demo",
      "priya@acme.demo",
      "jordan@orbit.demo",
    ][index - 1],
    properties: { plan: "Pro", source: "Product tour" },
    at: DEMO_ISO,
    entered_at: DEMO_ISO,
    last_event_at: DEMO_ISO,
    anchored_at: DEMO_ISO,
    date: "2026-08-18",
    started_at: DEMO_ISO,
    finished_at: DEMO_ISO,
    requested_at: DEMO_ISO,
    expires_at: "2026-09-18T10:30:00.000Z",
    count: 12 + index,
    total: 3,
    sent: 1_200 + index * 130,
    opens: 540 + index * 31,
    clicks: 126 + index * 9,
    bounces: index,
    unsubscribes: index - 1,
    delivered: 1_180 + index * 125,
    subscribers: 420 + index * 37,
    score: 86 - index * 4,
    engagement_score: 86 - index * 4,
    weight_bp: 5_000,
    amount_cents: 9_900 + index * 2_000,
    revenue_cents: 49_900 + index * 10_000,
    tree_size: 1_024,
    rate: 0.42,
    open_rate: 0.42 + index * 0.01,
    click_rate: 0.1 + index * 0.01,
    conversion_rate: 0.05 + index * 0.01,
    pct: 42 + index,
    value: 5 + index,
    idle_days: index,
    position: index,
    days: 30,
    new_items: 2,
    items_seen: 4,
    threshold_days: 5,
    segments_per_message: 1,
    sent_count: 10,
    failed_count: 0,
    held_count: 1,
    rows_exported: 100,
    impressions: 240 + index * 10,
    submissions30d: 12 + index,
    visits30d: 180 + index * 20,
    tags: ["demo", index === 1 ? "featured" : "active"],
    scopes: ["read:subscribers", "read:campaigns"],
    descriptors: ["clear", "confident"],
    writing_rules: ["Keep it concise", "Lead with the outcome"],
    sample_snippets: ["A useful example for the client walkthrough."],
    days_arr: [1, 3, 7],
    object_selection: ["customers", "orders"],
    recipients: ["demo@postwave.demo"],
    models: ["engagement", "churn"],
    providers: ["HubSpot", "Shopify", "Snowflake"],
    objects: ["customers", "orders"],
    import_targets: ["subscribers"],
    directions: ["import", "export"],
    cadences: ["daily"],
    schema_version: 1,
    goal: { kind: "open", exit_on_goal: true },
    handle: `@demo${index}`,
    root_hash: `demo-root-${index}`,
    variants: [],
    steps: [],
    milestones: [],
    sources: [{ name: "Landing page", count: 18 + index }],
  };
}

function requestedPage(query: URLSearchParams): number {
  const value = Number(query.get("page") ?? "1");
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function requestedPerPage(query: URLSearchParams, fallback = 50): number {
  const value = Number(query.get("per_page") ?? fallback);
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 200)
    : fallback;
}

function dailySeries(days: number, asOf = DEMO_ISO): Record<string, unknown>[] {
  const end = new Date(asOf);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (days - index - 1));
    return {
      date: date.toISOString().slice(0, 10),
      count: 32 + ((index * 17) % 41),
    };
  });
}

const TEMPLATE_TOTAL = 2_048;
const TEMPLATE_GOALS = [
  "welcome",
  "newsletter",
  "announcement",
  "promotional",
  "re_engagement",
  "transactional",
  "automation",
] as const;
const TEMPLATE_PREFIXES = [
  "Signal",
  "Momentum",
  "Northstar",
  "Launch",
  "Studio",
  "Summit",
  "Pulse",
  "Beacon",
];
const TEMPLATE_PURPOSES = [
  "Welcome",
  "Weekly Brief",
  "Product Launch",
  "Customer Story",
  "Event Invite",
  "Trial Upgrade",
  "Win-back",
  "Order Update",
];

function templateRows(
  page: number,
  perPage: number,
): Record<string, unknown>[] {
  const start = (page - 1) * perPage;
  const remaining = Math.max(0, TEMPLATE_TOTAL - start);
  return Array.from({ length: Math.min(perPage, remaining) }, (_, offset) => {
    const ordinal = start + offset + 1;
    const goal = TEMPLATE_GOALS[(ordinal - 1) % TEMPLATE_GOALS.length]!;
    const prefix = TEMPLATE_PREFIXES[(ordinal - 1) % TEMPLATE_PREFIXES.length]!;
    const purpose =
      TEMPLATE_PURPOSES[
        Math.floor((ordinal - 1) / TEMPLATE_PREFIXES.length) %
          TEMPLATE_PURPOSES.length
      ]!;
    const id = `demo-template-${ordinal}`;
    return {
      id,
      slug: `${prefix}-${purpose}-${ordinal}`
        .toLowerCase()
        .replace(/\s+/g, "-"),
      name: `${prefix} ${purpose} ${ordinal}`,
      subject: `${purpose}: a clear next step`,
      preview_text:
        "A polished, client-ready email from the Moosewave demo library.",
      description:
        "A complete, editable campaign layout with realistic copy and responsive sections.",
      category: goal === "transactional" ? "Commerce" : "Marketing",
      body_html: `<main style="font-family:Arial,sans-serif;padding:32px"><h1>${prefix} ${purpose}</h1><p>Build momentum with one clear message and one useful next step.</p><a href="https://postwave.demo">Explore the update</a></main>`,
      tags: ["demo", goal, ordinal % 5 === 0 ? "featured" : "responsive"],
      goal,
      template_kind: "editable",
      is_featured: ordinal % 5 === 0,
      is_favorited: ordinal <= 6,
      usage_count: 240 - (ordinal % 120),
      quality_score: 0.91,
      created_at: DEMO_ISO,
      updated_at: DEMO_ISO,
      version: 1,
      etag: `"campaign-template:${id}:v1"`,
    };
  });
}

function templateFacets(): Record<string, unknown> {
  const facet = (values: readonly string[]) =>
    values.map((value) => ({
      value,
      count: Math.floor(TEMPLATE_TOTAL / values.length),
    }));
  return {
    goals: facet(TEMPLATE_GOALS),
    categories: facet(["Marketing", "Commerce"]),
    providers: facet(["Moosewave", "Mailchimp", "Klaviyo"]),
    industries: facet(["SaaS", "Commerce", "Media"]),
    styles: facet(["Editorial", "Minimal", "Bold"]),
    layouts: facet(["Single column", "Hero", "Digest"]),
  };
}

function points(): Record<string, unknown>[] {
  return [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    date: `2026-08-${String(10 + day).padStart(2, "0")}`,
    value: 18 + day * 4,
    count: 12 + day * 3,
    revenue_cents: 12_000 + day * 2_500,
    sends: 320 + day * 45,
    subscribers: 1_100 + day * 28,
  }));
}

function helpdeskPage(consistency: "mutable_window" | "created_at_window") {
  return {
    has_more: false,
    next_cursor: null,
    as_of: DEMO_HELPDESK_AS_OF,
    consistency,
    may_reorder: true,
  };
}

function demoHelpdeskConversation(): Record<string, unknown> {
  return {
    id: DEMO_HELPDESK_CONVERSATION_ID,
    tenantId: DEMO_TENANT_ID,
    tenant_id: DEMO_TENANT_ID,
    version: DEMO_HELPDESK_AS_OF,
    channel_type: "generic",
    source_type: "manual",
    requester_email: "reader@helpdesk.demo",
    requester_name: "Demo requester",
    subject: "Read-only Helpdesk walkthrough",
    status: "open",
    priority: "normal",
    assignment_state: "unassigned",
    tags: ["synthetic_demo", "read_only"],
    last_message_at: "2026-08-18T10:25:00.123456789Z",
    created_at: "2026-08-18T10:00:00.123456789Z",
    updated_at: DEMO_HELPDESK_AS_OF,
  };
}

/** Contract-valid, synthetic and read-only Service Suite presentation data.
 * Unknown resource and every create/mutation descendant return undefined so
 * the real held/error response remains authoritative. */
function demoServiceSuiteData(
  pathname: string,
  query: URLSearchParams,
): unknown | undefined {
  const conversation = demoHelpdeskConversation();
  const mutablePage = helpdeskPage("mutable_window");

  if (pathname === "/api/v1/service-suite/catalog") {
    return {
      schema_version: "postwave.service_suite.v2",
      provenance: {
        tenant_bound: false,
        source: "static_server_catalog",
      },
      channels: [
        { key: "web_chat", label: "Web chat", runtime_status: "held" },
        { key: "email", label: "Email", runtime_status: "held" },
        { key: "sms", label: "SMS", runtime_status: "held" },
        { key: "instagram", label: "Instagram", runtime_status: "held" },
        { key: "whatsapp", label: "WhatsApp", runtime_status: "held" },
        { key: "facebook", label: "Facebook", runtime_status: "held" },
      ],
      conversation_statuses: [
        "open",
        "pending",
        "waiting",
        "resolved",
        "closed",
        "spam",
        "archived",
      ],
      agent_run_types: ["draft_reply", "triage", "handoff", "summary"],
      guardrail: {
        draft_only: true,
        provider_executed: false,
        customer_mutations: false,
        requires_human_review: true,
      },
      capabilities: {
        outbound_reply_delivery: {
          status: "held",
          code: "helpdesk_delivery_unavailable",
        },
        inbound_email_bridge: { status: "held" },
        internal_notes: { status: "available" },
        privacy_lifecycle: { status: "held" },
        customer_hub_runtime: {
          status: "held",
          code: "customer_hub_runtime_unavailable",
        },
        channel_runtime: {
          status: "held",
          code: "helpdesk_channel_runtime_unavailable",
        },
        customer_agent: {
          status: "held",
          code: "customer_agent_draft_write_held",
          execution_mode: "deterministic_template_only",
        },
        macro_usage_evidence: {
          status: "held",
          code: "macro_usage_evidence_unavailable",
        },
        spam_assessment_write: {
          status: "held",
          code: "spam_assessment_write_held",
        },
        resource_creation: {
          status: "held",
          code: "helpdesk_create_replay_unavailable",
        },
      },
    };
  }

  if (pathname === "/api/v1/service-suite/config") {
    return {
      tenantId: DEMO_TENANT_ID,
      tenant_id: DEMO_TENANT_ID,
      version: "absent",
      status: "draft",
      storefronts: [],
      content_blocks: [],
      personalization_rules: {},
      support_settings: {},
      order_history_enabled: false,
      favorites_enabled: false,
      coupons_enabled: false,
      recommendations_enabled: false,
      customer_agent_enabled: false,
      runtime_available: false,
      runtime_status: "held",
      runtime_reason_code: "customer_hub_runtime_unavailable",
      customer_agent_effective_enabled: false,
      styling: {},
      metadata: {},
    };
  }

  if (pathname === "/api/v1/service-suite/conversations") {
    const status = query.get("status");
    return {
      tenantId: DEMO_TENANT_ID,
      items: !status || status === conversation.status ? [conversation] : [],
      page: mutablePage,
    };
  }

  if (
    pathname ===
    `/api/v1/service-suite/conversations/${DEMO_HELPDESK_CONVERSATION_ID}`
  ) {
    return conversation;
  }

  if (
    pathname ===
    `/api/v1/service-suite/conversations/${DEMO_HELPDESK_CONVERSATION_ID}/messages`
  ) {
    const messages = [
      {
        id: "00000000-0000-4000-8000-000000000302",
        tenantId: DEMO_TENANT_ID,
        tenant_id: DEMO_TENANT_ID,
        conversation_id: DEMO_HELPDESK_CONVERSATION_ID,
        source_type: "manual",
        direction: "internal",
        sender_type: "agent",
        sender: "Demo operator",
        body_text:
          "Synthetic internal record for the read-only demo. Customer delivery is not applicable.",
        record_kind: "internal_note",
        delivery_status: "not_applicable",
        attachment_count: 0,
        projection_truncated: false,
        sent_at: "2026-08-18T10:25:00.123456789Z",
        created_at: "2026-08-18T10:25:00.123456789Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000301",
        tenantId: DEMO_TENANT_ID,
        tenant_id: DEMO_TENANT_ID,
        conversation_id: DEMO_HELPDESK_CONVERSATION_ID,
        source_type: "manual",
        direction: "inbound",
        sender_type: "customer",
        sender: "reader@helpdesk.demo",
        body_text:
          "Synthetic read-only customer record; provider provenance is unavailable.",
        record_kind: "inbound_record",
        delivery_status: "received",
        attachment_count: 0,
        projection_truncated: false,
        sent_at: "2026-08-18T10:15:00.123456789Z",
        created_at: "2026-08-18T10:15:00.123456789Z",
      },
    ];
    if (query.get("order") === "asc") messages.reverse();
    return {
      tenantId: DEMO_TENANT_ID,
      items: messages,
      page: helpdeskPage("created_at_window"),
    };
  }

  if (pathname === "/api/v1/service-suite/tickets") {
    const requestedConversation = query.get("conversation_id");
    const ticket = {
      id: "00000000-0000-4000-8000-000000000201",
      tenantId: DEMO_TENANT_ID,
      tenant_id: DEMO_TENANT_ID,
      version: DEMO_HELPDESK_AS_OF,
      conversation_id: DEMO_HELPDESK_CONVERSATION_ID,
      ticket_number: 4101,
      title: "Read-only Helpdesk walkthrough",
      status: "open",
      priority: "normal",
      assignment_state: "unassigned",
      source_channel: "generic",
      due_at: "2026-08-28T10:00:00.123456789Z",
      resolved_at: null,
      created_at: "2026-08-18T10:00:00.123456789Z",
      updated_at: DEMO_HELPDESK_AS_OF,
    };
    return {
      tenantId: DEMO_TENANT_ID,
      items:
        !requestedConversation ||
        requestedConversation === DEMO_HELPDESK_CONVERSATION_ID
          ? [ticket]
          : [],
      page: mutablePage,
    };
  }

  if (pathname === "/api/v1/service-suite/macros") {
    return {
      tenantId: DEMO_TENANT_ID,
      items: [
        {
          id: "00000000-0000-4000-8000-000000000401",
          tenantId: DEMO_TENANT_ID,
          tenant_id: DEMO_TENANT_ID,
          version: DEMO_HELPDESK_AS_OF,
          name: "Demo acknowledgement",
          body: "Synthetic macro text. Review before local insertion.",
          channel_types: ["generic"],
          tags: ["synthetic_demo"],
          status: "active",
          usage_evidence_status: "unverified",
          created_at: "2026-08-18T10:00:00.123456789Z",
          updated_at: DEMO_HELPDESK_AS_OF,
        },
      ],
      page: mutablePage,
    };
  }

  return undefined;
}

function genericCollection(pathname: string): Record<string, unknown> {
  const rows = [1, 2, 3].map((index) => demoRow(pathname, index));
  const chartPoints = points();
  return {
    ...rows[0],
    items: rows,
    data: rows,
    results: rows,
    rows,
    keys: rows,
    regions: rows,
    pages: rows,
    lists: rows,
    campaigns: rows,
    subscribers: rows,
    sequences: rows,
    automations: rows,
    forms: rows,
    templates: rows,
    assets: rows,
    collections: rows,
    webhooks: rows,
    events: rows,
    products: rows,
    orders: rows,
    reviews: rows,
    approvals: rows,
    incidents: rows,
    receipts: rows,
    messages: rows,
    conversations: rows,
    domains: rows,
    reports: rows,
    jobs: rows,
    runs: rows,
    rules: rows,
    alerts: rows,
    sinks: rows,
    requests: rows,
    integrations: rows,
    profiles: rows,
    schedules: rows,
    goals: rows,
    conversions: rows,
    dsar_requests: rows,
    suppression_breakdown: rows,
    consent_proof_summary: rows,
    sources: [
      { name: "Landing page", count: 184 },
      { name: "Product signup", count: 126 },
      { name: "CSV import", count: 72 },
    ],
    points: chartPoints,
    series: [{ key: "engagement", label: "Engagement", points: chartPoints }],
    buckets: [
      { range: "Highly engaged", min: 80, max: 100, count: 184 },
      { range: "Growing", min: 50, max: 79, count: 126 },
    ],
    deciles: [
      {
        sends_bucket: "1–5 sends",
        subscribers: 410,
        open_rate: 0.44,
        unsub_rate: 0.006,
      },
      {
        sends_bucket: "6–10 sends",
        subscribers: 286,
        open_rate: 0.39,
        unsub_rate: 0.009,
      },
    ],
    progress: [
      {
        goal: rows[0],
        current: 7_640,
        target: 10_000,
        pct: 76.4,
        pace: "on_track",
        period_start: "2026-08-01T00:00:00.000Z",
        period_end: "2026-08-31T23:59:59.000Z",
        as_of: DEMO_ISO,
      },
    ],
    total: 3,
    count: 3,
    page: 1,
    per_page: 50,
    has_more: false,
    next_before: null,
    enabled: true,
    available: true,
    connected: true,
    status: "active",
    health_state: "healthy",
    window_days: 30,
    total_subscribers: 12_482,
    subscribers_total: 12_482,
    active_campaigns: 4,
    campaigns_sent: 8,
    campaigns_sent_30d: 8,
    emails_sent: 62_400,
    emails_sent_30d: 62_400,
    opens_total: 26_270,
    opens_total_30d: 26_270,
    clicks_total: 5_242,
    clicks_total_30d: 5_242,
    bounces_total: 374,
    bounces_total_30d: 374,
    gpc_signaled_count: 142,
    do_not_sell_count: 38,
    double_optin_pending: 21,
    jaccard: 0.34,
    intersection: 142,
    a_count: 418,
    b_count: 862,
    recent_audit: rows,
    anomalies: { opens: false, clicks: false, bounces: false },
    catalog: {
      providers: ["HubSpot", "Shopify", "Snowflake"],
      objects: ["customers", "orders"],
      import_targets: ["subscribers"],
      directions: ["import", "export"],
      cadences: ["daily"],
      schema_version: 1,
    },
  };
}

function isExcluded(pathname: string): boolean {
  return EXCLUDED_PATHS.some(
    (path) => pathname === path || pathname.startsWith(path),
  );
}

export function demoDataForRequest(
  rawPath: string,
  current?: unknown,
): unknown | undefined {
  const pathname = rawPath.split(/[?#]/, 1)[0] ?? rawPath;
  if (!pathname.startsWith("/api/") || isExcluded(pathname)) return undefined;
  const query = new URL(rawPath, "http://postwave.demo").searchParams;

  // The local API currently returns both the canonical `items` collection and
  // its legacy `tags` alias. The strict desktop reader intentionally rejects
  // ambiguous envelopes, so the demo build removes the duplicate alias while
  // retaining the server's real rows and counts.
  if (
    pathname === "/api/v1/tag-taxonomy" &&
    current !== null &&
    typeof current === "object" &&
    !Array.isArray(current)
  ) {
    const record = current as Record<string, unknown>;
    if (Array.isArray(record.items) && record.items.length > 0) {
      return { items: record.items, count: record.items.length };
    }
  }

  if (
    current !== undefined &&
    !DEMO_AUTHORITATIVE_PATHS.has(pathname) &&
    !responseNeedsDemoData(current)
  ) {
    return undefined;
  }

  if (pathname.startsWith("/api/v1/service-suite/")) {
    return demoServiceSuiteData(pathname, query);
  }

  // Sending settings are scalar resources, so the generic collection fixture
  // is not a valid fallback for either endpoint. Keep the configuration and
  // status snapshots deliberately aligned: the status window contains
  // DEMO_ISO, its count is below the configured cap, and 06:30 in New York is
  // inside the configured overnight quiet window.
  if (pathname === "/api/v1/settings/sending/status") {
    return {
      tenant_id: DEMO_TENANT_ID,
      max_sends_per_hour: 5_000,
      quiet_hours_start: "22:00",
      quiet_hours_end: "07:00",
      quiet_hours_tz: "America/New_York",
      quiet_hours_per_recipient: true,
      bucket_count: 1_250,
      window_start: "2026-08-18T10:00:00.000Z",
      window_resets_at: "2026-08-18T11:00:00.000Z",
      in_quiet_hours: true,
      quiet_changes_at: "2026-08-18T11:00:00.000Z",
      counter_authoritative: true,
      counter_source: "demo_fixture",
      counter_scope: "shared",
      cap_coordination_state: "ready",
      cap_coordination_ready: true,
      cap_coordination_cap: 5_000,
      cap_coordination_matches_settings: true,
      cap_coordination_fence_started_at: null,
    };
  }

  if (pathname === "/api/v1/settings/sending") {
    return {
      tenant_id: DEMO_TENANT_ID,
      max_sends_per_hour: 5_000,
      quiet_hours_start: "22:00",
      quiet_hours_end: "07:00",
      quiet_hours_tz: "America/New_York",
      quiet_hours_per_recipient: true,
      ip_pool: { name: "shared", dedicated: false },
      updated_at: DEMO_ISO,
    };
  }

  const generic = genericCollection(pathname);

  if (pathname === "/api/v1/subscribers") {
    const page = requestedPage(query);
    const rows = [
      {
        id: "demo-subscriber-1",
        email: "alex@northstar.demo",
        name: "Alex Morgan",
        status: "enabled",
      },
      {
        id: "demo-subscriber-2",
        email: "priya@acme.demo",
        name: "Priya Sharma",
        status: "enabled",
      },
      {
        id: "demo-subscriber-3",
        email: "jordan@orbit.demo",
        name: "Jordan Lee",
        status: "enabled",
      },
    ].map((row, index) => ({
      ...row,
      version: `"subscriber:${row.id}:v1"`,
      tags: [index === 0 ? "VIP customers" : "Newsletter regulars"],
      created_at: DEMO_ISO,
      updated_at: DEMO_ISO,
      engagement_score: 91 - index * 8,
    }));
    return {
      items: page === 1 ? rows : [],
      total: rows.length,
      page,
      per_page: requestedPerPage(query, 50),
    };
  }

  if (pathname === "/api/v1/predictive/profiles") {
    return {
      items: [
        [
          "alex@northstar.demo",
          "demo-subscriber-1",
          18_400,
          0.08,
          "555",
          "Champions",
        ],
        [
          "priya@acme.demo",
          "demo-subscriber-2",
          12_800,
          0.21,
          "454",
          "Loyal customers",
        ],
        [
          "jordan@orbit.demo",
          "demo-subscriber-3",
          7_600,
          0.42,
          "344",
          "Promising",
        ],
      ].map(
        (
          [email, subscriberId, totalClv, churnRisk, rfmScore, segmentKey],
          index,
        ) => ({
          prediction: {
            email,
            subscriber_id: subscriberId,
            historic_clv_cents: Number(totalClv) - 4_000,
            predicted_clv_cents: 4_000,
            total_clv_cents: totalClv,
            churn_risk: churnRisk,
            predicted_order_count: 3 - index,
            predicted_gender: "unknown",
            confidence: 0.86 - index * 0.04,
            data_sufficiency: "good",
            calculated_at: DEMO_ISO,
          },
          rfm: {
            email,
            subscriber_id: subscriberId,
            recency_days: 4 + index * 7,
            frequency: 9 - index * 2,
            monetary_cents: Number(totalClv) - 4_000,
            recency_score: 5 - index,
            frequency_score: 5 - index,
            monetary_score: 5 - index,
            rfm_score: rfmScore,
            segment_key: segmentKey,
            calculated_at: DEMO_ISO,
          },
        }),
      ),
    };
  }

  if (pathname === "/api/v1/campaigns/count") {
    return { total: 3, by_status: { draft: 1, scheduled: 1, sent: 1 } };
  }

  if (pathname === "/api/v1/campaign-templates/search") {
    const page = requestedPage(query);
    const perPage = requestedPerPage(query, 48);
    return {
      items: templateRows(page, perPage),
      page,
      per_page: perPage,
      total: TEMPLATE_TOTAL,
      facets: templateFacets(),
    };
  }

  if (pathname === "/api/v1/campaign-templates/stats") {
    return {
      total: TEMPLATE_TOTAL,
      mine: 24,
      featured: 186,
      favorites: 6,
      used_last_30d: 342,
      top_template_id: "demo-template-1",
      top_template_name: "Signal Welcome 1",
      top_usage_count: 239,
      last_used_at: DEMO_ISO,
    };
  }

  if (pathname === "/api/v1/campaign-templates/goals") {
    return TEMPLATE_GOALS.map((goal) => ({
      goal,
      count: Math.floor(TEMPLATE_TOTAL / TEMPLATE_GOALS.length),
    }));
  }

  if (pathname === "/api/v1/campaign-templates") {
    return templateRows(1, 48);
  }

  if (pathname === "/api/v1/assets") {
    const images = [
      ["launch-hero.jpg", "Launch hero", "photo-1556761175-b413da4baf72"],
      [
        "customer-story.jpg",
        "Customer story",
        "photo-1521737711867-e3b97375f902",
      ],
      [
        "product-overview.jpg",
        "Product overview",
        "photo-1460925895917-afdab827c52f",
      ],
    ];
    return {
      items: images.map(([filename, altText, photo], index) => ({
        id: `00000000-0000-4000-8000-00000000002${index + 1}`,
        filename,
        mime: "image/jpeg",
        bytes: 184_000 + index * 42_000,
        width: 1_600,
        height: 900,
        url: `https://images.unsplash.com/${photo}?auto=format&fit=crop&w=1200&q=80`,
        createdAt: DEMO_ISO,
        altText,
        referencesCount: 6 - index,
        lastUsedAt: DEMO_ISO,
        folderId: index < 2 ? "00000000-0000-4000-8000-000000000031" : null,
        tags: ["demo", index === 0 ? "featured" : "campaign"],
      })),
      counts: { all: 3, recent: 3, inUse: 3, unused: 0, large: 0 },
      nextCursor: null,
    };
  }

  if (pathname === "/api/v1/assets/tags") {
    return {
      tags: [
        { tag: "demo", count: 3 },
        { tag: "featured", count: 1 },
        { tag: "campaign", count: 2 },
      ],
    };
  }

  if (pathname === "/api/v1/assets/folders") {
    return {
      folders: [
        {
          id: "00000000-0000-4000-8000-000000000031",
          name: "Launch campaign",
          createdAt: DEMO_ISO,
          assetCount: 2,
        },
      ],
    };
  }

  if (pathname === "/api/v1/collections") {
    const workspaceId =
      query.get("workspace_id") ?? "00000000-0000-4000-8000-000000000099";
    return {
      items: [
        ["Product catalogue", "content", 24],
        ["Launch coupons", "coupons", 12],
        ["Upcoming events", "schedule", 8],
      ].map(([name, type, rowCount], index) => ({
        id: `00000000-0000-4000-8000-00000000004${index + 1}`,
        tenant_id: workspaceId,
        name,
        collection_type: type,
        source_type: index === 0 ? "api" : index === 1 ? "uploaded" : "manual",
        data: [],
        row_count: rowCount,
        created_at: DEMO_ISO,
        updated_at: DEMO_ISO,
      })),
      total: 3,
    };
  }

  if (pathname === "/api/v1/track/events") {
    return { items: [1, 2, 3].map((index) => demoRow(pathname, index)) };
  }

  if (pathname === "/api/v1/track/catalog") {
    const periodDays = Math.min(
      365,
      Math.max(1, Number(query.get("days") ?? 30)),
    );
    return {
      items: RESOURCE_NAMES.track.map((eventName, index) => ({
        eventName,
        count: 420 - index * 96,
        uniqueSubscribers: 260 - index * 52,
        firstSeen: "2026-07-20T08:00:00.000Z",
        lastSeen: DEMO_ISO,
        daily: dailySeries(Math.min(periodDays, 7)),
      })),
      totalDistinctEventNames: 3,
      periodDays,
      dailySeriesPeriodDays: Math.min(periodDays, 7),
      eventBoundsScope: "period",
      timeZone: "UTC",
      asOf: DEMO_ISO,
    };
  }

  if (pathname === "/api/v1/track/stats") {
    const periodDays = Math.min(
      365,
      Math.max(1, Number(query.get("days") ?? 30)),
    );
    const daily = dailySeries(periodDays);
    return {
      periodDays,
      totalEvents: daily.reduce((sum, point) => sum + Number(point.count), 0),
      uniqueSubscribers: 684,
      uniqueEventNames: 3,
      daily,
      timeZone: "UTC",
      asOf: DEMO_ISO,
    };
  }

  if (pathname === "/api/v1/conversions") {
    return [1, 2, 3].map((index) => ({
      id: index,
      tenant_id: "00000000-0000-4000-8000-000000000099",
      event_name: ["plan_upgraded", "trial_converted", "annual_renewed"][
        index - 1
      ],
      subscriber_email: [
        "alex@northstar.demo",
        "priya@acme.demo",
        "jordan@orbit.demo",
      ][index - 1],
      amount_cents: 9_900 + index * 5_000,
      currency: "USD",
      campaign_id: `demo-campaign-${index}`,
      attributed_via: "last_touch",
      properties: { plan: index === 1 ? "Pro" : "Growth" },
      occurred_at: DEMO_ISO,
    }));
  }

  if (pathname === "/api/v1/conversions/keys") {
    return [
      {
        id: "demo-conversion-key-1",
        tenant_id: "00000000-0000-4000-8000-000000000099",
        label: "Website checkout",
        prefix: "pw_conv_live_9f2a",
        created_at: DEMO_ISO,
      },
      {
        id: "demo-conversion-key-2",
        tenant_id: "00000000-0000-4000-8000-000000000099",
        label: "Mobile upgrade flow",
        prefix: "pw_conv_live_7c1d",
        created_at: "2026-08-10T10:30:00.000Z",
      },
    ];
  }

  if (pathname === "/api/v1/referral-programs/current") {
    return {
      id: "demo-referral-program",
      active: true,
      milestones: [
        {
          count: 1,
          reward_label: "Launch supporter badge",
          reward_kind: "swag",
        },
        { count: 3, reward_label: "One month free", reward_kind: "free" },
        {
          count: 10,
          reward_label: "Founder's annual plan",
          reward_kind: "annual",
        },
      ],
      referee_reward_kind: "free",
      referee_reward_label: "14 bonus days",
      verification_window_days: 7,
      createdAt: DEMO_ISO,
      updatedAt: DEMO_ISO,
    };
  }

  if (pathname === "/api/v1/referrals/stats") {
    return {
      funnel: {
        conversions_7d: 18,
        conversions_30d: 64,
        conversions_90d: 172,
        clicks_total: 1_284,
        fraud_filtered_count: 7,
      },
      top_referrers: [
        { subscriber_id: "demo-subscriber-1", count: 18, last_at: DEMO_ISO },
        {
          subscriber_id: "demo-subscriber-2",
          count: 12,
          last_at: "2026-08-17T10:30:00.000Z",
        },
        {
          subscriber_id: "demo-subscriber-3",
          count: 8,
          last_at: "2026-08-16T10:30:00.000Z",
        },
      ],
      recent: [
        {
          referrer_id: "demo-subscriber-1",
          referee_id: "demo-referee-3",
          created_at: DEMO_ISO,
        },
        {
          referrer_id: "demo-subscriber-2",
          referee_id: "demo-referee-2",
          created_at: "2026-08-17T10:30:00.000Z",
        },
        {
          referrer_id: "demo-subscriber-3",
          referee_id: "demo-referee-1",
          created_at: "2026-08-16T10:30:00.000Z",
        },
      ],
    };
  }

  if (pathname === "/api/v1/referrals/leaderboard") {
    const windowText = query.get("window") ?? "90d";
    const windowDays = Math.min(
      365,
      Math.max(1, Number.parseInt(windowText, 10) || 90),
    );
    return {
      window_days: windowDays,
      items: [
        {
          referrer_email_masked: "a***@northstar.demo",
          conversions: 18,
          milestone: 10,
          rank: 1,
        },
        {
          referrer_email_masked: "p***@acme.demo",
          conversions: 12,
          milestone: 10,
          rank: 2,
        },
        {
          referrer_email_masked: "j***@orbit.demo",
          conversions: 8,
          milestone: 3,
          rank: 3,
        },
      ],
    };
  }

  if (pathname === "/api/v1/referrals/payouts") {
    return {
      items: [
        {
          id: "demo-payout-1",
          referrer_id: "demo-subscriber-1",
          milestone: 10,
          reward_label: "Founder's annual plan",
          status: "approved",
          created_at: DEMO_ISO,
          updated_at: DEMO_ISO,
        },
        {
          id: "demo-payout-2",
          referrer_id: "demo-subscriber-2",
          milestone: 3,
          reward_label: "One month free",
          status: "pending",
          created_at: "2026-08-17T10:30:00.000Z",
          updated_at: "2026-08-17T10:30:00.000Z",
        },
      ],
      total: 2,
    };
  }

  if (pathname === "/api/v1/custom-domains") {
    return [
      {
        id: "demo-domain-1",
        domain: "mail.postwave.demo",
        purpose: "tracking",
        verified: true,
        dns_records: [
          {
            type: "CNAME",
            name: "mail",
            value: "tracking.postwave.demo",
            verified: true,
          },
        ],
        createdAt: DEMO_ISO,
        verifiedAt: DEMO_ISO,
      },
      {
        id: "demo-domain-2",
        domain: "news.postwave.demo",
        purpose: "web",
        verified: true,
        dns_records: [
          {
            type: "CNAME",
            name: "news",
            value: "web.postwave.demo",
            verified: true,
          },
        ],
        createdAt: DEMO_ISO,
        verifiedAt: DEMO_ISO,
      },
      {
        id: "demo-domain-3",
        domain: "forms.postwave.demo",
        purpose: "forms",
        verified: false,
        dns_records: [
          {
            type: "CNAME",
            name: "forms",
            value: "forms.postwave.demo",
            verified: false,
          },
        ],
        createdAt: DEMO_ISO,
        verifiedAt: null,
      },
    ];
  }

  if (pathname === "/api/v1/deliverability/dmarc-reports") {
    const from = query.get("from") ?? undefined;
    const to = query.get("to") ?? DEMO_ISO;
    const domain = query.get("domain")?.toLowerCase() || "mail.postwave.demo";
    const scope = {
      ...(query.get("domain") ? { domain } : {}),
      ...(from ? { from } : {}),
      ...(query.get("to") ? { to } : {}),
    };
    return {
      items: [
        {
          id: "00000000-0000-4000-8000-000000000061",
          orgName: "Google Workspace",
          reportId: "postwave-demo-20260818",
          domain,
          policyP: "quarantine",
          policyPct: 25,
          dateBegin: from ?? "2026-08-17T00:00:00.000Z",
          dateEnd: to,
          passCount: 900,
          failCount: 100,
          receivedAt: to,
        },
      ],
      meta: {
        generatedAt: to,
        limit: Number(query.get("limit") ?? 500),
        returned: 1,
        totalReports: 1,
        hasMore: false,
        availableDomains: ["mail.postwave.demo"],
        domainInventoryTruncated: false,
        scope,
      },
    };
  }

  if (pathname === "/api/v1/deliverability/dmarc-insights") {
    const periodDays = Math.min(
      365,
      Math.max(1, Number(query.get("days") ?? 30)),
    );
    const end = new Date(DEMO_ISO);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - periodDays);
    const domain = query.get("domain")?.toLowerCase() ?? "";
    return {
      domain,
      periodDays,
      generatedAt: end.toISOString(),
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      latestReportAt: end.toISOString(),
      reportingDays: 1,
      reportCount: 1,
      totalMessages: 1_000,
      sourceCount: 1,
      sourceListTruncated: false,
      alignment: {
        bothPass: 700,
        dkimOnlyPass: 100,
        spfOnlyPass: 100,
        neitherPass: 100,
        alignedPct: 0.9,
      },
      disposition: { none: 950, quarantine: 30, reject: 20, unknown: 0 },
      topSources: [
        {
          sourceIp: "198.51.100.10",
          messages: 1_000,
          dkimPass: 800,
          spfPass: 800,
          bothPass: 700,
          alignedPct: 0.9,
          primaryDisposition: "none",
          quarantined: 30,
          rejected: 20,
          envelopeFromDomain: domain || "mail.postwave.demo",
        },
      ],
      topFailingSources: [],
      suggestions: [
        {
          code: "policy_action_volume_low",
          severity: "info",
          action:
            "Keep monitoring new sending sources before tightening policy.",
          reason: "Alignment is healthy across the observed demo traffic.",
        },
      ],
      series: [
        {
          date: end.toISOString().slice(0, 10),
          messages: 1_000,
          aligned: 900,
          alignedPct: 0.9,
        },
      ],
      ...(domain ? { latestPolicy: "quarantine" } : {}),
    };
  }

  if (pathname === "/api/v1/privacy/incidents") {
    return {
      incidents: [
        [
          "00000000-0000-4000-8000-000000000071",
          "high",
          "notifications_pending",
          "2026-08-18T10:30:00.000Z",
          "Export link accessed outside its intended review window",
        ],
        [
          "00000000-0000-4000-8000-000000000072",
          "medium",
          "contained",
          "2026-08-17T09:00:00.000Z",
          "Consent sync discrepancy isolated to one connector",
        ],
        [
          "00000000-0000-4000-8000-000000000073",
          "low",
          "closed",
          "2026-08-15T13:15:00.000Z",
          "Workspace access review completed with no exposure",
        ],
      ].map(([id, severity, status, detectedAt], index) => ({
        id,
        severity,
        status,
        detected_at: detectedAt,
        discovered_at: detectedAt,
        template_version: "incident-response-v2",
        affected_regions: [index === 1 ? "US-CA" : "EU"],
        affected_data_categories: [
          index === 0 ? "subscriber_export" : "consent_preferences",
        ],
        affected_subject_count: [14, 62, 1][index],
        notification_decisions: {
          authority: index === 0 ? "review_pending" : "not_required",
        },
        jurisdictions: [index === 1 ? "US-CA" : "EU"],
        summary: [
          "Export link accessed outside its intended review window",
          "Consent sync discrepancy isolated to one connector",
          "Workspace access review completed with no exposure",
        ][index],
        created_at: detectedAt,
        updated_at: detectedAt,
      })),
      known_jurisdictions: [
        { code: "EU", name: "European Union" },
        { code: "US-CA", name: "California, United States" },
      ],
    };
  }

  if (pathname === "/api/v1/privacy/portal/double-optin/pending") {
    return {
      pending: [
        {
          id: "demo-optin-1",
          email: "morgan@northstar.demo",
          sent_at: "2026-08-18T09:00:00.000Z",
          expires_at: "2026-10-17T09:00:00.000Z",
        },
        {
          id: "demo-optin-2",
          email: "sam@acme.demo",
          sent_at: "2026-08-17T13:30:00.000Z",
          expires_at: "2026-10-16T13:30:00.000Z",
        },
        {
          id: "demo-optin-3",
          email: "devon@orbit.demo",
          sent_at: "2026-08-16T15:45:00.000Z",
          expires_at: "2026-10-15T15:45:00.000Z",
        },
      ],
    };
  }

  if (pathname === "/api/v1/consent/receipts") {
    const workspaceId =
      query.get("workspace_id") ?? "00000000-0000-4000-8000-000000000099";
    const receipts = [
      {
        id: "103",
        subscriber_email: "alex@northstar.demo",
        prev_state: "pending",
        new_state: "subscribed",
        source: "launch signup form",
        source_detail:
          "Checked email updates during the product launch signup.",
        privacy_policy_version: "2026-08",
        captured_text: "Send me useful product updates.",
        at: "2026-08-18T10:25:00.000Z",
        recorded_at: "2026-08-18T10:25:01.000Z",
        kind: "receipt",
      },
      {
        id: "102",
        subscriber_email: "priya@acme.demo",
        prev_state: "pending",
        new_state: "subscribed",
        source: "demo request",
        source_detail: "Confirmed follow-up during a demo request.",
        privacy_policy_version: "2026-08",
        captured_text: "I agree to receive follow-up by email.",
        at: "2026-08-17T09:10:00.000Z",
        recorded_at: "2026-08-17T09:10:01.000Z",
        kind: "receipt",
      },
      {
        id: "00000000-0000-4000-8000-000000000081",
        subscriber_email: "jordan@orbit.demo",
        new_state: "granted",
        source: "preference center",
        source_detail:
          "Saved marketing preference from the hosted preference center.",
        privacy_policy_version: "2026-08",
        captured_text: "Marketing email is allowed.",
        at: "2026-08-16T14:00:00.000Z",
        recorded_at: "2026-08-16T14:00:01.000Z",
        kind: "proof",
      },
    ];
    return {
      schema_version: 1,
      workspace_id: workspaceId,
      snapshot_at: DEMO_ISO,
      source_planes: ["consent_receipts", "consent_records"],
      receipts,
      count: receipts.length,
      has_more: false,
    };
  }

  if (pathname === "/api/v1/consent/events") {
    const workspaceId =
      query.get("workspace_id") ?? "00000000-0000-4000-8000-000000000099";
    const events = [
      {
        id: "00000000-0000-4000-8000-000000000091",
        decision_id: "00000000-0000-4000-8000-000000000081",
        subject_type: "subscriber",
        subject_id: "demo-subscriber-1",
        subject_email: "alex@northstar.demo",
        channel: "web",
        category: "email_marketing",
        action: "granted",
        source: "launch signup form",
        policy_version: "2026-08",
        preferences: { product_updates: true, weekly_digest: true },
        proof_text: "Saved from the launch signup form.",
        created_at: "2026-08-18T10:20:00.000Z",
        recorded_at: "2026-08-18T10:20:01.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000090",
        subject_type: "subscriber",
        subject_id: "demo-subscriber-2",
        subject_email: "priya@acme.demo",
        channel: "desktop",
        category: "analytics",
        action: "granted",
        source: "preference center",
        policy_version: "2026-08",
        preferences: { analytics: true },
        proof_text: "Updated during the guided preference review.",
        created_at: "2026-08-17T08:30:00.000Z",
        recorded_at: "2026-08-17T08:30:01.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000089",
        subject_type: "workspace",
        subject_id: workspaceId,
        channel: "api",
        category: "ai_processing",
        action: "denied",
        source: "workspace policy",
        policy_version: "2026-08",
        preferences: { ai_processing: false },
        proof_text: "AI processing remains disabled for this workspace.",
        created_at: "2026-08-16T12:00:00.000Z",
        recorded_at: "2026-08-16T12:00:01.000Z",
      },
    ];
    return {
      schema_version: 1,
      workspace_id: workspaceId,
      snapshot_at: DEMO_ISO,
      source_planes: ["consent_events"],
      events,
      count: events.length,
      has_more: false,
    };
  }

  if (pathname === "/api/v1/sms/conversations") {
    const conversations = [
      [
        "+14155550111",
        "Can you send me the launch details?",
        "inbound",
        2,
        "alex@northstar.demo",
      ],
      [
        "+14155550112",
        "Thanks — the demo time works for me.",
        "outbound",
        0,
        "priya@acme.demo",
      ],
      ["+14155550113", "UPDATES", "inbound", 1, undefined],
    ].map(
      (
        [
          phoneE164,
          lastMessagePreview,
          lastDirection,
          unreadCount,
          subscriberEmail,
        ],
        index,
      ) => ({
        phoneE164,
        lastMessagePreview,
        lastMessageAt: new Date(
          Date.parse(DEMO_ISO) - index * 3_600_000,
        ).toISOString(),
        lastDirection,
        messageCount: 8 - index,
        unreadCount,
        ...(Number(unreadCount) > 0
          ? {
              oldestUnreadAt: new Date(
                Date.parse(DEMO_ISO) - index * 3_600_000,
              ).toISOString(),
            }
          : {}),
        ...(subscriberEmail ? { subscriberEmail } : {}),
        identityAmbiguous: false,
      }),
    );
    return {
      tenantId: DEMO_TENANT_ID,
      conversations,
      snapshotAt: DEMO_ISO,
      unreadTotal: 2,
      unknownTotal: 1,
      totalConversations: 3,
      activeTotal: 3,
      snoozedTotal: 0,
      archivedTotal: 0,
    };
  }

  if (pathname === "/api/v1/sms/quick-replies") {
    return {
      replies: [
        {
          id: "demo-reply-1",
          label: "Send demo link",
          body: "Absolutely — here is the demo link and a quick overview.",
          useCount: 18,
          lastUsedAt: DEMO_ISO,
          createdAt: DEMO_ISO,
          updatedAt: DEMO_ISO,
        },
        {
          id: "demo-reply-2",
          label: "Book follow-up",
          body: "Happy to help. Would tomorrow afternoon work for a follow-up?",
          useCount: 11,
          createdAt: DEMO_ISO,
          updatedAt: DEMO_ISO,
        },
      ],
    };
  }

  if (pathname === "/api/v1/voice/sources") {
    return {
      sources: [
        {
          id: "demo-voice-source-1",
          type: "blog_rss",
          params: { FeedURL: "https://news.postwave.demo/feed.xml" },
          status: "ingested",
          last_item_count: 48,
          last_ingested_at: DEMO_ISO,
        },
        {
          id: "demo-voice-source-2",
          type: "campaign_archive",
          label: "Best-performing campaigns",
          status: "ready",
          last_item_count: 120,
          last_ingested_at: DEMO_ISO,
        },
      ],
    };
  }

  if (pathname === "/api/v1/voice/profile") {
    return {
      description:
        "Clear, confident and practical. Leads with the useful result, then gives the reader one obvious next step.",
      version: 3,
      built_at: DEMO_ISO,
      samples: [
        "Here’s what changed, why it matters, and the quickest way to put it to work.",
        "A useful update for teams that want to move faster without adding complexity.",
      ],
      status: "ready",
    };
  }

  if (pathname === "/api/v1/voice/brand-profile") {
    return {
      descriptors: ["clear", "confident", "warm", "practical"],
      writing_rules: [
        "Lead with the outcome.",
        "Use concrete language and short paragraphs.",
        "End with one natural next step.",
      ],
      sample_snippets: [
        "The launch workspace is ready. Your audience, message and follow-up are already connected.",
        "Start with the signal that matters, then make the next step feel effortless.",
      ],
      updated_at: DEMO_ISO,
      extracted_at: DEMO_ISO,
    };
  }

  if (pathname === "/api/v1/voice/templates") {
    return {
      templates: [
        {
          id: "demo-prompt-1",
          name: "Launch announcement",
          description:
            "A crisp product announcement with one strong call to action.",
        },
        {
          id: "demo-prompt-2",
          name: "Customer story",
          description:
            "Turn a customer result into an engaging, credible email.",
        },
        {
          id: "demo-prompt-3",
          name: "Win-back note",
          description:
            "A warm re-engagement message that earns attention without pressure.",
        },
      ],
    };
  }

  if (pathname === "/api/v1/sending/frequency-caps") {
    return {
      rules: [
        {
          id: "demo-cap-1",
          label: "Marketing messages",
          max_sends: 3,
          window_hours: 24,
          active: true,
          channels: ["email"],
          updated_at: "2026-08-18T10:30:00.000Z",
        },
        {
          id: "demo-cap-2",
          label: "Cross-channel launch",
          max_sends: 5,
          window_hours: 72,
          active: true,
          channels: ["email", "sms", "push"],
          updated_at: "2026-08-18T10:31:00.000Z",
        },
        {
          id: "demo-cap-3",
          label: "SMS courtesy cap",
          max_sends: 2,
          window_hours: 24,
          active: true,
          channels: ["sms"],
          updated_at: "2026-08-18T10:32:00.000Z",
        },
      ],
    };
  }

  if (pathname === "/api/v1/agency/children") {
    return {
      children: [
        {
          id: "47000000-0000-4000-8000-000000000001",
          slug: "northstar-studio",
          name: "Northstar Studio",
          tier: "pro",
          parent_tenant_id: DEMO_TENANT_ID,
          billing_mode: "parent",
          reseller_markup_bps: 1_500,
          whitelabel_enabled: true,
          created_at: DEMO_ISO,
          updated_at: DEMO_ISO,
        },
        {
          id: "47000000-0000-4000-8000-000000000002",
          slug: "acme-labs",
          name: "Acme Labs",
          tier: "sending",
          parent_tenant_id: DEMO_TENANT_ID,
          billing_mode: "parent",
          reseller_markup_bps: 1_000,
          whitelabel_enabled: true,
          created_at: DEMO_ISO,
          updated_at: DEMO_ISO,
        },
        {
          id: "47000000-0000-4000-8000-000000000003",
          slug: "orbit-commerce",
          name: "Orbit Commerce",
          tier: "studio",
          parent_tenant_id: DEMO_TENANT_ID,
          billing_mode: "self",
          reseller_markup_bps: 0,
          whitelabel_enabled: false,
          created_at: DEMO_ISO,
          updated_at: DEMO_ISO,
        },
      ],
      count: 3,
      has_more: false,
    };
  }

  if (pathname === "/api/v1/agency/branding") {
    return {
      whitelabel_enabled: true,
      brand_name: "Moosewave Partner Cloud",
      custom_domain: "clients.postwave.example.com",
      logo_url: "",
      primary_color: "#7C183E",
      support_email: "success@postwave.example.com",
      legal_entity: "Moosewave Demo Partners",
      updated_at: DEMO_ISO,
      etag: `"agency-branding:${DEMO_TENANT_ID}:v1"`,
    };
  }

  if (pathname === "/api/v1/inbound-routes") {
    return {
      routes: [
        {
          id: "demo-route-1",
          name: "VIP replies",
          priority: 10,
          stop_on_match: true,
          enabled: true,
          match_recipient: "vip@reply.postwave.demo",
          match_subject_prefix: "VIP",
          actions: [
            { kind: "tag", tag: "VIP customers" },
            { kind: "automation_trigger", event_type: "vip_reply_received" },
          ],
          last_matched_at: DEMO_ISO,
          match_count: 84,
          updated_at: DEMO_ISO,
          action_retry_max: 2,
          action_retry_backoff_seconds: 30,
        },
        {
          id: "demo-route-2",
          name: "Support forwards",
          priority: 20,
          stop_on_match: false,
          enabled: true,
          match_recipient: "support@reply.postwave.demo",
          actions: [{ kind: "forward", to: "success@postwave.demo" }],
          last_matched_at: "2026-08-17T10:30:00.000Z",
          match_count: 146,
          updated_at: DEMO_ISO,
          action_retry_max: 3,
          action_retry_backoff_seconds: 60,
        },
        {
          id: "demo-route-3",
          name: "Store unmatched replies",
          priority: 100,
          stop_on_match: true,
          enabled: true,
          match_recipient: "*@reply.postwave.demo",
          actions: [{ kind: "store_only" }],
          last_matched_at: DEMO_ISO,
          match_count: 312,
          updated_at: DEMO_ISO,
          action_retry_max: 0,
          action_retry_backoff_seconds: 0,
        },
      ],
    };
  }

  if (pathname === "/api/v1/inbound-emails/endpoint") {
    return {
      id: "demo-inbound-endpoint-1",
      tenantId: "00000000-0000-4000-8000-000000000099",
      slug: "postwave-demo",
      secretConfigured: true,
      rotationRequired: false,
      secretRotatedAt: DEMO_ISO,
      createdAt: "2026-07-01T10:30:00.000Z",
    };
  }

  if (pathname === "/api/v1/compliance/programs") {
    return {
      programs: [
        {
          framework: "soc2",
          status: "attested",
          signedByEmail: "security@postwave.demo",
          signerName: "Maya Chen",
          notes: "Annual operating-controls attestation.",
          attestedAt: "2026-06-01T10:00:00.000Z",
          renewalAt: "2027-06-01T10:00:00.000Z",
          updatedAt: DEMO_ISO,
        },
        {
          framework: "gdpr",
          status: "attested",
          signedByEmail: "privacy@postwave.demo",
          signerName: "Lena Ortiz",
          notes: "Controller and processor controls reviewed.",
          attestedAt: "2026-05-14T10:00:00.000Z",
          renewalAt: "2027-05-14T10:00:00.000Z",
          updatedAt: DEMO_ISO,
        },
        {
          framework: "ccpa",
          status: "in_progress",
          notes: "Annual evidence review is underway.",
          updatedAt: DEMO_ISO,
        },
      ],
    };
  }

  if (pathname === "/api/v1/audit/retention-activity") {
    return {
      events: [
        {
          id: 3,
          tenant_id: "00000000-0000-4000-8000-000000000099",
          action: "audit.retention.purge",
          deleted_id_range: "12001–12420",
          deleted_count: 420,
          retention_days: 365,
          before_root_hash:
            "77d1185e4c831a657f18df26fd96c0f5cfb72c6b20ca5e2439143fa8c61c77a1",
          at: DEMO_ISO,
        },
        {
          id: 2,
          tenant_id: "00000000-0000-4000-8000-000000000099",
          action: "audit.retention.purge",
          deleted_id_range: "11601–12000",
          deleted_count: 400,
          retention_days: 365,
          before_root_hash:
            "d9bf3d2b82734bc10b9157672257639cfb2cba7075d076c80bfb91fbcde46f81",
          at: "2026-08-10T10:30:00.000Z",
        },
      ],
      count: 2,
      total_purged_last_30d: 820,
    };
  }

  if (pathname === "/api/v1/audit/stats") {
    return {
      window: "30d",
      totalEvents: 184,
      byActorType: [
        { label: "human", count: 126 },
        { label: "agent", count: 58 },
      ],
      topActions: [
        { label: "campaign.sent", count: 42 },
        { label: "subscriber.updated", count: 38 },
      ],
      daily: dailySeries(30),
    };
  }

  if (pathname === "/api/v1/settings/custom-fields") {
    return {
      max_custom_fields: 100,
      max_searchable_fields: 25,
      used_custom_fields: 18,
      used_searchable_fields: 9,
    };
  }

  if (pathname === "/api/v1/webhooks/alert-prefs") {
    return {
      user_id: "demo-user",
      tenant_id: "00000000-0000-4000-8000-000000000099",
      notify_auto_disabled: true,
      notify_failure_rate: true,
      failure_rate_pct: 5,
      notify_latency: true,
      latency_ms: 2_000,
      updated_at: DEMO_ISO,
    };
  }
  if (
    BARE_ARRAY_PATHS.some(
      (path) => pathname.endsWith(path) || pathname.includes(`${path}/`),
    )
  ) {
    return generic.items;
  }

  if (pathname === "/api/v1/integrations/catalog") {
    return {
      schema_version: "1",
      categories: [
        { key: "crm", label: "CRM" },
        { key: "commerce", label: "Commerce" },
        { key: "data", label: "Data" },
      ],
      capabilities: ["audience_sync", "catalog_sync", "event_ingest"],
      items: [
        {
          ...demoRow(pathname, 1),
          slug: "hubspot",
          name: "HubSpot",
          category: "crm",
          featured: true,
        },
        {
          ...demoRow(pathname, 2),
          slug: "shopify",
          name: "Shopify",
          category: "commerce",
          featured: true,
        },
        {
          ...demoRow(pathname, 3),
          slug: "snowflake",
          name: "Snowflake",
          category: "data",
          featured: false,
        },
      ],
      counts: { total: 3, native: 3 },
    };
  }

  if (pathname === "/api/v1/tag-groups") {
    return {
      items: [
        {
          id: "00000000-0000-4000-8000-000000000011",
          name: "Lifecycle",
          color: "indigo",
          sort_order: 1,
          created_at: DEMO_ISO,
        },
        {
          id: "00000000-0000-4000-8000-000000000012",
          name: "Customer value",
          color: "rose",
          sort_order: 2,
          created_at: DEMO_ISO,
        },
        {
          id: "00000000-0000-4000-8000-000000000013",
          name: "Acquisition",
          color: "teal",
          sort_order: 3,
          created_at: DEMO_ISO,
        },
      ],
    };
  }

  if (pathname === "/api/v1/tag-taxonomy") {
    return {
      items: RESOURCE_NAMES.tags.map((tag, index) => ({
        tag,
        subscribers: [418, 126, 862][index],
        registered: true,
        created_at: DEMO_ISO,
      })),
      count: 3,
    };
  }

  if (pathname === "/api/v1/integrations/connections") {
    return {
      items: [
        {
          ...demoRow(pathname, 1),
          slug: "hubspot",
          name: "HubSpot",
          category: "crm",
          badge: "native",
          runtime_status: "available",
        },
        {
          ...demoRow(pathname, 2),
          slug: "shopify",
          name: "Shopify",
          category: "commerce",
          badge: "native",
          runtime_status: "available",
        },
      ],
      summary: { connected: 2 },
    };
  }

  if (pathname === "/api/v1/audit/my-scopes") {
    return {
      scopes: ["audit:read", "audit:read_pii"],
      auditScopes: ["audit:read", "audit:read_pii"],
      isAdmin: true,
    };
  }

  if (pathname === "/api/v1/isp-breakdown") {
    return {
      window_days: 30,
      buckets: [
        {
          isp: "Gmail",
          subscribers: 8_240,
          sent: 18_460,
          opens: 8_340,
          clicks: 1_690,
          bounces: 118,
          complaints: 4,
          open_rate: 0.452,
          click_rate: 0.092,
          bounce_rate: 0.006,
          complaint_rate: 0.0002,
        },
        {
          isp: "Outlook",
          subscribers: 2_680,
          sent: 6_480,
          opens: 2_710,
          clicks: 496,
          bounces: 54,
          complaints: 2,
          open_rate: 0.418,
          click_rate: 0.077,
          bounce_rate: 0.008,
          complaint_rate: 0.0003,
        },
      ],
    };
  }

  if (pathname === "/api/v1/tags") {
    return {
      items: [1, 2, 3].map((index) => ({
        id: `00000000-0000-4000-8000-00000000000${index}`,
        name: RESOURCE_NAMES.tags[index - 1],
        color: ["indigo", "rose", "teal"][index - 1],
        description:
          "A realistic, read-only tag included for the Moosewave product demo.",
        created_at: DEMO_ISO,
        updated_at: DEMO_ISO,
        pii: false,
        version: 1,
        etag: `"tag:00000000-0000-4000-8000-00000000000${index}:v1"`,
      })),
      total: 3,
    };
  }

  if (pathname === "/api/v1/sms/suppressions") {
    return {
      tenantId: DEMO_TENANT_ID,
      items: [
        {
          id: "00000000-0000-4000-8000-000000000143",
          phone_e164: "+14155550103",
          reason: "manual",
          source: "manual",
          reversible: true,
          created_at: DEMO_ISO,
        },
        {
          id: "00000000-0000-4000-8000-000000000142",
          phone_e164: "+14155550102",
          reason: "stop_keyword",
          source: "twilio",
          reversible: false,
          locked_reason: "carrier_or_system_authority",
          created_at: DEMO_ISO,
        },
        {
          id: "00000000-0000-4000-8000-000000000141",
          phone_e164: "+14155550101",
          reason: "carrier_block",
          source: "bandwidth",
          reversible: false,
          locked_reason: "carrier_or_system_authority",
          created_at: DEMO_ISO,
        },
      ],
      total: 3,
      snapshotAt: DEMO_ISO,
    };
  }

  if (pathname === "/api/v1/sms/quiet-hours") {
    return {
      tenantId: DEMO_TENANT_ID,
      items: [
        {
          id: "00000000-0000-4000-8000-000000000141",
          tenant_id: DEMO_TENANT_ID,
          label: "Tenant overnight",
          country_code: "",
          start_minute: 1_260,
          end_minute: 540,
          start_local: "21:00",
          end_local: "09:00",
          days: [0, 1, 2, 3, 4, 5, 6],
          timezone: "America/New_York",
          enabled: true,
          created_at: DEMO_ISO,
          updated_at: DEMO_ISO,
        },
      ],
    };
  }

  if (pathname === "/api/v1/sms/keyword-responses") {
    return {
      tenantId: DEMO_TENANT_ID,
      items: [
        {
          id: "00000000-0000-4000-8000-000000000142",
          tenant_id: DEMO_TENANT_ID,
          keyword: "LAUNCH",
          response_body: "Thanks — we'll keep you posted.",
          response_text: "Thanks — we'll keep you posted.",
          action: "reply_only",
          enabled: true,
          autoReplyDispatchAvailable: false,
          autoReplyDispatchUnavailableReason:
            "sms_auto_reply_dispatch_release_held",
          opt_in_count: 0,
          created_at: DEMO_ISO,
          updated_at: DEMO_ISO,
        },
      ],
    };
  }

  if (pathname === "/api/v1/sms/senders") {
    return {
      items: [
        {
          ...demoRow(pathname, 1),
          id: "demo-sender-us",
          label: "Moosewave updates",
          sender: "+14155550101",
          country_code: "US",
        },
      ],
    };
  }

  return generic;
}

/** True only for collection-shaped responses that contain no records. */
export function responseNeedsDemoData(value: unknown): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (entries.length === 0) return true;
  const collections = entries.filter(
    ([key, entry]) => COLLECTION_KEYS.has(key) && Array.isArray(entry),
  );
  return (
    collections.length > 0 &&
    collections.every(([, entry]) => (entry as unknown[]).length === 0)
  );
}
