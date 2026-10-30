// SPDX-License-Identifier: AGPL-3.0-only

// blocked.go -- the launch gates no engineer can close.
//
// Every check here watches something real and every one of them would be RED
// today, not because anything is broken but because an account has not been
// opened, a quota has not been granted, or a lawyer has not been engaged.
//
// Before StatusBlocked existed the only options were to leave these unwritten
// (invisible: the surface reads as healthy because nothing is looking) or to
// write them as ordinary checks (permanently red: investigated once, snoozed,
// and then the whole fire lane learns to be ignored). Neither is the truth.
// Blocked is: it names the obstacle, names who can clear it, sits in its own
// lane, and -- importantly -- does NOT count toward coverage, so the board
// keeps admitting the surface is unwatched.
//
// UNBLOCKING IS A PULL REQUEST. Delete the Blocked field and the probe below
// starts running on the next deploy. There is deliberately no "mark unblocked"
// button: that is a mute button with extra steps, and mute buttons are how
// boards die.
//
// WHAT THE PROBES ACTUALLY VERIFY. Each probe checks that the CONFIGURATION
// which can only exist once the blocker is cleared is present and well-formed.
// That is a real signal and it is not the same as the vendor having confirmed
// anything, so every detail line says which of the two it is checking.
package checks

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

func configuredProbe(what string, keys ...string) ops.ProbeFunc {
	return func(context.Context, *ops.Env) (ops.Status, string, error) {
		var missing []string
		for _, k := range keys {
			if strings.TrimSpace(os.Getenv(k)) == "" {
				missing = append(missing, k)
			}
		}
		if len(missing) > 0 {
			return ops.StatusRed, fmt.Sprintf("%s: %s not set", what, strings.Join(missing, ", ")), nil
		}
		return ops.StatusOK, fmt.Sprintf("%s: configuration present (does not itself prove the vendor side is live)", what), nil
	}
}

