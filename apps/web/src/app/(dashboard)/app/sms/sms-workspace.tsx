// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquareText, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type SmsCampaign,
  type SmsCampaignReport,
  type SmsComplianceStatus,
  type SmsCreditBalance,
  type SmsDiscountCode,
  type SmsList,
  type SmsMmsReadiness,
  type SmsPilotReadiness,
  type SmsProgramRegion,
  type SmsSenderPilotCertification,
  type SmsSenderProfile,
  type SmsSetupStatus,
  createSmsQuickReply,
  deleteSmsQuickReply,
  listSmsQuickReplies,
  updateSmsQuickReply,
  type SmsQuickReply,
  type SmsTemplate,
} from "@/lib/sms-api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { base, STALE } from "@/lib/query-keys";
import { useOnline } from "@/lib/use-online";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import {
  DEFAULT_AB_VARIANTS,
  senderQuietHours,
  smsCredits,
  smsSegments,
} from "./page-helpers";
import { loadSmsPageData } from "./sms-page-data";
import type { SmsCampaignDraft } from "./sms-campaign-drafts-card";
import type { SmsConsentAction } from "./sms-consent-card";
import {
  PRISTINE_SENDER_DRAFT,
  type SmsSenderDraft,
} from "./sms-registration-drafts";
import { SmsOverviewSection } from "./sms-overview-section";
import { useSmsAudienceActions } from "./use-sms-audience-actions";
import { useSmsCampaignActions } from "./use-sms-campaign-actions";
import { useSmsCreditPreviews } from "./use-sms-credit-previews";
import { useSmsSenderActions } from "./use-sms-sender-actions";
import { canonicalSmsTabUrl } from "./sms-page-access";
import { EngagementPageHeader } from "../_engagement/engagement-ui";

// Only the Overview tab is mounted on arrival — Radix unmounts inactive tab
// panels — yet every other tab's card used to be statically imported, making
// this the largest page chunk in the build (135 KiB raw) on the heaviest route
// in the app. Each panel now arrives when its tab is first opened. The pattern
// matches /app/analytics and /app/integrations.
const TabPanelFallback = ({ label }: { label: string }) => (
  <p className="text-sm text-muted-foreground" role="status">
    Loading {label}…
  </p>
);

const SmsListsCard = dynamic(
  () => import("./sms-lists-card").then((mod) => mod.SmsListsCard),
  { loading: () => <TabPanelFallback label="lists" /> },
);
const SmsConsentCard = dynamic(
  () => import("./sms-consent-card").then((mod) => mod.SmsConsentCard),
  { loading: () => <TabPanelFallback label="consent" /> },
);
const SmsSuppressionsCard = dynamic(
  () =>
    import("./sms-suppressions-card").then((mod) => mod.SmsSuppressionsCard),
  { loading: () => <TabPanelFallback label="suppressions" /> },
);
const SmsQuietHoursCard = dynamic(
  () => import("./sms-quiet-hours-card").then((mod) => mod.SmsQuietHoursCard),
  { loading: () => <TabPanelFallback label="quiet hours" /> },
);
const TapToTextBlockEditor = dynamic(
  () =>
    import("@/components/sms/TapToTextBlockEditor").then(
      (mod) => mod.TapToTextBlockEditor,
    ),
  { loading: () => <TabPanelFallback label="tap-to-text block" /> },
);
const SmsKeywordResponsesCard = dynamic(
  () =>
    import("./sms-keyword-responses-card").then(
      (mod) => mod.SmsKeywordResponsesCard,
    ),
  { loading: () => <TabPanelFallback label="keyword responses" /> },
);
const SmsConsentRosterCard = dynamic(
  () =>
    import("./sms-consent-roster-card").then((mod) => mod.SmsConsentRosterCard),
  { loading: () => <TabPanelFallback label="consent roster" /> },
);
const SmsCampaignDraftsCard = dynamic(
  () =>
    import("./sms-campaign-drafts-card").then(
      (mod) => mod.SmsCampaignDraftsCard,
    ),
  { loading: () => <TabPanelFallback label="campaigns" /> },
);
const SmsBroadcastsCard = dynamic(
  () => import("./sms-broadcasts-card").then((mod) => mod.SmsBroadcastsCard),
  { loading: () => <TabPanelFallback label="broadcasts" /> },
);
const SmsSenderRegistrationCard = dynamic(
  () =>
    import("./sms-sender-registration-card").then(
      (mod) => mod.SmsSenderRegistrationCard,
    ),
  { loading: () => <TabPanelFallback label="registration" /> },
);
const SmsInboxTab = dynamic(
  () => import("./sms-message-log-card").then((mod) => mod.SmsInboxTab),
  { loading: () => <TabPanelFallback label="inbox" /> },
);
const SmsConversationFinder = dynamic(
  () =>
    import("@/components/sms/ConversationFinder").then(
      (mod) => mod.SmsConversationFinder,
    ),
  { loading: () => <TabPanelFallback label="conversation search" /> },
);
// Opens on demand only (messaging-19): the dialog, its sender/context reads
// and the durable reply-intent safeguard stay out of the initial route chunk.
const SmsNewConversationDialog = dynamic(
  () =>
    import("@/components/sms/NewConversationDialog").then(
      (mod) => mod.NewConversationDialog,
    ),
  { loading: () => <TabPanelFallback label="new conversation" /> },
);
const SmsTestSendCard = dynamic(
  () => import("./sms-test-send-card").then((mod) => mod.SmsTestSendCard),
  { loading: () => <TabPanelFallback label="test send" /> },
);
const SmsQuickReplyDialog = dynamic(
  () =>
    import("./sms-quick-reply-dialog").then(
      (module) => module.SmsQuickReplyDialog,
    ),
  {
    ssr: false,
    loading: () => (
      <span role="status" className="sr-only">
        Loading custom template editor…
      </span>
    ),
  },
);

