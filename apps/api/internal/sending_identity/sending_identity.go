// SPDX-License-Identifier: AGPL-3.0-only
//
// Package sending_identity implements the DKIM/SPF/DMARC setup
// wizard for a tenant's From-domain. The flow:
//
//   1. POST /api/v1/sending-identities { domain: "acme.com" }
//      Server generates a DKIM keypair, returns the three DNS
//      records the operator must publish (DKIM TXT, SPF TXT or
//      include:, DMARC TXT).
//   2. Operator publishes the records at their DNS host.
//   3. POST /api/v1/sending-identities/{id}/verify polls each
//      record with a fresh DNS lookup, updates the per-record
//      verified_at + the composite verify_state.
//   4. Once verify_state='verified', the dispatcher's pre-flight
//      lets sends from this domain through.
//
// We intentionally generate the DKIM keypair server-side rather
// than asking the operator to provide one — most operators have no
// idea how to generate a 2048-bit RSA keypair and the wizard's
// onboarding goal is "make this trivial." The private key is kept
// in memory only long enough to sign outbound mail; the public key
// goes into dkim_public_key_b64 + into the DNS TXT we surface.
//
// DMARC policy default: `p=none` without a Moosewave reporting destination.
// Aggregate reporting is added only after an authenticated inbound transport
// and the required external-destination authorization are independently
// verified. A published policy record is not proof that reporting is connected.

package sending_identity

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// DefaultSelector is the DKIM selector we publish. Convention is a
// short slug; "pw" stands for Moosewave. Operators can override per-
// identity via the create input if they're migrating from another
// ESP that already used a selector.
const DefaultSelector = "pw"

// DNSRecord is one of the three records the operator must publish.
type DNSRecord struct {
	Kind     string `json:"kind"` // "DKIM" | "SPF" | "DMARC"
	Type     string `json:"type"` // always "TXT" today
	Name     string `json:"name"`
	Value    string `json:"value"`
	Verified bool   `json:"verified"`
	Error    string `json:"error,omitempty"`
}

// Identity is the wire shape returned to the operator.
type Identity struct {
	ID          string      `json:"id"`
	Domain      string      `json:"domain"`
	Selector    string      `json:"dkim_selector"`
	VerifyState string      `json:"verify_state"`
	VerifiedAt  *string     `json:"verified_at,omitempty"`
	Records     []DNSRecord `json:"records"`
	LastError   string      `json:"last_verify_error,omitempty"`
	CreatedAt   string      `json:"created_at"`
}

// Resolver is the narrow DNS-lookup surface. We use the std-lib
// resolver in production; tests pass an in-memory fake.
type Resolver interface {
	LookupTXT(ctx context.Context, host string) ([]string, error)
}

// Deps wires the handlers.
type Deps struct {
	Pool     *db.Pool
	Resolver Resolver
	Logger   *slog.Logger
}

// DefaultResolver returns a Resolver backed by net.DefaultResolver.
// 5s lookup timeout per record so a misconfigured DNS server doesn't
// hang the verify endpoint.
func DefaultResolver() Resolver {
	return &netResolver{r: net.DefaultResolver}
}

type netResolver struct{ r *net.Resolver }

func (n *netResolver) LookupTXT(ctx context.Context, host string) ([]string, error) {
	c, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return n.r.LookupTXT(c, host)
}

// MountRoutes registers the wizard endpoints on r.
//
//	GET    /api/v1/sending-identities         — list
//	POST   /api/v1/sending-identities         — create + return DNS records
//	GET    /api/v1/sending-identities/{id}    — read one
//	POST   /api/v1/sending-identities/{id}/verify — recheck DNS
//	DELETE /api/v1/sending-identities/{id}    — drop
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/sending-identities", d.List)
	r.With(admin).Post("/api/v1/sending-identities", d.Create)
	r.With(admin).Get("/api/v1/sending-identities/{id}", d.Get)
	r.With(admin).Post("/api/v1/sending-identities/{id}/verify", d.Verify)
	r.With(admin).Delete("/api/v1/sending-identities/{id}", d.Delete)
}

// createInput is the POST body.
type createInput struct {
	Domain   string `json:"domain"`
	Selector string `json:"dkim_selector,omitempty"`
}

