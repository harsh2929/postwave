// SPDX-License-Identifier: AGPL-3.0-only
//
// Package presend implements the "AI Compose v2" unified pre-send
// verdict — a single endpoint that fans out to EQ Score + voice
// drift + placement predictor in parallel and returns ONE verdict
// the editor banner can display.
//
// The motivation: the legacy flow showed three separate banners in
// the send-confirmation modal (Inbox Reality, Voice Drift, and a
// future EQ banner). Operators reported the cognitive overhead as
// "is the draft ready or not?" with no clear answer when one banner
// said warn and another said ok. This endpoint normalizes the three
// signals into a single Verdict { send / revise / wait } the UI can
// gate the Send button on.
//
// Verdict rules (in priority order):
//
//   critical → ANY of: EQ < 40 | drift severity=critical | placement
//                       primary < 0.30
//   incomplete → one or more required checks returned error/skipped/invalid
//   warn     → ANY of: EQ < 65 | drift severity=warn      | placement
//                       primary < 0.55
//   ok       → otherwise
//
// The endpoint composes results from three independent calls. A known critical
// result remains critical even when another check is unavailable, but a missing
// result can never collapse to a green/all-passed verdict.

package presend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/eqscore"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Verdict is one of four terminal states the editor banner gates on.
type Verdict string

const (
	VerdictOK       Verdict = "ok"       // send is safe; banner is informational
	VerdictWarn     Verdict = "warn"     // banner shows amber; "Send anyway" is still allowed
	VerdictCritical Verdict = "critical" // banner shows red; "Send anyway" needs confirmation
	// VerdictIncomplete means at least one required component could not produce
	// a trustworthy result. It deliberately does not collapse to OK or claim
	// that every check passed. A known critical result still takes precedence.
	VerdictIncomplete Verdict = "incomplete"
)

// Component is one of the three base signals, plus optional exact Campaign
// Assurance, that feeds the verdict.
type Component struct {
	Name    string   `json:"name"`              // "eq_score" | "voice_drift" | "placement" | "campaign_assurance"
	Status  string   `json:"status"`            // "ok" | "warn" | "critical" | "error" | "skipped"
	Score   *float64 `json:"score,omitempty"`   // 0..1 or 0..100 depending on component
	Message string   `json:"message,omitempty"` // human hint for the banner
	Error   string   `json:"error,omitempty"`   // stable public error; never raw upstream detail
	// Reasons lists what the EQ score deducted for, blocking failures first,
	// so a client can show each cause on its own line. Message already names
	// the most severe of them. eq_score only; omitted when nothing was found.
	Reasons []eqscore.Reason `json:"reasons,omitempty"`
}

// Response is the wire shape.
type Response struct {
	Verdict           Verdict                           `json:"verdict"`
	Complete          bool                              `json:"complete"`
	Summary           string                            `json:"summary"`
	Components        []Component                       `json:"components"`
	CampaignAssurance *campaignassurancegate.Evaluation `json:"campaign_assurance,omitempty"`
	ComputedAt        time.Time                         `json:"computed_at"`
}

// Deps wires the handler.
type Deps struct {
	Pool *db.Pool
	// SenderAuth and Reputation are injectable seams. Production resolves both
	// from Pool under tenant RLS; requests never supply authoritative flags.
	SenderAuth eqscore.SenderAuthResolver
	Reputation eqscore.Reputation
	// VoiceDriftBaseURL + InternalToken are forwarded to /v1/voice/drift.
	// VoicePredictBaseURL + InternalToken to /v1/predict.
	VoiceServiceURL     string
	PredictorServiceURL string
	InternalToken       string
	HTTPClient          *http.Client
	Logger              *slog.Logger
	// CampaignAssurance consumes the same cached exact-hash evaluation as the
	// queue and dispatch gates. The handler imposes a maximum five-second
	// timeout and never launches analyzers inline.
	CampaignAssurance        campaignassurancegate.Evaluator
	CampaignAssuranceTimeout time.Duration
}

// MountRoutes registers POST /api/v1/presend/verdict.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/presend/verdict", d.Handle)
}

