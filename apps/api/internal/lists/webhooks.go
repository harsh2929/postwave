// Package lists — webhooks.go owns the list-scoped compatibility façade for
// the canonical outbound-webhooks engine.
//
// Every operation delegates storage, signing, destination protection,
// delivery inspection, test probes, and deletion to outbound_webhooks. This
// file only resolves the parent list and enforces that the requested endpoint
// belongs to that same list before delegating. The legacy
// list_webhook_deliveries test-only path is intentionally retired.

package lists

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// MountWebhookRoutes registers the per-list webhook endpoints.
func (d *Deps) MountWebhookRoutes(r chi.Router) {
	// Delivery bodies and destination configuration are sensitive, and every
	// mutation can cause server-side egress. Keep this surface aligned with the
	// canonical outbound-webhooks API: admin scope is mandatory for reads,
	// writes, test fires, and delivery inspection.
	admin := r.With(apikeys.RequireScope(apikeys.ScopeAdmin))
	admin.Get("/api/v1/lists/{id}/webhooks", d.ListWebhooks)
	// p4d-recordsurface-wire-others: webhook CRUD + test-fire wire to
	// pw_lists_<action>_total; the *_test action covers the synthetic
	// payload round-trip (network call to the consumer, so expect
	// 100ms+ p50).
	admin.Post("/api/v1/lists/{id}/webhooks", observability.RecordSurfaceFunc("lists", "webhook_create", d.CreateWebhook))
	admin.Patch("/api/v1/lists/{id}/webhooks/{wid}", observability.RecordSurfaceFunc("lists", "webhook_update", d.UpdateWebhook))
	admin.Delete("/api/v1/lists/{id}/webhooks/{wid}", observability.RecordSurfaceFunc("lists", "webhook_delete", d.DeleteWebhook))
	admin.Post("/api/v1/lists/{id}/webhooks/{wid}/rotate-secret", observability.RecordSurfaceFunc("lists", "webhook_rotate", d.RotateWebhookSecret))
	admin.Post("/api/v1/lists/{id}/webhooks/{wid}/test", observability.RecordSurfaceFunc("lists", "webhook_test", d.TestWebhook))
	admin.Get("/api/v1/lists/{id}/webhooks/{wid}/deliveries", d.WebhookDeliveries)
}

// webhookEventCatalog only advertises events the transactional list fanout
// actually emits. Expanding this catalog before wiring a durable producer
// would make a successfully saved subscription silently dishonest.
var webhookEventCatalog = map[string]struct{}{
	outbound_webhooks.EventListSubscriberAdded: {},
}

var (
	errListWebhookIdempotencyRequired = errors.New("lists: webhook idempotency key required")
	errListWebhookIdempotencyInvalid  = errors.New("lists: webhook idempotency key invalid")
)

func requiredListWebhookIdempotencyKey(header http.Header) (string, error) {
	values := header.Values(idempotency.HeaderName)
	if len(values) != 1 {
		if len(values) == 0 {
			return "", errListWebhookIdempotencyRequired
		}
		return "", errListWebhookIdempotencyInvalid
	}
	key := strings.TrimSpace(values[0])
	if key == "" {
		return "", errListWebhookIdempotencyRequired
	}
	if len(key) > idempotency.MaxKeyLength ||
		!utf8.ValidString(key) ||
		strings.IndexFunc(key, unicode.IsControl) >= 0 {
		return "", errListWebhookIdempotencyInvalid
	}
	return key, nil
}

func requireListWebhookIdempotencyKey(w http.ResponseWriter, r *http.Request) bool {
	_, err := requiredListWebhookIdempotencyKey(r.Header)
	if err == nil {
		return true
	}
	if errors.Is(err, errListWebhookIdempotencyRequired) {
		httperror.WriteValidation(
			w,
			"idempotency_key_required",
			"Idempotency-Key is required for this one-time signing-secret operation",
		)
		return false
	}
	httperror.WriteValidation(
		w,
		"idempotency_key_invalid",
		"Idempotency-Key must be supplied exactly once as 1-255 valid UTF-8 bytes without control characters",
	)
	return false
}

