package sms

import (
	"context"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const smsCreditValueMicros int64 = defaultEstimatedSegmentCostMicros

func (d *Deps) MMSReadiness(w http.ResponseWriter, r *http.Request) {
	if !smsMMSReadinessReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_mms_readiness_release_held", "end-to-end MMS readiness is unavailable until inbound media evidence and provider smoke receipts are durable"))
		return
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	senders, err := d.store().ListSenders(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	out := mmsReadinessForSenders(senders)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SMSCreditPreview(w http.ResponseWriter, r *http.Request) {
	if !smsFinancialLedgerReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_financial_ledger_release_held", "SMS credit preview is unavailable until segment estimates and the authoritative payment ledger share one contract"))
		return
	}
	var in SMSCreditPreviewInput
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	out := smsCreditPreview(in)
	if !smsFinancialLedgerReleaseReady {
		out.EntitlementStatus = "financial_ledger_release_held"
		out.Warnings = append(out.Warnings, "Segment estimate only; authoritative SMS balance and purchase ledger are unavailable.")
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) SMSCreditBalance(w http.ResponseWriter, r *http.Request) {
	if !smsFinancialLedgerReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_financial_ledger_release_held", "authoritative SMS balance and purchased-credit ledger are unavailable"))
		return
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	writeJSON(w, http.StatusOK, d.smsCreditBalance(r.Context(), tenant.ID, r.URL.Query().Get("plan")))
}

// SMSCreditUsage GET /api/v1/sms/credits/usage?days=N — per-day credit
// consumption over the last N days (default 30, max 365) (SMS-045).
func (d *Deps) SMSCreditUsage(w http.ResponseWriter, r *http.Request) {
	if !smsFinancialLedgerReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_financial_ledger_release_held", "authoritative SMS credit usage is unavailable until the financial ledger is deployed"))
		return
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	days := 30
	if raw := r.URL.Query().Get("days"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 365 {
			days = n
		}
	}
	end := time.Now().UTC().Truncate(24 * time.Hour).Add(24 * time.Hour)
	start := end.Add(-time.Duration(days) * 24 * time.Hour)
	series, err := d.Store.SMSCreditUsageSeries(r.Context(), tenant.ID, start, end)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": series, "days": days})
}

func (d *Deps) SMSCreditTopUpQuote(w http.ResponseWriter, r *http.Request) {
	if !smsFinancialLedgerReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_financial_ledger_release_held", "SMS top-up quoting is unavailable until the payment and credit ledgers are integrated"))
		return
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in SMSCreditTopUpInput
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d.smsCreditTopUpQuote(r.Context(), tenant.ID, in))
}

func (d *Deps) SMSCreditTopUpCheckout(w http.ResponseWriter, r *http.Request) {
	if !smsFinancialLedgerReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_financial_ledger_release_held", "SMS top-up checkout is unavailable until the payment and credit ledgers are integrated"))
		return
	}
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in SMSCreditTopUpInput
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	quote := d.smsCreditTopUpQuote(r.Context(), tenant.ID, in)
	writeJSON(w, http.StatusOK, SMSCreditTopUpCheckoutResponse{
		Status:      "requires_billing_checkout",
		CheckoutURL: "/api/v1/billing/checkout",
		Quote:       quote,
		Metadata: map[string]any{
			"tenant_id":           tenant.ID,
			"credit_product":      "sms_top_up",
			"billing_mode":        "stripe_checkout_or_manual_invoice",
			"apply_credits_after": "payment_success_or_admin_invoice_posting",
		},
	})
}

func (d *Deps) smsCreditTopUpQuote(ctx context.Context, tenantID string, in SMSCreditTopUpInput) SMSCreditTopUpQuoteResponse {
	credits := in.Credits
	if credits <= 0 {
		credits = 1000
	}
	if credits < 250 {
		credits = 250
	}
	if credits > 5_000_000 {
		credits = 5_000_000
	}
	bonus := smsTopUpBonusCredits(credits)
	total := credits + bonus
	balance := d.smsCreditBalance(ctx, tenantID, in.Plan)
	balance.PurchasedCredits += total
	balance.AvailableCredits += total
	out := SMSCreditTopUpQuoteResponse{
		Credits:            credits,
		UnitPriceMicros:    smsCreditValueMicros,
		SubtotalMicros:     int64(credits) * smsCreditValueMicros,
		BonusCredits:       bonus,
		TotalCredits:       total,
		CheckoutMode:       "quote_ready_requires_billing_checkout_or_invoice",
		EntitlementPreview: balance,
		LineItems: []SMSCreditLineItem{
			{Label: "Purchased SMS credits", Credits: 1, Count: credits, Total: credits},
		},
		Warnings: []string{"Quote only: credits are not added until payment/contract entitlement is recorded."},
	}
	if bonus > 0 {
		out.LineItems = append(out.LineItems, SMSCreditLineItem{Label: "Volume bonus credits", Credits: 1, Count: bonus, Total: bonus})
	}
	return out
}

func (d *Deps) SMSProgramRegions(w http.ResponseWriter, r *http.Request) {
	items := smsProgramRegions()
	for i := range items {
		if items[i].Country != "US" && items[i].Country != "CA" {
			continue
		}
		// supports_sms describes the carrier transport family only. Product
		// dispatch and end-to-end MMS evidence are separate release gates.
		items[i].Status = "release_held"
		items[i].SupportsMMS = false
		items[i].LiveSendingEnabled = false
		items[i].LaunchPhase = "release_held"
		items[i].RequiredSetup = append(items[i].RequiredSetup,
			"durable_dispatch_reconciliation", "authoritative_financial_ledger", "inbound_mms_evidence")
	}
	writeJSON(w, http.StatusOK, SMSProgramRegionsResponse{Items: items})
}

func (d *Deps) SMSTemplates(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, SMSTemplatesResponse{Items: smsTemplates()})
}