// presendRequest is the body the editor sends.
type presendRequest struct {
	Subject string `json:"subject"`
	HTML    string `json:"html"`
	Text    string `json:"text,omitempty"`
	From    string `json:"from"`
	// Optional voice profile hint; defaults to the active profile.
	VoiceProfileID string `json:"voice_profile_id,omitempty"`
	// All three immutable identity fields are supplied together. Omitting all
	// preserves the generic body-only verdict; supplying a partial identity is
	// an explicit incomplete Campaign Assurance component, never a fallback to
	// a "latest" campaign run.
	CampaignID        string `json:"campaign_id,omitempty"`
	ContentRevisionID string `json:"content_revision_id,omitempty"`
	SourceHash        string `json:"source_hash,omitempty"`
}

// Handle POST /api/v1/presend/verdict.
//
// Fans out to three legacy checks and, when campaign identity is supplied,
// one cached exact Campaign Assurance read in parallel:
//  1. eqscore.Score (in-process)
//  2. POST /v1/voice/drift  (HTTP to the voice service)
//  3. POST /v1/predict      (HTTP to the deliverability service)
//
// Each call has a hard 5s timeout. A timed-out/unavailable component makes the
// aggregate verdict incomplete; it can never produce a green/all-passed claim.
func (d *Deps) Handle(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in presendRequest
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}

	httpClient := d.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 5 * time.Second}
	}
	httpClient = clientWithoutRedirects(httpClient)

	var (
		wg                 sync.WaitGroup
		eqComp             Component
		drftCmp            Component
		plcCmp             Component
		assuranceComp      Component
		assuranceStatus    *campaignassurancegate.Evaluation
		assuranceRequested = campaignAssuranceIdentityAny(in)
	)

	// --- EQ Score (in-process) ---
	wg.Add(1)
	go func() {
		defer wg.Done()
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		resolver := d.senderAuthResolver()
		if resolver == nil {
			d.logComponentFailure("eq_score", errors.New("sender auth resolver is unavailable"))
			eqComp = failedComponent("eq_score", "EQ score check unavailable.")
			return
		}
		auth, err := resolver.ResolveSenderAuth(ctx, t.ID, in.From)
		if err != nil {
			d.logComponentFailure("eq_score", err)
			eqComp = failedComponent("eq_score", "EQ score check unavailable.")
			return
		}
		res, err := eqscore.Score(
			ctx,
			eqscore.AuthoritativeInput(in.Subject, in.HTML, in.Text, in.From, auth),
			t.ID,
			d.reputation(),
		)
		if err != nil {
			d.logComponentFailure("eq_score", err)
			eqComp = failedComponent("eq_score", "EQ score check unavailable.")
			return
		}
		if eqResultHasReason(res, "reputation_lookup_failed") {
			d.logComponentFailure("eq_score", errors.New("reputation lookup failed"))
			eqComp = failedComponent("eq_score", "EQ score check unavailable.")
			return
		}
		eqComp = eqScoreComponent(res)
	}()

	// --- Voice drift (HTTP) ---
	wg.Add(1)
	go func() {
		defer wg.Done()
		if strings.TrimSpace(d.VoiceServiceURL) == "" {
			drftCmp = skippedComponent("voice_drift", "Voice drift check is not configured.")
			return
		}
		bodyText := in.HTML
		if strings.TrimSpace(bodyText) == "" {
			bodyText = in.Text
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		req, err := newJSONRequest(ctx,
			strings.TrimRight(d.VoiceServiceURL, "/")+"/v1/voice/drift",
			map[string]any{
				"body":       bodyText,
				"subject":    in.Subject,
				"profile_id": in.VoiceProfileID,
			})
		if err != nil {
			d.logComponentFailure("voice_drift", err)
			drftCmp = failedComponent("voice_drift", "Voice drift check unavailable.")
			return
		}
		// The downstream service uses this header as its tenant lookup key. It
		// must come from authenticated middleware context, never caller input.
		req.Header.Set("X-Tenant-ID", t.ID)
		if d.InternalToken != "" {
			req.Header.Set("Authorization", "Bearer "+d.InternalToken)
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			d.logComponentFailure("voice_drift", err)
			drftCmp = failedComponent("voice_drift", "Voice drift check unavailable.")
			return
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusNotFound {
			drftCmp = skippedComponent("voice_drift", "Voice drift check is not configured.")
			return
		}
		if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
			d.logComponentFailure("voice_drift", fmt.Errorf("upstream returned HTTP %d", resp.StatusCode))
			drftCmp = failedComponent("voice_drift", "Voice drift check unavailable.")
			return
		}
		var dr struct {
			Score       *float64 `json:"score"`
			Severity    string   `json:"severity"`
			Reason      string   `json:"reason"`
			Suggestions []string `json:"suggestions"`
		}
		if err := decodeUpstreamJSON(resp.Body, &dr); err != nil {
			d.logComponentFailure("voice_drift", err)
			drftCmp = failedComponent("voice_drift", "Voice drift check unavailable.")
			return
		}
		if dr.Score == nil || !validCompletedStatus(dr.Severity) || !finiteInRange(*dr.Score, 0, 100) {
			err := fmt.Errorf("invalid success payload: severity=%q score=%v", dr.Severity, dr.Score)
			d.logComponentFailure("voice_drift", err)
			drftCmp = failedComponent("voice_drift", "Voice drift check unavailable.")
			return
		}
		message := strings.TrimSpace(dr.Reason)
		if message == "" {
			message = firstNonEmpty(dr.Suggestions)
		}
		drftCmp = Component{
			Name:    "voice_drift",
			Score:   dr.Score,
			Status:  dr.Severity,
			Message: message,
		}
	}()

	// --- Placement predictor (HTTP) ---
	wg.Add(1)
	go func() {
		defer wg.Done()
		if strings.TrimSpace(d.PredictorServiceURL) == "" {
			plcCmp = skippedComponent("placement", "Placement prediction is not configured.")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		req, err := newJSONRequest(ctx,
			strings.TrimRight(d.PredictorServiceURL, "/")+"/v1/predict",
			map[string]any{
				"html":    in.HTML,
				"subject": in.Subject,
			})
		if err != nil {
			d.logComponentFailure("placement", err)
			plcCmp = failedComponent("placement", "Placement prediction unavailable.")
			return
		}
		req.Header.Set("X-Tenant-ID", t.ID)
		if d.InternalToken != "" {
			req.Header.Set("Authorization", "Bearer "+d.InternalToken)
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			d.logComponentFailure("placement", err)
			plcCmp = failedComponent("placement", "Placement prediction unavailable.")
			return
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusNotFound {
			plcCmp = skippedComponent("placement", "Placement prediction is not configured.")
			return
		}
		if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
			d.logComponentFailure("placement", fmt.Errorf("upstream returned HTTP %d", resp.StatusCode))
			plcCmp = failedComponent("placement", "Placement prediction unavailable.")
			return
		}
		var pr struct {
			Predicted struct {
				Primary *float64 `json:"primary"`
			} `json:"predicted"`
		}
		if err := decodeUpstreamJSON(resp.Body, &pr); err != nil {
			d.logComponentFailure("placement", err)
			plcCmp = failedComponent("placement", "Placement prediction unavailable.")
			return
		}
		if pr.Predicted.Primary == nil || !finiteInRange(*pr.Predicted.Primary, 0, 1) {
			err := fmt.Errorf("invalid success payload: primary=%v", pr.Predicted.Primary)
			d.logComponentFailure("placement", err)
			plcCmp = failedComponent("placement", "Placement prediction unavailable.")
			return
		}
		score := *pr.Predicted.Primary
		plcCmp = Component{
			Name:  "placement",
			Score: &score,
		}
		switch {
		case score < 0.30:
			plcCmp.Status = "critical"
			plcCmp.Message = "Predicted Primary placement is below 30%."
		case score < 0.55:
			plcCmp.Status = "warn"
			plcCmp.Message = "Predicted Primary placement is below 55%."
		default:
			plcCmp.Status = "ok"
		}
	}()

	// --- Campaign Assurance (cached exact-hash read) ---
	if assuranceRequested {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !campaignAssuranceIdentityComplete(in) {
				status := campaignassurancegate.StatusError
				reason := campaignassurancegate.ReasonIntegrityMismatch
				message := "Campaign Assurance identity is incomplete."
				if campaignAssuranceCampaignOnly(in) {
					status = campaignassurancegate.StatusUnavailable
					reason = campaignassurancegate.ReasonNotAssured
					message = "No frozen Campaign Assurance run is available for this campaign."
				}
				evaluation := unavailableCampaignAssuranceEvaluation(t.ID, in,
					status, reason)
				assuranceStatus = &evaluation
				assuranceComp = failedComponent("campaign_assurance", message)
				return
			}
			if d.CampaignAssurance == nil {
				evaluation := unavailableCampaignAssuranceEvaluation(t.ID, in,
					campaignassurancegate.StatusUnavailable, campaignassurancegate.ReasonEvidenceUnavailable)
				assuranceStatus = &evaluation
				assuranceComp = failedComponent("campaign_assurance", "Campaign Assurance is not configured.")
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), d.campaignAssuranceTimeout())
			defer cancel()
			evaluation, err := d.CampaignAssurance.Evaluate(ctx, campaignassurancegate.Request{
				TenantID: t.ID, CampaignID: strings.TrimSpace(in.CampaignID),
				ContentRevisionID: strings.TrimSpace(in.ContentRevisionID),
				SourceHash:        strings.TrimSpace(in.SourceHash),
			})
			if !validCampaignAssuranceEvaluation(t.ID, in, evaluation) {
				d.logComponentFailure("campaign_assurance", errors.New("invalid exact-hash evaluation contract"))
				evaluation = unavailableCampaignAssuranceEvaluation(t.ID, in,
					campaignassurancegate.StatusError, campaignassurancegate.ReasonIntegrityMismatch)
				assuranceStatus = &evaluation
				assuranceComp = failedComponent("campaign_assurance", "Campaign Assurance returned an invalid status.")
				return
			}
			assuranceStatus = &evaluation
			assuranceComp = campaignAssuranceComponent(evaluation)
			if err != nil && !campaignassurancegate.IsDenial(err) {
				d.logComponentFailure("campaign_assurance", err)
			}
		}()
	}

	wg.Wait()

	components := []Component{eqComp, drftCmp, plcCmp}
	expected := []string{"eq_score", "voice_drift", "placement"}
	if assuranceRequested {
		components = append(components, assuranceComp)
		expected = append(expected, "campaign_assurance")
	}
	resp := Response{
		Components: components, CampaignAssurance: assuranceStatus,
		ComputedAt: time.Now().UTC(),
	}
	resp.Verdict, resp.Summary, resp.Complete = computeVerdictExpected(resp.Components, expected)
	writeJSON(w, http.StatusOK, resp)
}