func validateWebhookEvents(events []string) error {
	if len(events) == 0 {
		return fmt.Errorf("events required")
	}
	if len(events) > 25 {
		return fmt.Errorf("at most 25 events per webhook")
	}
	for _, e := range events {
		if _, ok := webhookEventCatalog[e]; !ok {
			return fmt.Errorf("unknown event %q", e)
		}
	}
	return nil
}

func validateWebhookURL(raw string, requireHTTPS bool) error {
	return outbound_webhooks.ValidateURL(raw, requireHTTPS)
}

// ListWebhook is the per-list projection of an outbound_webhooks row.
// We omit signing material — list-scoped consumers see only what they
// need to manage the subscription.
type ListWebhook struct {
	ID                   string     `json:"id"`
	URL                  string     `json:"url"`
	Description          string     `json:"description,omitempty"`
	Events               []string   `json:"events"`
	Active               bool       `json:"active"`
	URLStatus            string     `json:"url_status"`
	AuthConfigStatus     string     `json:"auth_config_status"`
	DeliveryPolicyStatus string     `json:"delivery_policy_status"`
	CreatedAt            time.Time  `json:"created_at"`
	UpdatedAt            time.Time  `json:"updated_at"`
	LastSucceeded        *time.Time `json:"last_succeeded_at,omitempty"`
	LastFailed           *time.Time `json:"last_failed_at,omitempty"`
	// SigningSecret is returned once on create. It is never persisted in this
	// projection or returned by list/get/update operations.
	SigningSecret string `json:"signing_secret,omitempty"`
}

func projectCanonicalListWebhook(webhook *outbound_webhooks.Webhook) *ListWebhook {
	if webhook == nil {
		return nil
	}
	return &ListWebhook{
		ID:                   webhook.ID,
		URL:                  webhook.URL,
		Description:          webhook.Description,
		Events:               append([]string(nil), webhook.Events...),
		Active:               webhook.Active,
		URLStatus:            webhook.URLStatus,
		AuthConfigStatus:     webhook.AuthConfigStatus,
		DeliveryPolicyStatus: webhook.DeliveryPolicyStatus,
		CreatedAt:            webhook.CreatedAt,
		UpdatedAt:            webhook.UpdatedAt,
		LastSucceeded:        webhook.LastSucceededAt,
		LastFailed:           webhook.LastFailedAt,
	}
}

// ListWebhooks GET /api/v1/lists/{id}/webhooks
func (d *Deps) ListWebhooks(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	limit, cursor, err := pagination.ReadParams(r.URL.Query())
	if err != nil {
		httperror.WriteValidation(w, "invalid_cursor", "cursor is malformed")
		return
	}
	out, nextCursor, err := d.Repo.ListWebhooksForList(
		r.Context(),
		tenantID,
		listUUID,
		limit,
		cursor,
	)
	if err != nil {
		if errors.Is(err, ErrListIDNotMapped) {
			httperror.Write(w, http.StatusNotFound, "list_not_found", "list not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"list_id":     listUUID,
		"webhooks":    out,
		"next_cursor": nextCursor,
	})
}

// CreateWebhookInput is the body for POST /api/v1/lists/{id}/webhooks.
type CreateWebhookInput struct {
	URL         string   `json:"url"`
	Description string   `json:"description,omitempty"`
	Events      []string `json:"events"`
}

// CreateWebhook POST /api/v1/lists/{id}/webhooks
func (d *Deps) CreateWebhook(w http.ResponseWriter, r *http.Request) {
	if !requireListWebhookIdempotencyKey(w, r) {
		return
	}
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	var in CreateWebhookInput
	if err := httpbody.DecodeJSON(w, r, archiveJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := validateWebhookURL(in.URL, d.RequireWebhookHTTPS); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_url", err.Error())
		return
	}
	if err := validateWebhookEvents(in.Events); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_events", err.Error())
		return
	}
	userID := actorUserID(r.Context())
	wh, err := d.Repo.CreateListWebhook(r.Context(), tenantID, listUUID, userID, in)
	if err != nil {
		d.writeListWebhookStoreError(w, r, err)
		return
	}
	safeAuditWebhook := *wh
	safeAuditWebhook.SigningSecret = ""
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.webhook.create", "list_webhook", wh.ID,
		nil, &safeAuditWebhook, map[string]any{"list_id": listUUID})
	writeJSON(w, http.StatusCreated, wh)
}

