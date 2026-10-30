import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type APIResponse,
  type Page,
  type Route,
} from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const FORM_ID = "frm_newsletter";
const SUBSCRIBER_ID = "11111111-2222-4333-8444-555555555555";
const SEGMENT_FIXTURE_NAME = "Residual route closure segment";
const REFERENCE_ID = "residual-reference-design";
const DESIGN_ID = "residual-generated-design";
const TENANT_HEADERS = { "X-Tenant-Slug": "demo" };
const BLOCKING_IMPACTS = new Set(["critical", "serious"]);
// Shared idempotent mutations retry 5xx responses internally. These fixtures
// exercise the component-owned error and explicit retry, so use a permanent
// application response that maps one network attempt to one operator action.
const UI_CONTROLLED_FAILURE_STATUS = 422;

const SEMANTIC_CAMPAIGN = {
  id: "camp_demo_semantic",
  tenant_id: "residual-tenant",
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
};

const SENT_CAMPAIGN = {
  id: "camp_demo_sent",
  tenant_id: "residual-tenant",
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
};

const FORM_FIXTURE = {
  id: FORM_ID,
  tenantId: "residual-tenant",
  slug: "newsletter",
  name: "Newsletter signup",
  optInMode: "double",
  structure: { fields: [] },
  settings: {},
  status: "published",
  createdAt: "2026-03-04T10:00:00Z",
  updatedAt: "2026-04-15T14:23:00Z",
};

const REFERENCE_TEMPLATE = {
  id: REFERENCE_ID,
  name: "Editorial signal reference",
  description: "A governed reference for deterministic design review.",
  subject: "A useful weekly signal",
  goal: "newsletter",
  tags: ["editorial"],
  template_kind: "reference",
  source: "platform",
  review_status: "approved",
  source_license_status: "reviewed",
  preview_assets: [],
  capabilities: {
    can_preview: true,
    can_favorite: true,
    can_adapt: true,
    can_use_directly: false,
    can_edit_directly: false,
    can_clone: false,
    can_create_campaign: false,
    can_delete: false,
    can_archive: false,
    can_restore: false,
    has_source_html: false,
    has_source_mjml: false,
    has_desktop_preview: false,
    has_mobile_preview: false,
  },
};

const DESIGN_REVISION = {
  id: "residual-revision-1",
  draft_id: DESIGN_ID,
  revision: 1,
  operation: "initial",
  output: {
    name: "Generated editorial signal",
    subject: "Three useful product updates",
    preview_text: "A concise weekly digest",
    body_html:
      "<!doctype html><html><body><h1>Three useful updates</h1><p>Reviewable output.</p></body></html>",
    variables: {},
    unresolved_variables: [],
    reference_template_ids: [REFERENCE_ID],
    warnings: [],
  },
  output_hash: "a".repeat(64),
  validation: {
    status: "pass",
    checks: [
      {
        code: "required_sections",
        status: "pass",
        message: "All required sections are present.",
      },
    ],
  },
  warnings: [],
  created_at: "2026-08-20T09:00:00Z",
};

type DesignState = "generating" | "failed" | "ready";

function designFixture(status: DesignState) {
  return {
    id: DESIGN_ID,
    mode: "adapt",
    status,
    source_template_id: REFERENCE_ID,
    reference_template_ids: [REFERENCE_ID],
    current_revision: status === "ready" ? 1 : 0,
    ...(status === "ready" ? { revision: DESIGN_REVISION } : {}),
    attempt_count: status === "failed" ? 2 : 1,
    ...(status === "failed"
      ? {
          last_error_code: "provider_unavailable",
          last_error_message: "The design provider did not respond.",
        }
      : {}),
    capabilities: {
      can_refine: status === "ready",
      can_retry: status === "failed",
      can_save: status === "ready",
      can_create_campaign: status === "ready",
      can_archive: true,
    },
    recommended_action: status === "failed" ? "retry" : "review",
    retry_after_seconds: status === "generating" ? 30 : undefined,
    expires_at: "2099-08-21T09:00:00Z",
    created_at: "2026-08-20T09:00:00Z",
    updated_at: "2026-08-20T09:01:00Z",
    request: {
      mode: "adapt",
      source_template_id: REFERENCE_ID,
      instructions: "Adapt this into a weekly product newsletter.",
    },
  };
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
    headers,
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (
      window as typeof window & {
        __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
      }
    ).__POSTWAVE_FORCE_REAL_API_FOR_E2E__ = true;
  });
  await page.route("**/api/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    }),
  );
});

async function installAuthFixture(page: Page) {
  await page.route("**/api/v1/auth/me", async (route) => {
    await fulfillJson(route, {
      user_id: "residual-user",
      tenant_id: "residual-tenant",
      email: "owner@example.test",
      role: "owner",
      effective_role: "owner",
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Residual closure workspace",
      workspace_slug: "demo",
    });
  });
}

async function installCampaignDetailFixtures(page: Page) {
  for (const campaign of [SEMANTIC_CAMPAIGN, SENT_CAMPAIGN]) {
    const base = `/api/v1/campaigns/${campaign.id}`;
    await page.route(`**${base}`, (route) =>
      fulfillJson(route, campaign, 200, { ETag: `"${campaign.id}-v1"` }),
    );
    await page.route(`**${base}/edit-lease`, (route) =>
      fulfillJson(route, { ok: true }),
    );
  }
  await page.route(
    `**/api/v1/campaigns/${SEMANTIC_CAMPAIGN.id}/save-as-template`,
    async (route) => {
      const input = route.request().postDataJSON() as { slug: string };
      await fulfillJson(route, {
        id: "residual-semantic-template",
        slug: input.slug,
      });
    },
  );
  await page.route(
    `**/api/v1/campaigns/${SENT_CAMPAIGN.id}/resend-unopened`,
    (route) =>
      fulfillJson(route, {
        campaign_id: "residual-resend-campaign",
        status: "scheduled",
      }),
  );
}

function makeFormSubmissionFixtures() {
  const start = Date.parse("2026-04-29T10:00:00Z");
  return Array.from({ length: 47 }, (_, index) => {
    const submittedAt = new Date(
      start - index * 5 * 60 * 60 * 1_000,
    ).toISOString();
    const confirmed = index % 4 !== 0;
    return {
      id: `sub_${FORM_ID}_${index}`,
      formId: FORM_ID,
      email: `reader${index}@example.com`,
      customFields: index % 3 === 0 ? { role: "newsletter writer" } : {},
      status: confirmed ? "confirmed" : "pending",
      ip: `203.0.113.${(index * 7) % 250}`,
      userAgent: "Moosewave residual-state fixture",
      submittedAt,
      confirmedAt: confirmed
        ? new Date(Date.parse(submittedAt) + 6 * 60 * 1_000).toISOString()
        : null,
    };
  });
}

async function installFormSubmissionsFixture(page: Page) {
  let submissions = makeFormSubmissionFixtures();
  const base = `/api/v1/forms/${FORM_ID}`;
  await page.route(`**${base}`, (route) =>
    fulfillJson(route, FORM_FIXTURE, 200, { ETag: `"${FORM_ID}-v1"` }),
  );
  await page.route(`**${base}/submissions?**`, (route) =>
    fulfillJson(route, submissions, 200, { "X-Next-Cursor": "" }),
  );
  await page.route(`**${base}/submissions.csv`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/csv",
      body: "id,email,status\nsub_fixture,reader0@example.com,pending\n",
    }),
  );
  return {
    removeSubmission(id: string) {
      submissions = submissions.filter((submission) => submission.id !== id);
    },
  };
}

