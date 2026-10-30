package campaigns

// The lifecycle endpoint for scheduled_at.
//
// PATCH /api/v1/campaigns/{id} rejects any body carrying status or scheduled_at
// with "status and scheduled_at are controlled by campaign lifecycle endpoints".
// That separation is right — it is what keeps authoring writes from moving a
// campaign through its state machine, and it is the same boundary the content
// freeze depends on. But pause, resume, cancel, queue and send were the only
// lifecycle routes ever built. Nothing owned scheduled_at.
//
// So the desktop calendar's drag-to-reschedule — the one shipped write path on
// that surface — issued PATCH {scheduled_at} and took a 422 every single time,
// and the message sent the operator to a door that does not exist.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/packages/runtime/campaigndispatch"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/send_window"
)

// MountSchedule registers the scheduled_at lifecycle route. Mounted separately
// from MountSendDomain because scheduling requires only authoring authority —
// it moves a future send, it does not dispatch one. Requiring the send scope
// here would mean an editor who can write a campaign cannot place it on the
// calendar.
func MountSchedule(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/{id}/schedule", d.ScheduleCampaign)
}

// maxScheduleHorizonYears bounds how far ahead a send may be placed. Two years
// is well past any real campaign calendar and well short of the values a
// malformed date produces.
const maxScheduleHorizonYears = 2

type scheduleInput struct {
	// Pointer-to-pointer semantics via RawMessage: absent means "no schedule
	// field was sent" (rejected), explicit null means "unschedule", a timestamp
	// means "schedule or move to this instant". Without the distinction an
	// omitted field and an explicit null both arrive as the zero value, and
	// unscheduling becomes unexpressible.
	ScheduledAt json.RawMessage `json:"scheduled_at"`
}

// ScheduleCampaign POST /api/v1/campaigns/{id}/schedule
//
//	{"scheduled_at": "2026-09-01T09:00:00Z"}  → schedule or move
//	{"scheduled_at": null}                    → unschedule, back to draft
//
// Fails closed on the release lock before writing anything.
// campaigndispatch.SchedulingQualified is false, which stops Scheduler.Run from
// ever ticking (send.go). A campaign written as 'scheduled' today would sit at
// its send time forever — the operator reads "scheduled for Tuesday" and nothing
// fires, which is strictly worse than being told no.
//
// The route exists regardless of the lock. The missing lifecycle owner was a
// real gap: PATCH refused scheduled_at and named an endpoint that did not exist,
// so the caller was sent to a door with nothing behind it. Now the refusal is
// the honest reason, in the vocabulary already defined for this same lock — and
// when the lock lifts, no client changes.
//
// The lock is a compile-time constant, deliberately: per its own comment,
// "runtime environment flags express operator intent; they cannot qualify an
// unsafe implementation by themselves." So it is checked here rather than
// injected, and the logic below is a separate method that tests can exercise
// without introducing a runtime switch that could turn scheduling on in
// production.
func (d *Deps) ScheduleCampaign(w http.ResponseWriter, r *http.Request) {
	if !campaigndispatch.SchedulingQualified {
		writeSchedulingUnqualified(w)
		return
	}
	d.scheduleCampaign(w, r)
}

// writeSchedulingUnqualified emits the fixed strings for the release lock.
//
// Separate from the generic 5xx helpers on purpose: those correctly collapse
// unknown infrastructure detail to "internal_error", which would leave a client
// unable to tell "scheduling is not qualified yet" from "the database fell
// over". This is a documented, non-sensitive contract clients branch on — the
// same reasoning dispatchcontrol.WriteHTTPError records for its own 503.
func writeSchedulingUnqualified(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, errEnv(
		campaigndispatch.SchedulingUnqualifiedCode,
		campaigndispatch.SchedulingUnqualifiedMessage))
}

