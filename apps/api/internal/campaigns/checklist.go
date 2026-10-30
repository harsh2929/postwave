package campaigns

// checklist.go — Workstream 2 (C): Mailchimp-style pre-send checklist.
// Runs every check at compose time so the operator sees pass/warn/fail
// pills next to each gate before they hit Send. The check set:
//
//   from_address_verified         — campaign has a from address AND the
//                                   tenant has a verified sender domain
//   subject_set                   — subject is not blank
//   body_non_empty                — body_html OR plain_text has content
//   list_selected                 — names the audience: one list, one
//                                   segment, or (warn) the whole workspace
//   recipient_count_above_zero    — the resolved audience has > 0 eligible
//                                   recipients
//   unsubscribe_link_present      — body contains an unsub token
//
// No new migration: this derives entirely from existing state on the
// campaign row, the email_compliance_profiles table, and (when wired)
// the AudienceCounter dep.

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AudienceCounter resolves an audience-typed id (list or segment) to
// the number of subscribers a campaign would reach. Implementations
// live in the lists/ and segments/ repos; an adapter in main.go fans
// out to whichever matches the campaign's audience type.
//
// Returning int64 (not int) so very-large lists round-trip without
// truncation on 32-bit GOOS targets; callers stringify or compare to
// 0 — they don't need 64 bits of arithmetic.
//
// Returning an error means the population cannot be proven (including an
// unknown id or evaluator failure). The checklist fails closed in that case.
// A known, successfully evaluated empty audience is count=0, err=nil.
type AudienceCounter interface {
	CountListAudience(ctx context.Context, tenantID, listID string) (int64, error)
	CountSegmentAudience(ctx context.Context, tenantID, segmentID string) (int64, error)
}

// ChecklistStatus is the pass/warn/fail outcome of a single check.
// Renders as a coloured pill in the UI; "warn" is non-blocking and
// surfaces hand-wavy gates like a missing audience estimate.
type ChecklistStatus string

const (
	CheckPass ChecklistStatus = "pass"
	CheckWarn ChecklistStatus = "warn"
	CheckFail ChecklistStatus = "fail"
)

// CheckItem is one row in the checklist response.
type CheckItem struct {
	Key    string          `json:"key"`
	Label  string          `json:"label"`
	Status ChecklistStatus `json:"status"`
	Detail string          `json:"detail"`
}

// ChecklistResponse is returned by GET /api/v1/campaigns/{id}/checklist.
// Ready is true when no check has status="fail" — handy for a Send
// button enable / disable without re-scanning the array.
type ChecklistResponse struct {
	CampaignID string      `json:"campaign_id"`
	Ready      bool        `json:"ready"`
	Checks     []CheckItem `json:"checks"`
}

// MountChecklist wires the pre-send check endpoint.
func MountChecklist(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/campaigns/{id}/checklist", d.GetChecklist)
}

func (d *Deps) GetChecklist(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	c, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resp := d.Repo.BuildChecklist(r.Context(), t.ID, c)
	resp.CampaignID = id
	writeJSON(w, http.StatusOK, resp)
}

// BuildChecklist runs every gate against the campaign row and returns
// the ordered list of CheckItem results. Cheap — one extra DB read for
// the tenant's verified-sender-domain flag, plus (when wired) one
// COUNT(*) through the AudienceCounter for the "recipients > 0" gate.
// Exposed on Repo so tests can drive it without an HTTP round-trip.
//
// The audience counter is read from r.AudienceCounter (nil falls back
// to the legacy TrackingSettings hint so dev wiring without a counter
// still renders sensibly).
func (r *Repo) BuildChecklist(ctx context.Context, tenantID string, c *Campaign) ChecklistResponse {
	checks := make([]CheckItem, 0, 6)
	checks = append(checks, r.checkFromAddress(ctx, tenantID, c))
	checks = append(checks, checkSubject(c))
	checks = append(checks, checkBody(c))
	checks = append(checks, r.checkList(ctx, tenantID, c))
	checks = append(checks, r.checkRecipients(ctx, tenantID, c))
	checks = append(checks, checkUnsubscribe(c))

	ready := true
	for _, ck := range checks {
		if ck.Status == CheckFail {
			ready = false
			break
		}
	}
	return ChecklistResponse{Ready: ready, Checks: checks}
}