// computeVerdict applies the priority rules. Critical is the only completed
// signal that outranks incompleteness: a known critical issue must remain
// visible even if another check failed. Otherwise error, skipped, unknown, or
// missing component status produces the explicit incomplete verdict.
func computeVerdict(comps []Component) (Verdict, string, bool) {
	return computeVerdictExpected(comps, []string{"eq_score", "voice_drift", "placement"})
}

func computeVerdictExpected(comps []Component, expectedNames []string) (Verdict, string, bool) {
	hasCritical := false
	hasWarn := false
	criticalReasons := []string{}
	warnReasons := []string{}
	unavailable := []string{}
	expected := make(map[string]bool, len(expectedNames))
	for _, name := range expectedNames {
		expected[name] = false
	}
	for _, c := range comps {
		if _, ok := expected[c.Name]; !ok {
			name := strings.TrimSpace(c.Name)
			if name == "" {
				name = "unknown_component"
			}
			unavailable = append(unavailable, name)
		} else if expected[c.Name] {
			unavailable = append(unavailable, c.Name+" (duplicate)")
		} else {
			expected[c.Name] = true
		}
		switch c.Status {
		case "critical":
			hasCritical = true
			criticalReasons = append(criticalReasons, componentReason(c))
		case "warn":
			hasWarn = true
			warnReasons = append(warnReasons, componentReason(c))
		case "ok":
			// Complete component.
		case "error", "skipped":
			unavailable = append(unavailable, c.Name)
		default:
			name := strings.TrimSpace(c.Name)
			if name == "" {
				name = "unknown_component"
			}
			unavailable = append(unavailable, name)
		}
	}
	for _, name := range expectedNames {
		if !expected[name] {
			unavailable = append(unavailable, name)
		}
	}
	complete := len(unavailable) == 0
	for i, name := range unavailable {
		unavailable[i] = componentLabel(name)
	}
	switch {
	case hasCritical:
		summary := "Critical issues detected. " + strings.Join(criticalReasons, " | ")
		if len(warnReasons) > 0 {
			summary += " | Warnings: " + strings.Join(warnReasons, " | ")
		}
		if !complete {
			summary += " | Checks incomplete: " + strings.Join(unavailable, ", ") + "."
		}
		return VerdictCritical, summary, complete
	case !complete:
		summary := "Pre-send checks incomplete. Unavailable: " + strings.Join(unavailable, ", ") + "."
		if hasWarn {
			summary += " Available checks also reported warnings: " + strings.Join(warnReasons, " | ")
		}
		return VerdictIncomplete, summary, false
	case hasWarn:
		return VerdictWarn, "Warnings: " + strings.Join(warnReasons, " | "), true
	default:
		return VerdictOK, "All pre-send checks passed.", true
	}
}

