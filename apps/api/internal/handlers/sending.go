package handlers

import (
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/postwave/postwave/apps/api/internal/tenantcontrols"
)

// SendingHandlers serves the per-tenant sending-tier control plane:
// provisioning, state, warmup. All routes require the tenant middleware.
type SendingHandlers struct {
	Provisioner   *sending.Provisioner
	Repo          sending.StateRepo
	WarmupTracker sending.WarmupTracker
	Controls      *tenantcontrols.Repo
}

const sendingControlJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// Provision triggers tenant provisioning into Postmark.
//
// POST /api/v1/sending/provision
//
// CANONICAL PATH: the billing webhook handler at
// /api/public/stripe/webhook calls Provisioner.ProvisionTenant on
// subscription-created + tier-change events (see internal/billing/webhook.go).
// This direct admin route exists only as an escape hatch for ops + dev.
//
// In production we refuse the direct call unless POSTWAVE_ALLOW_DIRECT_PROVISION=1
// is set in the environment — bypassing billing must be a deliberate
// operator decision, not a default. Dev and tests run without the gate.
func (h *SendingHandlers) Provision(w http.ResponseWriter, r *http.Request) {
	if isProductionEnv() && !directProvisionAllowed() {
		writeDirectProvisionDisabledDenial(w)
		return
	}
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]string{"code": "no_tenant", "message": "tenant required"},
		})
		return
	}
	st, err := h.Provisioner.ProvisionTenant(r.Context(), sending.Tenant{
		ID: t.ID, Slug: t.Slug, Name: t.Name, Tier: t.Tier,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]string{"code": "provision_failed", "message": "an internal error occurred"},
		})
		return
	}
	writeJSON(w, http.StatusCreated, st)
}

func isProductionEnv() bool {
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		v := strings.TrimSpace(os.Getenv(key))
		if strings.EqualFold(v, "production") || strings.EqualFold(v, "prod") {
			return true
		}
	}
	return false
}

func directProvisionAllowed() bool {
	v := strings.TrimSpace(os.Getenv("POSTWAVE_ALLOW_DIRECT_PROVISION"))
	return v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "yes")
}

// State returns the per-tenant sending state, never the encrypted token.
//
// GET /api/v1/sending/state
func (h *SendingHandlers) State(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "no tenant"})
		return
	}
	st, _, err := h.Repo.Get(r.Context(), t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "an internal error occurred"})
		return
	}
	if st == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"error": map[string]string{"code": "not_provisioned", "message": "tenant has no sending state"},
		})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// Warmup returns the warmup schedule + today's cap for the tenant.
//
// GET /api/v1/sending/warmup
func (h *SendingHandlers) Warmup(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "no tenant"})
		return
	}
	ws, err := h.WarmupTracker.Get(r.Context(), t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "an internal error occurred"})
		return
	}
	if ws == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"started":  false,
			"schedule": sending.WarmupSchedule,
		})
		return
	}
	now := time.Now().UTC()
	dayKey := now.Format("2006-01-02")
	cap := sending.CapForDay(ws.WarmupDay, ws.TierLimit)

	writeJSON(w, http.StatusOK, map[string]any{
		"started":           true,
		"warmup_started_at": ws.WarmupStartedAt,
		"warmup_day":        ws.WarmupDay,
		"todays_cap":        cap,
		"todays_sent":       ws.DailySent[dayKey],
		"schedule":          sending.WarmupSchedule,
	})
}

type pauseInput struct {
	Reason string `json:"reason"`
}

type readinessItem struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Complete bool   `json:"complete"`
	Severity string `json:"severity"`
	Detail   string `json:"detail,omitempty"`
}

type readinessResponse struct {
	Ready              bool                                  `json:"ready"`
	Items              []readinessItem                       `json:"items"`
	Controls           tenantcontrols.EmailSendingControl    `json:"controls"`
	Compliance         tenantcontrols.EmailComplianceSummary `json:"compliance"`
	Settings           tenantcontrols.SendingSettingsSummary `json:"settings"`
	WarmupStarted      bool                                  `json:"warmup_started"`
	WarmupDay          int                                   `json:"warmup_day,omitempty"`
	TodaysCap          int                                   `json:"todays_cap,omitempty"`
	TodaysSent         int                                   `json:"todays_sent,omitempty"`
	SendingProvisioned bool                                  `json:"sending_provisioned"`
}