// UpdateWebhookInput is the body for PATCH /api/v1/lists/{id}/webhooks/{wid}.
type UpdateWebhookInput struct {
	URL         *string   `json:"url,omitempty"`
	Description *string   `json:"description,omitempty"`
	Events      *[]string `json:"events,omitempty"`
	Active      *bool     `json:"active,omitempty"`
}

// UpdateWebhook PATCH /api/v1/lists/{id}/webhooks/{wid}
func (d *Deps) UpdateWebhook(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	wid := strings.TrimSpace(chi.URLParam(r, "wid"))
	if wid == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "wid required"))
		return
	}
	var in UpdateWebhookInput
	if err := httpbody.DecodeJSON(w, r, archiveJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.URL != nil {
		if err := validateWebhookURL(*in.URL, d.RequireWebhookHTTPS); err != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_url", err.Error())
			return
		}
	}
	if in.Events != nil {
		if err := validateWebhookEvents(*in.Events); err != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_events", err.Error())
			return
		}
	}
	wh, err := d.Repo.UpdateListWebhook(r.Context(), tenantID, listUUID, wid, in)
	if err != nil {
		d.writeListWebhookStoreError(w, r, err)
		return
	}
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.webhook.update", "list_webhook", wid,
		nil, in, map[string]any{"list_id": listUUID})
	writeJSON(w, http.StatusOK, wh)
}

// DeleteWebhook DELETE /api/v1/lists/{id}/webhooks/{wid}
func (d *Deps) DeleteWebhook(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	wid := strings.TrimSpace(chi.URLParam(r, "wid"))
	if wid == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "wid required"))
		return
	}
	if err := d.Repo.DeleteListWebhook(r.Context(), tenantID, listUUID, wid); err != nil {
		d.writeListWebhookStoreError(w, r, err)
		return
	}
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.webhook.delete", "list_webhook", wid,
		nil, nil, map[string]any{"list_id": listUUID})
	w.WriteHeader(http.StatusNoContent)
}

func listWebhookRotationGraceMinutes(r *http.Request) (int, error) {
	const defaultGraceMinutes = 24 * 60
	values, present := r.URL.Query()["grace_minutes"]
	if !present {
		return defaultGraceMinutes, nil
	}
	if len(values) != 1 {
		return 0, fmt.Errorf("grace_minutes must be provided exactly once")
	}
	value := strings.TrimSpace(values[0])
	minutes, err := strconv.Atoi(value)
	if err != nil || minutes < 1 || minutes > 7*24*60 {
		return 0, fmt.Errorf("grace_minutes must be an integer from 1 through 10080")
	}
	return minutes, nil
}

// RotateWebhookSecret POST /api/v1/lists/{id}/webhooks/{wid}/rotate-secret.
//
// Rotation stays list-scoped: the child is verified against the parent before
// canonical rotation, and the new HMAC secret is flattened into the same
// shown-once response used by create. Authenticated Idempotency-Key middleware
// binds caller retries before this handler runs.
func (d *Deps) RotateWebhookSecret(w http.ResponseWriter, r *http.Request) {
	if !requireListWebhookIdempotencyKey(w, r) {
		return
	}
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	wid := strings.TrimSpace(chi.URLParam(r, "wid"))
	if wid == "" {
		httperror.WriteValidation(w, "missing_id", "wid required")
		return
	}
	graceMinutes, err := listWebhookRotationGraceMinutes(r)
	if err != nil {
		httperror.WriteValidation(w, "invalid_grace_minutes", err.Error())
		return
	}
	webhook, err := d.Repo.RotateListWebhook(
		r.Context(),
		tenantID,
		listUUID,
		wid,
		time.Duration(graceMinutes)*time.Minute,
	)
	if err != nil {
		d.writeListWebhookStoreError(w, r, err)
		return
	}
	safeAuditWebhook := *webhook
	safeAuditWebhook.SigningSecret = ""
	audit.EmitOrLog(
		r.Context(),
		d.auditPool(),
		"list.webhook.rotate",
		"list_webhook",
		wid,
		nil,
		&safeAuditWebhook,
		map[string]any{"list_id": listUUID, "grace_minutes": graceMinutes},
	)
	writeJSON(w, http.StatusOK, webhook)
}