const TAB_VALUES = [
  "overview",
  "audience",
  "campaigns",
  "broadcasts",
  "registration",
  "inbox",
  "testing",
] as const;
type SmsTabValue = (typeof TAB_VALUES)[number];

const SMS_DISPATCH_AVAILABLE = false;
const SMS_DISPATCH_UNAVAILABLE_REASON =
  "SMS reply dispatch is release-held (sms_reply_dispatch_release_held), and SMS broadcast dispatch is release-held (sms_broadcast_dispatch_release_held). This page cannot send, schedule, retry, or test live SMS.";
const SMS_REPORT_EXPORT_AVAILABLE = false;
const SMS_REPORT_EXPORT_UNAVAILABLE_REASON =
  "Campaign evidence and recipient export are release-held (sms_evidence_read_release_held). No evidence request is sent.";

/** Exactly the draft the sender form shows for a persisted profile. */
function senderDraftFromProfile(profile: SmsSenderProfile): SmsSenderDraft {
  const quietHours = senderQuietHours(profile.metadata);
  return {
    provider: profile.provider,
    country: profile.country,
    sender_type: profile.sender_type,
    phone_number: profile.phone_number ?? "",
    messaging_service_sid: profile.messaging_service_sid ?? "",
    brand_registration_sid: profile.brand_registration_sid ?? "",
    campaign_registration_sid: profile.campaign_registration_sid ?? "",
    registration_status: profile.registration_status,
    quiet_hours_enabled: quietHours.enabled,
    quiet_hours_timezone: quietHours.timezone,
    quiet_hours_start: quietHours.start,
    quiet_hours_end: quietHours.end,
  };
}

/** Every field, so a new draft field cannot quietly escape the comparison. */
function senderDraftMatches(
  draft: SmsSenderDraft,
  baseline: SmsSenderDraft,
): boolean {
  return (Object.keys(baseline) as (keyof SmsSenderDraft)[]).every(
    (key) => draft[key] === baseline[key],
  );
}

