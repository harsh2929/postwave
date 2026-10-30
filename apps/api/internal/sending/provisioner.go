package sending

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// Tenant is the projection of tenants table data the provisioner needs.
type Tenant struct {
	ID   string
	Slug string
	Name string
	Tier string // "studio" | "sending" | "pro"
}

// State is the per-tenant sending_state row, returned without secrets.
type State struct {
	TenantID         string    `json:"tenant_id"`
	Tier             string    `json:"tier"`
	PostmarkServerID string    `json:"postmark_server_id,omitempty"`
	PostmarkStreamID string    `json:"postmark_stream_id,omitempty"`
	DKIMDomain       string    `json:"dkim_domain,omitempty"`
	DedicatedIP      string    `json:"dedicated_ip,omitempty"`
	WarmupStartedAt  time.Time `json:"warmup_started_at,omitempty"`
	WarmupDay        int       `json:"warmup_day"`
}

// StateRepo persists the sending_state row. PostgresStateRepo is used in the
// gateway; MemoryStateRepo is kept for tests and local fallback.
type StateRepo interface {
	Get(ctx context.Context, tenantID string) (*State, []byte /*encrypted token*/, error)
	Upsert(ctx context.Context, st *State, encryptedToken []byte) error
	Delete(ctx context.Context, tenantID string) error
}

type DeprovisionJob struct {
	ID               string
	TenantID         string
	PostmarkServerID string
	PostmarkStreamID string
	ScheduledAt      time.Time
	Attempts         int
}

type DeprovisionJobRepo interface {
	ScheduleDeprovision(ctx context.Context, tenantID, serverID, streamID string, scheduledAt time.Time) error
	ListDueDeprovisionJobs(ctx context.Context, now time.Time, limit int) ([]DeprovisionJob, error)
	MarkDeprovisionJobCompleted(ctx context.Context, id string, completedAt time.Time) error
	MarkDeprovisionJobFailed(ctx context.Context, id string, attemptedAt time.Time, errText string) error
}

// MemoryStateRepo is in-memory; tests + dev fallback only.
type MemoryStateRepo struct {
	rows map[string]*State
	toks map[string][]byte
	jobs map[string]DeprovisionJob
}

// NewMemoryStateRepo constructs an empty MemoryStateRepo.
func NewMemoryStateRepo() *MemoryStateRepo {
	return &MemoryStateRepo{rows: map[string]*State{}, toks: map[string][]byte{}, jobs: map[string]DeprovisionJob{}}
}

func (m *MemoryStateRepo) Get(ctx context.Context, tenantID string) (*State, []byte, error) {
	st, ok := m.rows[tenantID]
	if !ok {
		return nil, nil, nil
	}
	cp := *st
	return &cp, m.toks[tenantID], nil
}

func (m *MemoryStateRepo) Upsert(ctx context.Context, st *State, tok []byte) error {
	cp := *st
	m.rows[st.TenantID] = &cp
	if tok != nil {
		m.toks[st.TenantID] = tok
	}
	return nil
}

func (m *MemoryStateRepo) Delete(ctx context.Context, tenantID string) error {
	delete(m.rows, tenantID)
	delete(m.toks, tenantID)
	return nil
}

func (m *MemoryStateRepo) ScheduleDeprovision(ctx context.Context, tenantID, serverID, streamID string, scheduledAt time.Time) error {
	if serverID == "" {
		return nil
	}
	id := tenantID + ":" + serverID
	if _, exists := m.jobs[id]; exists {
		return nil
	}
	m.jobs[id] = DeprovisionJob{ID: id, TenantID: tenantID, PostmarkServerID: serverID, PostmarkStreamID: streamID, ScheduledAt: scheduledAt}
	return nil
}

