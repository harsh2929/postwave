"use client";

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { toast } from "sonner";

import { createCampaign, type Campaign } from "@/lib/campaigns-api";
import type { AuthRole } from "@/lib/auth-api";
import { isMockModeEnabled } from "@/lib/mock-mode";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  applyMailchimpLocalClosures,
  createAccountExport,
  createBatch,
  createCompatResource,
  convertVideoForEmail,
  generateCreativeAssistant,
  getAccountExports,
  getBatches,
  getCampaignReport,
  getMailchimpParityWorkbench,
  previewMailchimpTemplate,
  recordCampaignEvent,
  resumeJourney,
  syncDemoCommerce,
  type AccountExportsResponse,
  type BatchesResponse,
  type CampaignReport,
  type CompatResource,
  type CreativeAssistantResponse,
  type MailchimpParityWorkbenchResponse,
  type TemplateLanguagePreviewResponse,
  type VideoConvertResponse,
} from "@/lib/mailchimp-compat-api";

import { selectReportableCampaign } from "./compatibility-campaign";

/**
 * Demo writes are intentionally impossible in a production browser bundle.
 * The local flag only exposes them to an authenticated owner/admin; the API
 * remains the authoritative permission boundary for every request.
 */
export function compatibilityDemoActionsEnabled(
  role: AuthRole | null | undefined,
): boolean {
  if (process.env.NODE_ENV === "production" || !roleCanWrite(role)) {
    return false;
  }
  return (
    isMockModeEnabled() ||
    process.env.NEXT_PUBLIC_ENABLE_COMPAT_DEMO_ACTIONS === "1"
  );
}

export const CAMPAIGN_BUILDER_ASSET = {
  name: "Launch hero",
  asset_type: "image",
  url: "https://images.unsplash.com/photo-1497366754035-f200968a6e72",
  alt_text: "Workspace desk with laptop",
  metadata: { width: 1600, height: 1000, source: "demo" },
};

export const CAMPAIGN_BUILDER_SECTION = {
  name: "Founder note",
  category: "newsletter",
  blocks: [
    { type: "heading", content: "A note from the founder" },
    {
      type: "text",
      content: "Here is what changed, why it matters, and what to do next.",
    },
  ],
  html: "<h2>A note from the founder</h2><p>Here is what changed, why it matters, and what to do next.</p>",
};

export const REPORT_SEED_EVENTS = [
  {
    subscriber_email: "maya@example.com",
    event_type: "sent",
    device: "desktop",
    client: "gmail",
    country: "US",
  },
  {
    subscriber_email: "maya@example.com",
    event_type: "delivered",
    device: "desktop",
    client: "gmail",
    country: "US",
  },
  {
    subscriber_email: "maya@example.com",
    event_type: "opened",
    device: "desktop",
    client: "gmail",
    country: "US",
  },
  {
    subscriber_email: "maya@example.com",
    event_type: "clicked",
    link_url: "https://example.com/course",
    device: "desktop",
    client: "gmail",
    country: "US",
  },
  {
    subscriber_email: "maya@example.com",
    event_type: "conversion",
    revenue_cents: 9900,
    device: "desktop",
    client: "gmail",
    country: "US",
  },
  {
    subscriber_email: "rio@example.com",
    event_type: "sent",
    device: "mobile",
    client: "apple_mail",
    country: "GB",
  },
  {
    subscriber_email: "rio@example.com",
    event_type: "delivered",
    device: "mobile",
    client: "apple_mail",
    country: "GB",
  },
  {
    subscriber_email: "rio@example.com",
    event_type: "opened",
    device: "mobile",
    client: "apple_mail",
    country: "GB",
  },
];

export const CREATIVE_ASSISTANT_DEMO_REQUEST = {
  goal: "Mailchimp switch launch",
  channel: "email",
  audience: "Active newsletter operators",
  offer: "guided email and SMS migration",
  tone: "plainspoken",
  brand_voice: "clear, useful, operator-friendly",
  context: { surface: "compatibility_dashboard" },
};

export const VIDEO_CONVERSION_DEMO_REQUEST = {
  url: "https://youtu.be/dQw4w9WgXcQ",
  title: "Migration walkthrough",
  alt_text: "Migration walkthrough video thumbnail",
  cta: "Watch the migration walkthrough",
};

export const TEMPLATE_PREVIEW_DEMO_REQUEST = {
  html: '<h1>Hi *|FNAME|*</h1>*|IF:VIP=true|*<p>Your VIP preview is ready.</p>*|ELSE:|*<p>Your update is ready.</p>*|END:IF|*<p><a href="*|ARCHIVE|*">View in browser</a> - <a href="*|UNSUB|*">Unsubscribe</a></p>',
  text: "Hi *|FNAME|* - *|IF:VIP=true|*your VIP preview*|ELSE:|*your update*|END:IF|* is ready. Unsubscribe: *|UNSUB|*",
  variables: {
    FNAME: "Maya",
    VIP: true,
    ARCHIVE: "https://example.com/archive",
    UNSUB: "https://example.com/unsubscribe",
  },
};