const campaignAssuranceMaxTimeout = 5 * time.Second

func (d *Deps) campaignAssuranceTimeout() time.Duration {
	if d == nil || d.CampaignAssuranceTimeout <= 0 || d.CampaignAssuranceTimeout > campaignAssuranceMaxTimeout {
		return campaignAssuranceMaxTimeout
	}
	return d.CampaignAssuranceTimeout
}

func campaignAssuranceIdentityAny(input presendRequest) bool {
	return strings.TrimSpace(input.CampaignID) != "" ||
		strings.TrimSpace(input.ContentRevisionID) != "" || strings.TrimSpace(input.SourceHash) != ""
}

func campaignAssuranceIdentityComplete(input presendRequest) bool {
	return strings.TrimSpace(input.CampaignID) != "" &&
		strings.TrimSpace(input.ContentRevisionID) != "" && strings.TrimSpace(input.SourceHash) != ""
}

func campaignAssuranceCampaignOnly(input presendRequest) bool {
	return strings.TrimSpace(input.CampaignID) != "" &&
		strings.TrimSpace(input.ContentRevisionID) == "" && strings.TrimSpace(input.SourceHash) == ""
}

func unavailableCampaignAssuranceEvaluation(
	tenantID string,
	input presendRequest,
	status campaignassurancegate.Status,
	reason string,
) campaignassurancegate.Evaluation {
	return campaignassurancegate.Evaluation{
		PolicyVersion: campaignassurancegate.PolicyVersion,
		TenantID:      tenantID, CampaignID: strings.TrimSpace(input.CampaignID),
		ContentRevisionID: strings.TrimSpace(input.ContentRevisionID),
		SourceHash:        strings.TrimSpace(input.SourceHash), Status: status,
		ReasonCode: reason, SourceCoverage: campaignassurancegate.SourceCoverage{},
		RefreshedAt: time.Now().UTC(),
	}
}

