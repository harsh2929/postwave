// mirror_clients.go — desktop audit A6 / GAP-LS-026. Real
// suppression-pull MirrorClient implementations for Mailchimp and
// SendGrid, plus the credential source they share.
//
// Credentials resolve in two steps:
//
//  1. tenant config — the active tenant_deliverability_providers row names a
//     runtime-vault secret in config.credential_ref. The secret may contain a
//     raw key or JSON with api_key/token/key. Legacy config.api_key remains
//     readable only long enough to migrate old rows.
//  2. env fallback — POSTWAVE_MIRROR_<PROVIDER>_API_KEY (uppercased),
//     for single-tenant / self-hosted deploys without per-tenant rows.
//
// Neither present → a typed ErrMirrorNotConfigured which the Mirror
// handler maps to a 503 {"not_configured":true} so the dashboard can
// render a setup prompt instead of an error toast.
//
// Both clients take a BaseURL override so tests fake the provider with
// httptest.Server; production leaves it empty and gets the real API
// host (SendGrid: api.sendgrid.com; Mailchimp: the datacenter encoded
// in the API key suffix, e.g. "...-us21" → us21.api.mailchimp.com).

package suppressions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/integration_egress"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

// ErrMirrorNotConfigured is the typed "no credentials" error. The
// Mirror handler turns anything wrapping it into a 503 not_configured
// response rather than a 500.
var ErrMirrorNotConfigured = errors.New("suppressions: mirror provider not configured")

// MirrorCredentialSource resolves the API key a mirror client should
// use for (tenant, provider). Implementations return an error wrapping
// ErrMirrorNotConfigured when no key exists anywhere.
type MirrorCredentialSource interface {
	APIKey(ctx context.Context, tenantID string, provider MirrorProvider) (string, error)
}

// MirrorRuntimeSecretResolver is the narrow runtime-vault surface needed by
// the suppression mirror. The production packages/secrets resolver satisfies
// it; tests can inject a deterministic fake.
type MirrorRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
}

type mirrorCredentialConfigLookup func(context.Context, string, MirrorProvider) (credentialRef, legacyAPIKey string, err error)

// DBEnvMirrorCredentials is the production MirrorCredentialSource. New
// tenant configuration stores only config.credential_ref and resolves the
// actual API key through the runtime secret vault. A legacy config.api_key is
// read for migration compatibility but can no longer be written by the
// provider-config API. The process environment remains the self-hosted
// fallback when a tenant row has neither form.
type DBEnvMirrorCredentials struct {
	Pool    *db.Pool
	Secrets MirrorRuntimeSecretResolver
	lookup  mirrorCredentialConfigLookup
}

// mirrorEnvKey maps a provider to its env fallback variable name.
func mirrorEnvKey(p MirrorProvider) string {
	return "POSTWAVE_MIRROR_" + strings.ToUpper(string(p)) + "_API_KEY"
}

// APIKey implements MirrorCredentialSource.
func (c *DBEnvMirrorCredentials) APIKey(ctx context.Context, tenantID string, provider MirrorProvider) (string, error) {
	if c != nil && tenantID != "" && (c.Pool != nil || c.lookup != nil) {
		credentialRef, legacyKey, err := c.tenantConfigCredential(ctx, tenantID, provider)
		if err != nil {
			return "", err
		}
		if credentialRef != "" {
			if c.Secrets == nil {
				return "", fmt.Errorf("%w: %s credential reference exists but the runtime secret resolver is unavailable", ErrMirrorNotConfigured, provider)
			}
			secretName, err := tenantBoundMirrorSecretName(tenantID, credentialRef)
			if err != nil {
				return "", fmt.Errorf("%w: %s credential reference is invalid", ErrMirrorNotConfigured, provider)
			}
			raw, err := c.Secrets.Get(ctx, secretName)
			if err != nil {
				if errors.Is(err, pwsecrets.ErrNotFound) {
					return "", fmt.Errorf("%w: %s credential reference was not found", ErrMirrorNotConfigured, provider)
				}
				return "", fmt.Errorf("suppressions: resolve %s mirror credential: %w", provider, err)
			}
			key, err := mirrorAPIKeyFromSecret(raw)
			if err != nil {
				return "", fmt.Errorf("%w: %s credential reference has no usable API key", ErrMirrorNotConfigured, provider)
			}
			return key, nil
		}
		if legacyKey != "" {
			return legacyKey, nil
		}
	}
	if v := strings.TrimSpace(os.Getenv(mirrorEnvKey(provider))); v != "" {
		return v, nil
	}
	return "", fmt.Errorf("%w: %s (no active tenant mirror credential reference and %s unset)",
		ErrMirrorNotConfigured, provider, mirrorEnvKey(provider))
}