func (d *Deps) scheduleCampaign(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")

	// The send time is part of what an approver signed off on, and moving it is
	// an edit like any other. Refused while ANOTHER editor holds the lease —
	// two people placing the same campaign on different days is precisely the
	// collision the lease exists to stop, and rescheduling is the change most
	// likely to be made by someone who has not opened the editor.
	if err := d.AssertRequestEditable(r, t.ID, id); err != nil {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": map[string]any{"code": "edit_lease_held", "message": err.Error()},
		})
		return
	}

	var in scheduleInput
	if err := httpbody.DecodeJSON(w, r, campaignJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(in.ScheduledAt) == 0 {
		httperror.Write(w, http.StatusUnprocessableEntity, "missing_scheduled_at",
			"send scheduled_at: a timestamp to schedule, or null to unschedule")
		return
	}

	// The value being replaced, read BEFORE anything can refuse. A history that
	// records only the destination cannot answer "who moved it off Monday" — and
	// that was true of every refusal, which passed nil here while this read sat
	// after the window check. The refused rows are the ones the question is
	// usually about: three blocked attempts to move a send is a person fighting
	// a policy, and "they tried to move it to 3am" without "from Tuesday 9am" is
	// half the sentence.
	var priorAt *time.Time
	if prior, perr := d.Repo.Get(r.Context(), t.ID, id); perr == nil && prior != nil {
		priorAt = prior.ScheduledAt
	}

	var at *time.Time
	// Carried out of the block below so the response can tell the person their
	// send is outside the window even when the policy only warns. A warning
	// nobody sees is the same as no policy.
	windowWarning := ""
	if string(in.ScheduledAt) != "null" {
		var parsed time.Time
		if err := json.Unmarshal(in.ScheduledAt, &parsed); err != nil {
			httperror.Write(w, http.StatusUnprocessableEntity, "invalid_scheduled_at",
				"scheduled_at must be an RFC3339 timestamp or null")
			return
		}
		// A past instant means "fire on the next scheduler tick", which is never
		// what dropping a card on last Tuesday means. Refusing is also the only
		// way the operator learns the drag did not do what it looked like.
		if !parsed.After(time.Now()) {
			d.recordScheduleVersion(r, t.ID, id, priorAt, &parsed, "refused",
				"scheduled_at is in the past")
			httperror.Write(w, http.StatusUnprocessableEntity, "scheduled_at_in_past",
				"scheduled_at must be in the future")
			return
		}
		// The far future is the same class of mistake as the past, and arrives the
		// same way: a mis-parsed date, seconds read as milliseconds, a picker
		// defaulting to year 9999. Without a bound the campaign sits scheduled
		// forever and nobody finds out, which is the failure mode this whole route
		// is meant to stop producing.
		if parsed.After(time.Now().AddDate(maxScheduleHorizonYears, 0, 0)) {
			d.recordScheduleVersion(r, t.ID, id, priorAt, &parsed, "refused",
				"scheduled_at is beyond the two-year horizon")
			httperror.Write(w, http.StatusUnprocessableEntity, "scheduled_at_too_far",
				"scheduled_at must be within two years")
			return
		}
		at = &parsed

		// The tenant's send window. The policy has carried an `enforcement`
		// column accepting block|warn|off since it shipped and NOTHING outside
		// its own CRUD package ever read it — an operator could set "block",
		// see it saved and rendered back, and every send would ignore it. A
		// setting that reads as a guarantee and is decoration is worse than no
		// setting at all.
		//
		// A policy-store failure refuses rather than proceeding: a database
		// hiccup must not silently disable a control the operator set.
		decision, wErr := send_window.Evaluate(r.Context(), d.Repo.Pool, t.ID, parsed)
		if wErr != nil {
			httperror.WriteInternal(w, d.Logger, wErr, r.Context())
			return
		}
		if !decision.Allowed {
			d.recordScheduleVersion(r, t.ID, id, priorAt, at, "refused", decision.Reason)
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"error": map[string]any{
					"code":    "outside_send_window",
					"message": "that time is outside this workspace's sending window: " + decision.Reason,
					"reason":  decision.Reason,
				},
			})
			return
		}
		windowWarning = decision.Reason
	}

	update := UpdateInput{ScheduledAt: at}
	if at == nil {
		// Repo.Update treats a nil ScheduledAt as "don't touch", so unscheduling
		// needs its own instruction rather than the absence of one.
		update.ClearScheduledAt = true
	}
	// Same If-Match semantics as PATCH, including the wildcard refusal: a caller
	// that sends `If-Match: *` believes it sent a precondition, and silently
	// downgrading that to last-writer-wins is worse than rejecting a header shape
	// this resource does not support.
	if tok, present, wildcard := httpcache.ParseIfMatch(r); present {
		if wildcard {
			httpcache.WritePreconditionFailed(w)
			return
		}
		update.IfMatchToken = tok
	}

	c, err := d.Repo.Update(r.Context(), t.ID, id, update)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
		case errors.Is(err, ErrCampaignDispatching):
			// Recipients already hold a message; there is no future send left to
			// move. Same 409 vocabulary the content freeze uses, because it is
			// the same fact about the campaign.
			writeJSON(w, http.StatusConflict, errEnv("campaign_dispatching",
				"this campaign has started sending and can no longer be rescheduled"))
		case errors.Is(err, ErrNotSchedulable):
			writeJSON(w, http.StatusConflict, errEnv("campaign_not_schedulable",
				"only a draft or scheduled campaign can carry a send time; "+
					"duplicate this campaign to schedule a fresh send"))
		case errors.Is(err, ErrAudienceMixedSources):
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("ambiguous_audience", mixedAudienceDetail))
		case errors.Is(err, ErrSegmentNotFound):
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("segment_not_found", audienceSegmentNotFoundMessage))
		case errors.Is(err, ErrPreconditionFailed):
			httpcache.WritePreconditionFailed(w)
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}

	w.Header().Set("ETag", httpcache.ConcurrencyToken("campaign", c.ID, c.UpdatedAt))
	// campaign.scheduled, not a new campaign.rescheduled: the topic already
	// exists (packages/telemetry/src/events.ts CAMPAIGN_SCHEDULED) and mobile's
	// activity feed already renders it. A synonym would be a second name for one
	// event that no listener knows about.
	d.emit(t.ID, "campaign.scheduled", map[string]any{
		"id":           c.ID,
		"name":         c.Name,
		"status":       c.Status,
		"scheduled_at": c.ScheduledAt,
	})
	// Does this reschedule invalidate an approval?
	//
	// The send path ALREADY refuses a campaign whose approved fingerprint has
	// moved, and `ScheduledAt` is part of that fingerprint — so moving the time
	// after sign-off already breaks the approval. What it does not do is say so
	// NOW: today somebody drags a campaign, everything looks fine, and the send
	// is refused hours later by a rule they never saw.
	//
	// The value is arriving BEFORE the work, the same reasoning the editing
	// lease banner records: a refusal after somebody has rearranged a week's
	// schedule has already cost them the rearranging.
	//
	// It WARNS rather than refuses. Rescheduling an approved campaign is a
	// legitimate thing to do — the approval simply has to be sought again — and
	// blocking it would make an approval a lock on the calendar.
	approvalWarning := d.approvalInvalidatedBySchedule(r.Context(), t.ID, id)

	// Another campaign landing on the same audience within two hours.
	//
	// Nothing checked for this: a person scheduling from the calendar sees
	// their own campaign and not the one a colleague placed an hour earlier on
	// the same list, and the audience receives two emails in one inbox session
	// — the complaint that produces unsubscribes rather than a support ticket.
	collisionWarning := d.scheduleCollision(r.Context(), t.ID, id, at, c)
	// Who is this actually going to? Only asked when scheduling — a campaign
	// being pulled off the calendar does not need to hear that its audience is
	// empty.
	audienceWarning := ""
	// And can it reach them WHEN the calendar says? A ceiling the sender
	// enforces but the schedule screen never mentioned is how a slot claims a
	// time the send cannot keep.
	capacityWarning := ""
	if at != nil {
		audienceWarning = d.scheduleAudienceWarning(r.Context(), t.ID, c)
		capacityWarning = d.scheduleCapacityWarning(r.Context(), t.ID, c)
	}

	outcome := "scheduled"
	if at == nil {
		outcome = "unscheduled"
	} else if windowWarning != "" || approvalWarning != "" || collisionWarning != "" ||
		audienceWarning != "" || capacityWarning != "" {
		outcome = "warned"
	}
	reason := joinWarnings(windowWarning, approvalWarning, collisionWarning, audienceWarning, capacityWarning)
	d.recordScheduleVersion(r, t.ID, id, priorAt, at, outcome, reason)

	// ONE SHAPE, warned or not.
	//
	// This previously returned the bare campaign on a clean accept and
	// `{"campaign": {...}, "collision_warning": ...}` when something objected —
	// so a successful-but-warned schedule changed the response type. The one
	// shipped consumer types it `ApiResult<Campaign>` and does
	// `setDetail(result.data)`, which would have put an object with no `id`,
	// `status` or `scheduled_at` into the detail pane precisely when a warning
	// fired, and the warning itself would still not have been shown.
	//
	// The campaign is embedded, so its fields stay at the top level and the
	// warnings are additive keys a client may ignore. Adding a key is
	// compatible; moving every field down one level is not.
	writeJSON(w, http.StatusOK, scheduleResponse{
		Campaign:          c,
		SendWindowWarning: windowWarning,
		ApprovalWarning:   approvalWarning,
		CollisionWarning:  collisionWarning,
		AudienceWarning:   audienceWarning,
		CapacityWarning:   capacityWarning,
	})
}