async function installPaidMembersFixture(page: Page) {
  const calls = { deletes: 0, posts: 0 };
  let revokeAttempts = 0;
  let members: Array<{
    cancelled_at: string | null;
    metadata: Record<string, unknown>;
    started_at: string;
    status: string;
    stripe_subscription_id: string | null;
    subscriber_email: string;
    tier: string | null;
  }> = [
    {
      subscriber_email: "paid.reader@example.test",
      status: "active",
      tier: "Pro",
      stripe_subscription_id: null,
      started_at: "2026-08-20T09:00:00Z",
      cancelled_at: null,
      metadata: {},
    },
  ];
  await page.route("**/api/v1/paid-members**", async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;
    if (method === "GET") {
      const url = new URL(request.url());
      const email = url.searchParams.get("email")?.toLowerCase() ?? "";
      const status = url.searchParams.get("status") ?? "";
      const filtered = members.filter(
        (member) =>
          (!email || member.subscriber_email.toLowerCase().includes(email)) &&
          (!status || member.status === status),
      );
      await fulfillJson(route, {
        members: filtered,
        total: filtered.length,
        page: 1,
        per_page: 50,
      });
      return;
    }
    if (method === "POST" && pathname === "/api/v1/paid-members") {
      calls.posts += 1;
      const input = request.postDataJSON() as {
        subscriber_email: string;
        status?: string;
        tier?: string;
      };
      if (
        input.subscriber_email === "failure@example.test" ||
        input.tier === "Transport failure"
      ) {
        await fulfillJson(
          route,
          { message: "Paid-member transport failed." },
          UI_CONTROLLED_FAILURE_STATUS,
        );
        return;
      }
      if (input.subscriber_email === "pending@example.test") {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      if (input.subscriber_email === "paid.reader@example.test") {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const existing = members.findIndex(
        (member) => member.subscriber_email === input.subscriber_email,
      );
      const next = {
        subscriber_email: input.subscriber_email,
        status: input.status ?? "active",
        tier: input.tier ?? null,
        stripe_subscription_id: null,
        started_at:
          existing >= 0
            ? members[existing]!.started_at
            : "2026-08-21T09:00:00Z",
        cancelled_at:
          input.status === "canceled" ? "2026-08-21T09:00:00Z" : null,
        metadata: {},
      };
      if (existing >= 0) members[existing] = next;
      else members = [next, ...members];
      await fulfillJson(route, { ok: true });
      return;
    }
    if (method === "DELETE" && pathname.startsWith("/api/v1/paid-members/")) {
      calls.deletes += 1;
      revokeAttempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (revokeAttempts === 1) {
        await fulfillJson(
          route,
          { message: "Revoke transport failed." },
          UI_CONTROLLED_FAILURE_STATUS,
        );
        return;
      }
      const email = decodeURIComponent(pathname.split("/").at(-1) ?? "");
      members = members.filter((member) => member.subscriber_email !== email);
      await fulfillJson(route, { ok: true });
      return;
    }
    await fulfillJson(
      route,
      { message: "Unexpected paid-member request." },
      405,
    );
  });
  return calls;
}

async function installSegmentEditorFixtures(page: Page) {
  await page.route("**/api/v1/custom-fields", (route) =>
    fulfillJson(route, []),
  );
  await page.route("**/api/v1/segments/predicate-registry", (route) =>
    fulfillJson(route, {
      registry_version: "closure-v1",
      boolean_ops: ["and", "or", "not"],
      predicates: [],
      metrics: [],
      custom_objects: [],
      warnings: [],
    }),
  );
  await page.route("**/api/v1/segments/templates", (route) =>
    fulfillJson(route, { items: [] }),
  );
  await page.route("**/api/v1/segments/preview", (route) =>
    fulfillJson(route, { count: 0, total: 0 }),
  );
}

async function installSubscriberFixtures(page: Page) {
  let notes = [
    {
      id: "note-1",
      subscriber_id: SUBSCRIBER_ID,
      body: "Pinned customer context",
      markdown_body: "Pinned customer context",
      mentions: [],
      author_email: "owner@example.test",
      pinned: true,
      created_at: "2026-08-20T09:00:00Z",
    },
  ];
  let consentStatus = "opted_in";
  let subscriber = {
    id: SUBSCRIBER_ID,
    email: "reader@example.test",
    status: "enabled",
    consent_timestamp: "2026-06-10T09:00:00Z",
    consent_source: "double_optin",
    custom_fields: {},
    tags: ["newsletter"],
    first_name: "Ada",
    last_name: "Reader",
    version: 3,
    created_at: "2026-06-10T09:00:00Z",
    updated_at: "2026-08-20T09:00:00Z",
  };
  let patchAttempts = 0;
  let receiptAttempts = 0;
  let untagAttempts = 0;
  let notePatchAttempts = 0;
  let noteDeleteAttempts = 0;

  await page.route("**/api/v1/subscribers/bulk/*", async (route) => {
    const input = route.request().postDataJSON() as { tag: string };
    const pathname = new URL(route.request().url()).pathname;
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (input.tag === "failure") {
      await fulfillJson(
        route,
        { message: "Tag transport failed." },
        UI_CONTROLLED_FAILURE_STATUS,
      );
      return;
    }
    if (pathname.endsWith("/tag")) {
      subscriber = {
        ...subscriber,
        tags: Array.from(new Set([...subscriber.tags, input.tag])),
      };
    } else {
      untagAttempts += 1;
      if (untagAttempts === 1) {
        await fulfillJson(
          route,
          { message: "Untag transport failed." },
          UI_CONTROLLED_FAILURE_STATUS,
        );
        return;
      }
      subscriber = {
        ...subscriber,
        tags: subscriber.tags.filter((tag) => tag !== input.tag),
      };
    }
    await fulfillJson(route, { affected: 1 });
  });

  await page.route(
    `**/api/v1/subscribers/${SUBSCRIBER_ID}**`,
    async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      const base = `/api/v1/subscribers/${SUBSCRIBER_ID}`;

      if (pathname === `${base}/timeline`) {
        await fulfillJson(route, {
          subscriber_id: SUBSCRIBER_ID,
          email: "reader@example.test",
          stats: {
            sent_count: 12,
            opened_count: 9,
            clicked_count: 4,
            bounced_count: 0,
            replied_count: 2,
            open_rate: 0.75,
            click_rate: 0.333,
            engagement_score: 0.82,
            subscribed_at: "2026-06-10T09:00:00Z",
            last_active_at: "2026-08-20T09:00:00Z",
            current_status: "enabled",
          },
          events: [
            {
              type: "opened",
              occurred_at: "2026-08-20T09:00:00Z",
              subject: "Weekly signal",
              source: "email",
            },
          ],
          pagination: { limit: 50, has_more: false },
        });
        return;
      }
      if (pathname === `${base}/notes`) {
        if (method === "POST") {
          const input = request.postDataJSON() as {
            markdown_body: string;
            pinned?: boolean;
          };
          notes = [
            {
              id: "note-2",
              subscriber_id: SUBSCRIBER_ID,
              body: input.markdown_body,
              markdown_body: input.markdown_body,
              mentions: [],
              author_email: "owner@example.test",
              pinned: Boolean(input.pinned),
              created_at: "2026-08-21T09:00:00Z",
            },
            ...notes,
          ];
          await fulfillJson(route, { id: "note-2" }, 201);
          return;
        }
        await fulfillJson(route, { notes, count: notes.length });
        return;
      }
      if (pathname.startsWith(`${base}/notes/`)) {
        const noteId = pathname.split("/").at(-1);
        if (method === "PATCH") {
          notePatchAttempts += 1;
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (notePatchAttempts === 1) {
            await fulfillJson(
              route,
              { message: "Note update failed." },
              UI_CONTROLLED_FAILURE_STATUS,
            );
            return;
          }
          const input = request.postDataJSON() as { pinned?: boolean };
          notes = notes.map((note) =>
            note.id === noteId
              ? { ...note, pinned: input.pinned ?? note.pinned }
              : note,
          );
          await fulfillJson(route, { ok: true });
          return;
        }
        if (method === "DELETE") {
          noteDeleteAttempts += 1;
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (noteDeleteAttempts === 1) {
            await fulfillJson(
              route,
              { message: "Note delete failed." },
              UI_CONTROLLED_FAILURE_STATUS,
            );
            return;
          }
          notes = notes.filter((note) => note.id !== noteId);
          await fulfillJson(route, { ok: true });
          return;
        }
        await fulfillJson(route, { ok: true });
        return;
      }
      if (pathname === `${base}/channel-consents`) {
        await fulfillJson(
          route,
          {
            items: [
              {
                id: "consent-1",
                subscriber_id: SUBSCRIBER_ID,
                channel: "email",
                status: consentStatus,
                consent_timestamp: "2026-06-10T09:00:00Z",
                consent_source: "double_optin",
                created_at: "2026-06-10T09:00:00Z",
                updated_at: "2026-08-20T09:00:00Z",
              },
            ],
          },
          200,
          { ETag: '"consent-v1"' },
        );
        return;
      }
      if (pathname === `${base}/channel-consents/email`) {
        const input = request.postDataJSON() as { status: string };
        consentStatus = input.status;
        await fulfillJson(route, {
          id: "consent-1",
          subscriber_id: SUBSCRIBER_ID,
          channel: "email",
          status: consentStatus,
          consent_source: "manual",
          created_at: "2026-06-10T09:00:00Z",
          updated_at: "2026-08-21T09:00:00Z",
        });
        return;
      }
      if (pathname === `${base}/audit`) {
        await fulfillJson(route, {
          items: [
            {
              id: 7,
              action: "subscriber.updated",
              actor_type: "user",
              actor_label: "owner@example.test",
              metadata: {},
              at: "2026-08-20T09:00:00Z",
            },
          ],
        });
        return;
      }
      if (pathname === `${base}/erasure-receipt`) {
        receiptAttempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (receiptAttempts === 1) {
          await fulfillJson(
            route,
            { message: "Receipt transport failed." },
            503,
          );
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ subscriber_id: SUBSCRIBER_ID, erased: true }),
        });
        return;
      }
      if (pathname === `${base}/attribute-history`) {
        await fulfillJson(route, {
          items: [
            {
              id: "attribute-1",
              field_name: "first_name",
              old_value: "A.",
              new_value: "Ada",
              source: "profile_edit",
              changed_at: "2026-08-20T09:00:00Z",
            },
          ],
        });
        return;
      }
      if (pathname === `${base}/segment-membership`) {
        await fulfillJson(route, {
          subscriber_id: SUBSCRIBER_ID,
          segments: [],
        });
        return;
      }
      if (pathname === `${base}/groups`) {
        await fulfillJson(route, { subscriber_id: SUBSCRIBER_ID, groups: [] });
        return;
      }
      if (pathname === `${base}/demographics`) {
        await fulfillJson(route, {
          subscriber_id: SUBSCRIBER_ID,
          gender: null,
          age_group: null,
          interests: null,
        });
        return;
      }
      if (pathname === `${base}/replenishment-cadence`) {
        await fulfillJson(route, {
          subscriber_id: SUBSCRIBER_ID,
          average_days_between_orders: null,
          expected_next_order_at: null,
          last_order_at: null,
        });
        return;
      }
      if (pathname === `${base}/best-send-time`) {
        await fulfillJson(route, {
          best_hour_utc: 9,
          computed_at: "2026-08-20T09:00:00Z",
          sample_size: 12,
        });
        return;
      }
      if (pathname === `${base}/prediction-metadata`) {
        await fulfillJson(route, { subscriber_id: SUBSCRIBER_ID, items: [] });
        return;
      }
      if (pathname === base) {
        if (method === "PATCH") {
          patchAttempts += 1;
          if (patchAttempts === 1) {
            subscriber = {
              ...subscriber,
              first_name: "Ada (latest)",
              version: 4,
              updated_at: "2026-08-21T08:55:00Z",
            };
            await fulfillJson(
              route,
              {
                code: "precondition_failed",
                message: "Subscriber version conflict.",
              },
              412,
            );
            return;
          }
          const input = request.postDataJSON() as Partial<typeof subscriber>;
          await new Promise((resolve) => setTimeout(resolve, 250));
          subscriber = {
            ...subscriber,
            ...input,
            version: subscriber.version + 1,
            updated_at: "2026-08-21T09:05:00Z",
          };
          await fulfillJson(route, subscriber, 200, {
            ETag: `"subscriber-v${subscriber.version}"`,
          });
          return;
        }
        if (patchAttempts === 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await fulfillJson(route, subscriber, 200, {
          ETag: `"subscriber-v${subscriber.version}"`,
        });
        return;
      }
      await fulfillJson(route, { items: [] });
    },
  );
}