// tenantConfigCredential reads the vault reference and a legacy raw-key field
// from the tenant's active provider row. No row lets the env fallback run.
func (c *DBEnvMirrorCredentials) tenantConfigCredential(ctx context.Context, tenantID string, provider MirrorProvider) (string, string, error) {
	if c.lookup != nil {
		return c.lookup(ctx, tenantID, provider)
	}
	tx, err := db.WithTenant(ctx, c.Pool, tenantID)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var credentialRef, legacyKey string
	err = tx.QueryRow(ctx, `
SELECT COALESCE(config->>'credential_ref', config->>'credentials_ref', ''),
       COALESCE(config->>'api_key', '')
FROM tenant_deliverability_providers
WHERE tenant_id = $1::uuid AND provider = $2 AND active
LIMIT 1`, tenantID, string(provider)).Scan(&credentialRef, &legacyKey)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if cerr := tx.Commit(ctx); cerr != nil {
				return "", "", cerr
			}
			return "", "", nil
		}
		return "", "", fmt.Errorf("suppressions: mirror credential lookup: %w", err)
	}
	if cerr := tx.Commit(ctx); cerr != nil {
		return "", "", cerr
	}
	return strings.TrimSpace(credentialRef), strings.TrimSpace(legacyKey), nil
}

func tenantBoundMirrorSecretName(tenantID, rawRef string) (string, error) {
	tenantID = strings.TrimSpace(tenantID)
	ref := strings.Trim(strings.TrimSpace(rawRef), "/")
	if tenantID == "" || ref == "" {
		return "", errors.New("tenant and credential reference are required")
	}
	prefix := "tenants/" + tenantID + "/"
	if strings.HasPrefix(ref, "tenants/") {
		if !strings.HasPrefix(ref, prefix) || len(ref) == len(prefix) {
			return "", errors.New("credential reference belongs to another tenant")
		}
		return ref, nil
	}
	return prefix + ref, nil
}

func mirrorAPIKeyFromSecret(raw string) (string, error) {
	const maxMirrorCredentialBytes = 16 << 10
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > maxMirrorCredentialBytes {
		return "", errors.New("mirror credential is empty or oversized")
	}
	if !strings.HasPrefix(trimmed, "{") {
		return trimmed, nil
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return "", errors.New("mirror credential JSON is invalid")
	}
	for _, key := range []string{"api_key", "apiKey", "token", "key", "access_token"} {
		value, ok := payload[key].(string)
		if !ok {
			continue
		}
		if value = strings.TrimSpace(value); value != "" {
			return value, nil
		}
	}
	return "", errors.New("mirror credential JSON has no API key")
}

// StaticMirrorCredentials is a fixed-key MirrorCredentialSource for
// tests and single-key wiring. An empty Key yields the typed
// not-configured error.
type StaticMirrorCredentials struct {
	Key string
}

// APIKey implements MirrorCredentialSource.
func (s StaticMirrorCredentials) APIKey(_ context.Context, _ string, provider MirrorProvider) (string, error) {
	if strings.TrimSpace(s.Key) == "" {
		return "", fmt.Errorf("%w: %s (static key empty)", ErrMirrorNotConfigured, provider)
	}
	return s.Key, nil
}