func init() {
	for _, c := range []ops.Check{
		{
			ID: "sending.ses-production-access", Group: "Vendors",
			Domain: "sending", Owner: "platform",
			Title:    "SES production sending access",
			Severity: ops.SevCritical,
			Why: "In the sandbox, SES accepts mail addressed only to verified identities and silently refuses everything else. " +
				"That is indistinguishable from working right up to the first real customer send.",
			Kind: ops.KindEvaluated, Interval: 6 * time.Hour,
			Probe: configuredProbe("SES region and identity", "AWS_REGION", "POSTWAVE_DEFAULT_FROM_EMAIL"),
			Remediation: "Production access is granted per region. It is already granted in eu-west-1 and was DENIED in eu-north-1, so this is a region decision as much as a support ticket: " +
				"either re-apply for eu-north-1 with concrete volume and bounce-handling detail, or move sending to eu-west-1.",
			Blocked: &ops.BlockedMeta{
				Reason: "SES production access denied in eu-north-1; only eu-west-1 is approved",
				Owner:  "founder",
			},
		},
		{
			ID: "billing.dodo-live-configuration", Group: "Vendors",
			Domain: "billing", Owner: "founder",
			Title:    "Dodo Payments live keys and products",
			Severity: ops.SevCritical,
			Why:      "Without the live API key, product IDs and webhook signing key, checkout either does not run or runs in test mode -- taking no money while looking like it did.",
			Kind:     ops.KindEvaluated, Interval: time.Hour,
			Probe: configuredProbe("Dodo Payments live configuration",
				"DODO_PAYMENTS_API_KEY", "DODO_PAYMENTS_WEBHOOK_KEY",
				"DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY", "DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY", "DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY"),
			Remediation: "Finish Dodo Payments live-mode verification, create three approved products, and configure the signed webhook endpoint. " +
				"The full production readiness report also requires BILLING_PROVIDER=dodo, live_mode, pdt_ product identifiers, distinctness, and an approved launch record.",
			Blocked: &ops.BlockedMeta{
				Reason: "Dodo Payments live credentials, approved product IDs, and rehearsal evidence are external inputs",
				Owner:  "founder",
			},
		},
		{
			ID: "inbox-placement.seed-mailboxes", Group: "Vendors",
			Domain: "inbox-placement", Owner: "platform",
			Title:    "Inbox-placement seed mailboxes",
			Severity: ops.SevHigh,
			Why: "Delivered is not the same as seen. Without seed mailboxes across the major providers there is no measurement that can distinguish a healthy send from one landing entirely in spam -- " +
				"and the delivery metrics look identical either way.",
			Kind: ops.KindEvaluated, Interval: 6 * time.Hour,
			Probe: configuredProbe("seed registry", "POSTWAVE_SEED_REGISTRY_URL"),
			Remediation: "Roughly 30 mailboxes across Gmail, Outlook, Yahoo and the major regional providers, either built (~4 weeks) or bought from a placement vendor. " +
				"Production refuses to boot with zero seeds configured, which is deliberate.",
			Blocked: &ops.BlockedMeta{
				Reason: "seed mailboxes not procured (~30 needed across major providers)",
				Owner:  "platform",
			},
		},
		{
			ID: "compliance.art27-representative", Group: "Legal",
			Domain: "compliance", Owner: "legal",
			Title:    "GDPR Art. 27 representative",
			Severity: ops.SevCritical,
			Why: "A non-EU controller offering services to EU data subjects must appoint a representative in the Union and publish their identity. " +
				"The privacy page currently says truthfully that we have not, which is the right posture and is also a hard blocker for EU general availability.",
			Kind: ops.KindEvaluated, Interval: 24 * time.Hour,
			Probe: configuredProbe("Art. 27 representative", "POSTWAVE_EU_REPRESENTATIVE"),
			Remediation: "Engage counsel, appoint an EU (and separately a UK) representative, publish their identity on the privacy page, and update register row GDPR-18. " +
				"Until then EU public signups stay behind the beta gate.",
			Blocked: &ops.BlockedMeta{
				Reason: "no Art. 27 representative appointed (register row GDPR-18, status external)",
				Owner:  "founder/counsel",
			},
		},
		{
			ID: "compliance.counsel-review", Group: "Legal",
			Domain: "compliance", Owner: "legal",
			Title:    "Counsel review of Terms, Privacy and DPA",
			Severity: ops.SevHigh,
			Why:      "The public legal documents are currently marked self_reviewed_no_counsel. They are the contract every customer accepts, and a self-reviewed contract is an untested one.",
			Kind:     ops.KindEvaluated, Interval: 24 * time.Hour,
			Probe:       configuredProbe("counsel review record", "POSTWAVE_LEGAL_COUNSEL_REVIEW"),
			Remediation: "Have counsel review Terms, Privacy and the DPA, then record the review reference so the legal-facts source stops reporting self_reviewed_no_counsel.",
			Blocked: &ops.BlockedMeta{
				Reason: "legal counsel not engaged; documents are self-reviewed",
				Owner:  "founder/counsel",
			},
		},
		{
			ID: "sending.sms-a2p-registration", Group: "Vendors",
			Domain: "sending", Owner: "platform",
			Title:    "SMS A2P / 10DLC registration",
			Severity: ops.SevHigh,
			Why: "Unregistered A2P traffic in the US is filtered by the carriers rather than rejected by the API. Messages report as sent and are never delivered, " +
				"which is the worst failure shape available: confident success, no arrival, no error.",
			Kind: ops.KindEvaluated, Interval: 12 * time.Hour,
			Probe:       configuredProbe("A2P brand and campaign", "POSTWAVE_SMS_A2P_BRAND_ID", "POSTWAVE_SMS_A2P_CAMPAIGN_ID"),
			Remediation: "Register the brand and campaign with the carrier aggregator, wait out the vetting period, then set the brand and campaign IDs.",
			Blocked: &ops.BlockedMeta{
				Reason: "A2P/10DLC brand and campaign not registered",
				Owner:  "platform",
			},
		},
	} {
		ops.Register(c)
	}
}