func (d *Deps) SMSDiscountCodes(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	limit := 20
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 100 {
		limit = 100
	}
	out, err := d.store().ListDiscountCodes(r.Context(), tenant.ID, r.URL.Query().Get("q"), limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	for i := range out {
		if out[i].Source == "" {
			out[i].Source = "postwave_discounts"
		}
		if out[i].SyncStatus == "" {
			out[i].SyncStatus = "synced_from_postwave"
		}
		if out[i].StoreProvider == "" {
			out[i].StoreProvider = "postwave"
		}
	}
	writeJSON(w, http.StatusOK, SMSDiscountCodesResponse{
		Items:      out,
		Sources:    []string{"postwave_discounts", "store_native_promos"},
		SyncStatus: "postwave_ready_store_native_partial",
		Capabilities: []string{
			"manual_code_insert",
			"postwave_discount_insert",
			"store_native_code_surface_when_synced",
		},
	})
}

func (d *Deps) smsCreditBalance(ctx context.Context, tenantID, plan string) SMSCreditBalanceResponse {
	start, end := smsBillingPeriod(time.Now().UTC())
	plan = strings.ToLower(strings.TrimSpace(plan))
	if plan == "" {
		plan = "starter"
	}
	included := smsIncludedCredits(plan)
	used, err := d.store().SMSCreditsUsed(ctx, tenantID, start, end)
	warnings := []string{}
	ledgerMode := "message_cost_ledger"
	if err != nil {
		warnings = append(warnings, "Credit usage ledger unavailable; showing entitlement defaults until SMS migrations are applied: "+err.Error())
		ledgerMode = "entitlement_defaults"
	}
	available := included - used
	if available < 0 {
		available = 0
	}
	return SMSCreditBalanceResponse{
		TenantID:         tenantID,
		Plan:             plan,
		IncludedCredits:  included,
		PurchasedCredits: 0,
		UsedCredits:      used,
		AvailableCredits: available,
		PeriodStart:      start,
		PeriodEnd:        end,
		LedgerMode:       ledgerMode,
		Warnings:         warnings,
		Entitlements: map[string]any{
			"supports_top_ups":       true,
			"purchase_flow":          "stripe_checkout_or_invoice",
			"overage_policy":         "block_or_require_top_up",
			"mms_debits_credit_pool": true,
			"included_plan_credits":  included,
		},
	}
}

func smsBillingPeriod(now time.Time) (time.Time, time.Time) {
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	return start, start.AddDate(0, 1, 0)
}

func smsIncludedCredits(plan string) int {
	switch strings.ToLower(strings.TrimSpace(plan)) {
	case "growth":
		return 10_000
	case "scale":
		return 50_000
	case "enterprise":
		return 250_000
	case "pilot":
		return 1_000
	default:
		return 2_500
	}
}

func smsTopUpBonusCredits(credits int) int {
	switch {
	case credits >= 100_000:
		return credits / 10
	case credits >= 25_000:
		return credits / 20
	default:
		return 0
	}
}

func mmsReadinessForSenders(senders []SenderProfile) MMSReadinessResponse {
	out := MMSReadinessResponse{
		SupportedCountries: []string{"US", "CA"},
		Providers:          smsMMSProviderSupport(),
		LiveSmokeRequired:  true,
		SmokeTestContract: map[string]any{
			"required_before_customer_cutover": true,
			"send_to":                          "customer-approved internal test handset",
			"assertions":                       []string{"provider accepted MMS", "carrier delivered media", "status callback received", "cost ledger updated"},
			"record_location":                  "sender metadata mms_smoke_last_passed_at",
		},
	}
	if len(senders) == 0 {
		out.Warnings = append(out.Warnings, "Create an approved US or Canada sender before sending MMS.")
		return out
	}
	for _, sender := range senders {
		item := MMSSenderReadiness{
			SenderID:           sender.ID,
			Provider:           sender.Provider,
			Country:            strings.ToUpper(sender.Country),
			SenderType:         sender.SenderType,
			RegistrationStatus: sender.RegistrationStatus,
			LiveSmokeRequired:  true,
			LiveSmokeStatus:    "required_before_cutover",
		}
		if raw, ok := sender.Metadata["mms_smoke_last_passed_at"]; ok {
			if ts, parsed := parseSmokeTimestamp(raw); parsed {
				item.LastSmokeAt = &ts
				item.LiveSmokeStatus = "passed"
				item.LiveSmokeRequired = false
			}
		}
		region := smsProgramRegion(item.Country)
		if region.Country == "" || region.Status != "active" || !region.SupportsMMS {
			item.Warnings = append(item.Warnings, "MMS is not active for this sender country.")
		}
		if !smsProviderSupportsMMS(sender.Provider) {
			item.Warnings = append(item.Warnings, "Configured provider does not support MMS media URLs in Moosewave.")
		}
		if sender.RegistrationStatus != RegistrationApproved {
			item.Warnings = append(item.Warnings, "Sender registration must be approved before live MMS sends.")
		}
		if SenderPaused(sender.Metadata) {
			item.Warnings = append(item.Warnings, "Sender is paused by the kill switch.")
		}
		if item.LiveSmokeRequired {
			item.Warnings = append(item.Warnings, "Run a live MMS carrier smoke test on this provider account before customer cutover.")
		}
		item.Ready = len(item.Warnings) == 0
		if item.Ready {
			out.Ready = true
		}
		out.Senders = append(out.Senders, item)
	}
	if !out.Ready {
		out.Warnings = append(out.Warnings, "No sender is currently MMS-ready.")
	}
	return out
}

func parseSmokeTimestamp(raw any) (time.Time, bool) {
	switch v := raw.(type) {
	case time.Time:
		return v, true
	case string:
		for _, layout := range []string{time.RFC3339, time.RFC3339Nano, "2006-01-02"} {
			if ts, err := time.Parse(layout, strings.TrimSpace(v)); err == nil {
				return ts.UTC(), true
			}
		}
	}
	return time.Time{}, false
}

func smsMMSProviderSupport() []MMSProviderSupport {
	return []MMSProviderSupport{
		{
			Provider:          ProviderTwilio,
			SupportsMMS:       true,
			SupportsMediaURL:  true,
			SmokeTestRequired: true,
			Detail:            "Twilio sends MMS by attaching MediaUrl to outbound messages.",
		},
		{
			Provider:          ProviderTelnyx,
			SupportsMMS:       true,
			SupportsMediaURL:  true,
			SmokeTestRequired: true,
			Detail:            "Telnyx sends MMS with type=MMS and media_urls.",
		},
		{
			Provider:          ProviderBandwidth,
			SupportsMMS:       true,
			SupportsMediaURL:  true,
			SmokeTestRequired: true,
			Detail:            "Bandwidth sends MMS with a media URL array.",
		},
	}
}

func smsProviderSupportsMMS(provider string) bool {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case ProviderTwilio, ProviderTelnyx, ProviderBandwidth:
		return true
	default:
		return false
	}
}

