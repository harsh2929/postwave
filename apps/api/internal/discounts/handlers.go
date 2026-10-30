package discounts

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps bundles handler dependencies.
type Deps struct {
	Repo   *Repo
	Bridge StripeBridge
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Wired by the caller
	// after construction; nil-safe at the httperror call site.
	Logger *slog.Logger
}

const discountJSONMaxBodyBytes int64 = 64 << 10    // 64 KiB
const couponImportJSONMaxBodyBytes int64 = 1 << 20 // 1 MiB
const discountHistoryDefaultLimit = 50
const discountHistoryMaxLimit = 100
const discountHistoryMaxOffset = 10000

// MountRoutes is the fail-closed production boundary for Discounts. Only the
// sanitized historical archive and its PII-free recent-event timeline are
// reachable. Provider-backed checks/mutations, exports, coupon-pool inventory,
// and coupon issuance stay unmounted until their authority and reconciliation
// models are certified. In particular, apps/api currently composes Deps without
// a StripeBridge, so mounting Delete would expose a destructive control that can
// never complete honestly.
//
// ── WHAT CHANGED, 2026-08-18 (A1) ──────────────────────────────────────────
// The retained handlers below are implementation scaffolding, not mounted
// capabilities. Keeping that distinction at this boundary prevents a handler
// that compiles from being mistaken for a production route.
//
// Coupon-pool inventory and coupon issuance are the same release-held family:
// issuing a coupon mints provider state this deployment cannot reconcile.
//
// ── THE ONE THAT TOUCHES THE PROVIDER ──────────────────────────────────────
// Repo.Delete calls bridge.DeleteCoupon before deleting the local row. The
// process composition supplies no bridge, so the operation is unavailable; the
// web app must not advertise it as a transiently failing action.
func (d *Deps) MountRoutes(r chi.Router) {
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(discountHistoryNoStore, read).Get("/api/v1/discounts", d.List)
	r.With(discountHistoryNoStore, read).Get("/api/v1/discounts/{record_id}/redemptions", d.ListRedemptions)
}

func discountHistoryNoStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		next.ServeHTTP(w, r)
	})
}

// Check GET /api/v1/discounts/{code}/check — read-only redeemability
// probe. Mirrors what `Redeem` decides at the top of its flow, but
// never bumps the counter and never inserts a row. Used by the admin
// UI's "is this code usable right now?" panel.
//
// Returns:
//   - 404 when the code doesn't exist for the tenant.
//   - 200 with `{valid, currently_redeemable, reason}` otherwise.
//     `reason` is empty when the code is good.
func (d *Deps) Check(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	code := chi.URLParam(r, "code")
	disc, err := d.Repo.GetByCode(r.Context(), t.ID, code)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "discount not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	redeemable, reason := CheckRedeemable(disc, time.Now().UTC())
	writeJSON(w, http.StatusOK, RedeemResult{
		Code:                disc.Code,
		Valid:               true,
		CurrentlyRedeemable: redeemable,
		Reason:              reason,
	})
}