interface SegmentFixture {
  id: string;
  name: string;
}

interface TemplateFixture {
  id: string;
  name: string;
  etag?: string;
  archived_at?: string | null;
}

async function expectApiOk(response: APIResponse, operation: string) {
  if (response.ok()) return;
  throw new Error(
    `${operation} failed (${response.status()}): ${await response.text()}`,
  );
}

async function ensureSegmentFixture(page: Page): Promise<SegmentFixture> {
  const list = await page.request.get("/api/v1/segments", {
    headers: TENANT_HEADERS,
  });
  await expectApiOk(list, "segment fixture search");
  const rows = (await list.json()) as SegmentFixture[];
  const existing = rows.find(
    (segment) => segment.name === SEGMENT_FIXTURE_NAME,
  );
  if (existing) return existing;

  const created = await page.request.post("/api/v1/segments", {
    headers: TENANT_HEADERS,
    data: {
      name: SEGMENT_FIXTURE_NAME,
      description: "Deterministic route-closure audience.",
      queryAst: {
        op: "condition",
        field: "email",
        comparator: "contains",
        value: "@",
      },
      includeArchived: false,
    },
  });
  await expectApiOk(created, "segment fixture creation");
  return (await created.json()) as SegmentFixture;
}

async function findTemplateFixture(
  page: Page,
  name: string,
): Promise<TemplateFixture | undefined> {
  const response = await page.request.get(
    `/api/v1/campaign-templates/search?q=${encodeURIComponent(name)}&source=mine&kind=editable&archived=all&per_page=20`,
    { headers: TENANT_HEADERS },
  );
  await expectApiOk(response, "template fixture search");
  const payload = (await response.json()) as { items?: TemplateFixture[] };
  return payload.items?.find((template) => template.name === name);
}