// Controls returns the tenant-level email sending control.
//
// GET /api/v1/sending/controls
func (h *SendingHandlers) ControlsState(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "no tenant"})
		return
	}
	ctrl, err := h.controls().EmailSendingControl(r.Context(), t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "an internal error occurred"})
		return
	}
	writeJSON(w, http.StatusOK, ctrl)
}

// PauseEmailSending activates the tenant-level email kill switch.
//
// POST /api/v1/sending/controls/pause
func (h *SendingHandlers) PauseEmailSending(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "no tenant"})
		return
	}
	var in pauseInput
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, sendingControlJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			writeJSON(w, httpbody.StatusCode(err), map[string]any{"error": httpbody.ErrorCode(err), "message": httpbody.PublicMessage(err)})
			return
		}
	}
	_, actor := middleware.ActorFromContext(r.Context())
	ctrl, err := h.controls().SetEmailSendingPaused(r.Context(), t.ID, true, in.Reason, actor)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "an internal error occurred"})
		return
	}
	writeJSON(w, http.StatusOK, ctrl)
}

// ResumeEmailSending clears the tenant-level email kill switch.
//
// POST /api/v1/sending/controls/resume
func (h *SendingHandlers) ResumeEmailSending(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "no tenant"})
		return
	}
	_, actor := middleware.ActorFromContext(r.Context())
	ctrl, err := h.controls().SetEmailSendingPaused(r.Context(), t.ID, false, "", actor)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "an internal error occurred"})
		return
	}
	writeJSON(w, http.StatusOK, ctrl)
}

// Readiness returns the production email sending checklist used by cutover.
//
// GET /api/v1/sending/readiness
func (h *SendingHandlers) Readiness(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "no tenant"})
		return
	}
	ctrlRepo := h.controls()
	ctrl, err := ctrlRepo.EmailSendingControl(r.Context(), t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "an internal error occurred"})
		return
	}
	compliance, err := ctrlRepo.EmailComplianceSummary(r.Context(), t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "an internal error occurred"})
		return
	}
	settings, err := ctrlRepo.SendingSettingsSummary(r.Context(), t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "an internal error occurred"})
		return
	}

	resp := readinessResponse{
		Ready:      true,
		Controls:   ctrl,
		Compliance: compliance,
		Settings:   settings,
		Items:      []readinessItem{},
	}

	if h.Repo != nil {
		st, _, err := h.Repo.Get(r.Context(), t.ID)
		if err == nil && st != nil {
			resp.SendingProvisioned = true
		}
	}
	if h.WarmupTracker != nil {
		ws, err := h.WarmupTracker.Get(r.Context(), t.ID)
		if err == nil && ws != nil {
			resp.WarmupStarted = true
			resp.WarmupDay = ws.WarmupDay
			resp.TodaysCap = sending.CapForDay(ws.WarmupDay, ws.TierLimit)
			resp.TodaysSent = ws.DailySent[time.Now().UTC().Format("2006-01-02")]
		}
	}

	resp.addItem("email_kill_switch_off", "Email kill switch off", !ctrl.Paused, "blocker", ctrl.PauseReason)
	resp.addItem("compliance_profile_complete", "Commercial sender profile complete", compliance.Complete, "blocker", "")
	resp.addItem("verified_sender_domain", "Sender domain verified", compliance.VerifiedSenderDomain, "blocker", "")
	resp.addItem("sending_state_provisioned", "Managed sending provisioned", resp.SendingProvisioned, "warning", "")
	resp.addItem("hourly_cap_configured", "Hourly send cap configured", settings.Exists && settings.MaxSendsPerHour != nil && *settings.MaxSendsPerHour > 0, "warning", "")
	resp.addItem("quiet_hours_configured", "Quiet hours configured", settings.QuietHoursEnabled, "warning", "")
	resp.addItem("warmup_started", "Warmup schedule started", resp.WarmupStarted, "warning", "")

	writeJSON(w, http.StatusOK, resp)
}

func (r *readinessResponse) addItem(key, label string, complete bool, severity, detail string) {
	r.Items = append(r.Items, readinessItem{
		Key:      key,
		Label:    label,
		Complete: complete,
		Severity: severity,
		Detail:   strings.TrimSpace(detail),
	})
	if severity == "blocker" && !complete {
		r.Ready = false
	}
}

func (h *SendingHandlers) controls() *tenantcontrols.Repo {
	if h.Controls != nil {
		return h.Controls
	}
	return &tenantcontrols.Repo{}
}