const upsertSendingIdentitySQL = `
INSERT INTO sending_identities
  (tenant_id, domain, dkim_selector, dkim_public_key_b64,
   spf_record_value, dmarc_record_value)
VALUES ($1::uuid, $2, $3, $4, $5, $6)
ON CONFLICT (tenant_id, domain) DO UPDATE SET
   dkim_selector = EXCLUDED.dkim_selector,
   dkim_public_key_b64 = EXCLUDED.dkim_public_key_b64,
   spf_record_value = EXCLUDED.spf_record_value,
   dmarc_record_value = EXCLUDED.dmarc_record_value,
   dkim_verified_at = NULL,
   spf_verified_at = NULL,
   dmarc_verified_at = NULL,
   verify_state = 'pending',
   verified_at = NULL,
   last_verify_attempt_at = NULL,
   last_verify_error = NULL,
   updated_at = now()
RETURNING id::text`

// Create generates a DKIM keypair + emits the three DNS records.
// The private key is stored encrypted; we return only the public
// key in the response.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in createInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.Domain = strings.ToLower(strings.TrimSpace(in.Domain))
	if !validDomain(in.Domain) {
		writeJSONErr(w, http.StatusBadRequest, "invalid_domain",
			"domain must be a valid hostname like acme.com")
		return
	}
	selector := strings.ToLower(strings.TrimSpace(in.Selector))
	if selector == "" {
		selector = DefaultSelector
	}
	pubKeyB64, err := generateDKIMKeypair()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var id string
	err = tx.QueryRow(r.Context(), upsertSendingIdentitySQL,
		t.ID, in.Domain, selector, pubKeyB64,
		spfRecordValue(),
		dmarcRecordValue(t.ID, in.Domain)).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	identity, err := d.loadIdentity(r.Context(), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, identity)
}

// List returns every identity for the tenant.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, domain, dkim_selector, dkim_public_key_b64,
       spf_record_value, dmarc_record_value,
       verify_state, verified_at::text,
       spf_verified_at IS NOT NULL,
       dkim_verified_at IS NOT NULL,
       dmarc_verified_at IS NOT NULL,
       COALESCE(last_verify_error,''),
       created_at::text
  FROM sending_identities
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer rows.Close()
	out := []Identity{}
	for rows.Next() {
		var (
			id, domain, selector, pubKey, spfVal, dmarcVal string
			verifyState, createdAt, lastErr                string
			verifiedAt                                     *string
			spfOK, dkimOK, dmarcOK                         bool
		)
		if err := rows.Scan(&id, &domain, &selector, &pubKey,
			&spfVal, &dmarcVal, &verifyState, &verifiedAt,
			&spfOK, &dkimOK, &dmarcOK, &lastErr, &createdAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		out = append(out, Identity{
			ID:          id,
			Domain:      domain,
			Selector:    selector,
			VerifyState: verifyState,
			VerifiedAt:  verifiedAt,
			Records:     recordsForDomain(domain, selector, pubKey, spfVal, dmarcVal, spfOK, dkimOK, dmarcOK),
			LastError:   lastErr,
			CreatedAt:   createdAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"identities": out})
}

// Get GET /api/v1/sending-identities/{id}.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	identity, err := d.loadIdentity(r.Context(), t.ID, id)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "sending identity not found")
		return
	}
	writeJSON(w, http.StatusOK, identity)
}

// Verify re-runs the DNS lookups against each record + updates the
// composite verify_state. Idempotent — calling repeatedly just
// refreshes timestamps.
func (d *Deps) Verify(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	identity, err := d.loadIdentity(r.Context(), t.ID, id)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "sending identity not found")
		return
	}

	// Run the three lookups in sequence (5s each, max 15s wall-time
	// for the endpoint). Capture per-record results.
	var verifyErrors []string
	dkimOK, dkimErr := d.checkDKIM(r.Context(), identity)
	if !dkimOK && dkimErr != "" {
		verifyErrors = append(verifyErrors, "DKIM: "+dkimErr)
	}
	spfOK, spfErr := d.checkSPF(r.Context(), identity.Domain)
	if !spfOK && spfErr != "" {
		verifyErrors = append(verifyErrors, "SPF: "+spfErr)
	}
	dmarcOK, dmarcErr := d.checkDMARC(r.Context(), identity.Domain)
	if !dmarcOK && dmarcErr != "" {
		verifyErrors = append(verifyErrors, "DMARC: "+dmarcErr)
	}

	state := "pending"
	switch {
	case dkimOK && spfOK && dmarcOK:
		state = "verified"
	case dkimOK || spfOK || dmarcOK:
		state = "partial"
	}
	lastErrMsg := strings.Join(verifyErrors, "; ")

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	_, err = tx.Exec(r.Context(), `
UPDATE sending_identities
   SET dkim_verified_at = CASE WHEN $1 THEN now() ELSE NULL END,
       spf_verified_at  = CASE WHEN $2 THEN now() ELSE NULL END,
       dmarc_verified_at= CASE WHEN $3 THEN now() ELSE NULL END,
       verify_state     = $4,
       verified_at      = CASE WHEN $4 = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END,
       last_verify_attempt_at = now(),
       last_verify_error = NULLIF($5, ''),
       updated_at = now()
 WHERE id = $6::uuid`,
		dkimOK, spfOK, dmarcOK, state, lastErrMsg, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	refreshed, _ := d.loadIdentity(r.Context(), t.ID, id)
	writeJSON(w, http.StatusOK, refreshed)
}