// truncateReason bounds the audit reason to what the column accepts, counting
// CHARACTERS and cutting on a rune boundary.
//
// It was `reason[:1000]`, a BYTE slice, and the mismatch destroyed the audit row
// it was protecting. The constraint is `char_length(reason) <= 1000` — characters
// — so a long reason was never the failure; the mid-rune cut was. A neighbour
// campaign named with ~250 emoji or CJK characters produced an invalid UTF-8
// sequence, Postgres rejected the INSERT with SQLSTATE 22021, and because this
// recorder is deliberately best-effort the request still returned 200. The
// operator saw an ordinary success and the record simply did not exist.
//
// Reversed: a 1000-character reason is now always storable, and a longer one is
// cut where a character ends.
func truncateReason(reason string) string {
	const maxReasonChars = 1000
	if utf8.RuneCountInString(reason) <= maxReasonChars {
		return reason
	}
	count := 0
	for i := range reason {
		if count == maxReasonChars {
			return reason[:i]
		}
		count++
	}
	return reason
}

// scheduleResponse is the campaign plus whatever objected to the change.
//
// The embedded pointer inlines the campaign's fields rather than nesting them,
// and `omitempty` keeps a clean accept byte-identical to what this endpoint
// returned before the warnings existed.
type scheduleResponse struct {
	*Campaign
	SendWindowWarning string `json:"send_window_warning,omitempty"`
	ApprovalWarning   string `json:"approval_warning,omitempty"`
	CollisionWarning  string `json:"collision_warning,omitempty"`
	AudienceWarning   string `json:"audience_warning,omitempty"`
	// CapacityWarning reports that the audience is larger than the tenant's
	// hourly sending ceiling can deliver inside the slot. Additive and
	// omitempty, like its siblings: a client that does not know the key is
	// unaffected, which is why warnings are added as keys rather than by
	// reshaping the response.
	CapacityWarning string `json:"capacity_warning,omitempty"`
}