func smsCreditPreview(in SMSCreditPreviewInput) SMSCreditPreviewResponse {
	country := strings.ToUpper(strings.TrimSpace(in.Country))
	if country == "" {
		country = "US"
	}
	region := smsProgramRegion(country)
	if region.Country == "" {
		region = SMSProgramRegion{
			Country:           country,
			Label:             country,
			Status:            "unsupported",
			ComplianceSummary: "No SMS program is configured for this country.",
		}
	}
	recipients := in.RecipientCount
	if recipients <= 0 {
		recipients = 1
	}
	if recipients > 1_000_000 {
		recipients = 1_000_000
	}
	segments := SegmentCount(in.Body)
	if segments == 0 && strings.TrimSpace(in.MediaURL) != "" {
		segments = 1
	}
	mms := strings.TrimSpace(in.MediaURL) != ""
	perRecipient := region.SMSCredits * maxInt(1, segments)
	channel := "sms"
	warnings := []string{}
	if region.Status != "active" {
		warnings = append(warnings, "This country is not enabled for live Moosewave SMS sending yet.")
	}
	if mms {
		channel = "mms"
		if region.SupportsMMS && region.MMSCredits > 0 {
			perRecipient = region.MMSCredits
		} else {
			warnings = append(warnings, "MMS is not supported in this country; remove media before sending.")
		}
	}
	if perRecipient <= 0 {
		perRecipient = maxInt(1, segments)
	}
	totalCredits := perRecipient * recipients
	throughput := smsThroughputPerSecond(in.SenderType)
	duration := int(math.Ceil(float64(recipients) / throughput))
	if duration < 1 {
		duration = 1
	}
	return SMSCreditPreviewResponse{
		Channel:                  channel,
		Country:                  region.Country,
		RegionStatus:             region.Status,
		MMS:                      mms,
		MMSSupported:             !mms || region.SupportsMMS,
		Segments:                 segments,
		RecipientCount:           recipients,
		PerRecipientCredits:      perRecipient,
		TotalCredits:             totalCredits,
		CreditValueMicros:        smsCreditValueMicros,
		EstimatedCostMicros:      int64(totalCredits) * smsCreditValueMicros,
		EstimatedDurationSeconds: duration,
		SendDurationLabel:        formatDurationLabel(duration),
		LineItems: []SMSCreditLineItem{
			{
				Label:   strings.ToUpper(channel) + " credits",
				Credits: perRecipient,
				Count:   recipients,
				Total:   totalCredits,
			},
		},
		Warnings: warnings,
	}
}

