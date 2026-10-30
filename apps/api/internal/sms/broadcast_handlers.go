package sms

// broadcast_handlers.go — HTTP surface for SMS broadcasts.
//
// Routes (mounted from handlers.go):
//
//	GET    /api/v1/sms/broadcasts                 read:reports
//	POST   /api/v1/sms/broadcasts                 admin
//	GET    /api/v1/sms/broadcasts/{id}            read:reports
//	PATCH  /api/v1/sms/broadcasts/{id}            admin (draft|scheduled only)
//	DELETE /api/v1/sms/broadcasts/{id}            admin (not while sending)
//	POST   /api/v1/sms/broadcasts/{id}/send       admin (idempotent mount)
//	POST   /api/v1/sms/broadcasts/{id}/cancel     admin
//	GET    /api/v1/sms/broadcasts/{id}/progress   read:reports
//
// Write routes are admin-scoped for consistency with the other
// operator-safety SMS siblings (quiet-hours, keyword-responses,
// senders). Errors surface as the standard {error:{code,message}}
// envelope; *BroadcastError carries operator-safe code + status, and
// anything else is logged server-side via httperror.WriteInternal.

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type broadcastListResponse struct {
	TenantID                           string      `json:"tenantId"`
	Items                              []Broadcast `json:"items"`
	NextCursor                         string      `json:"nextCursor,omitempty"`
	SnapshotAt                         time.Time   `json:"snapshotAt"`
	BroadcastDispatchAvailable         bool        `json:"broadcastDispatchAvailable"`
	BroadcastDispatchUnavailableReason string      `json:"broadcastDispatchUnavailableReason,omitempty"`
}

func (d *Deps) writeBroadcastErr(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	var be *BroadcastError
	if errors.As(err, &be) {
		writeJSON(w, be.Status, errEnv(be.Code, be.Message))
		return
	}
	httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
}

func (d *Deps) ListBroadcasts(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if err := validateInboxQuery(r.URL.Query(), "cursor", "limit"); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", err.Error()))
		return
	}
	limit, err := parseInboxLimit(r.URL.Query().Get("limit"), 50, 200)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_limit", "limit must be an integer between 1 and 200"))
		return
	}
	if !validInboxCursorKey(d.InboxCursorKey) {
		writeInboxCursorError(w, errInboxCursorUnavailable)
		return
	}
	dbNow, err := d.store().InboxDatabaseNow(r.Context(), tenant.ID)
	if err != nil {
		d.writeBroadcastErr(w, r, tenant.ID, err)
		return
	}
	binding := inboxCursorBinding(tenant.ID, "admin")
	cursor, err := decodeInboxCursor(d.inboxCursorKeys(), r.URL.Query().Get("cursor"), tenant.ID, "broadcasts", binding, dbNow)
	if err != nil {
		writeInboxCursorError(w, err)
		return
	}
	if cursor.KeyID != "" && (!validCanonicalUUIDV4(cursor.KeyID) || cursor.KeyAt.IsZero()) {
		writeInboxCursorError(w, errInboxInvalidCursor)
		return
	}
	out, err := d.store().ListBroadcasts(r.Context(), tenant.ID, d.InboxCursorKey, cursor, binding, limit)
	if err != nil {
		d.writeBroadcastErr(w, r, tenant.ID, err)
		return
	}
	dispatchAvailable := smsDispatchSagaReleaseReady && d.Provider != nil && d.BroadcastBudget != nil && d.store().SMSWorkerIdentityAvailable
	if dispatchAvailable {
		dispatchAvailable, err = d.hasConfiguredDispatchSender(r.Context(), tenant.ID)
		if err != nil {
			d.writeBroadcastErr(w, r, tenant.ID, err)
			return
		}
	}
	dispatchUnavailableReason := ""
	if !dispatchAvailable {
		switch {
		case !smsDispatchSagaReleaseReady:
			dispatchUnavailableReason = "sms_broadcast_dispatch_release_held"
		case d.BroadcastBudget == nil:
			dispatchUnavailableReason = "sms_financial_reservation_unavailable"
		case !d.store().SMSWorkerIdentityAvailable:
			dispatchUnavailableReason = "sms_dispatch_worker_unavailable"
		default:
			dispatchUnavailableReason = "sms_configured_sender_unavailable"
		}
	}
	if err := d.auditSMSInboxRead(r, "sms.broadcasts.list", "/api/v1/sms/broadcasts", len(out.Items), out.SnapshotAt, out.NextCursor != ""); err != nil {
		d.writeBroadcastErr(w, r, tenant.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, broadcastListResponse{
		TenantID:                           tenant.ID,
		Items:                              out.Items,
		NextCursor:                         out.NextCursor,
		SnapshotAt:                         out.SnapshotAt,
		BroadcastDispatchAvailable:         dispatchAvailable,
		BroadcastDispatchUnavailableReason: dispatchUnavailableReason,
	})
}