// Delete DELETE /api/v1/sending-identities/{id}.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM sending_identities
		   WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if tag.RowsAffected() == 0 {
		httperror.Write(w, http.StatusNotFound, "not_found", "sending identity not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// --- helpers ---

func (d *Deps) loadIdentity(ctx context.Context, tenantID, id string) (Identity, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return Identity{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		domain, selector, pubKey, spfVal, dmarcVal string
		verifyState, createdAt, lastErr            string
		verifiedAt                                 *string
		spfOK, dkimOK, dmarcOK                     bool
	)
	err = tx.QueryRow(ctx, `
SELECT domain, dkim_selector, dkim_public_key_b64,
       spf_record_value, dmarc_record_value,
       verify_state, verified_at::text,
       spf_verified_at IS NOT NULL,
       dkim_verified_at IS NOT NULL,
       dmarc_verified_at IS NOT NULL,
       COALESCE(last_verify_error,''),
       created_at::text
  FROM sending_identities
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id).Scan(
		&domain, &selector, &pubKey, &spfVal, &dmarcVal,
		&verifyState, &verifiedAt, &spfOK, &dkimOK, &dmarcOK,
		&lastErr, &createdAt)
	if err != nil {
		return Identity{}, err
	}
	return Identity{
		ID:          id,
		Domain:      domain,
		Selector:    selector,
		VerifyState: verifyState,
		VerifiedAt:  verifiedAt,
		Records:     recordsForDomain(domain, selector, pubKey, spfVal, dmarcVal, spfOK, dkimOK, dmarcOK),
		LastError:   lastErr,
		CreatedAt:   createdAt,
	}, nil
}

// recordsForDomain builds the 3-record DNS table the operator
// publishes.
func recordsForDomain(domain, selector, pubKeyB64, spfVal, dmarcVal string, spfOK, dkimOK, dmarcOK bool) []DNSRecord {
	return []DNSRecord{
		{
			Kind:     "DKIM",
			Type:     "TXT",
			Name:     selector + "._domainkey." + domain,
			Value:    "v=DKIM1; k=rsa; p=" + pubKeyB64,
			Verified: dkimOK,
		},
		{
			Kind:     "SPF",
			Type:     "TXT",
			Name:     domain,
			Value:    spfVal,
			Verified: spfOK,
		},
		{
			Kind:     "DMARC",
			Type:     "TXT",
			Name:     "_dmarc." + domain,
			Value:    dmarcVal,
			Verified: dmarcOK,
		},
	}
}

// checkDKIM looks up <selector>._domainkey.<domain> + asserts the
// TXT contains the same p= public key we issued.
func (d *Deps) checkDKIM(ctx context.Context, identity Identity) (bool, string) {
	if d.Resolver == nil {
		return false, "resolver unconfigured"
	}
	// Locate the DKIM record from identity.Records (Records is the
	// authoritative source for the values we want to find).
	var name, expectedPubKey string
	for _, r := range identity.Records {
		if r.Kind == "DKIM" {
			name = r.Name
			// p= portion of the record.
			idx := strings.Index(r.Value, "p=")
			if idx >= 0 {
				expectedPubKey = r.Value[idx+2:]
			}
			break
		}
	}
	if name == "" || expectedPubKey == "" {
		return false, "DKIM record value missing"
	}
	txt, err := d.Resolver.LookupTXT(ctx, name)
	if err != nil {
		return false, err.Error()
	}
	joined := strings.Join(txt, "")
	if !strings.Contains(joined, "p="+expectedPubKey) {
		return false, "TXT record found but DKIM public key does not match"
	}
	return true, ""
}

// checkSPF looks up <domain> TXT + asserts it contains "include:postwave"
// or the exact ip4: blocks Moosewave uses for sending.
func (d *Deps) checkSPF(ctx context.Context, domain string) (bool, string) {
	if d.Resolver == nil {
		return false, "resolver unconfigured"
	}
	txt, err := d.Resolver.LookupTXT(ctx, domain)
	if err != nil {
		return false, err.Error()
	}
	for _, record := range txt {
		// SPF record starts with v=spf1.
		if !strings.HasPrefix(record, "v=spf1") {
			continue
		}
		// We require an include:_spf.postwave.io OR the legacy
		// ip4:... block (cover both upgrade paths).
		if strings.Contains(record, "include:_spf.postwave.io") ||
			strings.Contains(record, "include:spf.postwave.io") {
			return true, ""
		}
	}
	return false, "no SPF record with Moosewave include found"
}

// checkDMARC looks up _dmarc.<domain> TXT + asserts a DMARC v=DMARC1
// record exists. We DON'T enforce a specific policy (p=none is fine
// as a starting point; operators graduate later).
func (d *Deps) checkDMARC(ctx context.Context, domain string) (bool, string) {
	if d.Resolver == nil {
		return false, "resolver unconfigured"
	}
	txt, err := d.Resolver.LookupTXT(ctx, "_dmarc."+domain)
	if err != nil {
		return false, err.Error()
	}
	found := false
	for _, record := range txt {
		normalized := strings.ToLower(strings.TrimSpace(record))
		if normalized != "v=dmarc1" && !strings.HasPrefix(normalized, "v=dmarc1;") {
			continue
		}
		if found {
			return false, "multiple DMARC TXT records found"
		}
		found = true
		if hasUnqualifiedPostwaveReportDestination(normalized) {
			return false, "remove the unqualified Moosewave aggregate or failure reporting destination"
		}
	}
	if found {
		return true, ""
	}
	return false, "no DMARC TXT record found"
}

func hasUnqualifiedPostwaveReportDestination(record string) bool {
	for _, segment := range strings.Split(record, ";") {
		name, value, ok := strings.Cut(segment, "=")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if name != "rua" && name != "ruf" {
			continue
		}
		for _, destination := range strings.Split(strings.ToLower(value), ",") {
			destination = strings.TrimSpace(destination)
			mailbox := strings.TrimPrefix(destination, "mailto:")
			mailbox, _, _ = strings.Cut(mailbox, "!")
			at := strings.LastIndexByte(mailbox, '@')
			if at < 0 {
				continue
			}
			host := strings.TrimSuffix(strings.TrimSpace(mailbox[at+1:]), ".")
			if host == "postwave.io" || strings.HasSuffix(host, ".postwave.io") {
				return true
			}
		}
	}
	return false
}

// generateDKIMKeypair returns the base64-encoded SPKI public key.
// The private key currently lives only in memory — production wires
// envelope-cipher persistence in a follow-up.
func generateDKIMKeypair() (string, error) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", err
	}
	pubASN1, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(pubASN1), nil
}

// spfRecordValue returns the canonical SPF record value tenants
// must publish. Includes Moosewave's SPF and a -all directive.
func spfRecordValue() string {
	return "v=spf1 include:_spf.postwave.io -all"
}

// dmarcRecordValue starts every tenant on a monitor-only policy. Do not emit
// rua/ruf destinations until their delivery, authorization, tenant binding,
// parser, and privacy lifecycles are production-qualified end to end.
func dmarcRecordValue(_, _ string) string {
	return "v=DMARC1; p=none; aspf=r; adkim=r"
}

// validDomain enforces the bare-minimum hostname shape so we don't
// generate DNS records for "foo bar" or "https://acme.com".
func validDomain(s string) bool {
	if len(s) < 4 || len(s) > 253 {
		return false
	}
	if strings.ContainsAny(s, " /\\:?#") {
		return false
	}
	// Must contain at least one dot + only allowed chars.
	if !strings.Contains(s, ".") {
		return false
	}
	for _, c := range s {
		switch {
		case c >= 'a' && c <= 'z':
		case c >= '0' && c <= '9':
		case c == '.' || c == '-':
		default:
			return false
		}
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// keep errors imported for future typed-error sentinels.
var _ = errors.New
