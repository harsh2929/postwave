package campaigns

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/unsubscribetoken"
)

// EmailComplianceReport is returned as the response body for blocked sends.
// The shape is intentionally UI-friendly: clients can render blockers as a
// checklist in the send dialog without parsing prose.
type EmailComplianceReport struct {
	Ready    bool     `json:"ready"`
	Blockers []string `json:"blockers"`
	Warnings []string `json:"warnings,omitempty"`
}

func (r *Repo) CheckEmailCompliance(ctx context.Context, tenantID string, c *Campaign) (*EmailComplianceReport, error) {
	report := &EmailComplianceReport{Ready: true}
	if strings.TrimSpace(tenantID) == "" {
		return nil, errors.New("compliance: tenant id required")
	}
	if c == nil {
		return nil, errors.New("compliance: campaign required")
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		legalName       string
		line1           string
		city            string
		country         string
		contactEmail    string
		listUnsub       bool
		oneClickUnsub   bool
		verifiedProfile bool
		// verifiedLive is COALESCE(EXISTS verified sending_identities,
		// FALSE). When TRUE, at least one row in sending_identities for
		// this tenant has verify_state='verified', which is the live
		// DNS-driven state (DKIM + SPF + DMARC all observed). The
		// compliance gate uses (verifiedProfile OR verifiedLive) so
		// any verified DKIM/SPF/DMARC identity satisfies the check
		// even when the migration 0234 trigger hasn't run on a fresh
		// row yet. Migration 0234 keeps verifiedProfile in sync, but
		// reading the live table here closes the regression-window:
		// if DNS breaks AND the trigger hasn't fired, we still block.
		verifiedLive bool
	)
	err = tx.QueryRow(ctx, `
SELECT p.legal_sender_name, p.physical_address_line1, p.physical_address_city,
       p.physical_address_country, COALESCE(p.compliance_contact_email::text, ''),
       p.list_unsubscribe_enabled, p.one_click_unsubscribe_enabled,
       p.verified_sender_domain,
       COALESCE((
         SELECT TRUE FROM sending_identities si
          WHERE si.tenant_id = p.tenant_id
            AND si.verify_state = 'verified'
          LIMIT 1
       ), FALSE) AS verified_live
FROM email_compliance_profiles p
WHERE p.tenant_id = $1::uuid`, tenantID).Scan(
		&legalName,
		&line1,
		&city,
		&country,
		&contactEmail,
		&listUnsub,
		&oneClickUnsub,
		&verifiedProfile,
		&verifiedLive,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			report.addBlocker("Configure Settings -> Sender Identity with legal sender name, physical postal address, compliance contact, and unsubscribe controls before sending.")
			return report, tx.Commit(ctx)
		}
		return nil, fmt.Errorf("compliance: load email profile: %w", err)
	}
	if strings.TrimSpace(legalName) == "" {
		report.addBlocker("Legal sender name is required.")
	}
	if strings.TrimSpace(line1) == "" || strings.TrimSpace(city) == "" || strings.TrimSpace(country) == "" {
		report.addBlocker("A physical postal address with line 1, city, and country is required.")
	}
	if strings.TrimSpace(contactEmail) == "" {
		report.addBlocker("Compliance contact email is required.")
	}
	if !listUnsub {
		report.addBlocker("List-Unsubscribe must remain enabled for commercial sending.")
	}
	if !oneClickUnsub {
		report.addBlocker("One-click unsubscribe must remain enabled for commercial sending.")
	}
	// Both the cached flag AND the live DNS state must agree the
	// tenant has at least one verified sending identity. The trigger
	// added in migration 0234 keeps these in sync, so a divergence
	// here means either (a) the trigger hasn't yet run on a fresh
	// insert, or (b) someone hand-edited the profile column. In
	// either case, refuse to send until the operator runs the
	// verify wizard.
	if !verifiedProfile || !verifiedLive {
		report.addBlocker("A verified sender domain is required before production sending. Run the DKIM/SPF/DMARC wizard until verify_state=verified.")
	}
	if !bodyHasUnsubscribe(c.BodyHTML) {
		report.addBlocker("The email body needs an unsubscribe link that uses {{ unsubscribe_url }}, so each recipient gets a link that unsubscribes them. A fixed link cannot.")
	}
	from := strings.TrimSpace(c.FromEmail())
	if from == "" {
		report.addBlocker("Campaign requires a from email or tenant default sender.")
	} else if verifiedLive {
		// Tightened verified-sender gate: the From-address domain must
		// match a sending_identities row in verify_state='verified' for
		// THIS tenant. Without this check, any verified identity in
		// the tenant satisfies the gate — a tenant with a verified
		// transactional domain could quietly send marketing from an
		// unverified address and DMARC would fail downstream. We only
		// enforce the domain match when at least one verified identity
		// exists; the verifiedLive check above already blocks the
		// "no identity at all" case, so this branch never produces a
		// duplicate blocker.
		fromDomain := emailDomain(from)
		if fromDomain == "" {
			report.addBlocker("Campaign From address is malformed; cannot resolve sending domain.")
		} else {
			var domainMatches bool
			if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM sending_identities
     WHERE tenant_id = $1::uuid
       AND verify_state = 'verified'
       AND lower(domain) = $2
)`, tenantID, fromDomain).Scan(&domainMatches); err != nil {
				return nil, fmt.Errorf("compliance: verify from domain: %w", err)
			}
			if !domainMatches {
				report.addBlocker(fmt.Sprintf(
					"Campaign From domain %q has no verified sending identity. Add and verify %q via the DKIM/SPF/DMARC wizard before sending.",
					fromDomain, fromDomain))
			}
		}
	}

	// Spam-complaint ceiling. This is the gate the mailbox providers actually
	// enforce: Gmail and Outlook reject non-compliant bulk mail at the SMTP
	// level (Outlook returns 550 5.7.515) rather than spam-foldering it, so a
	// tenant drifting over the line has to be stopped here — not warned about
	// on a dashboard nobody is watching.
	days, err := loadComplaintWindow(ctx, tx, tenantID)
	if err != nil {
		return nil, fmt.Errorf("compliance: load complaint window: %w", err)
	}
	applyComplaintPolicy(report, days)

	return report, tx.Commit(ctx)
}

// Spam-complaint policy, per the Google sender guidelines
// (support.google.com/a/answer/81126) and Microsoft's high-volume-sender
// rules. Yahoo publishes the same 0.30% ceiling.
//
//	0.30% is the hard requirement. Breaching it makes a sender ineligible
//	      for mitigation until spam rates stay below 0.30% for 7
//	      consecutive days.
//	0.10% is where measurable inbox-placement harm actually begins, and is
//	      therefore where a platform should act rather than where it should
//	      wait.
//
// Expressed as complaints-per-send ratios (0.003 == 0.30%).
const (
	complaintBlockNum = 3    // 3/1000 == 0.30%
	complaintWarnNum  = 1    // 1/1000 == 0.10%
	complaintRateDen  = 1000 // shared denominator

	// complaintMinDailySends is a noise floor. Below it a single unhappy
	// recipient dominates the ratio (1/50 == 2%), which would gate a small
	// or newly-warming tenant on nothing. Mirrors the intent of
	// sending.warmup_engagement's MinSampleSize.
	complaintMinDailySends = 500

	// Display forms of the two thresholds, for operator-facing copy.
	complaintCeilingPct = 0.30
	complaintHarmPct    = 0.10
)

// ComplaintDay is one day's send/complaint tally inside the trailing
// complaint window.
type ComplaintDay struct {
	Sends      int64
	Complaints int64
}

// evaluateComplaintWindow decides whether a tenant's recent spam-complaint
// history should block or merely warn on the next send.
//
// The 7-consecutive-clean-days unblock rule is implemented implicitly: we
// block when ANY day in the trailing window breached the ceiling, so once a
// bad day ages out of the window and the remaining days are clean, sending
// resumes on its own. No suspension table and no un-suspend job.
//
// Ratios are compared with integer cross-multiplication rather than floating
// point: this is a gate, and 15/5000 must compare equal to 0.30% exactly.
func evaluateComplaintWindow(days []ComplaintDay) (block bool, warn bool, worstDailyRate float64) {
	var totalSends, totalComplaints int64
	for _, d := range days {
		if d.Sends < complaintMinDailySends {
			continue // below the noise floor: not enough signal to act on
		}
		totalSends += d.Sends
		totalComplaints += d.Complaints

		if d.Complaints*complaintRateDen >= d.Sends*complaintBlockNum {
			block = true
		}
		if rate := float64(d.Complaints) / float64(d.Sends); rate > worstDailyRate {
			worstDailyRate = rate
		}
	}

	// Blocking always warns — the operator needs the number, not just the
	// refusal. Otherwise warn on the window aggregate crossing the harm line.
	warn = block ||
		(totalSends > 0 && totalComplaints*complaintRateDen >= totalSends*complaintWarnNum)

	return block, warn, worstDailyRate
}

// applyComplaintPolicy folds the trailing complaint window into the report.
// Blocking is a hard stop: Gmail and Outlook reject at the SMTP level rather
// than spam-foldering, so continuing to send past the ceiling actively burns
// the tenant's sending domain.
func applyComplaintPolicy(report *EmailComplianceReport, days []ComplaintDay) {
	block, warn, worst := evaluateComplaintWindow(days)
	switch {
	case block:
		report.addBlocker(fmt.Sprintf(
			"Spam-complaint rate reached %.2f%% in the last 7 days, at or above the %.2f%% ceiling enforced by Gmail, Yahoo and Outlook. "+
				"Sending is blocked until the rate stays below %.2f%% for 7 consecutive days. Prune unengaged subscribers and review recent acquisition sources.",
			worst*100, complaintCeilingPct, complaintCeilingPct))
	case warn:
		report.addWarning(fmt.Sprintf(
			"Spam-complaint rate is %.2f%%, above the %.2f%% line where inbox placement starts to degrade. "+
				"Stay below it: at %.2f%% sending is blocked.",
			worst*100, complaintHarmPct, complaintCeilingPct))
	}
}

// loadComplaintWindow returns one entry per day (last 7) that actually sent
// mail, with that day's complaint count.
//
// The denominator is campaign_recipients.sent_at — our own send ledger —
// deliberately NOT subscriber_events. subscriber_events has no 'sent'
// event_type (see the CHECK constraint in migration 0326), so counting sends
// from it yields a permanently-zero denominator.
func loadComplaintWindow(ctx context.Context, tx pgx.Tx, tenantID string) ([]ComplaintDay, error) {
	rows, err := tx.Query(ctx, `
SELECT COALESCE(s.sends, 0)::bigint, COALESCE(c.complaints, 0)::bigint
  FROM (
    SELECT date_trunc('day', sent_at) AS day, COUNT(*) AS sends
      FROM campaign_recipients
     WHERE tenant_id = $1::uuid
       AND status = 'sent'
       AND sent_at >= date_trunc('day', now()) - INTERVAL '6 days'
     GROUP BY 1
  ) s
  LEFT JOIN (
    SELECT date_trunc('day', at) AS day, COUNT(*) AS complaints
      FROM subscriber_events
     WHERE tenant_id = $1::uuid
       AND event_type = 'complained'
       AND at >= date_trunc('day', now()) - INTERVAL '6 days'
     GROUP BY 1
  ) c ON c.day = s.day`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var days []ComplaintDay
	for rows.Next() {
		var d ComplaintDay
		if err := rows.Scan(&d.Sends, &d.Complaints); err != nil {
			return nil, err
		}
		days = append(days, d)
	}
	return days, rows.Err()
}

// emailDomain pulls the lowercased domain out of an RFC-5322 address.
// Returns "" if the address is malformed or carries no @ sign so the
// caller can flag the campaign as un-sendable without panicking on
// nil/empty.
func emailDomain(addr string) string {
	at := strings.LastIndex(addr, "@")
	if at <= 0 || at == len(addr)-1 {
		return ""
	}
	domain := strings.TrimSpace(addr[at+1:])
	// Allow display-name addresses ("Name <user@example.com>").
	if idx := strings.IndexByte(domain, '>'); idx > 0 {
		domain = domain[:idx]
	}
	return strings.ToLower(domain)
}

func (r *EmailComplianceReport) addBlocker(msg string) {
	r.Ready = false
	r.Blockers = append(r.Blockers, msg)
}

// addWarning surfaces a problem without refusing the send.
func (r *EmailComplianceReport) addWarning(msg string) {
	r.Warnings = append(r.Warnings, msg)
}

// bodyHasUnsubscribe reports whether a body carries the placeholder the send
// loop replaces with each recipient's own preference-centre URL. It is the
// only way a campaign body can offer a working unsubscribe: nothing appends a
// footer at send time, and a fixed link (to a static /preferences/ page, or to
// any other host) cannot identify the person who clicks it. Matching the word
// "unsubscribe" let drafts made from templates pass the gate while their only
// unsubscribe link pointed at a domain the sender does not control.
func bodyHasUnsubscribe(html string) bool {
	return unsubscribetoken.Contains(html)
}
