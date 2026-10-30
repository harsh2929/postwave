package orchestrator

import (
	"fmt"
	"strings"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

type resourceRowSpec struct {
	resource  string
	label     string
	total     int
	imported  int
	supported bool
	forceGap  bool
	notes     []string
}

const klaviyoStaticRebuildTaskCount = 8
const customerIOStaticChecklistCount = 8
const customerIODeliverabilityChecklistCount = 1
const customerIOEcosystemChecklistCount = customerIOStaticChecklistCount - customerIODeliverabilityChecklistCount
const hubSpotStaticScopeReviewCount = 1

// ResourceCompletenessForSource builds the user-facing parity matrix for a
// source platform. It intentionally includes known source-native surfaces that
// may not have an API count so migrations do not look falsely complete.
func ResourceCompletenessForSource(source canonical.SourcePlatform, disc adapter.DiscoveryReport, report canonical.VerificationReport) []canonical.ResourceCompleteness {
	switch source {
	case canonical.SourceActiveCampaign:
		nonEmailContacts := sourceArchiveImported(report, "activecampaign_non_email_")
		emailAddressableContacts := disc.SubscribersTotal - nonEmailContacts
		if emailAddressableContacts < 0 {
			emailAddressableContacts = 0
		}
		return buildRows([]resourceRowSpec{
			{"subscribers", "Email-addressable contacts", emailAddressableContacts, report.SubscribersImported, true, false, []string{"Contacts with an email address import with phone, tags, custom fields, source IDs, and channel-specific list evidence. They remain unconfirmed unless complete email-channel and exclusion evidence proves a safer state."}},
			{"non_email_contacts", "Email-less contacts", nonEmailContacts, nonEmailContacts, true, nonEmailContacts > 0, []string{"Email-less and phone-only ActiveCampaign contacts are preserved as review evidence and are not fabricated into the email-keyed subscriber destination."}},
			{"consent_exclusions", "Email consent and exclusions", emailAddressableContacts, report.ConsentKnown, true, emailAddressableContacts > 0, []string{"List status and subscription date are retained as provenance, not treated as channel consent. ActiveCampaign API v3 does not provide complete exclusion-list coverage, so unknown contacts stay unconfirmed until consent and exclusions are reconciled."}},
			{"campaigns", "Sent campaigns", firstNonZero(disc.CampaignsTotal, disc.ArchiveTotal), report.ArchiveImported, true, false, []string{"Completed campaigns are hydrated from campaign detail plus linked message content and imported into the read-only archive; missing content is a fidelity warning, and drafts/scheduled campaigns must be recreated."}},
			{"templates", "Templates and messages", disc.TemplatesTotal, sourceArchiveImported(report, "activecampaign_message"), true, true, []string{"Message/template inventory is preserved as source archive evidence for rebuild; editable template reconstruction is a follow-up."}},
			{"automations", "Automation definitions", disc.AutomationsTotal, report.AutomationsTranslated, true, true, []string{"Automation summaries and available blocks, goals, linked campaigns, and SMS relationships are preserved as rebuild definitions. They are never materialized as executable Moosewave automations until rebuilt and tested."}},
			{"reports", "Campaign reports", firstNonZero(disc.ReportsTotal, disc.ArchiveTotal), report.ArchiveImported, true, false, []string{"Aggregate opens/clicks are preserved where exposed by the campaign API; per-contact activity is not fully replayed in this adapter slice."}},
			{"groups", "Subscriber targeting tags", activeCampaignRuntimeTagsImported(report), activeCampaignRuntimeTagsImported(report), true, false, []string{"Tags observed on imported contacts, including list-membership targeting tags, are materialized at runtime. The separate audience-schema row accounts for every source tag definition, including definitions unused by imported contacts."}},
			{"audience_schema", "Audience field and tag schema", activeCampaignAudienceSchemaTotal(disc), sourceArchiveImported(report, "activecampaign_custom_field") + sourceArchiveImported(report, "activecampaign_tag"), true, true, []string{"Custom-field definitions and tag definitions are preserved as source archive evidence so migrated subscriber values can be reviewed against the source schema."}},
			{"lists", "Lists and saved segments", disc.SegmentsTotal, report.SegmentsTranslated, true, false, []string{"Active membership in a known email list populates the matching tag-backed Moosewave segment so targeting structure is preserved, but that membership does not make the subscriber sendable. A non-active or conflicting status on the same list suppresses its targeting tag. ActiveCampaign can keep an address active on a list while excluding it separately, and API v3 does not expose a complete exclusion inventory, so affected subscribers stay unconfirmed until an operator reconciles exclusions and targeting tags. Saved-segment summaries come from `/audiences`, details from `/segmentsV2/{id}`, and raw predicates remain rebuild-only unless translated safely."}},
			{"forms", "Forms", disc.FormsTotal, sourceArchiveImported(report, "activecampaign_form"), true, true, []string{"Forms are preserved as source archive evidence for cutover; recreate hosted and embedded forms in Moosewave before switching capture points."}},
			{"crm", "CRM deals and pipelines", activeCampaignCRMTotal(disc), sourceArchiveImported(report, "crm_"), true, true, []string{"For HubSpot-backed pilots, HubSpot remains the CRM system of record and ActiveCampaign CRM records are preserved as read-only context; this is not an email/SMS cutover blocker."}},
			{"custom_objects", "Custom objects", disc.CustomObjectsTotal, sourceArchiveImported(report, "activecampaign_custom_object_schema"), true, true, []string{"Completeness is measured schema-for-schema so child records cannot conceal a missing schema. Available records are also preserved as rebuild evidence; schema parity alone does not prove record/relationship completeness, and dependent automations require an explicit export and rebuild review."}},
			{"ecommerce", "Ecommerce", disc.EcommerceTotal, sourceArchiveImported(report, "activecampaign_ecommerce_order"), true, true, []string{"Completeness is measured order-for-order so products, customers, or connections cannot conceal a missing order. Available connections, customers, and per-order products are also preserved for attribution review; catalogs, abandoned carts, and executable ecommerce triggers remain incomplete unless separately inventoried and rebuilt."}},
			{"sms", "SMS broadcasts and consent", disc.SMSCampaignsTotal, sourceArchiveImported(report, "activecampaign_sms_broadcast"), true, true, []string{"Completeness is measured broadcast-for-broadcast so recipient rows cannot conceal a missing broadcast. SMS detail, aggregate metrics, failures, recipients, and opt-out evidence are preserved for review, not live campaigns; sender registration and channel consent must pass before activation."}},
		})
	case canonical.SourceHubSpot:
		return buildRows([]resourceRowSpec{
			{"subscribers", "Email-addressable HubSpot contacts", disc.SubscribersTotal, report.SubscribersImported, true, false, []string{"Contacts with a valid primary email import with phone, lifecycle stage, populated custom properties, source IDs, exact communication-preference state, and CRM provenance. HubSpot remains the CRM system of record."}},
			{"non_email_profiles", "HubSpot contacts without a usable primary email", disc.ProfilesWithoutEmailTotal, 0, false, disc.ProfilesWithoutEmailTotal > 0, []string{"Phone-only and otherwise non-email HubSpot contacts are counted and fingerprinted as exact identity evidence. They are excluded from the email-keyed subscriber traversal and are never fabricated into destination subscribers."}},
			{"additional_email_identities", "HubSpot additional email identities", disc.AdditionalEmailIdentitiesTotal, 0, false, disc.AdditionalEmailIdentitiesTotal > 0, []string{"Additional email addresses remain non-sendable identity evidence rather than independent subscribers. Aliases on email-addressable contacts are retained in controlled custom fields; aliases on contacts without a usable primary email remain fingerprint-only evidence so the bridge never promotes them silently."}},
			{"groups", "Populated HubSpot contact-property values", len(disc.CustomFields), hubSpotObservedContactProperties(report), true, false, []string{"This runtime row compares exact populated field keys observed in the source snapshot with distinct keys observed on imported contacts. It does not claim that empty property definitions were imported."}},
			{"contact_property_definitions", "HubSpot contact-property definitions", disc.GroupsTotal, 0, false, true, []string{"Every non-sensitive contact-property definition is included in exact source-inventory and fingerprint evidence, including definitions with no populated values. Definitions are not materialized as destination schema and require explicit post-snapshot scope review."}},
			{"communication_preferences", "HubSpot email communication preferences", disc.SubscribersTotal, report.SubscribersImported, true, false, []string{fmt.Sprintf("The final snapshot validates %d active email subscription definition(s) and projects a complete status row for every definition on every email-addressable contact.", disc.SubscriptionChannelsTotal), "Only contacts SUBSCRIBED to every active email definition can be enabled. Any scoped or global opt-out is flattened conservatively to globally disabled; NOT_SPECIFIED remains unconfirmed. Consent timestamps are retained only when every active subscribed row has defensible legal-basis or self-service-resubscription evidence.", "Explicit SUBSCRIBED definitions materialize `hubspot:subscription:{businessUnitId}:{subscriptionId}` targeting tags. These are frozen final-snapshot boundaries, not continuously evaluated provider preferences."}},
			{"email_eligibility", "HubSpot current-primary-email eligibility", disc.SubscribersTotal, report.SubscribersImported, true, false, []string{"Every promotion to enabled is evaluated against current-primary-email evidence as well as communication preferences. A hard-bounce reason, quarantine, invalid-address marker, non-marketing or unknown marketing-contact state, pending/unconfirmed double opt-in, or legacy email opt-out keeps the contact conservatively non-sendable.", "`hs_email_bounce` is retained as evidence but is not by itself treated as a hard bounce. Eligibility properties and double-opt-in state are tied to the current primary email; a primary-email change requires a fresh authoritative snapshot.", "This is a conservative import projection, not a claim of exact HubSpot sendability parity. HubSpot remains authoritative for provider-side deliverability decisions."}},
			{"lists", "HubSpot list and subscription targeting boundaries", disc.SegmentsTotal, report.SegmentsTranslated, true, false, []string{"This total combines exact HubSpot list snapshots with one targeting segment for every active email subscription definition; it is not a lists-only count.", "List membership materializes `hubspot:list:{id}` tags, while explicit subscribed preferences materialize `hubspot:subscription:{businessUnitId}:{subscriptionId}` tags. Both are executable frozen targeting boundaries, but neither makes a contact sendable on its own.", "HubSpot dynamic-list predicates do not continue evaluating in Moosewave, and the final full snapshot is authoritative for list membership and subscription targeting."}},
			{"dynamic_list_predicates", "HubSpot dynamic-list rules", hubSpotStaticScopeReviewCount, 0, false, true, hubSpotStaticScopeNotes("Exact frozen membership and an allowlisted structural list envelope are retained, including list identity/version, object type, and processing type/status. Filter predicates are deliberately not requested or persisted because their operations can contain sensitive property and integration-event literals. Operators must inspect rules in HubSpot, then rebuild them in Moosewave, retain HubSpot ownership, or explicitly retire each dependency.")},
			{"crm", "HubSpot CRM contact bridge", disc.CRMTotal, report.SubscribersImported, true, false, []string{"CRM ownership intentionally remains in HubSpot. Imported is only the email-addressable contact mirror count; contacts without a usable primary email are accounted for in the separate non-email row, and no full CRM-object import is claimed."}},
			{"automations", "HubSpot workflows", hubSpotStaticScopeReviewCount, 0, false, true, hubSpotStaticScopeNotes("Workflows and their enrollment, branching, delays, actions, and send dependencies are not inventoried or executed by the contact bridge.")},
			{"campaigns", "HubSpot marketing email and archive", hubSpotStaticScopeReviewCount, 0, false, true, hubSpotStaticScopeNotes("Marketing emails, drafts, scheduled sends, campaign associations, and historical message/archive fidelity are not inventoried or imported by the contact bridge.")},
			{"templates", "HubSpot email templates", hubSpotStaticScopeReviewCount, 0, false, true, hubSpotStaticScopeNotes("Design Manager and marketing-email templates are not inventoried or converted into editable Moosewave templates.")},
			{"reports", "HubSpot reports and analytics", hubSpotStaticScopeReviewCount, 0, false, true, hubSpotStaticScopeNotes("Reports, dashboards, attribution, and historical engagement analytics are not inventoried or imported by the contact bridge.")},
			{"forms", "HubSpot forms", hubSpotStaticScopeReviewCount, 0, false, true, hubSpotStaticScopeNotes("Hosted and embedded forms, submissions, consent configuration, and capture routing are not inventoried or rewired by the contact bridge.")},
			{"landing", "HubSpot landing pages", hubSpotStaticScopeReviewCount, 0, false, true, hubSpotStaticScopeNotes("Landing pages, site content, domains, and embedded capture points are not inventoried or rebuilt by the contact bridge.")},
			{"ecommerce", "HubSpot ecommerce", hubSpotStaticScopeReviewCount, 0, false, true, hubSpotStaticScopeNotes("Products, carts, orders, payments, subscriptions, and commerce integrations are not inventoried or migrated by the contact bridge.")},
			{"sms", "HubSpot SMS", hubSpotStaticScopeReviewCount, 0, false, true, hubSpotStaticScopeNotes("SMS messages, consent, sender registration, subscription state, and channel history are not inventoried or activated by the contact bridge.")},
			{"custom_objects", "HubSpot custom objects", hubSpotStaticScopeReviewCount, 0, false, true, hubSpotStaticScopeNotes("Custom-object schemas, records, associations, and object-driven automation dependencies are not inventoried or migrated by the contact bridge.")},
			{"other_crm_objects", "Other HubSpot CRM objects", hubSpotStaticScopeReviewCount, 0, false, true, hubSpotStaticScopeNotes("Companies, deals, tickets, leads, owners, pipelines, activities, associations, and other non-contact CRM objects remain in HubSpot and are not inventoried by the contact bridge.")},
		})
	case canonical.SourceMailchimp:
		return buildRows([]resourceRowSpec{
			{"subscribers", "Contacts and audience members", disc.SubscribersTotal, report.SubscribersImported, true, false, []string{"Mailchimp audience members import with statuses, tags, interest memberships, merge-field values, consent timestamps, and source IDs."}},
			{"segments", "Saved and static segments", disc.SegmentsTotal, report.SegmentsTranslated, true, true, []string{"Saved/static segment definitions are translated to the Moosewave segment AST where possible, with unsupported predicates preserved for review."}},
			{"audience_schema", "Audience merge fields and signup schema", len(disc.Audiences), sourceArchiveImported(report, "mailchimp_audience_schema"), true, false, []string{"One schema snapshot per selected audience preserves merge fields, defaults, public/signup-form field metadata, interest categories, and source segment definitions."}},
			{"templates", "Templates", disc.TemplatesTotal, report.TemplatesImported, true, false, []string{"Editable Mailchimp templates are imported from the template inventory and default editable content."}},
			{"campaigns", "Campaigns", firstNonZero(disc.CampaignsTotal, disc.ArchiveTotal), report.ArchiveImported, true, false, []string{"Sent campaigns are imported into the archive and materialized as sent Moosewave campaign rows so report detail endpoints can replay history."}},
			{"automations", "Classic Automations", disc.AutomationsTotal, report.AutomationsTranslated, true, false, []string{"Classic automation chains import only when every send-email template and audience trigger resolves to a destination resource. Customer Journey graphs are not exportable or listable through the supported Marketing API; the adapter's one generic non-detected gap is not inventory, and operators must attach a manual Journey rebuild/waiver checklist."}},
			{"reports", "Reports", firstNonZero(disc.ReportsTotal, disc.ArchiveTotal), report.ArchiveImported, true, false, []string{"Aggregate reports, fetched Mailchimp payloads, per-recipient activity, click members, open/unsubscribe/complaint details, and ecommerce attribution payloads are preserved for replay where the API exposes them."}},
			{"groups", "Groups and interests", disc.GroupsTotal, disc.GroupsTotal, true, false, []string{"Mailchimp interest memberships are collapsed into subscriber tags using the interest:<id> prefix."}},
			{"forms", "Signup forms", len(disc.Audiences), sourceArchiveImported(report, "mailchimp_form"), true, false, []string{"Mailchimp exposes one aggregate signup-form configuration per selected audience. Non-empty configurations materialize as draft Moosewave forms; empty/error results remain explicit manual-review gaps."}},
			{"landing", "Landing pages", disc.LandingPagesTotal, sourceArchiveImported(report, "mailchimp_landing_page"), true, false, []string{"Landing page inventory and available content are archived and materialized as non-live source-tracked drafts. The API is account-wide, so audience-filtered migrations retain a manual scope review."}},
			{"ecommerce", "Ecommerce", disc.EcommerceTotal, sourceArchiveImported(report, "mailchimp_ecommerce_"), true, false, []string{"Connected stores and available customer/product/cart/order payloads are archived into disabled commerce integrations. The API is account-wide, so selected-audience migrations require manual scope review before activation."}},
			{"content", "Content Studio, AI, and template language", 0, sourceArchiveImported(report, "mailchimp_content_studio"), true, true, []string{"Content Studio, file manager folders, reusable blocks, template-language macros, video embeds, and Creative Assistant context are tracked as rebuild tasks against Moosewave content/editor foundations."}},
			{"surveys", "Hosted surveys and email polls", 0, sourceArchiveImported(report, "mailchimp_survey_poll"), true, true, []string{"Mailchimp surveys, polls, quizzes, and response mappings are represented as explicit rebuild tasks against Moosewave growth/survey foundations."}},
			{"sms", "SMS and MMS program", disc.SMSCampaignsTotal, sourceArchiveImported(report, "mailchimp_sms_program"), true, true, []string{"SMS/MMS sender programs, consent proof, keywords, credits, quiet hours, and country rollout are provider-gated rebuild tasks before live sending."}},
			{"connected_sites", "Connected sites and onsite tracking", 0, sourceArchiveImported(report, "mailchimp_connected_site"), true, true, []string{"Connected-site scripts, ecommerce tracking, popups, and embed verification are tracked as site-owner rebuild tasks."}},
			{"deliverability", "Verified domains and deliverability setup", 0, sourceArchiveImported(report, "mailchimp_verified_domain"), true, true, []string{"Verified/sending domains, DNS records, branded links, SSL, and warmup checks are tracked as deliverability rebuild tasks."}},
			{"ads", "Ads, social posts, and postcards", 0, sourceArchiveImported(report, "mailchimp_social_ad"), true, true, []string{"Social posts, Facebook/Instagram/Google ads, retargeting audiences, and postcards/direct mail are preserved as external-channel rebuild decisions."}},
			{"developer_platform", "Developer platform and exports", 0, sourceArchiveImported(report, "mailchimp_developer_platform"), true, true, []string{"Webhooks, async batches, account exports, authorized apps, and API client expectations are tracked for reauthorization or endpoint replacement."}},
			{"transactional", "Mailchimp Transactional", 0, sourceArchiveImported(report, "mailchimp_transactional"), true, true, []string{"Mandrill-style transactional templates, messages, SMTP/webhook/inbound-route expectations are provider-gated rebuild tasks, separate from marketing mail."}},
			{"marketplace", "Marketplace, agency, and partner integrations", 0, sourceArchiveImported(report, "mailchimp_marketplace"), true, true, []string{"Connected marketplace apps, OAuth installs, agency/expert dependencies, and partner workflows are tracked for explicit ownership and reauthorization."}},
		})
	case canonical.SourceCustomerIO:
		workflowDefinitions := sourceArchiveImported(report, "customerio_campaign_workflow") + sourceArchiveImported(report, "customerio_broadcast_workflow")
		workflowDefinitionTotal := firstNonZero(disc.AutomationsTotal, workflowDefinitions)
		transactionalDefinitions := sourceArchiveImported(report, "customerio_transactional_message")
		designRebuilds := sourceArchiveImported(report, "customerio_design_email_rebuild")
		topicDefinitions := sourceArchiveImported(report, "customerio_subscription_topic")
		topicDefinitionTotal := firstNonZero(customerIOTopicDefinitionTotal(disc), topicDefinitions)
		channelDefinitions := sourceArchiveImported(report, "customerio_subscription_channel")
		channelDefinitionTotal := firstNonZero(disc.SubscriptionChannelsTotal, channelDefinitions)
		espSuppressions := sourceArchiveImported(report, "customerio_esp_suppression")
		channelOptouts := sourceArchiveImported(report, "customerio_channel_optout")
		customObjects := sourceArchiveImported(report, "customerio_object_type")
		checklistItems := sourceArchiveImported(report, "customerio_migration_checklist")
		deliverabilityChecklistItems := 0
		ecosystemChecklistItems := 0
		if checklistItems == customerIOStaticChecklistCount {
			deliverabilityChecklistItems = customerIODeliverabilityChecklistCount
			ecosystemChecklistItems = customerIOEcosystemChecklistCount
		}
		return buildRows([]resourceRowSpec{
			{"subscribers", "Email-addressable Customer.io profiles", disc.SubscribersTotal, report.SubscribersImported, true, false, []string{"Profiles import under immutable `cio_id` identity with authoritative final-snapshot email, fields, global/email-channel/topic status, subscription-topic membership, and segment membership. Email enablement requires global subscribed plus resolved email-channel subscribed/default plus applicable topic subscribed/default. Customer.io creation time is provenance, not portable consent proof."}},
			{"non_email_profiles", "Customer.io profiles without email", disc.ProfilesWithoutEmailTotal, 0, false, disc.ProfilesWithoutEmailTotal > 0, []string{"Phone-only, push-only, and identifier-only profiles are preserved in discovery evidence but are not fabricated into the email-keyed destination. Their channel identity and consent require an explicit migration or retirement decision."}},
			{"segments", "Segment and subscription-topic snapshots", disc.SegmentsTotal, report.SegmentsTranslated, true, true, []string{"Customer.io segment and subscription-topic membership is frozen into exact tag-backed cutover snapshots. Provider predicates do not keep evaluating after cutover, so dynamic rules must be rebuilt or retired."}},
			{"subscription_topics", "Subscription-topic and channel definitions", topicDefinitionTotal + channelDefinitionTotal, topicDefinitions + channelDefinitions, true, true, []string{"Topic and subscription-center channel definitions are source-preserved, while resolved profile preferences are projected into final subscriber tags and conservative email status. Operators must verify topic purpose, channel defaults, consent semantics, and destination preference-center behavior after the final delta."}},
			{"campaigns", "Sent email newsletter archive", disc.ArchiveTotal, report.ArchiveImported, true, false, []string{"Sent email newsletters require an explicit empty-language content set and provably composable source HTML. The lowest stable content ID is the warned representative of a multi-default/A-B set, while every variant remains evidence. Campaign actions, broadcasts, drafts, transactional messages, and non-email sends remain rebuild/archive records and are never made executable."}},
			{"source_archive", "Exact Customer.io source archive", disc.SourceArchiveTotal, report.SourceArchiveImported, true, true, []string{"The non-executable evidence archive must exactly cover every discovery-bound workflow, newsletter, transactional, Design Studio, topic, subscription-center channel, suppression, sender opt-out, object, and checklist record before cutover review."}},
			{"workflow_definitions", "Campaign and API-broadcast workflow definitions", workflowDefinitionTotal, workflowDefinitions, true, true, []string{"Campaign and API-broadcast definitions, actions, triggers, and channel metadata are preserved for manual rebuild. They are not represented as executable Moosewave automations."}},
			{"transactional", "Transactional message definitions", transactionalDefinitions, transactionalDefinitions, true, true, []string{"Transactional definitions and available content are preserved for rebuild; trigger IDs, sender identity, delivery guarantees, and event wiring must be reimplemented and tested."}},
			{"templates", "Editable Design Studio email templates", disc.TemplatesTotal, report.TemplatesImported, true, false, []string{"Reusable Design Studio emails with non-empty content.html import as exact source HTML under stable source identity, not provider-rendered output. Components, Liquid, global styles/assets, transformers, and localized variants require destination fidelity validation."}},
			{"structured_templates", "Design Studio definitions requiring rebuild", designRebuilds, designRebuilds, true, true, []string{"Definitions without non-empty default source HTML are preserved as rebuild records. Structured components, Liquid, global styles/assets, transformers, and localized variants require fidelity review; Moosewave does not synthesize provider-rendered output."}},
			{"consent_exclusions", "ESP suppressions and SMS/WhatsApp sender opt-outs", espSuppressions + channelOptouts, espSuppressions + channelOptouts, true, true, []string{"Global/email-channel/topic subscription state and ESP suppressions determine conservative email status. The counted /v1/optouts records are separate sender-specific SMS/WhatsApp evidence, not subscription-center channel preferences and not email authorization. Archive coverage does not itself authorize sending."}},
			{"channel_dependencies", "SMS, push, in-app, and other channel dependencies", disc.SMSCampaignsTotal + disc.PushCampaignsTotal + disc.ProfilesWithoutEmailTotal, channelOptouts, false, true, []string{"Non-email campaign content, sender identities, device/phone identifiers, channel consent, quiet hours, and routing are retained for explicit migration or retirement; this email bridge does not activate them."}},
			{"custom_objects", "Customer.io custom object type metadata", firstNonZero(disc.CustomObjectsTotal, customObjects), customObjects, true, true, []string{"Only object-type metadata is preserved by the App API adapter. Object profiles, relationships, destination schema, event, audience, and workflow dependencies require a separate provider export plus rebuild review before source retirement."}},
			{"deliverability", "Customer.io deliverability and sender cutover", customerIODeliverabilityChecklistCount, deliverabilityChecklistItems, true, true, []string{"One of the eight shared static checklist records covers sender identities, domains, DNS, branded links, SSL, IP pools/warmup, bounce/complaint handling, and rollback ownership. This row and the ecosystem row partition the same eight non-inventory prompts; their totals are not additive."}},
			{"ecosystem", "Customer.io ecosystem dependencies", customerIOEcosystemChecklistCount, ecosystemChecklistItems, true, true, []string{"Seven of the eight shared static checklist records cover historical events/reports, broadcast triggers, object profiles/relationships, forms, commerce, snippets/assets, connected destinations, and retained export needs. The eighth is the deliverability row; checklist records are prompts, not migrated runtime behavior."}},
		})
	case canonical.SourceKlaviyo:
		nonSentCampaigns := disc.CampaignsTotal - disc.ArchiveTotal
		nonEmailCampaigns := disc.SMSCampaignsTotal + disc.PushCampaignsTotal
		nonSentCampaigns -= nonEmailCampaigns
		if nonSentCampaigns < 0 {
			nonSentCampaigns = 0
		}
		structuredTemplates := disc.SourceArchiveTotal - klaviyoStaticRebuildTaskCount - disc.AutomationsTotal - disc.FormsTotal - nonEmailCampaigns - nonSentCampaigns
		if structuredTemplates < 0 {
			structuredTemplates = 0
		}
		return buildRows([]resourceRowSpec{
			{"subscribers", "Email-addressable profiles", disc.SubscribersTotal, report.SubscribersImported, true, false, []string{"Email-addressable profiles import with validated email-marketing consent and suppression state, exact enumerated list/segment snapshot tags after validated list-level suppressions are excluded, controlled profile fields, source IDs, and nested Klaviyo subscription/predictive evidence. Counts represent the send-targetable projection, not raw provider membership."}},
			{"non_email_profiles", "Profiles without email", disc.ProfilesWithoutEmailTotal, 0, false, disc.ProfilesWithoutEmailTotal > 0, []string{"Phone-only, push-only, and external-ID-only profiles are not fabricated into the email-keyed subscriber model; migrate those channel identities separately."}},
			{"segments", "List/segment membership snapshots", disc.SegmentsTotal, report.SegmentsTranslated, true, true, []string{"Every discovered list and segment becomes an executable tag-backed cutover snapshot of enumerated membership after validated list-level suppressions are excluded. This is the send-targetable projection rather than a raw membership count. Klaviyo dynamic predicates are not exposed by the profile-membership relationship and must be rebuilt natively for membership to keep changing after cutover."}},
			{"automations", "Flow definitions", disc.AutomationsTotal, sourceArchiveImported(report, "klaviyo_flow_rebuild"), true, true, []string{"Flow metadata and encoded definitions, when Klaviyo supplies them, are preserved as source-archive rebuild records only. A null definition is marked not rebuild-complete and requires provider export recovery or explicit retirement. No Klaviyo flow is activated or represented as a fictional executable graph."}},
			{"campaigns", "Sent campaign archive", disc.ArchiveTotal, report.ArchiveImported, true, false, []string{"Only campaigns with an exact sent timestamp become immutable history. Email template content and SMS/push message evidence are preserved; no archived campaign is made executable."}},
			{"non_email_campaigns", "Sent SMS and mobile-push evidence", nonEmailCampaigns, sourceArchiveImported(report, "klaviyo_non_email_campaign_archive"), true, nonEmailCampaigns > 0, []string{"Sent SMS and mobile-push definitions, content, options, and template evidence are retained in the generic source archive so they cannot surface as email campaigns or executable channel runtime."}},
			{"campaign_rebuilds", "Non-sent campaigns", nonSentCampaigns, sourceArchiveImported(report, "klaviyo_campaign_rebuild"), true, true, []string{"Draft, scheduled, cancelled, and other non-sent campaigns are preserved as rebuild records and are never mislabeled as sent history. Valid early drafts with no message or a null message definition remain explicit incomplete rebuild evidence instead of aborting discovery."}},
			{"templates", "Editable HTML templates", disc.TemplatesTotal, report.TemplatesImported, true, false, []string{"Templates with rendered HTML import as editable destination templates. A changed source template fails final delta before creating an unsafe immutable-ledger intent and requires an explicit version/rebuild decision."}},
			{"structured_templates", "Templates without rendered HTML", structuredTemplates, sourceArchiveImported(report, "klaviyo_template_rebuild"), true, structuredTemplates > 0, []string{"Templates without rendered HTML are preserved with provider metadata and their structured definition when available, as rebuild records instead of aborting or inventing editable HTML."}},
			{"forms", "Signup forms and onsite targeting", disc.FormsTotal, sourceArchiveImported(report, "klaviyo_form"), true, true, []string{"Forms are preserved as Klaviyo source archive/rebuild tasks against the onsite-growth foundations for targeting, A/B tests, spin rewards, and coupon handoff."}},
			{"ecommerce", "Catalogs, products, orders, coupons, recommendations", 1, sourceArchiveImported(report, "klaviyo_commerce"), false, true, []string{"Commerce data is not imported by this adapter. The preserved rebuild task is an inventory warning, not a catalog/order export or runtime integration."}},
			{"reviews", "Reviews", 1, sourceArchiveImported(report, "klaviyo_reviews"), false, true, []string{"Review data is not imported; a rebuild record identifies the separate export, moderation, media, Q&A, widget, and review-request work."}},
			{"service", "Customer Hub, Helpdesk, Customer Agent", 1, sourceArchiveImported(report, "klaviyo_service"), false, true, []string{"Service-suite data is not imported; conversations, macros, knowledge, chat, and handoff require a separate migration."}},
			{"cdp", "Custom objects, transformations, warehouse sync/import", 1, sourceArchiveImported(report, "klaviyo_cdp"), false, true, []string{"Custom-object schemas, transformations, and warehouse syncs are not imported. Profile predictive evidence is preserved only inside imported email-addressable profiles."}},
			{"multi_email_profiles", "Secondary email identities and per-address consent", 1, sourceArchiveImported(report, "klaviyo_multi_email_profiles"), false, true, []string{"Klaviyo's stable profile read does not expose Multi-Email Profile secondary identifiers or their independent consent/suppression state. A provider export or retained account review must reconcile them into Moosewave subscriber_emails before cutover."}},
			{"omni_channels", "SMS, WhatsApp, RCS, push channel state", 1, sourceArchiveImported(report, "klaviyo_omni_channel"), false, true, []string{"Channel consent evidence is preserved on email-addressable profiles, but channel identities, senders, credentials, templates, quiet hours, and executable SMS/push/WhatsApp/RCS state are not imported."}},
			{"deliverability", "Deliverability setup", 1, sourceArchiveImported(report, "klaviyo_deliverability"), false, true, []string{"DNS ownership, domains, click tracking, IP routing/warmup, and render entitlements cannot be migrated automatically."}},
			{"marketplace", "Apps and partner integrations", 1, sourceArchiveImported(report, "klaviyo_marketplace"), false, true, []string{"Apps, OAuth installs, app webhooks, partner profiles, and credentials require recreation or reauthorization."}},
			{"reports", "Reports and recipient activity", disc.CampaignsTotal, 0, false, disc.CampaignsTotal > 0, []string{"The Reporting API and per-recipient campaign activity are not imported. Sent content is archived, but analytics continuity requires a separate export or retained Klaviyo access."}},
		})
	case canonical.SourceConvertKit:
		return buildRows([]resourceRowSpec{
			{"campaigns", "Broadcasts", firstNonZero(disc.CampaignsTotal, disc.ArchiveTotal), report.ArchiveImported, true, false, []string{"Sent broadcasts are imported into the archive; draft and scheduled broadcasts should be recreated."}},
			{"automations", "Sequence rebuild evidence", disc.AutomationsTotal, sourceArchiveImported(report, "convertkit_sequence_rebuild"), true, true, []string{"Sequence emails, HTML, delays, send days, exclusions and timezone settings are preserved for rebuild review. Visual automation graphs and enrollments require a separate inventory; no Kit workflow is activated."}},
			{"reports", "Broadcast reports", firstNonZero(disc.ReportsTotal, disc.ArchiveTotal), report.ArchiveImported, true, false, []string{"Aggregate opens and clicks are preserved with archived broadcasts."}},
			{"groups", "Tags", disc.GroupsTotal, disc.GroupsTotal, true, false, []string{"Kit tags map cleanly to Moosewave subscriber tags and tag-backed segments."}},
			{"paid_subs", "Paid subscriptions", disc.PaidSubsTotal, report.PaidSubsImported, true, true, []string{"Optional Stripe subscription records are read-only evidence. They do not transfer billing or establish charging authority."}},
			{"templates", "Email templates", disc.TemplatesTotal, 0, false, true, []string{"Kit email templates are not imported as editable templates yet."}},
			{"forms", "Forms", disc.FormsTotal, 0, false, true, []string{"Kit forms and incentive downloads must be recreated in Moosewave forms."}},
			{"landing", "Landing pages", disc.LandingPagesTotal, 0, false, true, []string{"Kit landing pages are not imported automatically."}},
			{"ecommerce", "Commerce products", disc.EcommerceTotal, 0, false, true, []string{"Kit commerce products and purchases are not imported directly; paid subscriptions come from Stripe when connected."}},
		})
	case canonical.SourceBeehiiv:
		premiumInventoryTotal := disc.PaidSubsTotal
		premiumMembershipsPreserved := report.PremiumMembershipsObserved
		if premiumMembershipsPreserved > premiumInventoryTotal {
			premiumInventoryTotal = premiumMembershipsPreserved
		}
		premiumCompletenessImported := premiumMembershipsPreserved
		if premiumMembershipsPreserved != disc.PaidSubsTotal {
			premiumCompletenessImported = minInt(premiumMembershipsPreserved, disc.PaidSubsTotal)
		}
		preservedAutomations := sourceArchiveImported(report, "beehiiv_automation")
		preservedAutomationEmailInventories := sourceArchiveImported(report, "beehiiv_automation_email_inventory_manifest")
		preservedAutomationJourneyInventories := sourceArchiveImported(report, "beehiiv_automation_journey_inventory_manifest")
		providerSegments := disc.SegmentsTotal - disc.GroupsTotal
		if providerSegments < 0 {
			providerSegments = 0
		}
		conditionSetDefinitions := sourceArchiveImported(report, "beehiiv_condition_set")
		return buildRows([]resourceRowSpec{
			{"subscribers", "Subscribers and subscription state", disc.SubscribersTotal, report.SubscribersImported, true, false, []string{"All subscription statuses, custom fields, acquisition metadata, newsletter-list IDs, and premium-tier metadata returned by API v2 are imported. Source-owned status, fields, and snapshot tags are authoritative on final delta. Beehiiv creation time is retained as provenance, not treated as portable consent proof."}},
			{"segments", "Segments and newsletter lists", disc.SegmentsTotal, report.SegmentsTranslated, true, false, []string{"Beehiiv does not expose saved-segment predicates. Completed memberships are frozen into tag-backed cutover snapshots; unavailable or over-10,000-member snapshots fail closed, and every dynamic rule must be rebuilt after cutover. Newsletter-list membership maps to separate tag-backed segments."}},
			{"segment_definitions", "Segment metadata and calculation state", providerSegments, sourceArchiveImported(report, "beehiiv_segment"), true, false, []string{"Every accessible Beehiiv segment definition is source-preserved with its stable ID, type, active/calculation state, result count, last-calculated time, and returned statistics. Saved predicates are not exposed by API v2; their rebuild review is enforced by the separate segments cutover gate."}},
			{"condition_set_archive", "Dynamic-content condition-set inventory traversal", 1, sourceArchiveImported(report, "beehiiv_condition_set_inventory_manifest"), true, false, []string{"A durable completion manifest proves the required condition_sets:read cursor traversal completed, including an explicitly empty inventory."}},
			{"condition_set_rules", "Dynamic-content condition-set rules", conditionSetDefinitions, conditionSetDefinitions, true, true, []string{"Active condition-set identity and lifecycle metadata are source-preserved. Beehiiv does not expose saved predicate trees, so every returned rule must be rebuilt or explicitly retired under the dynamic audience-rules cutover review."}},
			{"custom_field_schema", "Custom-field definitions", len(disc.CustomFields), sourceArchiveImported(report, "beehiiv_custom_field"), true, false, []string{"Custom-field IDs, display names, kinds, creation timestamps, and list options are source-preserved. Per-subscriber values are imported on the subscriber profile."}},
			{"newsletter_list_definitions", "Newsletter-list definitions", disc.GroupsTotal, sourceArchiveImported(report, "beehiiv_newsletter_list"), true, false, []string{"Every discovery-bound newsletter-list definition is source-preserved with its stable ID, status, subscriber count, timestamps, slug, and auto-subscribe state."}},
			{"newsletter_list_history", "Newsletter-list subscription-history traversals", disc.GroupsTotal, sourceArchiveImported(report, "beehiiv_newsletter_list_history_manifest"), true, false, []string{"One durable completion manifest per discovery-bound newsletter list proves its cursor-paginated subscription history was fully traversed, including an explicitly empty history. Active/pending/inactive/paused records retain timestamps and contact linkage."}},
			{"campaigns", "Sent posts/newsletters", firstNonZero(disc.CampaignsTotal, disc.ArchiveTotal), report.ArchiveImported, true, false, []string{"Past confirmed or archived email/both posts import with expanded free/premium HTML and nested email statistics. Drafts, future scheduled posts, and web-only posts are source-preserved instead of marked sent."}},
			{"automations", "Automation rebuild records", disc.AutomationsTotal, preservedAutomations, true, true, []string{"API v2 exposes automation metadata, trigger-event labels, email metadata, and statistics, but not executable graphs or message bodies. Records are preserved for rebuild/review and are never activated as Moosewave runtime automations."}},
			{"automation_email_inventory", "Automation email-inventory traversals", disc.AutomationsTotal, preservedAutomationEmailInventories, true, false, []string{"One durable completion manifest per discovery-bound automation proves its cursor-paginated email metadata/statistics inventory was fully traversed, including an explicitly empty inventory."}},
			{"automation_journey_inventory", "Automation journey-inventory traversals", disc.AutomationsTotal, preservedAutomationJourneyInventories, true, false, []string{"One durable completion manifest per discovery-bound automation proves its exact-total journey history was fully traversed, including an explicitly empty inventory. In-progress subscription journeys are preserved for duplicate/missed-send review before any rebuilt automation is activated."}},
			{"reports", "Post analytics", firstNonZero(disc.ReportsTotal, disc.ArchiveTotal), report.ArchiveImported, true, false, []string{"Nested email/web totals, verified-click fields, click maps, and premium-upgrade totals are preserved in archive reports when Beehiiv returns them; per-reader event history is not replayed."}},
			{"premium_memberships", "Premium membership metadata", premiumInventoryTotal, premiumCompletenessImported, true, false, []string{"Premium/free tier and tier-name metadata is retained on subscriber profiles. The subscriber traversal must exactly match the discovery-bound premium inventory; any 0→1 or other tier drift fails the run before cutover."}},
			{"paid_subs", "Stripe billing continuity", premiumInventoryTotal, report.PaidSubsImported, false, true, []string{"Billing records are not imported from an arbitrary Stripe account ID. A future paid migration must use a tenant-owned, publication-bound Stripe connection and verified product/customer ownership."}},
			{"forms", "Subscribe forms", firstNonZero(disc.FormsTotal, 1), sourceArchiveImported(report, "parity_gap:website_settings"), false, true, []string{"Beehiiv subscribe widgets and forms require a manual Moosewave rebuild."}},
			{"landing", "Publication website", firstNonZero(disc.LandingPagesTotal, 1), sourceArchiveImported(report, "parity_gap:website_settings"), false, true, []string{"Website pages, navigation, custom-domain, theme, and widget settings require a manual rebuild."}},
			{"referrals", "Referral program and network", 0, sourceArchiveImported(report, "beehiiv_referral_milestone") + sourceArchiveImported(report, "parity_gap:referrals_boosts"), true, true, []string{"Accessible referral milestones are source-preserved. Recommendation relationships, boosts, and ad-network configuration still require manual recreation."}},
			{"polls", "Polls and responses", 0, sourceArchiveImported(report, "beehiiv_poll") + sourceArchiveImported(report, "beehiiv_poll_response"), true, true, []string{"Accessible poll definitions and responses are source-preserved for rebuild; they are not activated as Moosewave forms."}},
			{"beehiiv_website_capture_rebuild", "Website, theme, and capture-widget rebuild", 1, sourceArchiveImported(report, "parity_gap:website_settings"), true, true, []string{"The durable parity-gap record must be followed by explicit post-delta inventory and rebuild/retirement evidence before traffic changes."}},
			{"beehiiv_boosts_recommendations_rebuild", "Boosts and recommendation-network rebuild", 1, sourceArchiveImported(report, "parity_gap:referrals_boosts"), true, true, []string{"The durable parity-gap record must be followed by explicit post-delta inventory and rebuild/retirement evidence before cutover."}},
			{"beehiiv_ad_network_rebuild", "Beehiiv Ad Network review", 1, sourceArchiveImported(report, "parity_gap:ad_network"), true, true, []string{"The durable parity-gap record must be followed by explicit post-delta export, ownership, and retirement evidence before cutover."}},
		})
	case canonical.SourceMailerLite:
		savedSegments := disc.SegmentsTotal - disc.GroupsTotal
		if savedSegments < 0 {
			savedSegments = 0
		}
		importedGroups := minInt(report.SegmentsTranslated, disc.GroupsTotal)
		nonSentCampaigns := disc.CampaignsTotal - disc.ArchiveTotal
		if nonSentCampaigns < 0 {
			nonSentCampaigns = 0
		}
		return buildRows([]resourceRowSpec{
			{"campaigns", "Sent campaign archive", disc.ArchiveTotal, report.ArchiveImported, true, true, []string{"All API-visible sent campaigns import with subject, plain text when available, preview reference, sent timestamp, aggregate delivery/open/click totals, and metadata for every A/B or multivariate email variant. The documented read API does not expose rendered HTML."}},
			{"campaign_rebuilds", "Draft and ready campaigns", nonSentCampaigns, sourceArchiveImported(report, "mailerlite_campaign_rebuild"), true, nonSentCampaigns > 0, []string{"Draft and ready campaign metadata is preserved for rebuild. Content, audience filters, scheduling, sender settings, and test variants must be verified before activation."}},
			{"automations", "Automation rebuild records", disc.AutomationsTotal, report.AutomationsTranslated, true, true, []string{"MailerLite exposes workflow trigger and step metadata, but provider-specific graph semantics and rendered message bodies are not safely portable. Definitions are preserved for rebuild/review and never activated automatically."}},
			{"reports", "Campaign reports", firstNonZero(disc.ReportsTotal, disc.ArchiveTotal), report.ArchiveImported, true, false, []string{"Aggregate sent, open, and click totals are preserved with archived campaigns; per-recipient activity is not replayed."}},
			{"groups", "Groups", disc.GroupsTotal, importedGroups, true, false, []string{"Subscriber requests explicitly include group relationships. Group names become subscriber tags and executable tag-backed Moosewave segments."}},
			{"segments", "Dynamic saved segments", savedSegments, 0, false, savedSegments > 0, []string{"The documented Connect API exposes segment names, counts, and membership reads, but not dynamic predicate definitions. Metadata is preserved for explicit rebuild; no executable rule is invented."}},
			{"custom_field_definitions", "Custom-field definitions", len(disc.CustomFields), sourceArchiveImported(report, "mailerlite_custom_field"), true, true, []string{"Field keys, names, and types are preserved, including fields with no populated subscriber value. Destination values are materialized from the authoritative final subscriber snapshot; definitions are evidence rather than pre-created destination schema."}},
			{"templates", "Reusable templates", 1, 0, false, true, []string{"The documented Connect API has no reusable-template inventory/read endpoint. Export or rebuild templates manually before retiring MailerLite."}},
			{"forms", "Forms and popups", disc.FormsTotal, sourceArchiveImported(report, "mailerlite_form"), true, disc.FormsTotal > 0, []string{"Popup, embedded, and promotion form metadata is preserved as source evidence. Capture UI, consent configuration, embeds, and routing must be rebuilt and tested in Moosewave."}},
			{"landing", "Sites and landing pages", 1, sourceArchiveImported(report, "parity_gap:sites_landing_pages"), false, true, []string{"The documented Connect API has no sites/landing-page inventory endpoint. The durable checklist item requires a manual inventory and rebuild/retirement decision."}},
			{"ecommerce", "Ecommerce shops", disc.EcommerceTotal, sourceArchiveImported(report, "mailerlite_ecommerce_shop"), true, disc.EcommerceTotal > 0, []string{"Shop metadata is preserved as source evidence; catalogs, customers, purchases, attribution, and triggers must be reconnected through Moosewave commerce integrations."}},
		})
	case canonical.SourceSubstack:
		return buildRows([]resourceRowSpec{
			{"subscribers", "Subscriber snapshot and email state", disc.SubscribersTotal, report.SubscribersImported, true, false, []string{"The final de-duplicated export snapshot is authoritative for source-owned status, names/attributes, and membership-tier tags. A missing or unknown status stays unconfirmed; later duplicate suppressions dominate earlier active rows."}},
			{"consent_exclusions", "Consent and exclusion evidence", disc.SubscribersTotal, report.ConsentKnown, false, true, []string{"Substack signup dates are import provenance, not portable opt-in proof. Reconcile consent, complaints, bounces, and every email-disabled state before enabling destination sends."}},
			{"premium_memberships", "Paid, founding, gift, and comp membership metadata", disc.PaidSubsTotal, report.PremiumMembershipsObserved, true, false, []string{"Tier labels are preserved as subscriber metadata and tags. They prove only the exported membership snapshot, not a Stripe/Apple billing relationship or a live Moosewave entitlement."}},
			{"paid_subs", "Publication-bound billing and entitlement handoff", disc.PaidSubsTotal, 0, false, true, []string{"Moosewave does not enumerate all subscriptions from a caller-supplied Stripe account ID or turn migration evidence into runtime entitlements. Coordinate product/customer ownership, Stripe or Apple payment rails, refunds/disputes/tax, trials, renewal behavior, and Substack shutdown with Substack and the payment provider."}},
			{"campaigns", "Email-sent post archive", firstNonZero(disc.CampaignsTotal, disc.ArchiveTotal), report.ArchiveImported, true, false, []string{"Official posts.csv rows with email-send evidence import as immutable sent history; matching posts/<post_id>.*.html fragments provide content and audience/type metadata remains attached."}},
			{"reports", "Aggregate delivery/open evidence", disc.ReportsTotal, minInt(report.ArchiveImported, disc.ReportsTotal), true, false, []string{"Per-post delivers/opens files are reduced to aggregate counts without retaining recipient identities. Clicks, per-reader activity, views, and richer analytics are not replayed unless a separately supplied stats CSV contains supported aggregate fields."}},
			{"non_email_posts", "Drafts, pages, and web-only posts", 1, sourceArchiveImported(report, "parity_gap:non_email_posts"), true, true, []string{"Rows without email-send evidence are deliberately excluded from sent campaign history and require rebuild, separate content preservation, or explicit retirement."}},
			{"audience_variants", "Audience-specific and paywalled variants", 1, sourceArchiveImported(report, "parity_gap:audience_variants"), true, true, []string{"A single HTML fragment does not prove every logged-out/free/paid/founding rendering or paywall rule; inspect and rebuild conditional content."}},
			{"comments", "Comments and reactions", 1, sourceArchiveImported(report, "parity_gap:comments_reactions"), true, true, []string{"Comment bodies, threads, likes, moderation state, and reader reactions require a separate export or retirement decision."}},
			{"notes_restacks", "Notes, restacks, and social graph", 1, sourceArchiveImported(report, "parity_gap:notes_restacks"), true, true, []string{"Notes, cross-posts, restacks, follows, and engagement history are not part of the publication ZIP contract."}},
			{"chat", "Chat", 1, sourceArchiveImported(report, "parity_gap:chat"), true, true, []string{"Chat threads, participants, moderation state, and attachments need a separate migration."}},
			{"referrals", "Recommendations and referrals", 1, sourceArchiveImported(report, "parity_gap:recommendations_referrals"), true, true, []string{"Recommendation relationships, referral attribution, and network growth settings must be rebuilt or retired."}},
			{"automations", "Welcome emails and source automations", 1, sourceArchiveImported(report, "parity_gap:welcome_automations"), true, true, []string{"Welcome messages, scheduled direct emails, and automation behavior are not inferred or activated from exported posts."}},
			{"surveys", "Surveys and responses", 1, sourceArchiveImported(report, "parity_gap:surveys"), true, true, []string{"Substack exposes survey responses through a separate export; definitions, responses, routing, and consent implications require separate handling."}},
			{"podcast_video_live", "Podcast, video, and live media", 1, sourceArchiveImported(report, "parity_gap:podcast_video_live"), true, true, []string{"Feeds, private-feed entitlements, media files, transcripts, livestream configuration, and distribution relationships need a separate migration."}},
			{"assets", "Images, thumbnails, and attachments", 1, sourceArchiveImported(report, "parity_gap:assets"), true, true, []string{"HTML may retain remote Substack CDN links, but asset ownership and portable image/file binaries are not proven by this adapter."}},
			{"landing", "Publication settings and web presence", 1, sourceArchiveImported(report, "parity_gap:publication_settings"), true, true, []string{"Theme, custom/About pages, navigation, custom domain, redirects, SEO/social metadata, embeds, and capture widgets must be recreated and tested."}},
			{"engagement_history", "Subscriber engagement and delivery history", 1, sourceArchiveImported(report, "parity_gap:engagement_history"), true, true, []string{"Per-reader deliveries, opens, views, clicks, activity scores, targeting history, and deletion history are not replayed."}},
			{"integrations", "Integrations and operational dependencies", 1, sourceArchiveImported(report, "parity_gap:integrations"), true, true, []string{"Apps, analytics/pixels, webhooks, API clients, sender identities, DNS, reply routing, and credentials require explicit reauthorization or replacement."}},
			{"source_archive", "Export inventory and migration checklist", disc.SourceArchiveTotal, report.SourceArchiveImported, true, false, []string{"The uploaded archive digest, portable-file inventory, and every fixed parity checklist record must be preserved exactly before cutover review."}},
		})
	case canonical.SourceSendy:
		return buildRows([]resourceRowSpec{
			{"subscribers", "Sendy subscribers", disc.SubscribersTotal, report.SubscribersImported, true, false, []string{"Sendy CSV exports import subscriber rows, status fields, tags, custom fields, and consent timestamps when columns are present."}},
			{"segments", "Sendy segments", disc.SegmentsTotal, report.SegmentsTranslated, false, true, []string{"Sendy CSV exports do not include saved segment definitions; recreate segments after import."}},
			{"automations", "Automations", disc.AutomationsTotal, report.AutomationsTranslated, false, true, []string{"Sendy does not export automation workflows through the official API/CSV path."}},
			{"campaigns", "Campaign archive", disc.ArchiveTotal, report.ArchiveImported, false, true, []string{"Sendy campaign content and aggregate reports are not present in the subscriber CSV export."}},
			{"paid_subs", "Paid subscriptions", disc.PaidSubsTotal, report.PaidSubsImported, false, true, []string{"Paid subscriptions require a source-specific commerce export or Stripe connection."}},
			{"forms", "Forms and hosted pages", 0, 0, false, true, []string{"Signup forms, landing pages, and embed settings should be recreated in Moosewave."}},
		})
	case canonical.SourceCSV:
		return buildRows([]resourceRowSpec{
			{"subscribers", "Subscribers", disc.SubscribersTotal, report.SubscribersImported, true, false, []string{"CSV imports subscriber rows, tags, custom fields, and consent timestamps when columns are present."}},
			{"segments", "Segments", disc.SegmentsTotal, report.SegmentsTranslated, false, true, []string{"Generic CSV has no portable saved-segment model; recreate segments after import."}},
			{"automations", "Automations", disc.AutomationsTotal, report.AutomationsTranslated, false, true, []string{"Generic CSV does not contain automation workflows."}},
			{"campaigns", "Campaign archive", disc.ArchiveTotal, report.ArchiveImported, false, true, []string{"Generic CSV does not carry sent campaign content or reports."}},
			{"paid_subs", "Paid subscriptions", disc.PaidSubsTotal, report.PaidSubsImported, false, true, []string{"Paid subscriptions require a source-specific export or Stripe connection."}},
			{"forms", "Forms and landing pages", 0, 0, false, true, []string{"Forms, landing pages, and embed settings are not represented in a generic contact CSV."}},
		})
	default:
		return nil
	}
}

// DiscoveryCompletenessForSource builds the same parity matrix for pre-flight
// discovery, before actual import counters exist.
func DiscoveryCompletenessForSource(source canonical.SourcePlatform, disc adapter.DiscoveryReport) []canonical.ResourceCompleteness {
	report := canonical.VerificationReport{
		SubscribersImported:   disc.SubscribersTotal,
		SegmentsTranslated:    disc.SegmentsTotal,
		AutomationsTranslated: disc.AutomationsTotal,
		PaidSubsImported:      0,
		ArchiveImported:       disc.ArchiveTotal,
	}
	if source == canonical.SourceActiveCampaign {
		report.AutomationsTranslated = 0
		report.SubscriberTagsImported = disc.GroupsTotal
	}
	if source == canonical.SourceMailerLite {
		report.AutomationsTranslated = 0
		report.SegmentsTranslated = disc.GroupsTotal
		report.SourceArchiveByResource = map[string]int{
			"mailerlite_custom_field":        len(disc.CustomFields),
			"mailerlite_campaign_rebuild":    maxInt(disc.CampaignsTotal-disc.ArchiveTotal, 0),
			"mailerlite_form":                disc.FormsTotal,
			"mailerlite_ecommerce_shop":      disc.EcommerceTotal,
			"parity_gap:sites_landing_pages": 1,
		}
	}
	if source == canonical.SourceMailchimp {
		audienceCount := len(disc.Audiences)
		report.TemplatesImported = disc.TemplatesTotal
		report.SourceArchiveByResource = map[string]int{
			"mailchimp_audience_schema":    audienceCount,
			"mailchimp_customer_journey":   1,
			"mailchimp_form":               audienceCount,
			"mailchimp_landing_page":       disc.LandingPagesTotal,
			"mailchimp_ecommerce_store":    disc.EcommerceTotal,
			"mailchimp_content_studio":     1,
			"mailchimp_survey_poll":        1,
			"mailchimp_sms_program":        1,
			"mailchimp_connected_site":     1,
			"mailchimp_verified_domain":    1,
			"mailchimp_social_ad":          1,
			"mailchimp_developer_platform": 1,
			"mailchimp_transactional":      1,
			"mailchimp_marketplace":        1,
		}
	}
	if source == canonical.SourceKlaviyo {
		nonSentCampaigns := disc.CampaignsTotal - disc.ArchiveTotal
		nonEmailCampaigns := disc.SMSCampaignsTotal + disc.PushCampaignsTotal
		nonSentCampaigns -= nonEmailCampaigns
		if nonSentCampaigns < 0 {
			nonSentCampaigns = 0
		}
		structuredTemplates := disc.SourceArchiveTotal - klaviyoStaticRebuildTaskCount - disc.AutomationsTotal - disc.FormsTotal - nonEmailCampaigns - nonSentCampaigns
		if structuredTemplates < 0 {
			structuredTemplates = 0
		}
		report.TemplatesImported = disc.TemplatesTotal
		report.SourceArchiveByResource = map[string]int{
			"klaviyo_flow_rebuild":               disc.AutomationsTotal,
			"klaviyo_form":                       disc.FormsTotal,
			"klaviyo_non_email_campaign_archive": nonEmailCampaigns,
			"klaviyo_campaign_rebuild":           nonSentCampaigns,
			"klaviyo_template_rebuild":           structuredTemplates,
			"klaviyo_commerce":                   1,
			"klaviyo_reviews":                    1,
			"klaviyo_service":                    1,
			"klaviyo_cdp":                        1,
			"klaviyo_multi_email_profiles":       1,
			"klaviyo_omni_channel":               1,
			"klaviyo_deliverability":             1,
			"klaviyo_marketplace":                1,
		}
	}
	if source == canonical.SourceCustomerIO {
		report.TemplatesImported = disc.TemplatesTotal
		report.SourceArchiveImported = disc.SourceArchiveTotal
		report.SourceArchiveByResource = map[string]int{
			"customerio_campaign_workflow":    disc.AutomationsTotal,
			"customerio_subscription_topic":   customerIOTopicDefinitionTotal(disc),
			"customerio_subscription_channel": disc.SubscriptionChannelsTotal,
			"customerio_object_type":          disc.CustomObjectsTotal,
			"customerio_migration_checklist":  customerIOStaticChecklistCount,
		}
	}
	return ResourceCompletenessForSource(source, disc, report)
}

func buildRows(specs []resourceRowSpec) []canonical.ResourceCompleteness {
	rows := make([]canonical.ResourceCompleteness, 0, len(specs))
	for _, spec := range specs {
		rows = append(rows, canonical.ResourceCompleteness{
			Resource:    spec.resource,
			Label:       spec.label,
			SourceTotal: spec.total,
			Imported:    spec.imported,
			Supported:   spec.supported,
			Status:      resourceStatus(spec.resource, spec.total, spec.imported, spec.supported, spec.forceGap),
			Notes:       spec.notes,
		})
	}
	return rows
}

func resourceStatus(resource string, sourceTotal, imported int, supported, forceGap bool) string {
	if !supported {
		if sourceTotal == 0 && !forceGap {
			return "not_detected"
		}
		if forceGap {
			return "manual_rebuild_required"
		}
		return "not_supported"
	}
	if forceGap && rebuildTaskResource(resource) {
		if imported <= 0 || (sourceTotal > 0 && imported < sourceTotal) {
			return "manual_rebuild_required"
		}
		return "preserved_for_rebuild"
	}
	if imported > 0 && sourceTotal == 0 {
		return "imported_runtime"
	}
	if sourceTotal == 0 {
		return "not_detected"
	}
	if imported >= sourceTotal && !forceGap {
		return "imported_runtime"
	}
	if imported > 0 {
		return "partial_runtime"
	}
	if forceGap {
		return "manual_rebuild_required"
	}
	return "partial_runtime"
}

func rebuildTaskResource(resource string) bool {
	switch resource {
	case "assets",
		"automations",
		"audience_schema",
		"consent_exclusions",
		"comments",
		"condition_set_rules",
		"channel_dependencies",
		"connected_sites",
		"content",
		"campaign_rebuilds",
		"cdp",
		"crm",
		"custom_objects",
		"custom_field_definitions",
		"deliverability",
		"ads",
		"developer_platform",
		"ecommerce",
		"forms",
		"engagement_history",
		"integrations",
		"landing",
		"marketplace",
		"non_email_contacts",
		"non_email_campaigns",
		"non_email_posts",
		"notes_restacks",
		"omni_channels",
		"podcast_video_live",
		"polls",
		"referrals",
		"reviews",
		"service",
		"source_archive",
		"sms",
		"surveys",
		"audience_variants",
		"chat",
		"templates",
		"transactional",
		"workflow_definitions",
		"subscription_topics",
		"structured_templates",
		"ecosystem",
		"beehiiv_ad_network_rebuild",
		"beehiiv_boosts_recommendations_rebuild",
		"beehiiv_website_capture_rebuild":
		return true
	default:
		return false
	}
}

func firstNonZero(values ...int) int {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func customerIOTopicDefinitionTotal(disc adapter.DiscoveryReport) int {
	total := 0
	for _, audience := range disc.Audiences {
		if strings.HasPrefix(strings.TrimSpace(audience.ID), "customerio:topic:") {
			total++
		}
	}
	return total
}

func boolCount(v bool) int {
	if v {
		return 1
	}
	return 0
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func activeCampaignCRMTotal(disc adapter.DiscoveryReport) int {
	if disc.CRMTotal > 0 {
		return disc.CRMTotal
	}
	return disc.DealsTotal + disc.PipelinesTotal
}

func activeCampaignAudienceSchemaTotal(disc adapter.DiscoveryReport) int {
	return len(disc.CustomFields) + disc.GroupsTotal
}

func hubSpotObservedContactProperties(report canonical.VerificationReport) int {
	return len(report.CustomFieldsMapped) + len(report.CustomFieldsUnmapped)
}

func hubSpotStaticScopeNotes(detail string) []string {
	return []string{
		"This row is one non-additive, static scope-review checklist item; it is not a provider inventory count and must never be interpreted as proof that the surface was absent.",
		detail,
		"Inventory dependencies outside the adapter, then rebuild, retain in HubSpot, export, or explicitly retire them and attach post-final-snapshot cutover evidence.",
	}
}

func activeCampaignRuntimeTagsImported(report canonical.VerificationReport) int {
	if report.SubscriberTagsImported > 0 {
		return report.SubscriberTagsImported
	}
	for _, row := range report.ResourceCompleteness {
		if row.Resource == "groups" {
			if row.Imported < 0 {
				return 0
			}
			return row.Imported
		}
	}
	return 0
}

func sourceArchiveImported(report canonical.VerificationReport, resourceType string) int {
	if len(report.SourceArchiveByResource) == 0 {
		return 0
	}
	total := 0
	for key, value := range report.SourceArchiveByResource {
		if key == resourceType || (len(resourceType) > 0 && resourceType[len(resourceType)-1] == '_' && len(key) >= len(resourceType) && key[:len(resourceType)] == resourceType) {
			total += value
		}
	}
	return total
}