func smsThroughputPerSecond(senderType string) float64 {
	switch strings.ToLower(strings.TrimSpace(senderType)) {
	case "short_code":
		return 100
	case "toll_free":
		return 3
	default:
		return 1
	}
}

func formatDurationLabel(seconds int) string {
	switch {
	case seconds < 60:
		return strconv.Itoa(seconds) + " sec"
	case seconds < 3600:
		minutes := int(math.Ceil(float64(seconds) / 60))
		return strconv.Itoa(minutes) + " min"
	default:
		hours := int(math.Ceil(float64(seconds) / 3600))
		return strconv.Itoa(hours) + " hr"
	}
}

func smsProgramRegion(country string) SMSProgramRegion {
	country = strings.ToUpper(strings.TrimSpace(country))
	for _, region := range smsProgramRegions() {
		if region.Country == country {
			return region
		}
	}
	return SMSProgramRegion{}
}

func smsProgramRegions() []SMSProgramRegion {
	return []SMSProgramRegion{
		{
			Country:              "US",
			Label:                "United States",
			Status:               "active",
			SupportsSMS:          true,
			SupportsMMS:          true,
			SMSCredits:           1,
			MMSCredits:           3,
			DefaultSenderTypes:   []string{"10dlc", "toll_free", "short_code"},
			ComplianceSummary:    "A2P 10DLC, toll-free verification, opt-in proof, STOP/HELP handling, quiet hours, and consent gates required.",
			ProviderRequirements: []string{"Brand registration", "Campaign registration", "Approved sender", "Status callback"},
			LiveSendingEnabled:   true,
			LaunchPhase:          "live",
			RequiredSetup:        []string{"approved_sender", "opt_in_proof", "STOP_HELP_callbacks", "billing_credits"},
		},
		{
			Country:              "CA",
			Label:                "Canada",
			Status:               "active",
			SupportsSMS:          true,
			SupportsMMS:          true,
			SMSCredits:           3,
			MMSCredits:           5,
			DefaultSenderTypes:   []string{"toll_free", "10dlc", "short_code"},
			ComplianceSummary:    "Express consent, opt-out handling, sender approval, and quiet-hours controls required.",
			ProviderRequirements: []string{"Approved sender", "Consent proof", "Status callback"},
			LiveSendingEnabled:   true,
			LaunchPhase:          "live",
			RequiredSetup:        []string{"approved_sender", "express_consent", "STOP_HELP_callbacks", "billing_credits"},
		},
		{
			Country:            "GB",
			Label:              "United Kingdom",
			Status:             "planned",
			SupportsSMS:        true,
			SupportsMMS:        false,
			SMSCredits:         5,
			DefaultSenderTypes: []string{"long_code", "short_code", "alpha_sender"},
			ComplianceSummary:  "Program metadata only. Live sending remains disabled until UK sender and consent policy is configured.",
			LiveSendingEnabled: false,
			LaunchPhase:        "metadata_only",
			RequiredSetup:      []string{"provider_region_contract", "sender_registration", "country_consent_policy", "pricing_approval"},
		},
		{
			Country:            "AU",
			Label:              "Australia",
			Status:             "planned",
			SupportsSMS:        true,
			SupportsMMS:        false,
			SMSCredits:         4,
			DefaultSenderTypes: []string{"long_code", "short_code", "alpha_sender"},
			ComplianceSummary:  "Program metadata only. Live sending remains disabled until AU sender and consent policy is configured.",
			LiveSendingEnabled: false,
			LaunchPhase:        "metadata_only",
			RequiredSetup:      []string{"provider_region_contract", "sender_registration", "country_consent_policy", "pricing_approval"},
		},
		{
			Country:            "DE",
			Label:              "Germany",
			Status:             "planned",
			SupportsSMS:        true,
			SupportsMMS:        false,
			SMSCredits:         12,
			DefaultSenderTypes: []string{"long_code", "alpha_sender"},
			ComplianceSummary:  "Program metadata only. Live sending remains disabled until EU sender, consent, and privacy review are complete.",
			LiveSendingEnabled: false,
			LaunchPhase:        "metadata_only",
			RequiredSetup:      []string{"provider_region_contract", "sender_registration", "GDPR/ePrivacy review", "pricing_approval"},
		},
		{
			Country:            "FR",
			Label:              "France",
			Status:             "planned",
			SupportsSMS:        true,
			SupportsMMS:        false,
			SMSCredits:         7,
			DefaultSenderTypes: []string{"long_code", "alpha_sender"},
			ComplianceSummary:  "Program metadata only. Live sending remains disabled until EU sender, consent, and privacy review are complete.",
			LiveSendingEnabled: false,
			LaunchPhase:        "metadata_only",
			RequiredSetup:      []string{"provider_region_contract", "sender_registration", "GDPR/ePrivacy review", "pricing_approval"},
		},
	}
}