func campaignAssuranceComponent(evaluation campaignassurancegate.Evaluation) Component {
	component := Component{Name: "campaign_assurance", Score: cloneScore(evaluation.PredictedScore)}
	switch evaluation.Status {
	case campaignassurancegate.StatusOK:
		component.Status = "ok"
	case campaignassurancegate.StatusWarn:
		component.Status = "warn"
		component.Message = "Campaign Assurance completed with advisory findings."
	case campaignassurancegate.StatusCritical:
		component.Status = "critical"
		if evaluation.Authorized && evaluation.GateDecision == "overridden" {
			component.Message = "Deterministic blockers have a current governed override set; review the override receipts before sending."
		} else {
			component.Message = "Deterministic Campaign Assurance findings block this exact revision."
		}
	case campaignassurancegate.StatusPending:
		component = failedComponent("campaign_assurance", "Campaign Assurance is still running for this exact revision.")
	case campaignassurancegate.StatusStale:
		component = failedComponent("campaign_assurance", "Campaign Assurance is stale for this exact revision.")
	case campaignassurancegate.StatusUnavailable:
		component = failedComponent("campaign_assurance", "Complete Campaign Assurance evidence is unavailable for this exact revision.")
	default:
		component = failedComponent("campaign_assurance", "Campaign Assurance status could not be verified.")
	}
	return component
}