func (r *Repo) checkFromAddress(ctx context.Context, tenantID string, c *Campaign) CheckItem {
	from := strings.TrimSpace(c.FromEmail())
	if from == "" {
		return CheckItem{
			Key:    "from_address_verified",
			Label:  "From address verified",
			Status: CheckFail,
			Detail: "Set a from address on the campaign or the tenant default sender.",
		}
	}
	verified, err := r.lookupVerifiedSenderDomain(ctx, tenantID)
	if err != nil {
		// DB error reading the compliance row is non-fatal for the
		// checklist UX — surface as a warn so the operator can still
		// see other failures.
		return CheckItem{
			Key:    "from_address_verified",
			Label:  "From address verified",
			Status: CheckWarn,
			Detail: "Couldn't verify sender domain (database read failed); check the Compliance settings.",
		}
	}
	if !verified {
		return CheckItem{
			Key:    "from_address_verified",
			Label:  "From address verified",
			Status: CheckFail,
			Detail: "Verify the sender domain in Settings → Compliance before sending.",
		}
	}
	return CheckItem{
		Key:    "from_address_verified",
		Label:  "From address verified",
		Status: CheckPass,
		Detail: "Sender domain is verified for " + from + ".",
	}
}

func checkSubject(c *Campaign) CheckItem {
	if strings.TrimSpace(c.Subject) == "" {
		return CheckItem{
			Key:    "subject_set",
			Label:  "Subject line",
			Status: CheckFail,
			Detail: "Add a subject line — empty subjects drop straight to spam.",
		}
	}
	return CheckItem{
		Key:    "subject_set",
		Label:  "Subject line",
		Status: CheckPass,
		Detail: "Subject: " + c.Subject,
	}
}

func checkBody(c *Campaign) CheckItem {
	if strings.TrimSpace(c.BodyHTML) == "" && strings.TrimSpace(c.PlainText) == "" {
		return CheckItem{
			Key:    "body_non_empty",
			Label:  "Body has content",
			Status: CheckFail,
			Detail: "Body is empty — write some copy before sending.",
		}
	}
	return CheckItem{
		Key:    "body_non_empty",
		Label:  "Body has content",
		Status: CheckPass,
		Detail: "Body content is present.",
	}
}

// checkList names the audience the campaign is addressed to. A list or a
// segment passes; no audience is a deliberate whole-workspace send, which
// queue-fill and send-preview both honour, so it warns — confirm it was meant —
// rather than failing. Whether anyone eligible is in it is the next check's
// question.
func (r *Repo) checkList(ctx context.Context, tenantID string, c *Campaign) CheckItem {
	listID := strings.TrimSpace(c.AudienceListID())
	segmentID := strings.TrimSpace(c.SegmentID)
	if listID != "" && segmentID != "" {
		return CheckItem{
			Key:    "list_selected",
			Label:  "Audience selected",
			Status: CheckFail,
			Detail: mixedAudienceDetail,
		}
	}
	label := r.campaignAudienceLabel(ctx, tenantID, c)
	status := CheckPass
	if label.Kind == CampaignAudienceWorkspace {
		status = CheckWarn
	}
	return CheckItem{
		Key:    "list_selected",
		Label:  "Audience selected",
		Status: status,
		Detail: audienceSelectedDetail(label),
	}
}

// mixedAudienceDetail is the checklist sentence for a campaign naming both a
// list and a segment, which no surface can send.
const mixedAudienceDetail = "Choose either one list or one segment — a campaign can't send to both."