async function ensureTemplateFixture(
  page: Page,
  projectName: string,
): Promise<TemplateFixture> {
  const name = `Residual lifecycle template ${projectName}`;
  let template = await findTemplateFixture(page, name);
  if (!template) {
    const slug = `residual-lifecycle-${projectName}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 72);
    const created = await page.request.post("/api/v1/campaign-templates", {
      headers: TENANT_HEADERS,
      data: {
        slug,
        name,
        subject: "A deterministic lifecycle template",
        description: "Exercises favorite, active, archived, and detail states.",
        goal: "newsletter",
        body_html:
          "<!doctype html><html><body><h1>Lifecycle fixture</h1><p>Reviewable content.</p></body></html>",
        tags: ["residual-closure"],
      },
    });
    if (!created.ok() && created.status() !== 409) {
      await expectApiOk(created, "template fixture creation");
    }
    template = await findTemplateFixture(page, name);
  }
  if (!template) throw new Error("Template fixture was not searchable.");
  if (template.archived_at) {
    if (!template.etag) throw new Error("Archived fixture has no ETag.");
    const restored = await page.request.patch(
      `/api/v1/campaign-templates/${template.id}/restore`,
      { headers: { ...TENANT_HEADERS, "If-Match": template.etag } },
    );
    await expectApiOk(restored, "template fixture restore");
    template = (await restored.json()) as TemplateFixture;
  }
  return template;
}

async function installDesignFixtures(page: Page, status: DesignState) {
  await page.route("**/api/v1/campaign-templates/search**", (route) =>
    fulfillJson(route, {
      items: [REFERENCE_TEMPLATE],
      next_cursor: null,
      total: 1,
      facets: {},
    }),
  );
  await page.route("**/api/v1/campaign-template-designs**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const base = "/api/v1/campaign-template-designs";
    if (pathname === base && request.method() === "GET") {
      await fulfillJson(route, { items: [], next_cursor: null });
      return;
    }
    if (pathname === base && request.method() === "POST") {
      await fulfillJson(route, designFixture(status), 201);
      return;
    }
    if (pathname === `${base}/${DESIGN_ID}/revisions`) {
      await fulfillJson(route, {
        items: status === "ready" ? [DESIGN_REVISION] : [],
      });
      return;
    }
    if (pathname === `${base}/${DESIGN_ID}`) {
      await fulfillJson(route, designFixture(status));
      return;
    }
    await fulfillJson(route, { message: "Unexpected design request." }, 404);
  });
  await page.route("**/api/v1/lists**", (route) => fulfillJson(route, []));
  await page.route("**/api/v1/segments**", async (route) => {
    if (route.request().method() === "GET") {
      await fulfillJson(route, []);
      return;
    }
    await route.fallback();
  });
}

async function settleRoute(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => {
    const main = document.querySelector("main#main-content");
    const hydrated = document.querySelector('[data-dashboard-hydrated="true"]');
    return (
      Boolean(main) &&
      Boolean(hydrated) &&
      !document.querySelector("[data-route-transition]")
    );
  });
}

async function gotoRoute(page: Page, path: string, heading: string | RegExp) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { level: 1, name: heading }),
  ).toBeVisible();
  await settleRoute(page);
}

async function auditRoute(page: Page, path: string, mobile: boolean) {
  const structure = await page.evaluate(() => {
    const main = document.querySelector("main#main-content");
    return {
      h1Count: document.querySelectorAll("h1").length,
      mainCount: document.querySelectorAll("main#main-content").length,
      documentOverflow:
        Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
        ) - window.innerWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
      title: document.title,
    };
  });
  expect.soft(structure.mainCount, path).toBe(1);
  expect.soft(structure.h1Count, path).toBe(1);
  expect.soft(structure.documentOverflow, path).toBeLessThanOrEqual(1);
  expect.soft(structure.mainOverflow, path).toBeLessThanOrEqual(1);
  expect.soft(structure.title, path).not.toMatch(/404|not found/i);

  if (mobile) {
    const undersized = await page
      .locator(
        "a,button,input:not([type=checkbox]):not([type=radio]),select,textarea",
      )
      .evaluateAll((elements) =>
        elements
          .filter((element) => {
            const node = element as HTMLElement;
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return (
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              // Focus-revealed skip links intentionally sit just outside the
              // viewport until focused. They are keyboard-operable and grow
              // to a full target on focus, so their off-canvas 1px resting
              // box is not an undersized visible control.
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.width > 0 &&
              rect.height > 0 &&
              (rect.width < 24 || rect.height < 24)
            );
          })
          .map((element) => ({
            label:
              element.getAttribute("aria-label") ||
              element.textContent?.trim().slice(0, 80) ||
              element.tagName,
            rect: (element as HTMLElement).getBoundingClientRect().toJSON(),
          })),
      );
    expect.soft(undersized, `${path} undersized targets`).toEqual([]);
  }

  const axe = await new AxeBuilder({ page })
    .include("main#main-content")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );
  expect
    .soft(blocking, `${path}\n${JSON.stringify(blocking, null, 2)}`)
    .toEqual([]);
}

async function expectDialogQuality(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveCount(1);
  const describedBy = await dialog.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveCount(1);
  const focused = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return Boolean(dialog && dialog.contains(document.activeElement));
  });
  expect(focused).toBe(true);
}

const ROUTE_ROOTS = [
  {
    path: `/app/forms/${FORM_ID}/submissions`,
    heading: "Submissions",
  },
  { path: "/app/subscribers/paid-members", heading: "Paid members" },
  { path: "/app/subscribers/segments", heading: /Segments/ },
  { path: "/app/subscribers/segments/new", heading: "New segment" },
  { path: "/app/templates/new", heading: "Create template" },
] as const;

test.describe("residual route-root certification", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await loginAsDemo(page, { navigate: false });
    await installAuthFixture(page);
    await installFormSubmissionsFixture(page);
    await installPaidMembersFixture(page);
    await installSegmentEditorFixtures(page);
  });

  test("desktop: five loaded roots keep one main, one H1, layout, title, and axe", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-desktop");
    test.slow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await ensureSegmentFixture(page);
    for (const route of ROUTE_ROOTS) {
      await gotoRoute(page, route.path, route.heading);
      await auditRoute(page, route.path, false);
    }
  });

  test("320px: five loaded roots avoid page overflow and unsafe controls", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-mobile");
    test.slow();
    await page.setViewportSize({ width: 320, height: 800 });
    await ensureSegmentFixture(page);
    for (const route of ROUTE_ROOTS) {
      await gotoRoute(page, route.path, route.heading);
      await auditRoute(page, route.path, true);
    }
  });
});

test.describe("loaded form submissions", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await loginAsDemo(page, { navigate: false });
    await installAuthFixture(page);
  });

  test("320px: filters, disclosure, resend, delete, and export remain truthful", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.setViewportSize({ width: 320, height: 800 });
    const formState = await installFormSubmissionsFixture(page);
    let resendAttempts = 0;
    let deleteAttempts = 0;
    await page.route(
      `**/api/v1/forms/${FORM_ID}/submissions/**`,
      async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname.endsWith("/resend-confirmation")) {
          resendAttempts += 1;
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (resendAttempts === 1) {
            await fulfillJson(
              route,
              { message: "Confirmation transport unavailable." },
              UI_CONTROLLED_FAILURE_STATUS,
            );
            return;
          }
          await fulfillJson(route, {
            ok: true,
            resent_to: "reader0@example.com",
          });
          return;
        }
        if (request.method() === "DELETE") {
          deleteAttempts += 1;
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (deleteAttempts === 1) {
            await fulfillJson(
              route,
              { message: "Submission delete transport unavailable." },
              UI_CONTROLLED_FAILURE_STATUS,
            );
            return;
          }
          formState.removeSubmission(
            decodeURIComponent(pathname.split("/").at(-1) ?? ""),
          );
          await fulfillJson(route, { ok: true });
          return;
        }
        await route.fallback();
      },
    );

    await gotoRoute(page, `/app/forms/${FORM_ID}/submissions`, "Submissions");
    await expect(page.getByText("47 total")).toBeVisible();

    await page.getByLabel("Status").selectOption("pending");
    await expect(page).toHaveURL(/status=pending/);
    const search = page.getByPlaceholder("Search by email");
    await search.fill("reader0@example.com");
    await search.press("Enter");
    await expect(page).toHaveURL(/q=reader0%40example.com/);
    await expect(
      page.getByRole("link", { name: "reader0@example.com" }),
    ).toBeVisible();

    await page.getByLabel("From", { exact: true }).fill("2026-05-01");
    await page.getByLabel("To", { exact: true }).fill("2026-04-01");
    await expect(
      page.getByRole("alert").filter({ hasText: "From date" }),
    ).toBeVisible();
    await expect(
      page.getByText("No submissions match your filters"),
    ).toHaveCount(0);
    await page.getByLabel("From", { exact: true }).fill("");
    await page.getByLabel("To", { exact: true }).fill("");

    await page.getByRole("button", { name: "Show answers" }).click();
    const expandedDisclosure = page.getByRole("button", {
      name: "Hide answers",
    });
    await expect(expandedDisclosure).toHaveAttribute("aria-expanded", "true");
    const answersID = await expandedDisclosure.getAttribute("aria-controls");
    expect(answersID).toBeTruthy();
    await expect(page.locator(`[id="${answersID}"]`)).toContainText(
      "newsletter writer",
    );

    const actions = page.getByRole("button", {
      name: "Actions for reader0@example.com",
    });
    await actions.click();
    await page.getByRole("menuitem", { name: "Resend confirmation" }).click();
    await actions.click();
    await expect(
      page.getByRole("menuitem", { name: "Resend confirmation" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    const resendError = page
      .getByRole("alert", {
        name: "",
      })
      .filter({ hasText: "Could not resend" });
    await expect(resendError).toBeVisible();
    await expect(resendError).toBeFocused();
    expect(resendAttempts).toBe(1);

    await actions.click();
    await page.getByRole("menuitem", { name: "Resend confirmation" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Confirmation re-sent" }),
    ).toBeVisible();
    expect(resendAttempts).toBe(2);

    await actions.click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(actions).toBeFocused();

    await actions.click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const deleteDialog = page.getByRole("dialog");
    await deleteDialog.getByRole("button", { name: "Delete" }).click();
    await expect(deleteDialog).toHaveAttribute("aria-busy", "true");
    await expect(
      deleteDialog.getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(deleteDialog).toBeVisible();
    const deleteError = deleteDialog.getByRole("alert");
    await expect(deleteError).toBeVisible();
    await expect(deleteError).toBeFocused();
    expect(deleteAttempts).toBe(1);
    await deleteDialog.getByRole("button", { name: "Delete" }).click();
    await expect(deleteDialog).toBeHidden();
    expect(deleteAttempts).toBe(2);

    await page.getByRole("button", { name: "Export CSV" }).click();
    await expect(page.getByText("Export ready.")).toBeVisible();
    await auditRoute(page, `/app/forms/${FORM_ID}/submissions`, true);
  });
});

test.describe("paid-member mutation closure", () => {
  test("320px: grant, edit, and revoke guard intent and recover in place", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 800 });
    await loginAsDemo(page, { navigate: false });
    await installAuthFixture(page);
    const calls = await installPaidMembersFixture(page);
    await gotoRoute(page, "/app/subscribers/paid-members", "Paid members");
    await expect(page.getByText("paid.reader@example.test")).toBeVisible();

    const grantEmail = page.getByRole("textbox", {
      name: "Email",
      exact: true,
    });
    const grantTier = page.getByLabel("Tier (optional)");
    const grant = page.getByRole("button", { name: "Grant paid access" });
    await grantEmail.fill("not-an-email");
    await grant.click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(grantEmail).toHaveValue("not-an-email");
    expect(calls.posts).toBe(0);

    await grantEmail.fill("failure@example.test");
    await grant.click();
    const grantError = page
      .getByRole("alert")
      .filter({ hasText: "Paid-member transport failed" });
    await expect(grantError).toBeVisible();
    await expect(grantError).toBeFocused();
    await expect(grantEmail).toHaveValue("failure@example.test");
    expect(calls.posts).toBe(1);

    await grantEmail.fill("pending@example.test");
    await grantTier.fill("Founding");
    await grant.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    // The button's accessible name intentionally changes while pending, so a
    // locator created from "Grant paid access" no longer resolves. Anchor the
    // transient surface assertion to the email field whose name stays stable.
    await expect(
      grantEmail.locator("xpath=ancestor::*[@aria-busy='true']"),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Granting…" }),
    ).toBeDisabled();
    await expect(grantEmail).toBeDisabled();
    await expect(grantTier).toBeDisabled();
    await expect(
      page
        .getByRole("region", { name: "Paid members" })
        .getByRole("link", { name: "pending@example.test", exact: true }),
    ).toBeVisible();
    expect(calls.posts).toBe(2);

    const edit = page
      .getByRole("button", { name: "Edit", exact: true })
      .first();
    await edit.click();
    await expectDialogQuality(page);
    const editDialog = page.getByRole("dialog");
    const editSave = editDialog.getByRole("button", {
      name: "Save",
      exact: true,
    });
    await expect(editSave).toBeDisabled();
    await editDialog.getByLabel("Tier").fill("Transport failure");
    await editSave.click();
    const editError = editDialog.getByRole("alert");
    await expect(editError).toContainText("Paid-member transport failed");
    await expect(editError).toBeFocused();
    await expect(editDialog).toBeVisible();
    expect(calls.posts).toBe(3);

    await editDialog.getByLabel("Tier").fill("Premium");
    await editSave.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(editDialog).toHaveAttribute("aria-busy", "true");
    await expect(editDialog.getByLabel("Tier")).toBeDisabled();
    await expect(editDialog.getByLabel("Status")).toBeDisabled();
    await expect(
      editDialog.getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(editDialog).toBeVisible();
    await expect(editDialog).toBeHidden();
    expect(calls.posts).toBe(4);

    const revoke = page
      .getByRole("button", { name: "Revoke", exact: true })
      .first();
    await revoke.click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(revoke).toBeFocused();
    await revoke.click();
    const revokeDialog = page.getByRole("dialog");
    const confirmRevoke = revokeDialog.getByRole("button", {
      name: "Revoke",
      exact: true,
    });
    await confirmRevoke.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(revokeDialog).toHaveAttribute("aria-busy", "true");
    await expect(
      revokeDialog.getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(revokeDialog).toBeVisible();
    const revokeError = revokeDialog.getByRole("alert");
    await expect(revokeError).toContainText("Revoke transport failed");
    await expect(revokeError).toBeFocused();
    expect(calls.deletes).toBe(1);
    await revokeDialog
      .getByRole("button", { name: "Revoke", exact: true })
      .click();
    await expect(revokeDialog).toBeHidden();
    expect(calls.deletes).toBe(2);
    await auditRoute(page, "/app/subscribers/paid-members", true);
  });
});

test.describe("subscriber profile residual panels", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await loginAsDemo(page, { navigate: false });
    await installAuthFixture(page);
    await installSubscriberFixtures(page);
    await page.route("**/api/v1/custom-fields", (route) =>
      fulfillJson(route, []),
    );
  });

  test("desktop: Notes, Consent, Audit, and edit conflict recovery are complete", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-desktop");
    await page.setViewportSize({ width: 1280, height: 900 });
    let bulkRequests = 0;
    let receiptRequests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/subscribers/bulk/")) {
        bulkRequests += 1;
      }
      if (request.url().includes("/erasure-receipt")) receiptRequests += 1;
    });
    await gotoRoute(
      page,
      `/app/subscribers/${SUBSCRIBER_ID}`,
      "reader@example.test",
    );

    await page.getByRole("tab", { name: "Notes" }).click();
    await expect(page.getByText("Pinned customer context")).toBeVisible();
    await page.getByLabel("New note").fill("Follow up after the next launch");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(
      page.getByText("Follow up after the next launch"),
    ).toBeVisible();
    const pinnedNote = page
      .getByRole("listitem")
      .filter({ hasText: "Pinned customer context" });
    const unpin = pinnedNote.getByRole("button", { name: "Unpin note" });
    await unpin.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(unpin).toBeDisabled();
    const noteUpdateFailure = page
      .getByRole("alert")
      .filter({ hasText: "Note update failed" });
    await expect(noteUpdateFailure).toBeFocused();
    await unpin.click();
    await expect(
      pinnedNote.getByRole("button", { name: "Pin note" }),
    ).toBeVisible();
    const newNote = page
      .getByRole("listitem")
      .filter({ hasText: "Follow up after the next launch" });
    const deleteNote = newNote.getByRole("button", { name: "Delete note" });
    await deleteNote.click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(deleteNote).toBeFocused();
    await deleteNote.click();
    const noteDeleteDialog = page.getByRole("dialog");
    const confirmNoteDelete = noteDeleteDialog.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await confirmNoteDelete.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(noteDeleteDialog).toHaveAttribute("aria-busy", "true");
    await expect(
      noteDeleteDialog.getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(noteDeleteDialog).toBeVisible();
    const noteDeleteFailure = noteDeleteDialog.getByRole("alert");
    await expect(noteDeleteFailure).toContainText("Note delete failed");
    await expect(noteDeleteFailure).toBeFocused();
    await noteDeleteDialog
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(newNote).toBeHidden();

    await page.getByRole("tab", { name: "Lists & Tags" }).click();
    const addTag = page.getByRole("button", { name: "Add", exact: true });
    const tagInput = page.getByLabel("Add a tag");
    await tagInput.fill("failure");
    await addTag.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(tagInput).toBeDisabled();
    await expect(addTag).toBeDisabled();
    const tagFailure = page
      .getByRole("alert")
      .filter({ hasText: "Tag transport failed" });
    await expect(tagFailure).toBeFocused();
    await expect(tagInput).toHaveValue("failure");
    expect(bulkRequests).toBe(1);
    await tagInput.fill("vip");
    await addTag.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(page.getByText("vip", { exact: true })).toBeVisible();
    expect(bulkRequests).toBe(2);
    const removeVip = page.getByRole("button", { name: "Remove tag vip" });
    await removeVip.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(removeVip).toBeDisabled();
    const untagFailure = page
      .getByRole("alert")
      .filter({ hasText: "Untag transport failed" });
    await expect(untagFailure).toBeFocused();
    await expect(page.getByText("vip", { exact: true })).toBeVisible();
    expect(bulkRequests).toBe(3);
    await removeVip.click();
    await expect(page.getByText("vip", { exact: true })).toHaveCount(0);
    expect(bulkRequests).toBe(4);

    await page.getByRole("tab", { name: "Consent" }).click();
    const consent = page.getByLabel("email consent status");
    await expect(consent).toHaveValue("opted_in");
    await consent.selectOption("opted_out");
    await expect(consent).toHaveValue("opted_out");

    await page.getByRole("tab", { name: "Audit" }).click();
    await expect(page.getByText("subscriber.updated")).toBeVisible();
    await expect(page.getByText("first_name")).toBeVisible();
    const receipt = page.getByRole("button", { name: "Erasure receipt" });
    await receipt.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(
      page.getByRole("button", { name: "Preparing…" }),
    ).toBeDisabled();
    const receiptFailure = page
      .getByRole("alert")
      .filter({ hasText: "Receipt transport failed" });
    await expect(receiptFailure).toBeFocused();
    expect(receiptRequests).toBe(1);
    await page
      .getByRole("button", { name: "Erasure receipt" })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Erasure receipt downloaded" }),
    ).toBeVisible();
    expect(receiptRequests).toBe(2);

    const edit = page.getByRole("button", { name: "Edit", exact: true });
    await edit.click();
    await expectDialogQuality(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("First name")).toHaveValue("Ada");
    await expect(dialog.getByLabel("Last name")).toHaveValue("Reader");
    await expect(dialog.getByLabel("Status")).toHaveValue("enabled");
    await expect(dialog.getByLabel("Tags (comma-separated)")).toHaveValue(
      "newsletter",
    );
    await expect(
      dialog.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    await dialog.getByLabel("First name").fill("Grace");
    await dialog.getByLabel("Tags (comma-separated)").fill("newsletter, vip");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    const conflict = dialog.getByRole("alert");
    await expect(conflict).toContainText("changed since you opened it");
    await expect(conflict).toBeFocused();
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("button", { name: "Reload latest" })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(dialog.getByLabel("First name")).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("First name")).toHaveValue("Ada (latest)");
    await dialog.getByLabel("First name").fill("Grace");
    await dialog
      .getByRole("button", { name: "Save changes" })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(dialog.getByLabel("First name")).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "reader@example.test" }),
    ).toBeVisible();
    await auditRoute(page, `/app/subscribers/${SUBSCRIBER_ID}`, false);
  });

  test("desktop: timeline keeps loaded activity and retries the same cursor once", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-desktop");
    await page.setViewportSize({ width: 1280, height: 900 });
    let cursorRequests = 0;
    const stats = {
      sent_count: 12,
      opened_count: 9,
      clicked_count: 4,
      bounced_count: 0,
      replied_count: 2,
      open_rate: 0.75,
      click_rate: 0.333,
      engagement_score: 0.82,
      subscribed_at: "2026-06-10T09:00:00Z",
      last_active_at: "2026-08-20T09:00:00Z",
      current_status: "enabled",
    };
    const boundaryEvent = {
      type: "opened",
      occurred_at: "2026-08-20T09:00:00Z",
      subject_id: "boundary-event",
      subject: "Boundary launch",
      source: "email",
    };
    await page.route(
      `**/api/v1/subscribers/${SUBSCRIBER_ID}/timeline**`,
      async (route) => {
        const cursor = new URL(route.request().url()).searchParams.get(
          "cursor",
        );
        if (!cursor) {
          await fulfillJson(route, {
            subscriber_id: SUBSCRIBER_ID,
            email: "reader@example.test",
            stats,
            events: [boundaryEvent],
            pagination: {
              limit: 50,
              has_more: true,
              next_cursor: "opaque-cursor-2",
            },
          });
          return;
        }
        expect(cursor).toBe("opaque-cursor-2");
        cursorRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (cursorRequests === 1) {
          await fulfillJson(
            route,
            { message: "Cursor transport failed." },
            UI_CONTROLLED_FAILURE_STATUS,
          );
          return;
        }
        await fulfillJson(route, {
          subscriber_id: SUBSCRIBER_ID,
          email: "reader@example.test",
          stats,
          events: [
            boundaryEvent,
            {
              ...boundaryEvent,
              source: "automation",
            },
            {
              type: "clicked",
              occurred_at: "2026-08-19T09:00:00Z",
              subject_id: "older-event",
              subject: "Older launch",
              source: "email",
            },
          ],
          pagination: { limit: 50, has_more: false, next_cursor: null },
        });
      },
    );

    await gotoRoute(
      page,
      `/app/subscribers/${SUBSCRIBER_ID}`,
      "reader@example.test",
    );
    await page.getByRole("tab", { name: "Timeline" }).click();
    const timeline = page
      .getByTestId("subscriber-timeline")
      .filter({ visible: true });
    await expect(timeline.getByText("Boundary launch")).toBeVisible();
    const loadMore = timeline.getByRole("button", { name: "Load more" });
    await loadMore.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(timeline.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(timeline.getByRole("alert")).toContainText(
      "Cursor transport failed",
    );
    await expect(timeline.getByText("Boundary launch")).toBeVisible();
    expect(cursorRequests).toBe(1);

    await timeline
      .getByRole("button", { name: "Retry" })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await expect(timeline.getByText("Older launch")).toBeVisible();
    await expect(timeline.getByRole("button", { name: "Retry" })).toHaveCount(
      0,
    );
    await expect(
      timeline.locator('[data-source="email"]').filter({
        hasText: "Boundary launch",
      }),
    ).toHaveCount(1);
    await expect(
      timeline.locator('[data-source="automation"]').filter({
        hasText: "Boundary launch",
      }),
    ).toHaveCount(1);
    expect(cursorRequests).toBe(2);
  });

  test("320px: a missing timeline cursor is honest and recovers by refresh", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.setViewportSize({ width: 320, height: 800 });
    let timelineRequests = 0;
    await page.route(
      `**/api/v1/subscribers/${SUBSCRIBER_ID}/timeline**`,
      async (route) => {
        timelineRequests += 1;
        await fulfillJson(route, {
          subscriber_id: SUBSCRIBER_ID,
          email: "reader@example.test",
          stats: {
            sent_count: 1,
            opened_count: 1,
            clicked_count: 0,
            bounced_count: 0,
            replied_count: 0,
            open_rate: 1,
            click_rate: 0,
            engagement_score: 0.7,
            subscribed_at: "2026-06-10T09:00:00Z",
            last_active_at: "2026-08-20T09:00:00Z",
            current_status: "enabled",
          },
          events: [
            {
              type: "opened",
              occurred_at: "2026-08-20T09:00:00Z",
              subject:
                "A long but legitimate campaign subject that must wrap on the narrowest supported viewport",
              detail: {
                link_url:
                  "https://example.test/a/very/long/path/that/must/wrap/without/widening/the/subscriber/profile",
              },
              source: "email",
            },
          ],
          pagination:
            timelineRequests === 1
              ? { limit: 50, has_more: true }
              : { limit: 50, has_more: false, next_cursor: null },
        });
      },
    );

    await gotoRoute(
      page,
      `/app/subscribers/${SUBSCRIBER_ID}`,
      "reader@example.test",
    );
    const timelineTrigger = page.getByRole("button", {
      name: "Timeline",
      exact: true,
    });
    if ((await timelineTrigger.getAttribute("aria-expanded")) !== "true") {
      await timelineTrigger.click();
    }
    const timeline = page
      .getByTestId("subscriber-timeline")
      .filter({ visible: true });
    await expect(timeline.getByRole("alert")).toContainText(
      "did not include its next-page cursor",
    );
    const retry = timeline.getByRole("button", { name: "Retry" });
    const retryBox = await retry.boundingBox();
    expect(retryBox?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await retry.click();
    await expect(timeline.getByRole("alert")).toHaveCount(0);
    await expect(retry).toHaveCount(0);
    expect(timelineRequests).toBe(2);
    await auditRoute(page, `/app/subscribers/${SUBSCRIBER_ID}`, true);
  });

  test("320px: Notes, Consent, and Audit disclosures own their regions", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.setViewportSize({ width: 320, height: 800 });
    await gotoRoute(
      page,
      `/app/subscribers/${SUBSCRIBER_ID}`,
      "reader@example.test",
    );
    for (const name of ["Notes", "Consent", "Audit & compliance"]) {
      const trigger = page.getByRole("button", { name, exact: true });
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      const controls = await trigger.getAttribute("aria-controls");
      expect(controls).toBeTruthy();
      await expect(page.locator(`[id="${controls}"]`)).toBeVisible();
    }
    await expect(page.getByText("Pinned customer context")).toBeVisible();
    await expect(page.getByLabel("email consent status")).toBeVisible();
    await expect(page.getByText("subscriber.updated")).toBeVisible();
    await auditRoute(page, `/app/subscribers/${SUBSCRIBER_ID}`, true);
  });
});