func cloneScore(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func validCampaignAssuranceEvaluation(tenantID string, input presendRequest, evaluation campaignassurancegate.Evaluation) bool {
	if evaluation.PolicyVersion != campaignassurancegate.PolicyVersion ||
		evaluation.TenantID != tenantID || evaluation.CampaignID != strings.TrimSpace(input.CampaignID) ||
		evaluation.ContentRevisionID != strings.TrimSpace(input.ContentRevisionID) ||
		evaluation.SourceHash != strings.TrimSpace(input.SourceHash) || evaluation.RefreshedAt.IsZero() ||
		!validCampaignAssuranceStatus(evaluation.Status) || !validCampaignAssuranceReason(evaluation.ReasonCode) ||
		!validCampaignAssuranceScores(evaluation) || !validCampaignAssuranceCoverage(evaluation.SourceCoverage) ||
		!validCampaignAssuranceDisposition(evaluation) {
		return false
	}
	if _, err := uuid.Parse(evaluation.CampaignID); err != nil {
		return false
	}
	if _, err := uuid.Parse(evaluation.ContentRevisionID); err != nil {
		return false
	}
	if !validLowerSHA256(evaluation.SourceHash) {
		return false
	}
	if evaluation.RunID == "" {
		return !evaluation.Authorized && evaluation.SendPlanID == "" && evaluation.PlanHash == "" &&
			evaluation.ArtifactSetHash == "" && evaluation.RunAttempt == 0 && len(evaluation.OverrideIDs) == 0
	}
	for _, identity := range []string{evaluation.RunID, evaluation.SendPlanID} {
		parsed, err := uuid.Parse(identity)
		if err != nil || parsed.String() != identity {
			return false
		}
	}
	if evaluation.RunAttempt < 1 || !validLowerSHA256(evaluation.PlanHash) ||
		!validLowerSHA256(evaluation.ArtifactSetHash) || !validLowerSHA256(evaluation.CoverageManifestHash) ||
		!sortedUniqueUUIDs(evaluation.OverrideIDs) {
		return false
	}
	if evaluation.Authorized {
		switch evaluation.GateDecision {
		case "pass", "warn":
			return len(evaluation.OverrideIDs) == 0
		case "overridden":
			return len(evaluation.OverrideIDs) > 0
		default:
			return false
		}
	}
	return len(evaluation.OverrideIDs) == 0
}

func validCampaignAssuranceDisposition(evaluation campaignassurancegate.Evaluation) bool {
	switch evaluation.Status {
	case campaignassurancegate.StatusOK:
		return evaluation.Authorized && evaluation.GateDecision == "pass" &&
			evaluation.ReasonCode == campaignassurancegate.ReasonAuthorized
	case campaignassurancegate.StatusWarn:
		return evaluation.Authorized && evaluation.GateDecision == "warn" &&
			evaluation.ReasonCode == campaignassurancegate.ReasonAuthorizedWarn
	case campaignassurancegate.StatusCritical:
		if evaluation.Authorized {
			return evaluation.GateDecision == "overridden" &&
				evaluation.ReasonCode == campaignassurancegate.ReasonAuthorizedOverride
		}
		return evaluation.GateDecision == "block" &&
			evaluation.ReasonCode == campaignassurancegate.ReasonDeterministicBlock
	case campaignassurancegate.StatusPending:
		return !evaluation.Authorized && evaluation.ReasonCode == campaignassurancegate.ReasonRunPending
	case campaignassurancegate.StatusStale:
		return !evaluation.Authorized && evaluation.ReasonCode == campaignassurancegate.ReasonRunStale
	case campaignassurancegate.StatusUnavailable:
		return !evaluation.Authorized && (evaluation.ReasonCode == campaignassurancegate.ReasonNotAssured ||
			evaluation.ReasonCode == campaignassurancegate.ReasonEvidenceUnavailable)
	case campaignassurancegate.StatusError:
		return !evaluation.Authorized && (evaluation.ReasonCode == campaignassurancegate.ReasonIntegrityMismatch ||
			evaluation.ReasonCode == campaignassurancegate.ReasonDependencyError)
	default:
		return false
	}
}

func validCampaignAssuranceStatus(status campaignassurancegate.Status) bool {
	switch status {
	case campaignassurancegate.StatusOK, campaignassurancegate.StatusWarn,
		campaignassurancegate.StatusCritical, campaignassurancegate.StatusPending,
		campaignassurancegate.StatusStale, campaignassurancegate.StatusUnavailable,
		campaignassurancegate.StatusError:
		return true
	default:
		return false
	}
}

func validCampaignAssuranceReason(reason string) bool {
	switch reason {
	case campaignassurancegate.ReasonAuthorized, campaignassurancegate.ReasonAuthorizedWarn,
		campaignassurancegate.ReasonAuthorizedOverride, campaignassurancegate.ReasonNotAssured,
		campaignassurancegate.ReasonRunPending, campaignassurancegate.ReasonRunStale,
		campaignassurancegate.ReasonEvidenceUnavailable, campaignassurancegate.ReasonDeterministicBlock,
		campaignassurancegate.ReasonIntegrityMismatch, campaignassurancegate.ReasonDependencyError:
		return true
	default:
		return false
	}
}

func validCampaignAssuranceScores(evaluation campaignassurancegate.Evaluation) bool {
	for _, value := range []*float64{evaluation.PredictedScore, evaluation.PredictedScoreMin, evaluation.PredictedScoreMax} {
		if value != nil && !finiteInRange(*value, 0, 100) {
			return false
		}
	}
	return evaluation.PredictedScoreMin == nil || evaluation.PredictedScoreMax == nil ||
		*evaluation.PredictedScoreMin <= *evaluation.PredictedScoreMax
}

func validCampaignAssuranceCoverage(coverage campaignassurancegate.SourceCoverage) bool {
	if coverage.Required < 0 || coverage.Successful < 0 || coverage.Successful > coverage.Required ||
		coverage.DeterministicConfigs < 0 || coverage.ModeledConfigs < 0 ||
		coverage.ControlledObservationConfigs < 0 || !finiteInRange(coverage.Ratio, 0, 1) {
		return false
	}
	want := 0.0
	if coverage.Required > 0 {
		want = float64(coverage.Successful) / float64(coverage.Required)
	}
	return math.Abs(coverage.Ratio-want) <= 0.000001
}

func validLowerSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, current := range value {
		if (current < '0' || current > '9') && (current < 'a' || current > 'f') {
			return false
		}
	}
	return true
}