// checkRecipients gates "this campaign would actually reach somebody".
// Resolution order:
//
//  1. Both a list and a segment -> fail before counting anything; no
//     surface can send a mixed audience.
//  2. A database pool (production) -> resolve the audience exactly as
//     queue-fill and send-preview do, including the no-list/no-segment
//     whole-workspace audience. count > 0 passes, count == 0 fails (the
//     gate's whole point), and resolution errors fail closed because
//     recipient eligibility was not verified.
//  3. AudienceCounter without a pool (isolated test seam) -> count the
//     list or segment the same way; it cannot count a workspace.
//  4. Neither (legacy / dev wiring) -> fall back to the TrackingSettings
//     hint populated by the prior send path. Hint missing folds to a warn.
//
// The only warn paths are wiring that cannot count; runtime evaluator
// failures are never represented as a zero or a best-effort warning.
func (r *Repo) checkRecipients(ctx context.Context, tenantID string, c *Campaign) CheckItem {
	listID := strings.TrimSpace(c.AudienceListID())
	segID := strings.TrimSpace(c.SegmentID)
	if listID != "" && segID != "" {
		return CheckItem{
			Key:    "recipient_count_above_zero",
			Label:  "Recipients > 0",
			Status: CheckFail,
			Detail: mixedAudienceDetail,
		}
	}
	// Production wiring has a Pool and therefore uses the exact same resolved
	// email set as queue-fill/send-preview. Keep AudienceCounter below only as
	// the isolated legacy/test seam for repositories without a database pool.
	if r != nil && r.Pool != nil {
		resolved, err := r.ResolveCampaignAudience(ctx, tenantID, c)
		if err != nil {
			return CheckItem{
				Key:    "recipient_count_above_zero",
				Label:  "Recipients > 0",
				Status: CheckFail,
				Detail: recipientResolutionDetail(ctx, tenantID, c, err),
			}
		}
		if len(resolved.Emails) == 0 {
			return CheckItem{
				Key:    "recipient_count_above_zero",
				Label:  "Recipients > 0",
				Status: CheckFail,
				Detail: "Audience has zero eligible subscribers",
			}
		}
		return CheckItem{
			Key:    "recipient_count_above_zero",
			Label:  "Recipients > 0",
			Status: CheckPass,
			Detail: itoa(len(resolved.Emails)) + " eligible recipients",
		}
	}
	if r != nil && r.AudienceCounter != nil && (listID != "" || segID != "") {
		var (
			count int64
			err   error
		)
		if listID != "" {
			count, err = r.AudienceCounter.CountListAudience(ctx, tenantID, listID)
		} else {
			count, err = r.AudienceCounter.CountSegmentAudience(ctx, tenantID, segID)
		}
		if err != nil {
			return CheckItem{
				Key:    "recipient_count_above_zero",
				Label:  "Recipients > 0",
				Status: CheckFail,
				Detail: recipientResolutionDetail(ctx, tenantID, c, err),
			}
		}
		if count == 0 {
			return CheckItem{
				Key:    "recipient_count_above_zero",
				Label:  "Recipients > 0",
				Status: CheckFail,
				Detail: "Audience has zero subscribers",
			}
		}
		return CheckItem{
			Key:    "recipient_count_above_zero",
			Label:  "Recipients > 0",
			Status: CheckPass,
			Detail: itoa(int(count)) + " recipients",
		}
	}
	// Legacy fallback when no counter is wired (dev / older test rigs).
	count, ok := recipientCountHint(c)
	if !ok {
		return CheckItem{
			Key:    "recipient_count_above_zero",
			Label:  "Recipients > 0",
			Status: CheckWarn,
			Detail: "Recipient count can't be estimated until queue-fill.",
		}
	}
	if count <= 0 {
		return CheckItem{
			Key:    "recipient_count_above_zero",
			Label:  "Recipients > 0",
			Status: CheckFail,
			Detail: "Audience has zero subscribers",
		}
	}
	return CheckItem{
		Key:    "recipient_count_above_zero",
		Label:  "Recipients > 0",
		Status: CheckPass,
		Detail: "Estimated recipients: " + itoa(count),
	}
}