interface UseCompatibilityDemoActionsParams {
  authorityKey: string;
  beforeWrite: (signal: AbortSignal) => Promise<void>;
  campaigns: Campaign[];
  demoActionsEnabled: boolean;
  groupsCount: number;
  integrations: CompatResource[];
  refresh: () => Promise<void>;
  setAccountExports: Dispatch<SetStateAction<AccountExportsResponse | null>>;
  setBatches: Dispatch<SetStateAction<BatchesResponse | null>>;
  setCreativeDraft: Dispatch<SetStateAction<CreativeAssistantResponse | null>>;
  setParityWorkbench: Dispatch<
    SetStateAction<MailchimpParityWorkbenchResponse | null>
  >;
  setReport: Dispatch<SetStateAction<CampaignReport | null>>;
  setTemplatePreview: Dispatch<
    SetStateAction<TemplateLanguagePreviewResponse | null>
  >;
  setVideoConversion: Dispatch<SetStateAction<VideoConvertResponse | null>>;
}

export function useCompatibilityDemoActions({
  authorityKey,
  beforeWrite,
  campaigns,
  demoActionsEnabled,
  groupsCount,
  integrations,
  refresh,
  setAccountExports,
  setBatches,
  setCreativeDraft,
  setParityWorkbench,
  setReport,
  setTemplatePreview,
  setVideoConversion,
}: UseCompatibilityDemoActionsParams) {
  const [busy, setBusy] = useState<string | null>(null);
  const authorityRef = useRef(authorityKey);
  const operationRef = useRef<{
    authorityKey: string;
    controller: AbortController;
  } | null>(null);

  useEffect(() => {
    authorityRef.current = authorityKey;
    operationRef.current?.controller.abort();
    operationRef.current = null;
    setBusy(null);
    // These responses are generated by admin-only actions and can contain
    // tenant data or one-time URLs. Purge them with the principal.
    setAccountExports(null);
    setBatches(null);
    setCreativeDraft(null);
    setParityWorkbench(null);
    setTemplatePreview(null);
    setVideoConversion(null);
    return () => {
      operationRef.current?.controller.abort();
      operationRef.current = null;
    };
  }, [
    authorityKey,
    setAccountExports,
    setBatches,
    setCreativeDraft,
    setParityWorkbench,
    setTemplatePreview,
    setVideoConversion,
  ]);

  function requireDemoActions(): boolean {
    if (demoActionsEnabled) return true;
    toast.info("Demo compatibility writes are disabled for this session.");
    return false;
  }

  function beginOperation(label: string) {
    if (!requireDemoActions() || operationRef.current) return null;
    const operation = {
      authorityKey,
      controller: new AbortController(),
    };
    operationRef.current = operation;
    setBusy(label);
    return operation;
  }

  function operationIsCurrent(operation: {
    authorityKey: string;
    controller: AbortController;
  }): boolean {
    return (
      operationRef.current === operation &&
      !operation.controller.signal.aborted &&
      authorityRef.current === operation.authorityKey
    );
  }

  function requireCurrentOperation() {
    const operation = operationRef.current;
    if (!operation || !operationIsCurrent(operation)) {
      const aborted = new Error("Compatibility action was cancelled.");
      aborted.name = "AbortError";
      throw aborted;
    }
    return operation;
  }

  async function authorizedWrite<T>(
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operation = requireCurrentOperation();
    await beforeWrite(operation.controller.signal);
    if (!operationIsCurrent(operation)) {
      return await Promise.reject(
        Object.assign(new Error("Compatibility action was cancelled."), {
          name: "AbortError",
        }),
      );
    }
    const result = await request(operation.controller.signal);
    if (!operationIsCurrent(operation)) {
      return await Promise.reject(
        Object.assign(new Error("Compatibility action was cancelled."), {
          name: "AbortError",
        }),
      );
    }
    return result;
  }

  async function finishOperation(
    label: string,
    operation: NonNullable<ReturnType<typeof beginOperation>>,
    action: () => Promise<void>,
    refreshAfter: boolean,
    announceSuccess: boolean,
  ) {
    try {
      await action();
      if (!operationIsCurrent(operation)) return;
      if (refreshAfter) await refresh();
      if (!operationIsCurrent(operation)) return;
      if (announceSuccess) toast.success(`${label} completed`);
    } catch (err) {
      if (operationIsCurrent(operation)) {
        toast.error(err instanceof Error ? err.message : `${label} failed`);
      }
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        setBusy(null);
      }
    }
  }

  async function runAction(label: string, action: () => Promise<void>) {
    const operation = beginOperation(label);
    if (!operation) return;
    await finishOperation(label, operation, action, true, true);
  }

  async function runStandalone(label: string, action: () => Promise<void>) {
    const operation = beginOperation(label);
    if (!operation) return;
    await finishOperation(label, operation, action, false, false);
  }

  async function seedContactModel() {
    await authorizedWrite((signal) =>
      createCompatResource(
        "groups",
        {
          category: "Content interests",
          name: "Product updates",
          type: "checkbox",
          display_order: groupsCount + 1,
          source_id: "mailchimp-interest-product-updates",
        },
        { signal },
      ),
    );
  }

  async function seedCampaignBuilder() {
    await Promise.all([
      authorizedWrite((signal) =>
        createCompatResource("assets", CAMPAIGN_BUILDER_ASSET, { signal }),
      ),
      authorizedWrite((signal) =>
        createCompatResource("sections", CAMPAIGN_BUILDER_SECTION, {
          signal,
        }),
      ),
    ]);
  }

  async function seedReport() {
    const campaign =
      selectReportableCampaign(campaigns) ??
      campaigns[0] ??
      (await authorizedWrite((signal) =>
        createCampaign(
          {
            name: "Mailchimp parity report seed",
            subject: "Your weekly field note",
            campaign_type: "regular",
            editor_mode: "blocks",
            body_html: "<p>Demo campaign</p>",
            content_blocks: [{ type: "text", content: "Demo campaign" }],
          },
          { signal },
        ),
      ));
    for (const event of REPORT_SEED_EVENTS) {
      await authorizedWrite((signal) =>
        recordCampaignEvent(campaign.id, event, { signal }),
      );
    }
    const operation = requireCurrentOperation();
    const report = await getCampaignReport(campaign.id, {
      signal: operation.controller.signal,
    });
    if (operationIsCurrent(operation)) setReport(report);
  }

  async function seedJourney() {
    const journey = await authorizedWrite((signal) =>
      createCompatResource<CompatResource>(
        "automations",
        {
          name: "Mailchimp customer journey parity",
          status: "draft",
          triggers: [
            { type: "subscriber_added_to_list", list_id: "mailchimp-audience" },
            { type: "tag_added", tag: "welcome" },
          ],
          nodes: [
            { id: "wait-1d", type: "wait", duration_seconds: 86400 },
            {
              id: "branch-engaged",
              type: "branch",
              condition: {
                op: "condition",
                field: "email.opened",
                comparator: "is_true",
                value: true,
              },
              true_next: "split-offer",
              false_next: "send-nudge",
            },
            {
              id: "send-nudge",
              type: "send_email",
              template_id: "re-engagement-email",
            },
            {
              id: "split-offer",
              type: "percentage_split",
              variants: [
                {
                  id: "a",
                  label: "Control",
                  percentage: 50,
                  next: "send-lesson",
                },
                {
                  id: "b",
                  label: "SMS assist",
                  percentage: 50,
                  next: "send-sms",
                },
              ],
            },
            {
              id: "send-lesson",
              type: "send_email",
              template_id: "welcome-email",
            },
            {
              id: "send-sms",
              type: "send_sms",
              sms_body: "Quick reminder: your starter guide is ready.",
            },
            {
              id: "wait-click",
              type: "wait_until_trigger",
              wait_trigger: {
                type: "subscriber_clicked_link",
                url_pattern: "/starter-guide",
                within_days: 3,
              },
            },
            {
              id: "webhook-handoff",
              type: "webhook",
              webhook_method: "POST",
              webhook_url: "https://example.com/postwave/customer-journey",
            },
            {
              id: "update-profile",
              type: "action",
              action: {
                kind: "update_contact",
                field: "lifecycle_stage",
                value: "activated",
              },
            },
            {
              id: "goal-purchased",
              type: "goal",
              goal: {
                op: "condition",
                field: "order_created",
                comparator: "within_days",
                value: 14,
              },
            },
          ],
          edges: [
            { from: "wait-1d", to: "branch-engaged" },
            { from: "branch-engaged", to: "split-offer", label: "yes" },
            { from: "branch-engaged", to: "send-nudge", label: "no" },
            { from: "split-offer", to: "send-lesson", label: "control" },
            { from: "split-offer", to: "send-sms", label: "sms" },
            { from: "send-lesson", to: "goal-purchased" },
            { from: "send-sms", to: "wait-click" },
            { from: "wait-click", to: "webhook-handoff" },
            { from: "webhook-handoff", to: "update-profile" },
            { from: "update-profile", to: "goal-purchased" },
          ],
          goals: [{ type: "order_created", window_days: 14 }],
        },
        { signal },
      ),
    );
    await authorizedWrite((signal) => resumeJourney(journey.id, { signal }));
  }

  async function seedGrowth() {
    const stamp = Date.now();
    await Promise.all([
      authorizedWrite((signal) =>
        createCompatResource(
          "landing-pages",
          {
            slug: `mailchimp-switch-${stamp}`,
            name: "Mailchimp switch landing page",
            status: "published",
            template: "signup",
            seo: {
              title: "Switch from Mailchimp",
              description: "Keep your audience and campaigns intact.",
            },
            tracking: { utm_source: "mailchimp-import" },
          },
          { signal },
        ),
      ),
      authorizedWrite((signal) =>
        createCompatResource(
          "popups",
          {
            name: "Exit intent newsletter popup",
            status: "published",
            trigger: { type: "exit_intent", delay_seconds: 3 },
            targeting: { paths: ["/", "/pricing"], frequency_days: 7 },
          },
          { signal },
        ),
      ),
    ]);
  }

  async function seedCommerce() {
    const integration =
      integrations[0] ??
      (await authorizedWrite((signal) =>
        createCompatResource<CompatResource>(
          "ecommerce/integrations",
          {
            provider: "shopify",
            shop_domain: "demo-store.myshopify.com",
            status: "connected",
            scopes: ["read_customers", "read_products", "read_orders"],
            settings: { mode: "local-demo" },
          },
          { signal },
        ),
      ));
    await authorizedWrite((signal) =>
      syncDemoCommerce(integration.id, { signal }),
    );
  }

  async function draftCampaignCreative() {
    await runStandalone("Creative Assistant", async () => {
      const draft = await authorizedWrite((signal) =>
        generateCreativeAssistant(CREATIVE_ASSISTANT_DEMO_REQUEST, { signal }),
      );
      setCreativeDraft(draft);
      toast.success("Creative Assistant draft generated");
    });
  }

  async function convertSampleVideo() {
    await runStandalone("Email video", async () => {
      const converted = await authorizedWrite((signal) =>
        convertVideoForEmail(VIDEO_CONVERSION_DEMO_REQUEST, { signal }),
      );
      setVideoConversion(converted);
      toast.success("Video converted for email");
    });
  }

  async function previewSampleTemplate() {
    await runStandalone("Template preview", async () => {
      const preview = await authorizedWrite((signal) =>
        previewMailchimpTemplate(TEMPLATE_PREVIEW_DEMO_REQUEST, { signal }),
      );
      setTemplatePreview(preview);
      toast.success("Mailchimp template preview rendered", {
        description: `${preview.found_tags.length} merge tag${
          preview.found_tags.length === 1 ? "" : "s"
        } resolved`,
      });
    });
  }

  async function runBatchCompatibilityCheck() {
    await runStandalone("Batch API", async () => {
      const batch = await authorizedWrite((signal) =>
        createBatch(
          {
            operations: [
              { method: "GET", path: "/lists", operation_id: "lists" },
              { method: "GET", path: "/campaigns", operation_id: "campaigns" },
              {
                method: "GET",
                path: "/connected-sites",
                operation_id: "sites",
              },
            ],
          },
          { signal },
        ),
      );
      const operation = requireCurrentOperation();
      const batches = await getBatches({ signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      setBatches(batches);
      toast.success("Batch compatibility check completed", {
        description: `${batch.finished_operations}/${batch.total_operations} operations finished`,
      });
    });
  }

  async function createAccountExportSnapshot() {
    await runStandalone("Account export", async () => {
      const snapshot = await authorizedWrite((signal) =>
        createAccountExport(
          {
            sections: [
              "audiences",
              "campaigns",
              "templates",
              "landing_pages",
              "automations",
              "ecommerce",
              "files",
            ],
          },
          { signal },
        ),
      );
      const operation = requireCurrentOperation();
      const exports = await getAccountExports({
        signal: operation.controller.signal,
      });
      if (!operationIsCurrent(operation)) return;
      setAccountExports(exports);
      toast.success("Account export snapshot generated", {
        description: snapshot.download_url ?? snapshot.status,
      });
    });
  }

  async function applyLocalMailchimpClosures() {
    await runStandalone("Local closures", async () => {
      await authorizedWrite((signal) =>
        applyMailchimpLocalClosures({ signal }),
      );
      const operation = requireCurrentOperation();
      const workbench = await getMailchimpParityWorkbench({
        signal: operation.controller.signal,
      });
      if (!operationIsCurrent(operation)) return;
      setParityWorkbench(workbench);
      toast.success("Local Mailchimp closures recorded");
    });
  }

  return {
    applyLocalMailchimpClosures,
    busy,
    convertSampleVideo,
    createAccountExportSnapshot,
    draftCampaignCreative,
    previewSampleTemplate,
    runAction,
    runBatchCompatibilityCheck,
    seedCampaignBuilder,
    seedCommerce,
    seedContactModel,
    seedGrowth,
    seedJourney,
    seedReport,
  };
}