func (d *Deps) CreateBroadcast(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in BroadcastUpsert
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	out, err := d.store().CreateBroadcast(r.Context(), tenant.ID, in)
	if err != nil {
		d.writeBroadcastErr(w, r, tenant.ID, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetBroadcast(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().GetBroadcast(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeBroadcastErr(w, r, tenant.ID, err)
		return
	}
	if err := d.auditSMSInboxRead(r, "sms.broadcasts.detail.read", "/api/v1/sms/broadcasts/{id}", 1, time.Now().UTC(), false); err != nil {
		d.writeBroadcastErr(w, r, tenant.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpdateBroadcast(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in BroadcastUpsert
	if err := decodeSMSJSON(w, r, &in); err != nil {
		writeSMSDecodeError(w, err)
		return
	}
	out, err := d.store().UpdateBroadcast(r.Context(), tenant.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeBroadcastErr(w, r, tenant.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteBroadcast(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if err := d.store().DeleteBroadcast(r.Context(), tenant.ID, chi.URLParam(r, "id")); err != nil {
		d.writeBroadcastErr(w, r, tenant.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// SendBroadcast starts (or schedules) the broadcast. Mounted inside
// the idempotency middleware group; the handler itself is ALSO
// idempotent (the claim in sendBroadcast flips draft|scheduled →
// sending exactly once), so a double-POST without an Idempotency-Key
// replays progress instead of double-enqueueing.
func (d *Deps) SendBroadcast(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if !smsDispatchSagaReleaseReady {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_broadcast_dispatch_release_held", "SMS broadcast dispatch is unavailable until the budget, frozen-audience, enqueue and provider reconciliation saga is durable"))
		return
	}
	if d.Provider == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("sms_provider_unconfigured", "configure an SMS provider before sending"))
		return
	}
	out, err := d.sendBroadcast(r.Context(), tenant.ID, chi.URLParam(r, "id"), time.Now())
	if err != nil {
		d.writeBroadcastErr(w, r, tenant.ID, err)
		return
	}
	writeJSON(w, http.StatusAccepted, out)
}

func (d *Deps) CancelBroadcast(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.store().CancelBroadcast(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeBroadcastErr(w, r, tenant.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// BroadcastProgress reports {status, sent, failed, held, total},
// refreshing the denormalised counters and lazily finalizing
// sending → sent when the queue has drained.
func (d *Deps) BroadcastProgress(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	_, progress, err := d.store().SyncBroadcastProgress(r.Context(), tenant.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeBroadcastErr(w, r, tenant.ID, err)
		return
	}
	if err := d.auditSMSInboxRead(r, "sms.broadcasts.progress.read", "/api/v1/sms/broadcasts/{id}/progress", 1, time.Now().UTC(), false); err != nil {
		d.writeBroadcastErr(w, r, tenant.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, progress)
}