test.describe("loaded campaign detail residual actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await loginAsDemo(page, { navigate: false });
    await installAuthFixture(page);
    await installCampaignDetailFixtures(page);
  });

  test("desktop: semantic Blocks to JSON and Save-as-template validation are loaded", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-desktop");
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoRoute(
      page,
      "/app/campaigns/camp_demo_semantic",
      "Semantic authoring demo",
    );
    const semanticTabs = page.getByRole("tablist", {
      name: "Semantic authoring view",
    });
    await expect(
      semanticTabs.getByRole("tab", { name: "Blocks" }),
    ).toHaveAttribute("aria-selected", "true");
    await semanticTabs.getByRole("tab", { name: "JSON" }).click();
    await expect(page.getByLabel("Semantic node array")).toContainText(
      "Hello from Moosewave",
    );
    await expect(page.getByLabel("Fact Contract v1")).toContainText(
      "newsletter",
    );

    const saveAsTemplate = page.getByRole("button", {
      name: "Save as template",
    });
    await saveAsTemplate.click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(saveAsTemplate).toBeFocused();
    await saveAsTemplate.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Template name").fill("");
    await dialog.getByRole("button", { name: "Save template" }).click();
    const required = dialog.getByRole("alert");
    await expect(required).toContainText("template slug is required");
    await expect(required).toBeFocused();
    await dialog.getByLabel("Template name").fill("Semantic closure template");
    await dialog.getByRole("button", { name: "Save template" }).click();
    await expect(dialog).toBeHidden();
    await auditRoute(page, "/app/campaigns/camp_demo_semantic", false);
  });

  test("320px: semantic editor and sent-campaign resend dialog stay complete", async ({
    page,
  }) => {
    // This journey cold-loads and axe-audits two large campaign routes. Keep
    // the interaction assertions strict while giving a clean Next dev cache
    // enough room to compile both surfaces before the final audit.
    test.setTimeout(90_000);
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.setViewportSize({ width: 320, height: 800 });
    await gotoRoute(
      page,
      "/app/campaigns/camp_demo_semantic",
      "Semantic authoring demo",
    );
    await page.getByRole("tab", { name: "JSON" }).click();
    await expect(page.getByLabel("Semantic node array")).toBeVisible();
    await auditRoute(page, "/app/campaigns/camp_demo_semantic", true);

    let exportAttempts = 0;
    await page.route(
      "**/api/v1/campaigns/camp_demo_sent/report.csv",
      async (route) => {
        exportAttempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (exportAttempts === 1) {
          await fulfillJson(route, { message: "Campaign export failed." }, 503);
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "text/csv",
          body: "recipient,status\nreader@example.test,delivered\n",
        });
      },
    );
    await gotoRoute(
      page,
      "/app/campaigns/camp_demo_sent",
      "Delivered product signal",
    );
    const resend = page.getByRole("button", {
      name: "Resend to non-openers",
    });
    await resend.click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(resend).toBeFocused();
    await resend.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("New subject").fill("");
    await dialog.getByRole("button", { name: "Schedule resend" }).click();
    const required = dialog.getByRole("alert");
    await expect(required).toContainText("subject is required");
    await expect(required).toBeFocused();
    await dialog.getByLabel("New subject").fill("A fresh subject");
    await dialog.getByRole("button", { name: "Schedule resend" }).click();
    await expect(dialog).toBeHidden();
    const exportCsv = page.getByRole("button", { name: "Export CSV" });
    await exportCsv.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(exportCsv).toHaveAttribute("aria-busy", "true");
    await expect(exportCsv).toBeDisabled();
    await expect(page.getByText("Campaign export failed.")).toBeVisible();
    expect(exportAttempts).toBe(1);
    await exportCsv.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(exportCsv).toHaveAttribute("aria-busy", "true");
    await expect(exportCsv).toBeEnabled();
    expect(exportAttempts).toBe(2);
    await auditRoute(page, "/app/campaigns/camp_demo_sent", true);
  });
});