func sortedUniqueUUIDs(values []string) bool {
	previous := ""
	for _, value := range values {
		parsed, err := uuid.Parse(value)
		if err != nil || parsed.String() != value || (previous != "" && value <= previous) {
			return false
		}
		previous = value
	}
	return true
}

const upstreamJSONMaxBytes int64 = 256 << 10

func newJSONRequest(ctx context.Context, url string, body any) (*http.Request, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	return req, nil
}

func clientWithoutRedirects(client *http.Client) *http.Client {
	clone := *client
	clone.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &clone
}

func decodeUpstreamJSON(body io.Reader, dst any) error {
	if body == nil {
		return fmt.Errorf("empty response body")
	}
	raw, err := io.ReadAll(io.LimitReader(body, upstreamJSONMaxBytes+1))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if int64(len(raw)) > upstreamJSONMaxBytes {
		return fmt.Errorf("response exceeds %d bytes", upstreamJSONMaxBytes)
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func failedComponent(name, publicError string) Component {
	return Component{Name: name, Status: "error", Error: publicError}
}

func skippedComponent(name, message string) Component {
	return Component{Name: name, Status: "skipped", Message: message}
}

func (d *Deps) logComponentFailure(name string, err error) {
	if d != nil && d.Logger != nil {
		d.Logger.Warn("pre-send component failed", "component", name, "error", err)
	}
}

func (d *Deps) senderAuthResolver() eqscore.SenderAuthResolver {
	if d.SenderAuth != nil {
		return d.SenderAuth
	}
	if d.Pool == nil {
		return nil
	}
	return eqscore.NewDBSenderAuthResolver(d.Pool)
}

func (d *Deps) reputation() eqscore.Reputation {
	if d.Reputation != nil {
		return d.Reputation
	}
	if d.Pool == nil {
		return nil
	}
	return eqscore.NewDBReputation(d.Pool)
}

func validCompletedStatus(status string) bool {
	switch status {
	case "ok", "warn", "critical":
		return true
	default:
		return false
	}
}

func finiteInRange(value, low, high float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= low && value <= high
}

func firstNonEmpty(values []string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func componentReason(c Component) string {
	label := componentLabel(c.Name)
	message := strings.TrimSpace(c.Message)
	if message == "" {
		return label
	}
	return label + ": " + message
}

// componentLabels are the names the summary uses for each check — the same
// names the web and desktop panels print beside each component row, so the
// summary never shows a wire key like "eq_score" to the person reading it.
var componentLabels = map[string]string{
	"eq_score":           "Content quality",
	"voice_drift":        "Voice alignment",
	"placement":          "Primary placement",
	"campaign_assurance": "Campaign Assurance",
}

func componentLabel(name string) string {
	if label, ok := componentLabels[name]; ok {
		return label
	}
	return name
}

func eqResultHasReason(result eqscore.Result, code string) bool {
	for _, reason := range result.Reasons {
		if reason.Code == code {
			return true
		}
	}
	return false
}

func eqResultHasSeverity(result eqscore.Result, severity string) bool {
	for _, reason := range result.Reasons {
		if reason.Severity == severity {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}