func smsTemplates() []SMSTemplate {
	return []SMSTemplate{
		{
			ID:           "limited_offer",
			Name:         "Limited offer",
			Category:     "promotion",
			Body:         "Your early access offer is live: {{discount_code}}. Shop now: {{link}} Reply STOP to opt out.",
			MediaAllowed: true,
			MergeFields:  []string{"discount_code", "link"},
			Tags:         []string{"discount", "launch", "mms"},
		},
		{
			ID:           "event_reminder",
			Name:         "Event reminder",
			Category:     "event",
			Body:         "Reminder: {{event_name}} starts {{time}}. Details: {{link}} Reply STOP to opt out.",
			MediaAllowed: false,
			MergeFields:  []string{"event_name", "time", "link"},
			Tags:         []string{"event", "reminder"},
		},
		{
			ID:           "winback",
			Name:         "Winback",
			Category:     "retention",
			Body:         "We saved something for you. Use {{discount_code}} before {{date}}: {{link}} Reply STOP to opt out.",
			MediaAllowed: true,
			MergeFields:  []string{"discount_code", "date", "link"},
			Tags:         []string{"winback", "discount"},
		},
		{
			ID:           "order_follow_up",
			Name:         "Order follow-up",
			Category:     "transactional_assist",
			Body:         "Thanks for your order. Need help or want recommendations? Reply here or visit {{link}}. Reply STOP to opt out.",
			MediaAllowed: false,
			MergeFields:  []string{"link"},
			Tags:         []string{"support", "post_purchase"},
		},
		{
			ID:           "back_in_stock",
			Name:         "Back in stock",
			Category:     "commerce",
			Body:         "{{product_name}} is back in stock. Get it here: {{link}} Reply STOP to opt out.",
			MediaAllowed: true,
			MergeFields:  []string{"product_name", "link"},
			Tags:         []string{"commerce", "inventory"},
		},
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