test.describe("generated-template design review states", () => {
  for (const status of ["generating", "failed", "ready"] as const) {
    test(`320px: ${status} is a distinct real review state`, async ({
      page,
    }) => {
      test.skip(test.info().project.name !== "chromium-mobile");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 320, height: 800 });
      await loginAsDemo(page, { navigate: false });
      await installAuthFixture(page);
      await installDesignFixtures(page, status);
      await gotoRoute(
        page,
        `/app/templates?view=inspiration&q=${encodeURIComponent(REFERENCE_TEMPLATE.name)}&kind=reference`,
        "Newsletter templates",
      );
      const card = page.getByRole("article", {
        name: REFERENCE_TEMPLATE.name,
        exact: true,
      });
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Make it mine" }).click();
      await expectDialogQuality(page);
      await page
        .getByLabel("What should this email say?")
        .fill("Adapt this into a weekly product newsletter.");
      await page.getByRole("button", { name: "Create adaptation" }).click();

      if (status === "generating") {
        const live = page
          .getByRole("status", {
            name: "",
          })
          .filter({ hasText: "Building your newsletter" });
        await expect(live).toBeVisible();
        await expect(live).toHaveAttribute("aria-busy", "true");
      } else if (status === "failed") {
        const failed = page
          .getByRole("alert")
          .filter({ hasText: "Design attempt failed" });
        await expect(failed).toContainText(
          "The design provider did not respond.",
        );
        await expect(
          page.getByRole("button", { name: "Retry attempt" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Edit brief" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Archive attempt" }),
        ).toBeVisible();
      } else {
        const comparison = page.getByRole("tablist", {
          name: "Compare inspiration and result",
        });
        const tabs = comparison.getByRole("tab");
        await expect(tabs).toHaveCount(3);
        await expect(tabs).toHaveText([
          "Your result",
          "Inspiration",
          "Side by side",
        ]);
        for (const name of ["Your result", "Inspiration", "Side by side"]) {
          await comparison.getByRole("tab", { name }).click();
          await expect(comparison.getByRole("tab", { name })).toHaveAttribute(
            "aria-selected",
            "true",
          );
        }
        await expect(page.getByText("Immutable revision 1")).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Save exact revision as template",
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Create campaign draft" }),
        ).toBeVisible();
      }
      await auditRoute(page, "/app/templates design review", true);
    });
  }
});