func (m *MemoryStateRepo) ListDueDeprovisionJobs(ctx context.Context, now time.Time, limit int) ([]DeprovisionJob, error) {
	out := []DeprovisionJob{}
	for _, job := range m.jobs {
		if job.ScheduledAt.After(now) {
			continue
		}
		out = append(out, job)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (m *MemoryStateRepo) MarkDeprovisionJobCompleted(ctx context.Context, id string, completedAt time.Time) error {
	delete(m.jobs, id)
	return nil
}

func (m *MemoryStateRepo) MarkDeprovisionJobFailed(ctx context.Context, id string, attemptedAt time.Time, errText string) error {
	job := m.jobs[id]
	job.Attempts++
	job.ScheduledAt = attemptedAt.Add(time.Duration(job.Attempts) * time.Hour)
	m.jobs[id] = job
	return nil
}

// Provisioner orchestrates per-tenant Postmark + warmup setup on tier upgrades.
//
// Encryption: when EnvelopeCipher is set, new writes use envelope-encryption
// (DEK per payload, KEK wraps the DEK). EncryptionKey remains the legacy
// direct-AES-GCM key used to decrypt blobs written before the envelope
// upgrade. New code should always set EnvelopeCipher; EncryptionKey is kept
// solely for the backward-compat decrypt path.
type Provisioner struct {
	Postmark        *PostmarkClient
	Repo            StateRepo
	Warmup          WarmupTracker
	DedicatedIP     *DedicatedIPProvisioner
	EncryptionKey   []byte            // legacy KEK for v=0x01 blobs
	EnvelopeCipher  EnvelopeEncryptor // preferred path; nil → legacy direct
	DKIMRootDomain  string            // e.g. "mail.postwave.io"; per-tenant subdomain prepended.
	DefaultRegion   string            // dedicated-IP region for Pro tier.
	ProTierDailyCap int               // Pro tier post-warmup daily cap; 0 → schedule terminal.
}

// ManagedPostmarkProvisioningAvailable withholds all managed Postmark
// provisioning before the first provider or repository call. Postmark's
// CreateServer/CreateMessageStream operations do not accept a replay-safe
// idempotency key, while the current implementation records its durable state
// only after those effects complete. An ambiguous failure can therefore orphan
// billable provider resources on every retry. The Pro path additionally calls
// an undocumented dedicated-IP endpoint. Keep this false until provisioning is
// driven by a durable intent/outbox with provider reconciliation and the
// dedicated-IP contract is certified with Postmark.
const ManagedPostmarkProvisioningAvailable = false

// ErrManagedPostmarkProvisioningHeld is returned without a success-shaped
// State and before any provider or repository call while the release lock is
// closed.
var ErrManagedPostmarkProvisioningHeld = errors.New("managed Postmark provisioning is release-held")

// EnvelopeEncryptor is the minimum interface Provisioner needs from the
// crypto package. Defined here to avoid an import cycle in tests.
type EnvelopeEncryptor interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

// ProvisionTenant runs the upgrade flow when a tenant moves to Sending or Pro.
//
// Flow (Sending):
//
//  0. Idempotency guard: look up sending_state for this tenant. If a row
//     already exists with a PostmarkServerID, return it without making
//     any Postmark calls. Stripe webhooks redeliver freely, and Postmark's
//     CreateServer has no idempotency key — so a redelivery without this
//     guard creates a SECOND server, and on Pro tier rents a SECOND
//     dedicated IP. That's real money, every retry, until an operator
//     manually reconciles. The guard makes the call effectively
//     idempotent across Stripe + manual triggers.
//
//  1. POST /servers — create Postmark server. Capture ServerID + first ApiToken.
//
//  2. POST /servers/{id}/message-streams — create the broadcasts stream.
//
//  3. Compute per-tenant DKIM subdomain: "<slug>.{DKIMRootDomain}".
//
//  4. Encrypt server-token with EncryptionKey (AES-GCM).
//
//  5. Upsert sending_state row.
//
// Pro adds:
//
//  6. RentDedicatedIP + Warmup.Start.
func (p *Provisioner) ProvisionTenant(ctx context.Context, t Tenant) (*State, error) {
	if t.Tier == "studio" {
		return nil, fmt.Errorf("studio tier does not require Postmark provisioning")
	}
	if !ManagedPostmarkProvisioningAvailable {
		return nil, ErrManagedPostmarkProvisioningHeld
	}
	return p.provisionTenantUnlocked(ctx, t)
}

// provisionTenantUnlocked contains the candidate implementation behind the
// release lock. Focused tests exercise its deterministic mechanics, but callers
// must enter through ProvisionTenant so unqualified provider effects remain
// unreachable in production.
func (p *Provisioner) provisionTenantUnlocked(ctx context.Context, t Tenant) (*State, error) {
	if t.Tier == "studio" {
		return nil, fmt.Errorf("studio tier does not require Postmark provisioning")
	}

	// Step 0: idempotency guard. If we already provisioned this tenant
	// (e.g. on a prior Stripe webhook delivery), return the existing
	// state instead of creating duplicate Postmark resources.
	//
	// Fail loud on DB errors. If Repo.Get returns a real error (DB blip,
	// pool exhausted, network), we MUST NOT fall through — falling
	// through would create a duplicate Postmark server / dedicated IP
	// every time the DB is briefly unhealthy. Returning the error lets
	// Stripe redeliver the webhook later when the DB is back; the
	// retry will then hit this guard correctly.
	existing, _, gerr := p.Repo.Get(ctx, t.ID)
	if gerr != nil {
		return nil, fmt.Errorf("idempotency lookup: %w", gerr)
	}
	// "Already has a Postmark server" is the canonical idempotency signal.
	// `existing.Tier` may be empty for rows written before migration 0026
	// added the column; treat empty-tier-with-server-id as "already
	// provisioned, tier unknown" rather than falling through to create a
	// SECOND Postmark server. Real money was leaking on every Stripe
	// redelivery for legacy tenants until this fix.
	if existing != nil && existing.PostmarkServerID != "" {
		if existing.Tier == t.Tier || existing.Tier == "" {
			// Same tier (or unknown legacy tier) — return as-is.
			return existing, nil
		}
		// Real tier upgrade (e.g. Sending → Pro). Don't re-create the
		// Postmark server / message-stream / DKIM that already exist;
		// only provision the additions and update the tier in-place.
		return p.upgradeTierInPlace(ctx, t, existing)
	}

	srv, err := p.Postmark.CreateServer(ctx, "tenant-"+t.Slug, "blue")
	if err != nil {
		return nil, fmt.Errorf("create server: %w", err)
	}
	if len(srv.APITokens) == 0 {
		return nil, errors.New("postmark CreateServer returned no api tokens")
	}
	streamID := "broadcasts"
	if _, err := p.Postmark.CreateMessageStream(ctx, srv.ID, streamID); err != nil {
		return nil, fmt.Errorf("create stream: %w", err)
	}

	dkim := t.Slug + "." + strings.TrimPrefix(p.DKIMRootDomain, ".")
	var encrypted []byte
	if p.EnvelopeCipher != nil {
		encrypted, err = p.EnvelopeCipher.Encrypt(ctx, []byte(srv.APITokens[0]))
		// Format byte 0x02 → KMS-backed envelope (production); 0x01 →
		// static-key envelope. The provisioner doesn't know which the
		// EnvelopeCipher chose internally, so we read it back from the
		// blob's first byte for the metric label.
		if err == nil {
			observePostmarkTokenWrite(envelopeBackendLabel(encrypted))
		}
	} else {
		// Legacy path: direct AES-GCM with a 0x01 version prefix so future
		// reads can detect the format.
		raw, ierr := encryptToken(p.EncryptionKey, srv.APITokens[0])
		if ierr == nil {
			encrypted = append([]byte{0x01}, raw...)
			observePostmarkTokenWrite("static")
		}
		err = ierr
	}
	if err != nil {
		return nil, fmt.Errorf("encrypt token: %w", err)
	}

	st := &State{
		TenantID:         t.ID,
		Tier:             t.Tier,
		PostmarkServerID: itoa(srv.ID),
		PostmarkStreamID: streamID,
		DKIMDomain:       dkim,
	}

	if t.Tier == "pro" {
		ip, err := p.DedicatedIP.ProvisionDedicatedIP(ctx, srv.ID, p.DefaultRegion)
		if err != nil {
			return nil, fmt.Errorf("dedicated ip: %w", err)
		}
		st.DedicatedIP = ip.IP
		st.WarmupStartedAt = time.Now().UTC()
		st.WarmupDay = 1
	}

	if err := p.Repo.Upsert(ctx, st, encrypted); err != nil {
		return nil, fmt.Errorf("upsert state: %w", err)
	}
	if t.Tier == "pro" && p.Warmup != nil {
		if err := p.Warmup.Start(ctx, t.ID, st.WarmupStartedAt, p.ProTierDailyCap); err != nil {
			return nil, fmt.Errorf("start warmup: %w", err)
		}
	}
	return st, nil
}

// upgradeTierInPlace handles the tier-upgrade case (e.g. Sending → Pro)
// for tenants that already have a provisioned Postmark server. We MUST
// NOT call CreateServer / CreateMessageStream again — that would orphan
// the existing Postmark server (still billing!) and leak a duplicate.
// Instead, only provision the new tier's additional resources.
//
// Today the only meaningful upgrade path is "anything → pro" which adds
// a dedicated IP + warmup. Downgrades are handled by DeprovisionTenant
// or stay no-op for V1.
func (p *Provisioner) upgradeTierInPlace(ctx context.Context, t Tenant, existing *State) (*State, error) {
	st := *existing
	st.Tier = t.Tier

	if t.Tier == "pro" && existing.DedicatedIP == "" {
		// Need the int form of the existing PostmarkServerID for the
		// dedicated-IP API call. We persist it as a string in State; parse
		// back here. If the DB ever holds a non-numeric server id we
		// surface that as an error rather than silently provisioning a
		// new server.
		serverID, err := atoiSafe(existing.PostmarkServerID)
		if err != nil {
			return nil, fmt.Errorf("upgrade tier: existing PostmarkServerID %q is not numeric: %w",
				existing.PostmarkServerID, err)
		}
		ip, err := p.DedicatedIP.ProvisionDedicatedIP(ctx, serverID, p.DefaultRegion)
		if err != nil {
			return nil, fmt.Errorf("upgrade tier: dedicated ip: %w", err)
		}
		st.DedicatedIP = ip.IP
		st.WarmupStartedAt = time.Now().UTC()
		st.WarmupDay = 1
	}

	// Persist the tier change (and any new dedicated IP). The encrypted
	// token blob doesn't change — pass nil so MemoryStateRepo.Upsert
	// preserves the existing one (PostgresStateRepo's UPSERT also leaves
	// the column alone when the param is nil).
	if err := p.Repo.Upsert(ctx, &st, nil); err != nil {
		return nil, fmt.Errorf("upgrade tier: upsert state: %w", err)
	}
	if t.Tier == "pro" && p.Warmup != nil && existing.DedicatedIP == "" {
		if err := p.Warmup.Start(ctx, t.ID, st.WarmupStartedAt, p.ProTierDailyCap); err != nil {
			return nil, fmt.Errorf("upgrade tier: start warmup: %w", err)
		}
	}
	return &st, nil
}

// atoiSafe parses an int with a clear error type. Equivalent to strconv.Atoi
// but kept local so this package doesn't grow another import surface.
func atoiSafe(s string) (int, error) {
	n := 0
	if s == "" {
		return 0, fmt.Errorf("empty string")
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("non-digit byte at %d", i)
		}
		n = n*10 + int(c-'0')
	}
	return n, nil
}

// DeprovisionTenant tears down local sending state on downgrade or churn and
// schedules the upstream Postmark server for grace-period deletion when the
// repo supports the deprovision queue.
func (p *Provisioner) DeprovisionTenant(ctx context.Context, tenantID string) error {
	st, _, err := p.Repo.Get(ctx, tenantID)
	if err != nil {
		return err
	}
	if st != nil && st.PostmarkServerID != "" {
		if jobs, ok := p.Repo.(DeprovisionJobRepo); ok {
			if err := jobs.ScheduleDeprovision(ctx, tenantID, st.PostmarkServerID, st.PostmarkStreamID, time.Now().UTC().Add(30*24*time.Hour)); err != nil {
				return fmt.Errorf("schedule deprovision: %w", err)
			}
		}
	}
	return p.Repo.Delete(ctx, tenantID)
}

// RunDueDeprovisionJobs deletes upstream Postmark servers whose grace period
// has elapsed. It is safe to run from a daily cron; failures are recorded and
// retried with a simple attempt-based delay.
func (p *Provisioner) RunDueDeprovisionJobs(ctx context.Context, limit int) (int, error) {
	jobs, ok := p.Repo.(DeprovisionJobRepo)
	if !ok || p.Postmark == nil {
		return 0, nil
	}
	if limit <= 0 {
		limit = 25
	}
	now := time.Now().UTC()
	due, err := jobs.ListDueDeprovisionJobs(ctx, now, limit)
	if err != nil {
		return 0, err
	}
	completed := 0
	for _, job := range due {
		serverID, err := atoiSafe(job.PostmarkServerID)
		if err == nil {
			err = p.Postmark.DeleteServer(ctx, serverID)
		}
		if err != nil {
			_ = jobs.MarkDeprovisionJobFailed(ctx, job.ID, now, err.Error())
			continue
		}
		if err := jobs.MarkDeprovisionJobCompleted(ctx, job.ID, now); err != nil {
			return completed, err
		}
		completed++
	}
	return completed, nil
}

// itoa avoids strconv import for one number.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// envelopeBackendLabel inspects the first byte of an envelope blob to
// label the postmark_token_envelope_writes_total counter:
//   - 0x02 → KMS-backed envelope (kms.GenerateDataKey + AES-GCM)
//   - 0x01 → legacy static-key direct AES-GCM
//   - any other → "unknown" (shouldn't happen in well-formed writes)
func envelopeBackendLabel(blob []byte) string {
	if len(blob) == 0 {
		return "unknown"
	}
	switch blob[0] {
	case 0x02:
		return "kms"
	case 0x01:
		return "static"
	default:
		return "unknown"
	}
}

// encryptToken AES-GCM-encrypts the per-tenant Postmark server token
// directly with the legacy SendingKEK. Used only when Provisioner.
// EnvelopeCipher is nil; the v=0x01 prefix is stamped at the call site
// so future reads detect the format.
//
// The KMS-backed path runs through Provisioner.EnvelopeCipher.Encrypt
// (configured in main.go via pwcrypto.NewKMSEnvelope) and produces a
// v=0x02 framed blob. Existing v=0x01 rows continue to decrypt via
// AwsKMSEnvelope.Decrypt's legacy fallback, enabling lazy re-encryption
// without a forklift migration.
func encryptToken(key []byte, plaintext string) ([]byte, error) {
	if len(key) == 0 {
		return nil, errors.New("encryption key not configured (POSTWAVE_SENDING_KEK)")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	ct := gcm.Seal(nil, nonce, []byte(plaintext), nil)
	return append(nonce, ct...), nil
}

// DecryptToken is exposed for handlers that legitimately need the plaintext
// token (e.g. proxying outbound sends). All callers must scope this to a
// single in-memory variable and never log it.
func DecryptToken(key, ciphertext []byte) (string, error) {
	if len(ciphertext) > 0 {
		switch ciphertext[0] {
		case 0x01:
			ciphertext = ciphertext[1:]
		case 0x02:
			return "", errors.New("envelope-encrypted token requires envelope cipher")
		}
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(ciphertext) < gcm.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	nonce, ct := ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// Stripe webhooks call ProvisionTenant/DeprovisionTenant via
// internal/billing.WebhookHandler. Full SDK-backed subscription reconciliation
// lives in the billing package so this provisioner stays provider-agnostic.