// TestWebhook POST /api/v1/lists/{id}/webhooks/{wid}/test.
//
// The parent/list check happens first so this compatibility route cannot be
// used to probe another list's endpoint. The canonical handler then performs
// the exact signed, transformed, credential-aware and redacted test flow used
// by /api/v1/outbound-webhooks/{id}/test.
func (d *Deps) TestWebhook(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	wid := strings.TrimSpace(chi.URLParam(r, "wid"))
	if wid == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "wid required"))
		return
	}
	if _, err := d.Repo.GetListWebhook(r.Context(), tenantID, listUUID, wid); err != nil {
		d.writeListWebhookStoreError(w, r, err)
		return
	}
	d.canonicalOutboundWebhookDeps().Test(
		w,
		requestWithCanonicalWebhookID(r, wid),
	)
}

// WebhookDeliveries GET /api/v1/lists/{id}/webhooks/{wid}/deliveries?limit=50
//
// Returns the canonical stable, cursor-paginated delivery history. The legacy
// list_webhook_deliveries test-only table is not part of this contract.
func (d *Deps) WebhookDeliveries(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	wid := strings.TrimSpace(chi.URLParam(r, "wid"))
	if wid == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "wid required"))
		return
	}
	if _, err := d.Repo.GetListWebhook(r.Context(), tenantID, listUUID, wid); err != nil {
		d.writeListWebhookStoreError(w, r, err)
		return
	}
	d.canonicalOutboundWebhookDeps().Deliveries(
		w,
		requestWithCanonicalWebhookID(r, wid),
	)
}

func (d *Deps) canonicalOutboundWebhookDeps() *outbound_webhooks.Deps {
	return &outbound_webhooks.Deps{
		Store:        d.Repo.OutboundWebhooks,
		HTTPClient:   d.WebhookHTTPClient,
		RequireHTTPS: d.RequireWebhookHTTPS,
		Logger:       d.Logger,
	}
}

func requestWithCanonicalWebhookID(r *http.Request, webhookID string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("id", webhookID)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, routeContext))
}