test.describe("template library lifecycle residuals", () => {
  test("desktop: Favorites and Active/Archived lifecycle agree with detail", async ({
    page,
  }, testInfo) => {
    test.skip(test.info().project.name !== "chromium-desktop");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsDemo(page, { navigate: false });
    await installAuthFixture(page);
    const fixture = await ensureTemplateFixture(page, testInfo.project.name);
    const activePath = `/app/templates?view=mine&source=mine&kind=editable&archived=active&goal=all&q=${encodeURIComponent(fixture.name)}`;
    await gotoRoute(page, activePath, "Newsletter templates");
    let card = page.getByRole("article", { name: fixture.name, exact: true });
    await expect(card).toBeVisible();
    const favorite = card.getByRole("button", {
      name: new RegExp(`^(Add to|Remove from) favorites: ${fixture.name}$`),
    });
    if ((await favorite.getAttribute("aria-pressed")) !== "true") {
      await favorite.click();
      await expect(favorite).toHaveAttribute("aria-pressed", "true");
    }

    await page.getByRole("tab", { name: /^Favorites/ }).click();
    await expect(
      page.getByRole("article", { name: fixture.name, exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: /^My templates/ }).click();
    card = page.getByRole("article", { name: fixture.name, exact: true });
    await expect(card).toBeVisible();
    await card
      .getByRole("button", { name: `Actions for ${fixture.name}` })
      .click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByText("Template archived")).toBeVisible();
    await expect(card).toBeHidden();

    const lifecycle = page.getByRole("group", { name: "Template lifecycle" });
    await lifecycle.getByRole("button", { name: "Archived" }).click();
    // Archived cards truthfully append their lifecycle state to the article's
    // accessible name; the card was mounted in the failing snapshot, but the
    // active-card oracle could not match it.
    card = page.getByRole("article", {
      name: `${fixture.name} (archived)`,
      exact: true,
    });
    await expect(card).toBeVisible();
    await expect(card.getByText("Archived", { exact: true })).toBeVisible();
    await card.getByRole("link", { name: /View design/ }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: fixture.name }),
    ).toBeVisible();
    await expect(page.getByText("Archived and safely read-only")).toBeVisible();
    const actions = page.getByRole("button", {
      name: `Actions for ${fixture.name}`,
    });
    await actions.click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(actions).toBeFocused();
    await actions.click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Restore template" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Archived and safely read-only")).toHaveCount(
      0,
    );
    await auditRoute(page, `/app/templates/${fixture.id}`, false);
  });

  test("320px: create-template validation and loaded save path are complete", async ({
    page,
  }, testInfo) => {
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 800 });
    await loginAsDemo(page, { navigate: false });
    await installAuthFixture(page);
    await gotoRoute(page, "/app/templates/new", "Create template");
    const authoring = page.getByRole("group", { name: "Authoring surface" });
    await authoring.getByRole("button", { name: "Design (blocks)" }).click();
    await expect(
      authoring.getByRole("button", { name: "Design (blocks)" }),
    ).toHaveAttribute("aria-pressed", "true");
    await authoring.getByRole("button", { name: "Code / import" }).click();
    await expect(
      authoring.getByRole("button", { name: "Code / import" }),
    ).toHaveAttribute("aria-pressed", "true");
    const format = page.getByRole("group", { name: "Source format" });
    await format.getByRole("button", { name: "MJML" }).click();
    await expect(page.getByLabel("MJML source")).toBeVisible();
    await format.getByRole("button", { name: "HTML" }).click();
    await expect(page.getByLabel("HTML source")).toBeVisible();
    const create = page.getByRole("button", { name: "Create template" });
    await create.click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "A template name is required." }),
    ).toBeVisible();
    const name = `Residual authored template ${testInfo.project.name} ${Date.now()}`;
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Subject").fill("A browser-certified subject");
    await page
      .getByLabel("HTML source")
      .fill("<!doctype html><html><body><h1>Certified</h1></body></html>");
    await create.click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page).toHaveURL(/\/app\/templates\/[^/]+$/);
    await auditRoute(page, "/app/templates/new created detail", true);
  });
});