// recordScheduleVersion writes the audit row for one schedule attempt.
//
// Best-effort and deliberately unable to fail the request: the schedule change
// has already happened (or already been refused) by the time this runs, and
// turning a bookkeeping error into a 500 would tell the operator their
// successful reschedule failed.
//
// REFUSALS OF THE TIME ITSELF are recorded as well as successes: outside the
// send window, in the past, beyond the two-year horizon. Three refused attempts
// to schedule outside a window is a person fighting a policy — a conversation to
// have rather than a silence — and a table holding only successes cannot show it.
//
// NOT RECORDED, and the earlier version of this comment wrongly implied they
// were: refusals that are about the campaign's STATE rather than the time —
// 409 campaign_not_schedulable, 409 campaign_dispatching, 409 edit_lease_held,
// 412 precondition_failed. Those are answers to "may this campaign be touched
// at all", they carry no proposed time to record, and filing them here would
// mix "somebody keeps fighting the send window" with "somebody clicked while a
// colleague held the lease". They belong to the lease and lifecycle audits.
func (d *Deps) recordScheduleVersion(
	r *http.Request, tenantID, campaignID string, from, to *time.Time, outcome, reason string,
) {
	if d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	actorID, actorLabel := "", ""
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		actorID, actorLabel = u.ID, u.Email
	}
	reason = truncateReason(reason)
	ctx := r.Context()
	tx, err := db.WithTenant(ctx, d.Repo.Pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_schedule_versions
    (tenant_id, campaign_id, actor_user_id, actor_label, from_at, to_at, outcome, reason)
VALUES ($1::uuid, $2::uuid, NULLIF($3,'')::uuid, $4, $5, $6, $7, $8)`,
		tenantID, campaignID, actorID, actorLabel, from, to, outcome, reason); err != nil {
		if d.Logger != nil {
			d.Logger.Warn("campaign schedule version not recorded",
				"campaign_id", campaignID, "outcome", outcome, "err", err.Error())
		}
		return
	}
	_ = tx.Commit(ctx)
}

// approvalInvalidatedBySchedule reports whether the campaign's approval no
// longer matches, or "" when there is nothing to say.
//
// Reuses the SAME fingerprint the send path checks. A second notion of "has
// this changed since approval" would eventually disagree with the one that
// actually blocks the send, and the disagreement surfaces as a campaign warned
// and then sent, or approved and then refused.
//
// Silent on every error. This is advisory — the send path is the enforcement —
// and a warning that cannot be computed must not become a scary message about
// an approval that may be perfectly intact.
func (d *Deps) approvalInvalidatedBySchedule(ctx context.Context, tenantID, campaignID string) string {
	if d.Approvals == nil || d.Repo == nil {
		return ""
	}
	// Re-read the campaign so the fingerprint is computed from the state that
	// now exists — the schedule has already been written by this point, which is
	// exactly what makes the comparison meaningful.
	c, err := d.Repo.Get(ctx, tenantID, campaignID)
	if err != nil || c == nil {
		return ""
	}
	fp, fpErr := d.approvalFingerprint(ctx, tenantID, campaignID, c)
	if fpErr != nil {
		return ""
	}
	ok, vErr := d.Approvals.VerifyApprovedFingerprint(ctx, tenantID, campaignID, fp)
	if vErr != nil || ok {
		return ""
	}
	return "this campaign was approved for a different send time; approval must be sought again before it can be sent"
}

// joinWarnings collapses the advisory results into one recorded reason.
//
// All of them, not the first: a send that is out of hours AND clashes with
// another campaign has two things wrong with it, and showing one would have the
// person fix it, reschedule, and meet the second.
func joinWarnings(parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, "; ")
}