// mirrorHTTPTimeout bounds each provider API call. Mirror runs are
// operator-triggered (a toast spinner), so fail fast rather than
// holding the request open on a slow provider.
const mirrorHTTPTimeout = 30 * time.Second

// mirrorPageSize is the per-page count requested from both providers.
const mirrorPageSize = 500

// mirrorGetJSON issues one authenticated GET and decodes the JSON
// body into out. Non-2xx responses are returned as errors with the
// status + a bounded body excerpt for the server-side log.
func mirrorGetJSON(ctx context.Context, hc *http.Client, req *http.Request, out any) error {
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		// A rejected key is a configuration problem, not a server
		// fault — surface it on the typed not-configured path so the
		// dashboard prompts for a working credential.
		return fmt.Errorf("%w: provider rejected API key (status %d)", ErrMirrorNotConfigured, resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		excerpt := string(body)
		if len(excerpt) > 200 {
			excerpt = excerpt[:200]
		}
		return fmt.Errorf("suppressions: mirror fetch %s: status %d: %s", req.URL.Path, resp.StatusCode, excerpt)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("suppressions: mirror decode %s: %w", req.URL.Path, err)
	}
	return nil
}

/* ---------- SendGrid ---------------------------------------------- */

// SendGridMirrorClient pulls the three SendGrid suppression lists:
//
//	GET /v3/suppression/bounces       → hard_bounce
//	GET /v3/suppression/spam_reports  → spam_complaint
//	GET /v3/suppression/unsubscribes  → global_unsubscribe
//
// All three accept start_time (unix seconds) + limit/offset paging and
// authenticate with `Authorization: Bearer <key>`.
type SendGridMirrorClient struct {
	Credentials MirrorCredentialSource
	// BaseURL overrides https://api.sendgrid.com (tests point this at
	// an httptest.Server).
	BaseURL string
	HTTP    *http.Client
}

// NewSendGridMirrorClient wires the production client.
func NewSendGridMirrorClient(creds MirrorCredentialSource) *SendGridMirrorClient {
	return &SendGridMirrorClient{Credentials: creds}
}

// sendgridSuppression is the wire row shared by all three endpoints
// (spam_reports/unsubscribes simply omit reason/status).
type sendgridSuppression struct {
	Created int64  `json:"created"`
	Email   string `json:"email"`
	Reason  string `json:"reason"`
	Status  string `json:"status"`
}