test.describe("segment list and create closure", () => {
  test("320px: saved-list search/pin and seeded creation use real route contracts", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 800 });
    await loginAsDemo(page, { navigate: false });
    await installAuthFixture(page);
    await installSegmentEditorFixtures(page);
    const fixture = await ensureSegmentFixture(page);

    await gotoRoute(page, "/app/subscribers/segments", /Segments/);
    const search = page.getByLabel("Search segments");
    await search.fill(fixture.name);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/q=Residual\+route\+closure\+segment/);
    await expect(page.getByRole("link", { name: fixture.name })).toBeVisible();
    const pin = page.getByRole("button", { name: "Pin segment to top" });
    await pin.click();
    await expect(
      page.getByRole("button", { name: "Unpin segment" }),
    ).toHaveAttribute("aria-pressed", "true");
    const select = page
      .getByLabel(`Select ${fixture.name}`, { exact: true })
      .filter({ visible: true });
    await select.check();
    await expect(page.getByText("1 selected")).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();

    await gotoRoute(page, "/app/subscribers/segments/new", "New segment");
    await page.getByRole("button", { name: "Create segment" }).click();
    await expect(
      page
        .locator("main")
        .getByRole("alert")
        .filter({ hasText: "Name is required" }),
    ).toBeVisible();
    await page.getByLabel("Name").fill("Unsaved closure draft");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Discard unsaved changes?" }),
    ).toBeVisible();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(page).toHaveURL(/\/app\/subscribers\/segments(?:\?|$)/);

    let createBody: Record<string, unknown> | null = null;
    await page.route("**/api/v1/segments", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      createBody = route.request().postDataJSON() as Record<string, unknown>;
      await fulfillJson(
        route,
        {
          id: "residual-created-segment",
          tenantId: "residual-tenant",
          name: "Seeded closure segment",
          description: "Created through the browser journey.",
          queryAst: {
            op: "and",
            children: [
              {
                op: "condition",
                field: "email",
                comparator: "contains",
                value: "@",
              },
            ],
          },
          includeArchived: false,
          createdAt: "2026-08-21T09:00:00Z",
          updatedAt: "2026-08-21T09:00:00Z",
        },
        201,
      );
    });
    await page.goto(
      "/app/subscribers/segments/new?seedName=Seeded%20closure%20segment&seedDescription=Created%20through%20the%20browser%20journey.&seedField=email&seedComparator=contains&seedValue=%40",
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.getByLabel("Name")).toHaveValue("Seeded closure segment");
    await expect(page.getByText("This segment has no rules yet")).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Create segment" }).click();
    await expect(page).toHaveURL(/\/app\/subscribers\/segments(?:\?|$)/);
    expect(createBody).toMatchObject({
      name: "Seeded closure segment",
      includeArchived: false,
    });
  });

  test("desktop: folder, overflow, row, and bulk actions preserve their real transport contracts", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-desktop");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await loginAsDemo(page, { navigate: false });
    await installAuthFixture(page);
    await installSegmentEditorFixtures(page);
    const fixture = await ensureSegmentFixture(page);
    const fullSegment = {
      id: fixture.id,
      tenantId: "residual-tenant",
      name: fixture.name,
      description: "Deterministic route-closure audience.",
      queryAst: {
        op: "condition",
        field: "email",
        comparator: "contains",
        value: "@",
      },
      includeArchived: false,
      folderId: null as string | null,
      lastCount: 42,
      lastEvaluatedAt: "2026-08-25T09:00:00Z",
      createdAt: "2026-08-20T09:00:00Z",
      updatedAt: "2026-08-25T09:00:00Z",
    };
    const calls = {
      campaigns: 0,
      deletes: 0,
      duplicates: 0,
      folderCreates: 0,
      folderDeletes: 0,
      moves: 0,
      recomputes: 0,
    };
    let folders: Array<{ id: string; name: string }> = [];

    await page.route("**/api/v1/segment-folders**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "GET") {
        await fulfillJson(route, { items: folders });
        return;
      }
      if (
        request.method() === "POST" &&
        pathname === "/api/v1/segment-folders"
      ) {
        calls.folderCreates += 1;
        const input = request.postDataJSON() as { name: string };
        const created = { id: "folder-priority", name: input.name };
        folders = [created];
        await fulfillJson(route, created, 201);
        return;
      }
      if (
        request.method() === "DELETE" &&
        pathname === "/api/v1/segment-folders/folder-priority"
      ) {
        calls.folderDeletes += 1;
        folders = [];
        await fulfillJson(route, { ok: true });
        return;
      }
      await fulfillJson(route, { message: "Unexpected folder request." }, 405);
    });
    await page.route(
      `**/api/v1/segments/${fixture.id}/recompute`,
      async (route) => {
        calls.recomputes += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
        await fulfillJson(route, {
          count: 51,
          scheduled_at: "2026-08-25T10:00:00Z",
        });
      },
    );
    await page.route(`**/api/v1/segments/${fixture.id}`, async (route) => {
      const request = route.request();
      if (request.method() === "PATCH") {
        calls.moves += 1;
        const input = request.postDataJSON() as { folderId?: string };
        fullSegment.folderId = input.folderId || null;
        await fulfillJson(route, { ...fullSegment });
        return;
      }
      if (request.method() === "DELETE") {
        calls.deletes += 1;
        await fulfillJson(route, { ok: true });
        return;
      }
      await route.fallback();
    });
    await page.route("**/api/v1/segments", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      calls.duplicates += 1;
      await fulfillJson(route, {
        ...fullSegment,
        id: "segment-duplicate",
        name: `${fixture.name} copy`,
      });
    });
    await page.route("**/api/v1/campaigns", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      calls.campaigns += 1;
      const input = route.request().postDataJSON() as {
        name: string;
        subject: string;
      };
      await fulfillJson(route, {
        id: "campaign-from-segment",
        tenant_id: "residual-tenant",
        status: "draft",
        body_html: "",
        created_at: "2026-08-25T09:00:00Z",
        updated_at: "2026-08-25T09:00:00Z",
        ...input,
      });
    });

    const openFixtureMenu = async () => {
      await page
        .getByRole("button", { name: `More actions for ${fixture.name}` })
        .click();
      await expect(page.getByRole("menu")).toBeVisible();
    };
    const loadFixture = async () => {
      await gotoRoute(page, "/app/subscribers/segments", /Segments/);
      await page.getByLabel("Search segments").fill(fixture.name);
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(
        page.getByRole("link", { name: fixture.name }),
      ).toBeVisible();
    };

    await loadFixture();
    await page.getByRole("button", { name: "New folder" }).click();
    const folderInput = page.getByLabel("New folder name");
    await expect(folderInput).toBeFocused();
    await folderInput.fill("Priority signals");
    const folderForm = page.locator("form").filter({ has: folderInput });
    await folderForm.getByRole("button", { name: "Add", exact: true }).click();
    expect(calls.folderCreates).toBe(1);
    await expect(
      page.getByRole("button", { name: /Priority signals/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /^All\b/ }).click();

    await openFixtureMenu();
    for (const item of [
      "Overview",
      "Edit",
      "Duplicate",
      "Use in a campaign",
      "Move to folder",
      "Delete",
    ]) {
      await expect(
        page.getByRole("menuitem", { name: item, exact: true }),
      ).toBeVisible();
    }
    await page
      .getByRole("menuitem", { name: "Move to folder", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Priority signals", exact: true })
      .click();
    expect(calls.moves).toBe(1);

    await page.getByRole("button", { name: /Priority signals/ }).click();
    // The trigger and confirmation deliberately share their operator-facing
    // label. Scope the trigger to main so the closing portal cannot win the
    // page-wide locator during its exit animation.
    const deleteFolderTrigger = page
      .locator("main")
      .getByRole("button", { name: "Delete folder", exact: true });
    await deleteFolderTrigger.click();
    let folderDialog = page.getByRole("dialog");
    await expectDialogQuality(page);
    await folderDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(folderDialog).toBeHidden();
    await expect(deleteFolderTrigger).toBeFocused();
    await deleteFolderTrigger.click();
    folderDialog = page.getByRole("dialog");
    await expect(folderDialog).toBeVisible();
    await folderDialog
      .getByRole("button", { name: "Delete folder", exact: true })
      .click();
    await expect.poll(() => calls.folderDeletes).toBe(1);
    // The route counter increments when the intercepted request arrives, before
    // the mutation has consumed its response and applied the folder-filter URL
    // change. Wait for the operator-visible completion so the next action does
    // not race that router.replace() against Duplicate's router.push().
    await expect(folderDialog).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]folder=folder-priority(?:&|$)/);
    await expect(page.getByRole("link", { name: fixture.name })).toBeVisible();

    await openFixtureMenu();
    await page
      .getByRole("menuitem", { name: "Duplicate", exact: true })
      .click();
    await expect(page).toHaveURL(/\/segments\/segment-duplicate\/edit$/);
    expect(calls.duplicates).toBe(1);

    await loadFixture();
    await openFixtureMenu();
    await page
      .getByRole("menuitem", { name: "Use in a campaign", exact: true })
      .click();
    await expect(page).toHaveURL(/\/app\/campaigns\//);
    expect(calls.campaigns).toBeLessThanOrEqual(1);

    await loadFixture();
    await openFixtureMenu();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    // Closing the modal also dismisses its parent action menu. Reopen from the
    // stable row trigger before exercising the destructive confirmation.
    await openFixtureMenu();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect.poll(() => calls.deletes).toBe(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await settleRoute(page);
    await page.getByLabel("Search segments").fill(fixture.name);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const select = page
      .getByLabel(`Select ${fixture.name}`, { exact: true })
      .filter({ visible: true });
    await select.check();
    await page
      .getByRole("button", { name: "Recalculate", exact: true })
      .click();
    await expect.poll(() => calls.recomputes).toBe(1);
    await select.check();
    const bulkActions = page.getByRole("group", {
      name: "Bulk segment actions",
    });
    const bulkDelete = bulkActions.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await bulkDelete.click();
    await expect(
      page.getByRole("heading", { name: "Delete 1 segment?" }),
    ).toBeVisible();
    await expectDialogQuality(page);
    const bulkDialog = page.getByRole("dialog");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(bulkDialog).toBeHidden();
    await expect(bulkDelete).toBeFocused();
    await bulkDelete.click();
    await expect(bulkDialog).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect.poll(() => calls.deletes).toBe(2);
    await auditRoute(page, "/app/subscribers/segments action closure", false);
  });
});