// Update PATCH /api/v1/discounts/{code}.
//
// Two safe, additive edits — anything else needs delete + recreate
// (the discount Code is the public identity; percent/amount aren't
// editable since changing them after redemptions would mean tenants
// got "the same code" for different terms).
//
//   - max_redemptions:
//
//   - bump higher than the current value to extend an active
//     campaign, OR
//
//   - set to null to remove the cap entirely.
//     Cannot be set lower than times_redeemed (would invalidate
//     already-redeemed rows).
//
//   - expires_at:
//
//   - push later than the current value to extend an active
//     campaign, OR
//
//   - set to null to remove the expiry.
//     Cannot be moved earlier (would retroactively invalidate
//     redemptions that happened in the now-skipped window).
//
// Bridge sync is intentionally NOT triggered for max_redemptions
// changes — Stripe coupons don't have a redemption cap that matches
// our semantics. Expiry sync is also skipped; the bridge is a
// best-effort mirror, not a master.
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	code := chi.URLParam(r, "code")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, discountJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.Update(r.Context(), t.ID, code, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "discount not found")
			return
		}
		if errors.Is(err, ErrInvalidInput) {
			httperror.WriteValidation(w, "invalid_input", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ExportRedemptions GET /api/v1/discounts/{code}/redemptions.csv.
//
// Streams up to 10_000 redemption rows as CSV. The audit lens: when
// an operator winds down a promo, they want a downloadable list of
// every redeeming subscriber for finance + support. We don't paginate
// the CSV (operators don't want to stitch 200 small files); the 10k
// cap is well above any realistic single-discount redemption volume.
//
// Headers: subscriber_email,subscriber_id,redeemed_at. Empty fields
// stay empty (anonymous checkouts have no subscriber yet).
func (d *Deps) ExportRedemptions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	code := chi.URLParam(r, "code")
	items, err := d.Repo.ListRedemptions(r.Context(), t.ID, code, 10000, 0)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "discount not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set(
		"Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s-redemptions.csv"`,
			strings.ToLower(strings.TrimSpace(code))),
	)
	cw := csv.NewWriter(w)
	defer cw.Flush()
	_ = cw.Write([]string{"subscriber_email", "subscriber_id", "redeemed_at"})
	for _, it := range items {
		_ = cw.Write([]string{
			it.SubscriberEmail,
			it.SubscriberID,
			it.RedeemedAt.UTC().Format(time.RFC3339),
		})
	}
}

// Create POST /api/v1/discounts.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, discountJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.Create(r.Context(), d.Bridge, t.ID, in)
	if err != nil {
		if errors.Is(err, ErrInvalidInput) {
			httperror.WriteValidation(w, "invalid_input", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// List GET /api/v1/discounts.
//
// This archive projection rejects the legacy code-search query: searching by
// redeemable code would recreate a code-existence oracle. An optional opaque
// record_id filter supports a saved detail link without scanning every page.
// Raw codes, provider IDs, and tenant IDs are never selected or serialized.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	if err := archiveQueryKeys(r, "limit", "offset", "record_id"); err != nil {
		httperror.WriteValidation(w, "invalid_query", "discount history query contains an unsupported or malformed parameter")
		return
	}
	recordID, err := archiveOptionalUUIDParam(r, "record_id")
	if err != nil {
		httperror.WriteValidation(w, "invalid_record_id", "record_id must be a canonical UUID")
		return
	}
	limit, err := archiveIntParam(r, "limit", discountHistoryDefaultLimit, 1, discountHistoryMaxLimit)
	if err != nil {
		httperror.WriteValidation(w, "invalid_pagination", "limit must be a whole number from 1 to 100")
		return
	}
	offset, err := archiveIntParam(r, "offset", 0, 0, discountHistoryMaxOffset)
	if err != nil {
		httperror.WriteValidation(w, "invalid_pagination", "offset must be a whole number from 0 to 10000")
		return
	}
	items, hasMore, err := d.Repo.ListHistoricalRecords(r.Context(), t.ID, recordID, limit, offset)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "has_more": hasMore})
}

// Delete DELETE /api/v1/discounts/{code}.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	code := chi.URLParam(r, "code")
	if err := d.Repo.Delete(r.Context(), d.Bridge, t.ID, code); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "discount not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ListRedemptions GET /api/v1/discounts/{record_id}/redemptions.
//
// The route retains its established path shape, but the path value is now the
// opaque record ID returned by List—not a redeemable code. The response omits
// subscriber IDs, emails, tenant IDs, provider IDs, and the discount code.
func (d *Deps) ListRedemptions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	recordID, err := canonicalArchiveUUID(chi.URLParam(r, "record_id"))
	if err != nil {
		httperror.WriteValidation(w, "invalid_record_id", "discount record id must be a canonical UUID")
		return
	}
	if err := archiveQueryKeys(r, "limit", "offset"); err != nil {
		httperror.WriteValidation(w, "invalid_query", "discount event-history query contains an unsupported or malformed parameter")
		return
	}
	limit, err := archiveIntParam(r, "limit", discountHistoryDefaultLimit, 1, discountHistoryMaxLimit)
	if err != nil {
		httperror.WriteValidation(w, "invalid_pagination", "limit must be a whole number from 1 to 100")
		return
	}
	offset, err := archiveIntParam(r, "offset", 0, 0, discountHistoryMaxOffset)
	if err != nil {
		httperror.WriteValidation(w, "invalid_pagination", "offset must be a whole number from 0 to 10000")
		return
	}
	items, err := d.Repo.ListHistoricalRedemptionEvents(r.Context(), t.ID, recordID, limit+1, offset)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "discount record not found")
			return
		}
		if errors.Is(err, ErrInvalidInput) {
			httperror.WriteValidation(w, "invalid_input", "discount record id must be a UUID")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "has_more": hasMore})
}

// Redeem POST /api/v1/discounts/{code}/redeem.
func (d *Deps) Redeem(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	code := chi.URLParam(r, "code")
	var body CouponRedemptionInput
	if r.ContentLength > 0 {
		if err := httpbody.DecodeJSONWith(w, r, discountJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	res, err := d.Repo.Redeem(r.Context(), t.ID, code, body, time.Now().UTC())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (d *Deps) ListCouponPools(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	page, err := d.Repo.ListCouponPools(r.Context(), t.ID, r.URL.Query().Get("status"), intParam(r, "limit", 50), intParam(r, "offset", 0))
	if err != nil {
		d.writeCouponError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (d *Deps) UpsertCouponPool(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	var in CouponPoolInput
	if err := httpbody.DecodeJSON(w, r, discountJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.UpsertCouponPool(r.Context(), t.ID, in)
	if err != nil {
		d.writeCouponError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetCouponPool(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	out, err := d.Repo.GetCouponPool(r.Context(), t.ID, chi.URLParam(r, "pool_id"))
	if err != nil {
		d.writeCouponError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ImportCouponCodes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	var in CouponCodeImportInput
	if err := httpbody.DecodeJSON(w, r, couponImportJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.ImportCouponCodes(r.Context(), t.ID, chi.URLParam(r, "pool_id"), in, time.Now().UTC())
	if err != nil {
		d.writeCouponError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ListCouponCodes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	page, err := d.Repo.ListCouponCodes(r.Context(), t.ID, chi.URLParam(r, "pool_id"), r.URL.Query().Get("status"), intParam(r, "limit", 50), intParam(r, "offset", 0))
	if err != nil {
		d.writeCouponError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (d *Deps) AssignCoupon(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	var in CouponAssignmentInput
	if err := httpbody.DecodeJSON(w, r, discountJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.AssignCoupon(r.Context(), t.ID, chi.URLParam(r, "pool_id"), in, time.Now().UTC())
	if err != nil {
		d.writeCouponError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListCouponAssignments(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	page, err := d.Repo.ListCouponAssignments(r.Context(), t.ID, chi.URLParam(r, "pool_id"), r.URL.Query().Get("status"), intParam(r, "limit", 50), intParam(r, "offset", 0))
	if err != nil {
		d.writeCouponError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (d *Deps) writeCouponError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "resource not found")
	case errors.Is(err, ErrInvalidInput):
		httperror.WriteValidation(w, "invalid_input", err.Error())
	case errors.Is(err, ErrCouponQuotaExceeded):
		// Distinct from exhaustion on purpose: the pool may be full. Reporting
		// this as "ran out of codes" sends an operator to buy inventory they
		// already have instead of looking at what is drawing so much of it.
		httperror.Write(w, http.StatusConflict, "coupon_quota_exceeded", err.Error())
	case errors.Is(err, ErrCouponExhausted):
		// coupon_pool_exhausted is operator-authored and safe to echo
		// (Repo-emitted message describing why no codes remain). It is
		// not in httperror's safe-echo allowlist so we use Write
		// directly with the explicit status; the message text is
		// guaranteed safe by Repo's emit site.
		httperror.Write(w, http.StatusConflict, "coupon_pool_exhausted", err.Error())
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func intParam(r *http.Request, key string, fallback int) int {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return fallback
	}
	n := 0
	for _, ch := range raw {
		if ch < '0' || ch > '9' {
			return fallback
		}
		n = n*10 + int(ch-'0')
		if n > 10000 {
			return fallback
		}
	}
	return n
}

// archiveIntParam rejects malformed or out-of-range values instead of silently
// falling back to a different page. Silent fallback makes distinct saved URLs
// render the same data and can misstate which evidence an operator inspected.
func archiveIntParam(r *http.Request, key string, fallback, min, max int) (int, error) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return 0, fmt.Errorf("query is malformed")
	}
	values, present := query[key]
	if !present {
		return fallback, nil
	}
	if len(values) != 1 || values[0] == "" {
		return 0, fmt.Errorf("%s must appear exactly once with a value", key)
	}
	raw := values[0]
	if len(raw) > 1 && raw[0] == '0' {
		return 0, fmt.Errorf("%s is not canonical", key)
	}
	value := 0
	for _, ch := range raw {
		if ch < '0' || ch > '9' {
			return 0, fmt.Errorf("%s is not a whole number", key)
		}
		value = value*10 + int(ch-'0')
		if value > max {
			return 0, fmt.Errorf("%s is out of range", key)
		}
	}
	if value < min || value > max {
		return 0, fmt.Errorf("%s is out of range", key)
	}
	return value, nil
}

func archiveQueryKeys(r *http.Request, allowed ...string) error {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return err
	}
	accepted := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		accepted[key] = struct{}{}
	}
	for key := range query {
		if _, ok := accepted[key]; !ok {
			return fmt.Errorf("unsupported query parameter %q", key)
		}
	}
	return nil
}

func archiveOptionalUUIDParam(r *http.Request, key string) (string, error) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return "", err
	}
	values, present := query[key]
	if !present {
		return "", nil
	}
	if len(values) != 1 || values[0] == "" {
		return "", fmt.Errorf("%s must appear exactly once with a value", key)
	}
	canonical, err := canonicalArchiveUUID(values[0])
	if err != nil {
		return "", fmt.Errorf("%s is not a canonical UUID", key)
	}
	return canonical, nil
}

func canonicalArchiveUUID(raw string) (string, error) {
	parsed, err := uuid.Parse(raw)
	if err != nil || parsed.String() != raw {
		return "", fmt.Errorf("value is not a canonical UUID")
	}
	return parsed.String(), nil
}