// FetchRecent implements MirrorClient.
func (c *SendGridMirrorClient) FetchRecent(ctx context.Context, tenantID string, since time.Time, limit int) ([]MirrorRecord, error) {
	if c == nil || c.Credentials == nil {
		return nil, fmt.Errorf("%w: sendgrid (client not wired)", ErrMirrorNotConfigured)
	}
	key, err := c.Credentials.APIKey(ctx, tenantID, MirrorProviderSendGrid)
	if err != nil {
		return nil, err
	}
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base = "https://api.sendgrid.com"
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: mirrorHTTPTimeout}
	}
	if limit <= 0 {
		limit = 5000
	}

	endpoints := []struct {
		path   string
		reason Reason
		kind   string // source_event_id prefix; stable per (email, list)
	}{
		{"/v3/suppression/bounces", ReasonHardBounce, "bounce"},
		{"/v3/suppression/spam_reports", ReasonSpamComplaint, "spam"},
		{"/v3/suppression/unsubscribes", ReasonGlobalUnsubscribe, "unsub"},
	}

	out := make([]MirrorRecord, 0, 64)
	for _, ep := range endpoints {
		for offset := 0; len(out) < limit; offset += mirrorPageSize {
			q := url.Values{}
			q.Set("start_time", strconv.FormatInt(since.Unix(), 10))
			q.Set("limit", strconv.Itoa(mirrorPageSize))
			q.Set("offset", strconv.Itoa(offset))
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+ep.path+"?"+q.Encode(), nil)
			if err != nil {
				return nil, err
			}
			req.Header.Set("Authorization", "Bearer "+key)
			req.Header.Set("Accept", "application/json")

			var page []sendgridSuppression
			if err := mirrorGetJSON(ctx, hc, req, &page); err != nil {
				return nil, fmt.Errorf("sendgrid %s: %w", ep.path, err)
			}
			for _, row := range page {
				if len(out) >= limit {
					break
				}
				email := strings.TrimSpace(row.Email)
				if email == "" {
					continue
				}
				meta := map[string]any{"sendgrid_list": ep.kind}
				if row.Reason != "" {
					meta["provider_reason"] = row.Reason
				}
				if row.Status != "" {
					meta["provider_status"] = row.Status
				}
				out = append(out, MirrorRecord{
					Email:  email,
					Reason: ep.reason,
					// Email-keyed (not timestamp-keyed) so repeated
					// mirror runs dedupe on (tenant, source,
					// source_event_id) instead of re-churning rows.
					SourceEventID: "sendgrid:" + ep.kind + ":" + strings.ToLower(email),
					CreatedAt:     time.Unix(row.Created, 0).UTC(),
					Metadata:      meta,
				})
			}
			if len(page) < mirrorPageSize {
				break // last page of this list
			}
		}
	}
	return out, nil
}

/* ---------- Mailchimp --------------------------------------------- */

// MailchimpMirrorClient pulls unsubscribed + cleaned members from the
// tenant's Mailchimp audiences:
//
//	GET /3.0/lists                                   (audience ids)
//	GET /3.0/lists/{id}/members?status=unsubscribed  → manual_unsubscribe
//	GET /3.0/lists/{id}/members?status=cleaned       → hard_bounce
//
// Mailchimp has no account-wide suppression list — "cleaned" (bounced/
// invalid) and "unsubscribed" member states per audience are the
// equivalent surface. Auth is HTTP basic with any username + the API
// key; the datacenter is the key's "-usNN" suffix.
type MailchimpMirrorClient struct {
	Credentials MirrorCredentialSource
	// BaseURL overrides the dc-derived https://{dc}.api.mailchimp.com/3.0
	// (tests point this at an httptest.Server).
	BaseURL string
	HTTP    *http.Client
}

// NewMailchimpMirrorClient wires the production client.
func NewMailchimpMirrorClient(creds MirrorCredentialSource) *MailchimpMirrorClient {
	return &MailchimpMirrorClient{Credentials: creds}
}

type mailchimpListsPage struct {
	Lists []struct {
		ID string `json:"id"`
	} `json:"lists"`
	TotalItems int `json:"total_items"`
}

type mailchimpMembersPage struct {
	Members []struct {
		ID           string    `json:"id"`
		EmailAddress string    `json:"email_address"`
		Status       string    `json:"status"`
		LastChanged  time.Time `json:"last_changed"`
		ListID       string    `json:"list_id"`
	} `json:"members"`
	TotalItems int `json:"total_items"`
}

var mailchimpDatacenterPattern = regexp.MustCompile(`^us[1-9][0-9]{0,2}$`)

// mailchimpBaseURL derives the API host from the key's dc suffix. Mailchimp
// currently issues lowercase usN datacenter labels; accepting only that
// bounded form prevents credential-controlled dots, ports, userinfo, Unicode,
// or suffix smuggling from influencing the outbound host.
func mailchimpBaseURL(apiKey string) (string, error) {
	apiKey = strings.TrimSpace(apiKey)
	i := strings.LastIndex(apiKey, "-")
	if i <= 0 || i == len(apiKey)-1 {
		return "", fmt.Errorf("%w: mailchimp (api key missing datacenter suffix, expected key-usNN)", ErrMirrorNotConfigured)
	}
	dc := apiKey[i+1:]
	if !mailchimpDatacenterPattern.MatchString(dc) {
		return "", fmt.Errorf("%w: mailchimp (invalid datacenter suffix, expected us followed by 1-3 digits)", ErrMirrorNotConfigured)
	}
	return "https://" + dc + ".api.mailchimp.com/3.0", nil
}