func (d *Deps) writeListWebhookStoreError(
	w http.ResponseWriter,
	r *http.Request,
	err error,
) {
	switch {
	case errors.Is(err, errWebhookMissing),
		errors.Is(err, outbound_webhooks.ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "webhook not found")
	case errors.Is(err, outbound_webhooks.ErrRedactedDestination):
		httperror.Write(
			w,
			http.StatusBadRequest,
			"redacted_destination",
			"enter the complete destination URL; the displayed address hides its path and query",
		)
	case errors.Is(err, outbound_webhooks.ErrInvalidURL):
		httperror.Write(w, http.StatusBadRequest, "invalid_url", "url must be a valid http(s) URL")
	case errors.Is(err, outbound_webhooks.ErrInvalidDescription):
		httperror.WriteValidation(w, "invalid_description", "description must be at most 512 characters")
	case errors.Is(err, outbound_webhooks.ErrInvalidListID):
		httperror.WriteValidation(w, "invalid_list_id", "list id must be a UUID")
	case errors.Is(err, outbound_webhooks.ErrListNotFound):
		httperror.Write(w, http.StatusNotFound, "list_not_found", "list not found")
	case errors.Is(err, errListWebhookRotationRequiresHMAC):
		httperror.Write(
			w,
			http.StatusConflict,
			"list_rotation_requires_hmac",
			"rotate asymmetric signing material from the global Outbound Webhooks workspace",
		)
	case errors.Is(err, outbound_webhooks.ErrEventsRequired):
		httperror.WriteValidation(w, "events_required", "at least one event type is required")
	case errors.Is(err, outbound_webhooks.ErrInvalidEvent):
		httperror.WriteValidation(w, "invalid_event", "event is not available for list-scoped webhooks")
	case errors.Is(err, outbound_webhooks.ErrAuthConfigPending),
		errors.Is(err, outbound_webhooks.ErrAuthConfigInvalid):
		httperror.Write(
			w,
			http.StatusConflict,
			"receiver_auth_unavailable",
			"repair receiver authentication before activating this webhook",
		)
	case errors.Is(err, outbound_webhooks.ErrDestinationPending),
		errors.Is(err, outbound_webhooks.ErrDestinationInvalid):
		httperror.Write(
			w,
			http.StatusConflict,
			"destination_unavailable",
			"replace the destination URL before activating this webhook",
		)
	case errors.Is(err, outbound_webhooks.ErrDeliveryPolicyInvalid):
		httperror.Write(
			w,
			http.StatusConflict,
			"delivery_configuration_invalid",
			"repair the delivery policy before activating this webhook",
		)
	case errors.Is(err, outbound_webhooks.ErrCipherUnconfigured):
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"cipher_unconfigured",
			"this Moosewave deployment has no envelope cipher configured",
		))
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

// ----------------- repo -----------------

var errWebhookMissing = errors.New("webhook not found")
var errListWebhookRotationRequiresHMAC = errors.New("list webhook rotation requires hmac_sha256")

// CreateListWebhook is a compatibility façade over the canonical outbound
// store. It must never write outbound_webhooks directly: the canonical path
// owns signing/destination envelopes, description/event validation, list
// ownership, and one-time secret presentation.
func (r *Repo) CreateListWebhook(ctx context.Context, tenantID, listUUID, userID string, in CreateWebhookInput) (*ListWebhook, error) {
	if r == nil || r.OutboundWebhooks == nil {
		return nil, fmt.Errorf("lists: repo not configured")
	}
	created, err := r.OutboundWebhooks.Create(
		ctx,
		tenantID,
		userID,
		outbound_webhooks.CreateInput{
			URL:         in.URL,
			Description: in.Description,
			Events:      append([]string(nil), in.Events...),
			Algorithm:   outbound_webhooks.AlgorithmHMACSHA256,
			ListID:      listUUID,
		},
		r.OutboundWebhooks.RequireHTTPS,
	)
	if err != nil {
		return nil, err
	}
	projected := projectCanonicalListWebhook(created.Webhook)
	projected.SigningSecret = created.SigningSecret
	return projected, nil
}

// ListWebhooksForList reads outbound_webhooks WHERE list_id = listUUID.
func (r *Repo) ListWebhooksForList(
	ctx context.Context,
	tenantID string,
	listUUID string,
	limit int,
	cursor pagination.Cursor,
) ([]ListWebhook, string, error) {
	if r == nil || r.OutboundWebhooks == nil {
		return nil, "", fmt.Errorf("lists: repo not configured")
	}
	// A canonical UUID is only syntactically valid until list_id_map proves
	// that the active tenant owns it. Validate the parent before reading the
	// child catalog so unknown and cross-tenant UUIDs retain the list
	// façade's non-disclosing 404 semantics instead of being echoed in a
	// successful empty response.
	if _, err := r.GetListBigintIDByUUID(ctx, tenantID, listUUID); err != nil {
		return nil, "", err
	}
	webhooks, nextCursor, err := r.OutboundWebhooks.ListForListPage(
		ctx,
		tenantID,
		listUUID,
		limit,
		cursor,
	)
	if err != nil {
		return nil, "", err
	}
	out := make([]ListWebhook, 0, len(webhooks))
	for index := range webhooks {
		out = append(out, *projectCanonicalListWebhook(&webhooks[index]))
	}
	return out, nextCursor, nil
}