// recipientResolutionDetail is the checklist sentence for an audience that
// could not be resolved. Every client renders the detail verbatim, so it is
// written for the person reading it: the known cases say what to do, and any
// other failure — a database or evaluator error whose text names tables and
// SQL — is logged and reported only as "couldn't be verified".
func recipientResolutionDetail(ctx context.Context, tenantID string, c *Campaign, err error) string {
	switch {
	case errors.Is(err, ErrAudienceMixedSources):
		return mixedAudienceDetail
	case errors.Is(err, ErrAudienceListNotFound):
		return audienceListNotFoundMessage
	case errors.Is(err, ErrSegmentNotFound):
		return audienceSegmentNotFoundMessage
	case errors.Is(err, ErrFrozenAudienceNotFound):
		return frozenAudienceMissingMessage
	}
	slog.Default().WarnContext(ctx, "campaign checklist: recipient eligibility unavailable",
		"tenant_id", tenantID, "campaign_id", c.ID, "error", err)
	if strings.TrimSpace(c.SegmentID) != "" {
		// A segment that cannot be evaluated is almost always a definition
		// problem — a rule or a referenced segment that no longer compiles —
		// which retrying will not fix.
		return "This segment's recipients couldn't be worked out, so the campaign can't be sent yet. Open the segment to check its conditions."
	}
	return "Recipient eligibility couldn't be verified right now. Try again in a moment."
}

func checkUnsubscribe(c *Campaign) CheckItem {
	if !bodyHasUnsubscribe(c.BodyHTML) && !bodyHasUnsubscribe(c.PlainText) {
		return CheckItem{
			Key:    "unsubscribe_link_present",
			Label:  "Unsubscribe link present",
			Status: CheckFail,
			Detail: "Body must contain {{ unsubscribe_url }} or a 'manage preferences' link.",
		}
	}
	return CheckItem{
		Key:    "unsubscribe_link_present",
		Label:  "Unsubscribe link present",
		Status: CheckPass,
		Detail: "Unsubscribe token detected in body.",
	}
}

// recipientCountHint inspects the campaign's TrackingSettings + cached
// audience estimate (if any prior send populated it) to make a
// best-effort guess. Returns (count, true) when a count is available
// or (0, false) when no source supplied one — the latter folds into a
// "warn" outcome rather than a hard fail.
func recipientCountHint(c *Campaign) (int, bool) {
	if v, ok := c.TrackingSettings["recipient_count"]; ok {
		switch n := v.(type) {
		case float64:
			return int(n), true
		case int:
			return n, true
		case int64:
			return int(n), true
		}
	}
	if v, ok := c.DeliverySettings["recipient_count"]; ok {
		switch n := v.(type) {
		case float64:
			return int(n), true
		case int:
			return n, true
		case int64:
			return int(n), true
		}
	}
	return 0, false
}

// lookupVerifiedSenderDomain reads the tenant's compliance row. Returns
// (false, nil) when the compliance profile hasn't been configured yet —
// the absence of a row is treated as "not verified" rather than as an
// error so the checklist still renders.
func (r *Repo) lookupVerifiedSenderDomain(ctx context.Context, tenantID string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var verified bool
	err = tx.QueryRow(ctx, `
SELECT verified_sender_domain
  FROM email_compliance_profiles
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&verified)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, tx.Commit(ctx)
		}
		return false, err
	}
	return verified, tx.Commit(ctx)
}

func itoa(n int) string {
	// strconv.Itoa via the small-int fast path; defined inline so the
	// file doesn't grow another import for a single conversion.
	if n == 0 {
		return "0"
	}
	negative := n < 0
	if negative {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if negative {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