// FetchRecent implements MirrorClient.
func (c *MailchimpMirrorClient) FetchRecent(ctx context.Context, tenantID string, since time.Time, limit int) ([]MirrorRecord, error) {
	if c == nil || c.Credentials == nil {
		return nil, fmt.Errorf("%w: mailchimp (client not wired)", ErrMirrorNotConfigured)
	}
	key, err := c.Credentials.APIKey(ctx, tenantID, MirrorProviderMailchimp)
	if err != nil {
		return nil, err
	}
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base, err = mailchimpBaseURL(key)
		if err != nil {
			return nil, err
		}
	}
	// The central integration egress policy pins Mailchimp to
	// *.api.mailchimp.com, rejects cross-origin redirects, disables process
	// proxies, and revalidates public DNS addresses at dial time. Arbitrary
	// injected clients are accepted only by Go test binaries.
	hc := integration_egress.EnforceClient(c.HTTP,
		integration_egress.FamilyMarketing, string(MirrorProviderMailchimp), mirrorHTTPTimeout)
	if limit <= 0 {
		limit = 5000
	}

	get := func(path string, q url.Values, out any) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path+"?"+q.Encode(), nil)
		if err != nil {
			return err
		}
		req.SetBasicAuth("postwave", key)
		req.Header.Set("Accept", "application/json")
		return mirrorGetJSON(ctx, hc, req, out)
	}

	// Audience ids (cap at 100 audiences — Mailchimp plans top out far
	// below that; tenants beyond it should scope via per-list keys).
	var lists mailchimpListsPage
	{
		q := url.Values{}
		q.Set("count", "100")
		q.Set("fields", "lists.id,total_items")
		if err := get("/lists", q, &lists); err != nil {
			return nil, fmt.Errorf("mailchimp /lists: %w", err)
		}
	}

	statuses := []struct {
		status string
		reason Reason
	}{
		{"unsubscribed", ReasonManualUnsubscribe},
		{"cleaned", ReasonHardBounce},
	}

	out := make([]MirrorRecord, 0, 64)
	for _, l := range lists.Lists {
		for _, st := range statuses {
			for offset := 0; len(out) < limit; offset += mirrorPageSize {
				q := url.Values{}
				q.Set("status", st.status)
				q.Set("since_last_changed", since.UTC().Format(time.RFC3339))
				q.Set("count", strconv.Itoa(mirrorPageSize))
				q.Set("offset", strconv.Itoa(offset))
				q.Set("fields", "members.id,members.email_address,members.status,members.last_changed,members.list_id,total_items")

				var page mailchimpMembersPage
				if err := get("/lists/"+l.ID+"/members", q, &page); err != nil {
					return nil, fmt.Errorf("mailchimp list %s members: %w", l.ID, err)
				}
				for _, m := range page.Members {
					if len(out) >= limit {
						break
					}
					email := strings.TrimSpace(m.EmailAddress)
					if email == "" {
						continue
					}
					out = append(out, MirrorRecord{
						Email:  email,
						Reason: st.reason,
						// Member ids are the md5 of the lowercased
						// address — stable across runs, so dedup holds.
						SourceEventID: "mailchimp:" + l.ID + ":" + st.status + ":" + m.ID,
						CreatedAt:     m.LastChanged.UTC(),
						Metadata: map[string]any{
							"mailchimp_list_id": l.ID,
							"provider_status":   m.Status,
						},
					})
				}
				if len(page.Members) < mirrorPageSize {
					break // last page for this (list, status)
				}
			}
		}
	}
	return out, nil
}