// GetListWebhook reads a single row scoped to (tenant, list, wid).
func (r *Repo) GetListWebhook(ctx context.Context, tenantID, listUUID, wid string) (*ListWebhook, error) {
	if r == nil || r.OutboundWebhooks == nil {
		return nil, fmt.Errorf("lists: repo not configured")
	}
	webhook, err := r.OutboundWebhooks.Get(ctx, tenantID, wid)
	if errors.Is(err, outbound_webhooks.ErrNotFound) {
		return nil, errWebhookMissing
	}
	if err != nil {
		return nil, err
	}
	if webhook.ListID != listUUID {
		return nil, errWebhookMissing
	}
	return projectCanonicalListWebhook(webhook), nil
}

// UpdateListWebhook patches the row in-place.
func (r *Repo) UpdateListWebhook(ctx context.Context, tenantID, listUUID, wid string, in UpdateWebhookInput) (*ListWebhook, error) {
	if r == nil || r.OutboundWebhooks == nil {
		return nil, fmt.Errorf("lists: repo not configured")
	}
	if _, err := r.GetListWebhook(ctx, tenantID, listUUID, wid); err != nil {
		return nil, err
	}
	webhook, err := r.OutboundWebhooks.Update(
		ctx,
		tenantID,
		wid,
		outbound_webhooks.UpdateInput{
			URL:         in.URL,
			Description: in.Description,
			Events:      in.Events,
			Active:      in.Active,
		},
		r.OutboundWebhooks.RequireHTTPS,
	)
	if errors.Is(err, outbound_webhooks.ErrNotFound) {
		return nil, errWebhookMissing
	}
	if err != nil {
		return nil, err
	}
	if webhook.ListID != listUUID {
		return nil, errWebhookMissing
	}
	return projectCanonicalListWebhook(webhook), nil
}

// DeleteListWebhook delegates to the canonical tombstone lifecycle so
// secrets are shredded and delivery evidence remains governed by retention.
func (r *Repo) DeleteListWebhook(ctx context.Context, tenantID, listUUID, wid string) error {
	if r == nil || r.OutboundWebhooks == nil {
		return fmt.Errorf("lists: repo not configured")
	}
	if _, err := r.GetListWebhook(ctx, tenantID, listUUID, wid); err != nil {
		return err
	}
	if err := r.OutboundWebhooks.Delete(ctx, tenantID, wid); errors.Is(err, outbound_webhooks.ErrNotFound) {
		return errWebhookMissing
	} else {
		return err
	}
}

// RotateListWebhook verifies the list-child ownership boundary, delegates key
// rotation to the canonical encrypted store, and returns only the list
// projection plus the one-time HMAC secret.
func (r *Repo) RotateListWebhook(
	ctx context.Context,
	tenantID string,
	listUUID string,
	wid string,
	graceWindow time.Duration,
) (*ListWebhook, error) {
	if r == nil || r.OutboundWebhooks == nil {
		return nil, fmt.Errorf("lists: repo not configured")
	}
	current, err := r.OutboundWebhooks.Get(ctx, tenantID, wid)
	if errors.Is(err, outbound_webhooks.ErrNotFound) {
		return nil, errWebhookMissing
	}
	if err != nil {
		return nil, err
	}
	if current.ListID != listUUID {
		return nil, errWebhookMissing
	}
	if current.SigningAlgorithm != outbound_webhooks.AlgorithmHMACSHA256 {
		return nil, errListWebhookRotationRequiresHMAC
	}
	rotated, err := r.OutboundWebhooks.Rotate(
		ctx,
		tenantID,
		wid,
		graceWindow,
	)
	if errors.Is(err, outbound_webhooks.ErrNotFound) {
		return nil, errWebhookMissing
	}
	if err != nil {
		return nil, err
	}
	if rotated.Webhook == nil || rotated.Webhook.ListID != listUUID {
		return nil, errWebhookMissing
	}
	projected := projectCanonicalListWebhook(rotated.Webhook)
	projected.SigningSecret = rotated.SigningSecret
	return projected, nil
}