export function SmsAdminPage({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState<SmsSetupStatus | null>(null);
  const [compliance, setCompliance] = useState<SmsComplianceStatus | null>(
    null,
  );
  const [pilotReadiness, setPilotReadiness] =
    useState<SmsPilotReadiness | null>(null);
  const [senderCertifications, setSenderCertifications] = useState<
    Record<string, SmsSenderPilotCertification>
  >({});
  const [mmsReadiness, setMmsReadiness] = useState<SmsMmsReadiness | null>(
    null,
  );
  const [smsTemplates, setSmsTemplates] = useState<SmsTemplate[]>([]);
  // SMS-035: tenant-authored custom templates, stored via the quick-replies CRUD.
  const [smsQuickReplies, setSmsQuickReplies] = useState<SmsQuickReply[]>([]);
  const [quickRepliesLoading, setQuickRepliesLoading] = useState(true);
  const [quickRepliesError, setQuickRepliesError] = useState<string | null>(
    null,
  );
  const [quickReplyEditor, setQuickReplyEditor] = useState<{
    id?: string;
    label: string;
    body: string;
  } | null>(null);
  const [quickReplyEditorError, setQuickReplyEditorError] = useState("");
  const [quickReplyEditorBusy, setQuickReplyEditorBusy] = useState(false);
  const quickReplyLabelRef = useRef<HTMLInputElement>(null);
  const quickReplyBodyRef = useRef<HTMLTextAreaElement>(null);
  const quickReplyEditorReturnFocusRef = useRef<HTMLElement | null>(null);
  const [smsProgramRegions, setSmsProgramRegions] = useState<
    SmsProgramRegion[]
  >([]);
  const [smsDiscountCodes, setSmsDiscountCodes] = useState<SmsDiscountCode[]>(
    [],
  );
  const [smsCreditBalance, setSmsCreditBalance] =
    useState<SmsCreditBalance | null>(null);
  const [lists, setLists] = useState<SmsList[]>([]);
  const [campaigns, setCampaigns] = useState<SmsCampaign[]>([]);
  const [reports, setReports] = useState<Record<string, SmsCampaignReport>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<SmsTabValue>("overview");
  const [selectedSenderId, setSelectedSenderId] = useState("");
  const selectedSenderIdRef = useRef(selectedSenderId);
  useEffect(() => {
    selectedSenderIdRef.current = selectedSenderId;
  }, [selectedSenderId]);
  const [sender, setSender] = useState<SmsSenderDraft>(PRISTINE_SENDER_DRAFT);
  // The server values this draft was last hydrated from. Both the
  // hydrate-on-refetch guard and the unsaved-changes guard ask the same
  // question of it: does the form hold edits the server has not seen?
  const [senderBaseline, setSenderBaseline] = useState<SmsSenderDraft>(
    PRISTINE_SENDER_DRAFT,
  );
  const senderRef = useRef(sender);
  const senderBaselineRef = useRef(senderBaseline);
  useEffect(() => {
    senderRef.current = sender;
    senderBaselineRef.current = senderBaseline;
  }, [sender, senderBaseline]);
  const [listDraft, setListDraft] = useState({
    name: "",
    description: "",
    keyword: "",
  });
  const [consent, setConsent] = useState({
    list_id: "",
    phone_e164: "",
    proof_text: "",
    action: "revoked" as SmsConsentAction,
    source: "manual" as const,
  });
  const [campaignDraft, setCampaignDraft] = useState<SmsCampaignDraft>({
    sender_profile_id: "",
    list_id: "",
    name: "",
    body: "",
    media_url: "",
    status: "draft",
    scheduled_at: "",
    link_tracking: true,
    cost_cap_dollars: "",
    discount_code: "",
    send_timing: "fixed",
    local_time: "09:00",
    fallback_tz: "UTC",
    ab_enabled: false,
    ab_variants: DEFAULT_AB_VARIANTS,
  });
  const [testSend, setTestSend] = useState({
    sender_profile_id: "",
    list_id: "",
    to: "",
    body: "",
    media_url: "",
  });
  const testSendRef = useRef(testSend);

  useEffect(() => {
    testSendRef.current = testSend;
  }, [testSend]);
  const [brandRegistration, setBrandRegistration] = useState({
    customer_profile_bundle_sid: "",
    a2p_profile_bundle_sid: "",
    brand_type: "STANDARD",
    skip_automatic_sec_vet: false,
    entity_type: "PRIVATE_PROFIT",
    display_name: "",
    company_name: "",
    ein: "",
    phone: "",
    street: "",
    city: "",
    state: "",
    postal_code: "",
    country: "US",
    email: "",
    website: "",
    vertical: "",
    business_contact_email: "",
  });
  const [campaignRegistration, setCampaignRegistration] = useState({
    usecase: "MARKETING",
    vertical: "",
    description: "",
    message_flow: "",
    message_samples: "",
    subscriber_opt_in: true,
    has_embedded_links: true,
    has_embedded_phone: false,
    number_pool: false,
    affiliate_marketing: false,
    auto_renewal: true,
    terms_and_conditions_link: "",
    privacy_policy_link: "",
  });
  const [pending, setPending] = useState<string | null>(null);

  // Deep-link the active tab (?tab=). Read after mount so SSR + first client
  // render always agree on "overview" (hydration-safe), then reconcile browser
  // Back/Forward navigation as well as invalid external links.
  useEffect(() => {
    const syncFromLocation = () => {
      const raw = new URLSearchParams(window.location.search).get("tab");
      const next =
        raw && (TAB_VALUES as readonly string[]).includes(raw)
          ? (raw as SmsTabValue)
          : "overview";
      setTab(next);
      const canonical = canonicalSmsTabUrl(window.location.href, next);
      if (canonical !== window.location.href) {
        window.history.replaceState(null, "", canonical);
      }
    };
    syncFromLocation();
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, []);
  const changeTab = useCallback((next: string) => {
    setTab(next as SmsTabValue);
    if (typeof window !== "undefined") {
      window.history.replaceState(
        null,
        "",
        canonicalSmsTabUrl(window.location.href, next),
      );
    }
  }, []);

  const tenantId = me.tenant_id;
  const role = effectiveAuthRole(me);
  const online = useOnline();
  // Only the exact workspace owner/admin may start customer SMS (the inbox
  // card applies the same boundary before it renders the thread).
  const inboxAdmin =
    (role === "owner" || role === "admin") && me.viewer_mode !== true;
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const newConversationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeNewConversation = useCallback(() => {
    setNewConversationOpen(false);
    newConversationTriggerRef.current?.focus();
  }, []);
  const smsBaseKey = useMemo(
    () => [...base("sms", tenantId, role), me.user_id] as const,
    [me.user_id, role, tenantId],
  );
  const smsDataKey = useMemo(
    () => [...smsBaseKey, "overview"] as const,
    [smsBaseKey],
  );
  const smsDataQuery = useQuery({
    queryKey: smsDataKey,
    queryFn: ({ signal }) => loadSmsPageData({ signal }),
    staleTime: STALE.list,
  });
  const loading = smsDataQuery.isPending && !smsDataQuery.data;
  const refreshing = smsDataQuery.isFetching;

  useEffect(() => {
    const predicate = (query: { queryKey: readonly unknown[] }) =>
      query.queryKey[0] === "sms";
    return () => {
      void queryClient.cancelQueries({ predicate });
      queryClient.removeQueries({ predicate });
    };
  }, [queryClient]);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      await queryClient.invalidateQueries({
        queryKey: smsBaseKey,
        exact: false,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not refresh SMS data";
      setLoadError(message);
    }
  }, [queryClient, smsBaseKey]);

  const clearLoadedSmsData = useCallback(() => {
    setSetup(null);
    setCompliance(null);
    setPilotReadiness(null);
    setMmsReadiness(null);
    setLists([]);
    setCampaigns([]);
    setReports({});
    setSmsProgramRegions([]);
    setSmsTemplates([]);
    setSmsDiscountCodes([]);
    setSmsCreditBalance(null);
    setSenderCertifications({});
  }, []);

  useEffect(() => {
    const data = smsDataQuery.data;
    if (!data) return;
    setLoadError(null);
    setSetup(data.setup);
    setCompliance(data.compliance);
    setPilotReadiness(data.pilotReadiness);
    setLists(data.lists);
    setCampaigns(data.campaigns);
    setMmsReadiness(data.mmsReadiness);
    setSmsProgramRegions(data.programRegions);
    setSmsTemplates(data.templates);
    setSmsDiscountCodes(data.discountCodes);
    setSmsCreditBalance(data.creditBalance);
    setSenderCertifications(data.senderCertifications);
    const first =
      data.setup.senders.find(
        (item) => item.id === selectedSenderIdRef.current,
      ) ?? data.setup.senders[0];
    if (first && !selectedSenderIdRef.current) setSelectedSenderId(first.id);
    if (first && !testSendRef.current.sender_profile_id) {
      setTestSend((s) => ({ ...s, sender_profile_id: first.id }));
      setCampaignDraft((s) => ({ ...s, sender_profile_id: first.id }));
    }
    if (first) {
      // This effect re-runs on every refetch of the page query — window focus
      // after 60s, the header Refresh button, any sibling save that
      // invalidates. Hydrating then overwrites whatever the operator has
      // typed into the sender form, and the old guard only noticed edits to
      // the phone number, so quiet hours and the messaging-service ID were
      // silently reverted to the server row with no toast and no way back.
      // Compare the whole draft against what it was hydrated from instead.
      const persisted = senderDraftFromProfile(first);
      if (senderDraftMatches(senderRef.current, senderBaselineRef.current)) {
        setSenderBaseline(persisted);
        setSender(persisted);
      } else {
        // The operator has local edits, so their draft is never overwritten.
        // But the BASELINE always follows the server, because "dirty" has to
        // mean "differs from the row as it stands now".
        //
        // Re-anchoring only on an exact draft/server match was not enough: a
        // save the server normalises (a trimmed field, a defaulted value, a
        // reformatted number) comes back matching neither the old baseline nor
        // the draft, so neither branch fired, `registrationDirty` latched true
        // for the rest of the session, and the unsaved-changes guard blocked
        // navigation over edits that were already saved. When the server row
        // has not moved this is a no-op, since `persisted` equals the old
        // baseline.
        setSenderBaseline(persisted);
      }
    }
    const firstList = data.lists[0];
    if (firstList && !testSendRef.current.list_id) {
      setConsent((s) => ({ ...s, list_id: firstList.id }));
      setTestSend((s) => ({ ...s, list_id: firstList.id }));
      setCampaignDraft((s) => ({ ...s, list_id: firstList.id }));
    }
  }, [smsDataQuery.data]);

  useEffect(() => {
    if (!smsDataQuery.isError) return;
    clearLoadedSmsData();
    const message =
      smsDataQuery.error instanceof Error
        ? smsDataQuery.error.message
        : "Unknown error";
    setLoadError(message);
    toast.error("Could not load SMS setup", {
      description: message,
    });
  }, [clearLoadedSmsData, smsDataQuery.error, smsDataQuery.isError]);

  // One sender picker governs both the profile form and the A2P registration
  // actions, so edits and submissions never target different senders (SMS-023).
  const selectSender = useCallback(
    (id: string) => {
      setSelectedSenderId(id);
      const target = setup?.senders?.find((item) => item.id === id);
      if (!target) return;
      // Switching senders re-hydrates the form from the sender picked, so the
      // baseline moves with it — otherwise the draft would read as dirty
      // against the previous sender and block every later hydrate.
      const picked = senderDraftFromProfile(target);
      setSenderBaseline(picked);
      setSender(picked);
    },
    [setup?.senders],
  );

  const selectedSender = useMemo(
    () =>
      setup?.senders?.find((s) => s.id === selectedSenderId) ??
      setup?.senders[0],
    [selectedSenderId, setup?.senders],
  );
  const activeSender = useMemo(
    () => setup?.senders?.find((s) => s.id === testSend.sender_profile_id),
    [setup?.senders, testSend.sender_profile_id],
  );
  const campaignSender = useMemo(
    () =>
      setup?.senders?.find((s) => s.id === campaignDraft.sender_profile_id) ??
      setup?.senders[0],
    [campaignDraft.sender_profile_id, setup?.senders],
  );
  const registrationProvider = selectedSender?.provider ?? sender.provider;
  const campaignRecipientCount = useMemo(
    () =>
      lists.find((list) => list.id === campaignDraft.list_id)
        ?.recipient_count ?? 0,
    [campaignDraft.list_id, lists],
  );

  // Guard the Registration tab against accidental navigation once it holds
  // unsaved input (SMS-022). The sender profile form is the only editable form
  // rendered there today — the A2P/brand fields below are release-held and
  // render nothing, so their terms stay in this list only to keep the guard
  // honest for the day they come back.
  const registrationDirty =
    !senderDraftMatches(sender, senderBaseline) ||
    [
      brandRegistration.company_name,
      brandRegistration.display_name,
      brandRegistration.ein,
      brandRegistration.email,
      brandRegistration.phone,
      brandRegistration.street,
      brandRegistration.city,
      brandRegistration.postal_code,
      brandRegistration.website,
      brandRegistration.customer_profile_bundle_sid,
      brandRegistration.a2p_profile_bundle_sid,
      campaignRegistration.description,
      campaignRegistration.message_flow,
      campaignRegistration.message_samples,
      campaignRegistration.terms_and_conditions_link,
      campaignRegistration.privacy_policy_link,
    ].some((value) => value.trim() !== "");
  useUnsavedChangesGuard(registrationDirty);

  const { campaignCreditPreview, smsTopUpQuote, testCreditPreview } =
    useSmsCreditPreviews({
      activeSender,
      campaignDraft,
      campaignSender,
      sender,
      smsCreditBalance,
      testSend,
      campaignRecipientCount,
    });
  const {
    applySmsTemplate,
    broadcastCampaign,
    campaignCredits,
    campaignSegments,
    campaignSendDuration,
    draftSmsWithAI,
    duplicateCampaign,
    editCampaign,
    exportReport,
    insertDiscountCode,
    loadCampaignReport,
    retryFailedRecipients,
    recordMmsSmokePass,
    saveCampaign,
    scheduleCampaignFromDraft,
    setCampaignLifecycle,
    startSmsTopUpCheckout,
  } = useSmsCampaignActions({
    activeSender,
    campaignCreditPreview,
    campaignDraft,
    campaignSender,
    reports,
    refresh,
    setCampaignDraft,
    setPending,
    setReports,
    setup,
    smsCreditBalance,
    smsDiscountCodes,
    smsTopUpQuote,
  });

  // SMS-035: custom-template (quick-reply) load + apply/save/edit/delete.
  const loadSmsQuickReplies = useCallback(async (signal?: AbortSignal) => {
    setQuickRepliesLoading(true);
    setQuickRepliesError(null);
    try {
      setSmsQuickReplies(await listSmsQuickReplies({ signal }));
    } catch (error) {
      if (signal?.aborted) return;
      setSmsQuickReplies([]);
      setQuickRepliesError(
        error instanceof Error
          ? error.message
          : "Could not load custom SMS templates.",
      );
    } finally {
      if (!signal?.aborted) setQuickRepliesLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void loadSmsQuickReplies(controller.signal);
    return () => controller.abort();
  }, [loadSmsQuickReplies]);
  const applyQuickReply = useCallback(
    (reply: SmsQuickReply) =>
      setCampaignDraft((s) => ({ ...s, body: reply.body })),
    [setCampaignDraft],
  );
  const saveDraftAsTemplate = useCallback(() => {
    quickReplyEditorReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const body = campaignDraft.body.trim();
    if (!body) {
      toast.error("Write a message before saving it as a template.");
      return;
    }
    setQuickReplyEditorError("");
    setQuickReplyEditor({ label: "", body });
  }, [campaignDraft.body]);
  const editQuickReply = useCallback((reply: SmsQuickReply) => {
    quickReplyEditorReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setQuickReplyEditorError("");
    setQuickReplyEditor({
      id: reply.id,
      label: reply.label,
      body: reply.body,
    });
  }, []);
  const saveQuickReplyEditor = useCallback(async () => {
    if (!quickReplyEditor) return;
    const label = quickReplyEditor.label.trim();
    const body = quickReplyEditor.body.trim();
    if (!label || !body) {
      setQuickReplyEditorError("Enter both a template name and message.");
      requestAnimationFrame(() => {
        if (!label) quickReplyLabelRef.current?.focus();
        else quickReplyBodyRef.current?.focus();
      });
      return;
    }
    setQuickReplyEditorBusy(true);
    setQuickReplyEditorError("");
    try {
      if (quickReplyEditor.id) {
        await updateSmsQuickReply(quickReplyEditor.id, { label, body });
        toast.success("Template updated.");
      } else {
        await createSmsQuickReply({ label, body });
        toast.success("Saved as a custom template.");
      }
      setQuickReplyEditor(null);
      await loadSmsQuickReplies();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not save the template.";
      setQuickReplyEditorError(message);
      toast.error("Could not save the template.", { description: message });
    } finally {
      setQuickReplyEditorBusy(false);
    }
  }, [loadSmsQuickReplies, quickReplyEditor]);
  const deleteQuickReply = useCallback(
    async (reply: SmsQuickReply) => {
      try {
        await deleteSmsQuickReply(reply.id);
        toast.success("Template deleted.");
        await loadSmsQuickReplies();
      } catch {
        toast.error("Could not delete the template.");
      }
    },
    [loadSmsQuickReplies],
  );

  const {
    generateA2PField,
    pollRegistration,
    saveSender,
    setSenderKillSwitch,
    submitBrand,
    submitCampaignRegistration,
  } = useSmsSenderActions({
    activeSender: selectedSender,
    brandRegistration,
    campaignRegistration,
    refresh,
    sender,
    setCampaignRegistration,
    setPending,
    setup,
    targetSenderId: selectedSenderId,
  });
  const { createList, editList, recordOptOut, removeList, sendTest } =
    useSmsAudienceActions({
      consent,
      tenantId: me.tenant_id,
      listDraft,
      refresh,
      setCampaignDraft,
      setConsent,
      setListDraft,
      setPending,
      setTestSend,
      testSend,
    });

  const testSegments = smsSegments(testSend.body);
  const testCredits = smsCredits(testSend.body, testSend.media_url);
  const backendEnabled = true;

  return (
    <PageShell className="max-w-6xl [@media(pointer:coarse)]:[&_button]:min-h-11 [@media(pointer:coarse)]:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 [@media(pointer:coarse)]:[&_input:not([type=checkbox]):not([type=radio])]:text-base [@media(pointer:coarse)]:[&_select]:min-h-11 [@media(pointer:coarse)]:[&_select]:text-base [@media(pointer:coarse)]:[&_textarea]:text-base">
      <EngagementPageHeader
        eyebrow="Messaging channel"
        title="SMS"
        description="US and Canada SMS administration, consent, suppressions, delivery evidence, and release-held outbound controls."
        icon={<MessageSquareText aria-hidden />}
        actions={
          <Button
            variant="outline"
            className="min-h-10"
            onClick={() => void refresh()}
            loading={refreshing}
          >
            {!refreshing ? <RefreshCw aria-hidden /> : null}
            Refresh
          </Button>
        }
      />

      {loadError ? (
        <Alert variant="destructive">
          <AlertTitle>SMS data could not be loaded</AlertTitle>
          <AlertDescription>
            {loadError} Refresh after the API is reachable before making SMS
            changes from this page.
          </AlertDescription>
        </Alert>
      ) : null}

      {refreshing && smsDataQuery.data ? (
        <Alert>
          <AlertTitle>Refreshing SMS data</AlertTitle>
          <AlertDescription>
            Server-backed values shown during this refresh are from the last
            completed load and are not claimed as current.
          </AlertDescription>
        </Alert>
      ) : null}

      {smsDataQuery.data?.supportingReadFailures?.length ? (
        <Alert>
          <AlertTitle>Some SMS data is unavailable</AlertTitle>
          <AlertDescription>
            The following supporting reads failed and were cleared rather than
            retained as current:{" "}
            {smsDataQuery.data.supportingReadFailures.join(", ")}. Empty
            affected sections are not confirmed zero results.
          </AlertDescription>
        </Alert>
      ) : null}

      {!SMS_DISPATCH_AVAILABLE ? (
        <Alert>
          <AlertTitle>SMS dispatch release hold</AlertTitle>
          <AlertDescription>
            {SMS_DISPATCH_UNAVAILABLE_REASON} Browse and draft tools remain
            available, but this page will not submit send, schedule, resume,
            retry, or test-send mutations.
          </AlertDescription>
        </Alert>
      ) : null}

      {quickReplyEditor ? (
        <SmsQuickReplyDialog
          busy={quickReplyEditorBusy}
          editor={quickReplyEditor}
          error={quickReplyEditorError}
          bodyRef={quickReplyBodyRef}
          labelRef={quickReplyLabelRef}
          returnFocus={quickReplyEditorReturnFocusRef}
          onChange={setQuickReplyEditor}
          onClearError={() => setQuickReplyEditorError("")}
          onClose={() => {
            if (quickReplyEditorBusy) return;
            setQuickReplyEditor(null);
            setQuickReplyEditorError("");
          }}
          onSave={saveQuickReplyEditor}
        />
      ) : null}

      <Tabs value={tab} onValueChange={changeTab} className="space-y-6">
        <div className="overflow-x-auto">
          <TabsList aria-label="SMS workspace section">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="audience">Audience</TabsTrigger>
            <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
            <TabsTrigger value="broadcasts">Broadcasts</TabsTrigger>
            <TabsTrigger value="registration">Registration</TabsTrigger>
            <TabsTrigger value="inbox">Inbox</TabsTrigger>
            <TabsTrigger value="testing">Testing</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-6">
          <SmsOverviewSection
            loading={loading}
            loadError={loadError}
            pending={pending}
            setup={setup}
            compliance={compliance}
            pilotReadiness={pilotReadiness}
            senderCertifications={senderCertifications}
            onSenderPauseChange={setSenderKillSwitch}
            onGoToTab={changeTab}
            onRetry={() => void refresh()}
          />
        </TabsContent>

        <TabsContent value="audience" className="space-y-6">
          <section className="grid gap-4 lg:grid-cols-2">
            <SmsListsCard
              draft={listDraft}
              lists={lists}
              loading={loading}
              loadError={loadError}
              pending={pending}
              setDraft={setListDraft}
              onSubmit={createList}
              onEditList={editList}
              onDeleteList={removeList}
              onRetry={() => void refresh()}
            />
            <SmsConsentCard
              draft={consent}
              lists={lists}
              pending={pending}
              setDraft={setConsent}
              onSubmit={recordOptOut}
            />
          </section>
          <section className="grid gap-4 lg:grid-cols-2">
            <SmsSuppressionsCard
              baseKey={smsBaseKey}
              enabled={backendEnabled}
              tenantId={tenantId}
              userId={me.user_id}
            />
            <SmsKeywordResponsesCard
              baseKey={smsBaseKey}
              enabled={backendEnabled}
              tenantId={tenantId}
              userId={me.user_id}
            />
          </section>
          <section>
            <SmsQuietHoursCard
              baseKey={smsBaseKey}
              enabled={backendEnabled}
              tenantId={tenantId}
              userId={me.user_id}
            />
          </section>
          <section>
            <SmsConsentRosterCard
              baseKey={smsBaseKey}
              enabled={backendEnabled}
            />
          </section>
          <section>
            <TapToTextBlockEditor />
          </section>
        </TabsContent>

        <TabsContent value="campaigns" className="space-y-6">
          {quickRepliesLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading custom SMS templates…
            </p>
          ) : quickRepliesError ? (
            <Alert variant="destructive">
              <AlertTitle>Custom templates could not be loaded</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  {quickRepliesError} The empty custom-template row below is not
                  a confirmed empty workspace.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-10"
                  onClick={() => void loadSmsQuickReplies()}
                >
                  <RefreshCw aria-hidden />
                  Retry custom templates
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          <SmsCampaignDraftsCard
            campaignCredits={campaignCredits}
            campaignSendDuration={campaignSendDuration}
            campaignSegments={campaignSegments}
            campaigns={campaigns}
            creditBalance={smsCreditBalance}
            creditPreview={campaignCreditPreview}
            discountCodes={smsDiscountCodes}
            dispatchAvailable={SMS_DISPATCH_AVAILABLE}
            dispatchUnavailableReason={SMS_DISPATCH_UNAVAILABLE_REASON}
            reportExportAvailable={SMS_REPORT_EXPORT_AVAILABLE}
            reportExportUnavailableReason={SMS_REPORT_EXPORT_UNAVAILABLE_REASON}
            draft={campaignDraft}
            lists={lists}
            loading={loading}
            loadError={loadError}
            mmsReadiness={mmsReadiness}
            pending={pending}
            programRegions={smsProgramRegions}
            reports={reports}
            senders={setup?.senders ?? []}
            setupCanSend={Boolean(setup?.can_send)}
            templates={smsTemplates}
            quickReplies={smsQuickReplies}
            topUpQuote={smsTopUpQuote}
            setDraft={setCampaignDraft}
            onApplyTemplate={applySmsTemplate}
            onApplyQuickReply={applyQuickReply}
            onSaveDraftAsTemplate={saveDraftAsTemplate}
            onEditQuickReply={editQuickReply}
            onDeleteQuickReply={deleteQuickReply}
            onBroadcastCampaign={broadcastCampaign}
            onCampaignLifecycle={(campaign, action) => {
              void setCampaignLifecycle(campaign, action);
            }}
            onDraftWithAI={draftSmsWithAI}
            onDuplicateCampaign={duplicateCampaign}
            onEditCampaign={editCampaign}
            onExportReport={(campaign, status) => {
              void exportReport(campaign, status);
            }}
            onInsertDiscountCode={insertDiscountCode}
            onLoadCampaignReport={loadCampaignReport}
            onRetryFailed={retryFailedRecipients}
            onRecordMmsSmokePass={recordMmsSmokePass}
            onRetry={() => void refresh()}
            onScheduleCampaign={scheduleCampaignFromDraft}
            onStartTopUpCheckout={startSmsTopUpCheckout}
            onSubmit={saveCampaign}
          />
        </TabsContent>

        <TabsContent value="broadcasts" className="space-y-6">
          <SmsBroadcastsCard
            baseKey={smsBaseKey}
            enabled={backendEnabled}
            tenantId={tenantId}
            userId={me.user_id}
            lists={lists}
          />
        </TabsContent>

        <TabsContent value="registration" className="space-y-6">
          <SmsSenderRegistrationCard
            brandRegistration={brandRegistration}
            campaignRegistration={campaignRegistration}
            pending={pending}
            registrationProvider={registrationProvider}
            sender={sender}
            senders={setup?.senders ?? []}
            selectedSenderId={selectedSenderId}
            setBrandRegistration={setBrandRegistration}
            setCampaignRegistration={setCampaignRegistration}
            setSender={setSender}
            onSelectSender={selectSender}
            onGenerateA2PField={generateA2PField}
            onPollRegistration={pollRegistration}
            onSubmitBrand={submitBrand}
            onSubmitCampaignRegistration={submitCampaignRegistration}
            onSubmitSender={saveSender}
          />
        </TabsContent>

        <TabsContent value="inbox" className="space-y-6">
          {inboxAdmin ? (
            <div className="flex justify-end">
              <Button
                ref={newConversationTriggerRef}
                type="button"
                className="min-h-10"
                disabled={online !== "online"}
                title={
                  online !== "online"
                    ? "Reconnect before starting a conversation."
                    : undefined
                }
                onClick={() => setNewConversationOpen(true)}
              >
                <MessageSquareText aria-hidden />
                New conversation
              </Button>
            </div>
          ) : null}
          <SmsConversationFinder baseKey={smsBaseKey} me={me} />
          <SmsInboxTab active={tab === "inbox"} baseKey={smsBaseKey} me={me} />
          {newConversationOpen && inboxAdmin ? (
            <SmsNewConversationDialog
              tenantId={tenantId}
              intentScope={`${tenantId}:${me.user_id}`}
              online={online}
              queryBase={smsBaseKey}
              onClose={closeNewConversation}
              onSent={() => {
                // The inbox card scopes its keys under this prefix; a fresh
                // thread must appear without a manual refresh.
                void queryClient.invalidateQueries({
                  queryKey: [...smsBaseKey, "inbox-v2"],
                  exact: false,
                });
                closeNewConversation();
              }}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="testing" className="space-y-6">
          <SmsTestSendCard
            activeSender={activeSender}
            creditPreview={testCreditPreview}
            credits={testCredits}
            draft={testSend}
            dispatchAvailable={SMS_DISPATCH_AVAILABLE}
            dispatchUnavailableReason={SMS_DISPATCH_UNAVAILABLE_REASON}
            lists={lists}
            pending={pending}
            segments={testSegments}
            senders={setup?.senders ?? []}
            setDraft={setTestSend}
            onSubmit={sendTest}
          />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
