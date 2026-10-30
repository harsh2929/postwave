// SPDX-License-Identifier: AGPL-3.0-only

package pushsend

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pushauthoritylock"
	"github.com/postwave/postwave/apps/api/internal/pushtoken"
)

// DeviceRow is the wire/storage shape of one push_devices row.
type DeviceRow struct {
	ID           string     `json:"id"`
	SubscriberID string     `json:"subscriber_id"`
	Platform     string     `json:"platform"`
	Token        string     `json:"token"`
	AppID        string     `json:"app_id,omitempty"`
	Enabled      bool       `json:"enabled"`
	LastSeenAt   *time.Time `json:"last_seen_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

// UpsertDeviceInput is the caller-supplied shape for registering/refreshing
// a device token.
type UpsertDeviceInput struct {
	SubscriberID string
	Platform     string
	Token        string
	AppID        string
	Enabled      bool
}

// ErrSubscriberNotFound is returned by UpsertDevice when subscriber_id does
// not reference an existing subscriber in the caller's tenant (the FK would
// otherwise surface as an opaque constraint-violation error).
var ErrSubscriberNotFound = errors.New("pushsend: subscriber not found")

// DeviceResolution is the all-or-nothing result of resolving a subscriber's
// enabled devices against the active suppression authorities. Devices contains
// only endpoints that may be sent to. The counts let PushSender distinguish a
// subscriber with no enabled devices from one whose devices were all
// suppressed, and let it reject an inconsistent custom resolver fail-closed.
type DeviceResolution struct {
	Devices         []Device
	EnabledCount    int
	SuppressedCount int
}

// DeviceResolver resolves a subscriber's enabled push devices, obtains the
// tenant reader lease shared by sends/lists and excluded by every authority
// mutation, checks the complete candidate set, and invokes use while that
// lease remains held. This makes the check and provider call one linearizable
// eligibility lease: an
// authority fact is ordered either before the check or after the send. A
// resolver error must discard the whole resolution. *Repo satisfies the
// interface; tests can substitute a synchronous fake.
type DeviceResolver interface {
	WithSendableDevices(
		ctx context.Context,
		tenantID, subscriberID string,
		use func(context.Context, DeviceResolution) error,
	) error
}

// DeviceUpserter registers/refreshes a device token. *Repo satisfies it; the
// HTTP handler depends on the interface so tests can substitute a fake.
type DeviceUpserter interface {
	UpsertDevice(ctx context.Context, tenantID string, in UpsertDeviceInput) (DeviceRow, error)
}

// Repo is the real, tenant-RLS-scoped data layer over push_devices (migration
// 1745) and push_suppression_authorities (migration 1996). All access goes
// through one db.WithTenant transaction so both tables are read under the same
// tenant GUC.
type Repo struct{ Pool *db.Pool }

var (
	_ DeviceResolver = (*Repo)(nil)
	_ DeviceUpserter = (*Repo)(nil)
)

const deviceSelectCols = `id::text, subscriber_id::text, platform, token,
	COALESCE(app_id, ''), enabled, last_seen_at, created_at`

type suppressionKey struct {
	platform  string
	tokenHash [sha256.Size]byte
}

// suppressionAuthorityChecker evaluates every key as one batch. The returned
// slice is positional: true at i means keys[i] has at least one active
// authority. Implementations must return exactly len(keys) decisions or an
// error; a partial result is never safe to send from.
type suppressionAuthorityChecker interface {
	CheckActive(ctx context.Context, tenantID string, keys []suppressionKey) ([]bool, error)
}

type txSuppressionAuthorityChecker struct{ tx pgx.Tx }

// CheckActive performs one tenant-bound statement for the whole candidate
// set. ANY active authority suppresses the endpoint: manual, provider, user,
// complaint, and legacy_unknown are independent facts whose union is the send
// gate. Hashes are produced in Go from the exact token bytes; PostgreSQL only
// compares the resulting bytea values.
func (c txSuppressionAuthorityChecker) CheckActive(ctx context.Context, tenantID string, keys []suppressionKey) ([]bool, error) {
	if len(keys) == 0 {
		return []bool{}, nil
	}

	platforms := make([]string, len(keys))
	hashes := make([][]byte, len(keys))
	for i := range keys {
		platforms[i] = keys[i].platform
		hashes[i] = keys[i].tokenHash[:]
	}

	rows, err := c.tx.Query(ctx, `
		WITH candidates AS (
			SELECT platform, device_token_hash, ordinal
			  FROM unnest($2::text[], $3::bytea[]) WITH ORDINALITY
			       AS candidate(platform, device_token_hash, ordinal)
		)
		SELECT candidate.ordinal
		  FROM candidates AS candidate
		 WHERE EXISTS (
			SELECT 1
			  FROM push_suppression_authorities AS authority
			 WHERE authority.tenant_id = $1::uuid
			   AND authority.platform = candidate.platform
			   AND authority.device_token_hash = candidate.device_token_hash
			   AND authority.revoked_at IS NULL
		 )
		 ORDER BY candidate.ordinal`, tenantID, platforms, hashes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	suppressed := make([]bool, len(keys))
	for rows.Next() {
		var ordinal int64
		if err := rows.Scan(&ordinal); err != nil {
			return nil, err
		}
		if ordinal < 1 || ordinal > int64(len(keys)) {
			return nil, fmt.Errorf("pushsend: suppression checker returned invalid candidate ordinal %d", ordinal)
		}
		suppressed[ordinal-1] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return suppressed, nil
}

// WithSendableDevices holds the tenant authority/device reader lease until use
// returns. Authority, device, and parent-cascade triggers take the matching
// writer lease before row locks, so neither eligibility input can
// change between the final check and use. The callback receives a marked
// context: synchronous authority/device writes using that context fail fast
// instead of self-deadlocking. Provider feedback must be persisted only after
// the callback returns and releases this lease.
func (r *Repo) WithSendableDevices(
	ctx context.Context,
	tenantID, subscriberID string,
	use func(context.Context, DeviceResolution) error,
) error {
	if err := pushauthoritylock.EnsureSendLeaseAllowed(ctx); err != nil {
		return err
	}
	if use == nil {
		return errors.New("pushsend: eligibility callback is required")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := pushauthoritylock.Shared(ctx, tx, tenantID); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
		SELECT platform, token, COALESCE(app_id, '')
		  FROM push_devices
		 WHERE tenant_id = $1::uuid
		   AND subscriber_id = $2::uuid
		   AND enabled
		 ORDER BY created_at DESC, id DESC`, tenantID, subscriberID)
	if err != nil {
		return err
	}
	devices := []Device{}
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.Platform, &d.Token, &d.AppID); err != nil {
			rows.Close()
			return err
		}
		devices = append(devices, d)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	resolution, err := resolveAgainstSuppressionAuthorities(
		ctx, tenantID, devices, txSuppressionAuthorityChecker{tx: tx},
	)
	if err != nil {
		return err
	}
	// This transaction intentionally rolls back after the callback: it exists
	// only as an advisory/snapshot lease and has no database writes to commit.
	// A plain MVCC read is deliberate: the tenant lease already excludes every
	// supported eligibility mutation, while avoiding row/advisory inversion if
	// arbitrary SQL locked a device row before attempting an authority write.
	// Rolling back also avoids turning a post-provider COMMIT acknowledgement
	// failure into a false claim that delivery did not happen.
	return use(pushauthoritylock.SendLeaseCallbackContext(ctx), resolution)
}

// ResolveSendableDevices is retained as a read-only diagnostic/test helper.
// Live PushSender dispatch uses WithSendableDevices so the locks span the
// provider call rather than being released when resolution returns.
func (r *Repo) ResolveSendableDevices(ctx context.Context, tenantID, subscriberID string) (DeviceResolution, error) {
	var resolution DeviceResolution
	err := r.WithSendableDevices(ctx, tenantID, subscriberID, func(_ context.Context, got DeviceResolution) error {
		resolution = got
		return nil
	})
	return resolution, err
}

func resolveAgainstSuppressionAuthorities(
	ctx context.Context,
	tenantID string,
	devices []Device,
	checker suppressionAuthorityChecker,
) (DeviceResolution, error) {
	keys := make([]suppressionKey, len(devices))
	for i := range devices {
		key, err := suppressionKeyForDevice(devices[i])
		if err != nil {
			return DeviceResolution{}, err
		}
		keys[i] = key
	}

	suppressed, err := checker.CheckActive(ctx, tenantID, keys)
	if err != nil {
		return DeviceResolution{}, fmt.Errorf("pushsend: check suppression authority: %w", err)
	}
	if len(suppressed) != len(devices) {
		return DeviceResolution{}, fmt.Errorf(
			"pushsend: suppression checker returned %d decisions for %d devices",
			len(suppressed), len(devices),
		)
	}

	resolution := DeviceResolution{
		Devices:      make([]Device, 0, len(devices)),
		EnabledCount: len(devices),
	}
	for i := range devices {
		if suppressed[i] {
			resolution.SuppressedCount++
			continue
		}
		resolution.Devices = append(resolution.Devices, devices[i])
	}
	return resolution, nil
}

// suppressionKeyForDevice deliberately hashes []byte(token) without trimming,
// case-folding, Unicode normalization, hex decoding, or any other rewrite.
// push_token_suppressions historically used SHA-256 over the caller's exact raw
// token string; the send gate must reproduce that byte-for-byte contract.
func suppressionKeyForDevice(device Device) (suppressionKey, error) {
	if err := pushtoken.ValidateExact(device.Token); err != nil {
		return suppressionKey{}, fmt.Errorf("pushsend: device is outside suppression identity domain: %w", err)
	}
	platform, err := suppressionPlatformForDevicePlatform(device.Platform)
	if err != nil {
		return suppressionKey{}, err
	}
	return suppressionKey{
		platform:  platform,
		tokenHash: sha256.Sum256([]byte(device.Token)),
	}, nil
}

func suppressionPlatformForDevicePlatform(platform string) (string, error) {
	switch platform {
	case "ios":
		return "apns", nil
	case "android":
		return "fcm", nil
	default:
		return "", fmt.Errorf("pushsend: unsupported device platform %q", platform)
	}
}

// UpsertDevice registers a device token for a subscriber, or refreshes an
// existing registration (ON CONFLICT (tenant_id, token) — the migration
// 1745 unique constraint) so re-registering the same token from a fresh app
// launch is idempotent and bumps last_seen_at rather than erroring.
//
// Re-registering a previously-disabled token (e.g. after a push-permission
// re-grant) re-enables it, matching the caller's Enabled input.
func (r *Repo) UpsertDevice(ctx context.Context, tenantID string, in UpsertDeviceInput) (DeviceRow, error) {
	if err := pushauthoritylock.EnsureMutationAllowed(ctx); err != nil {
		return DeviceRow{}, err
	}
	if err := pushtoken.ValidateExact(in.Token); err != nil {
		return DeviceRow{}, fmt.Errorf("pushsend: invalid device token: %w", err)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return DeviceRow{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Match migration 1996's BEFORE-statement trigger explicitly so every
	// first-party device write obtains the tenant lease before subscriber or
	// device row locks and therefore orders on one side of any active send.
	if err := pushauthoritylock.Exclusive(ctx, tx, tenantID); err != nil {
		return DeviceRow{}, err
	}

	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid)`,
		tenantID, in.SubscriberID).Scan(&exists); err != nil {
		return DeviceRow{}, err
	}
	if !exists {
		return DeviceRow{}, ErrSubscriberNotFound
	}

	var appID any
	if in.AppID != "" {
		appID = in.AppID
	}

	var row DeviceRow
	if err := tx.QueryRow(ctx, `
		INSERT INTO push_devices (tenant_id, subscriber_id, platform, token, app_id, enabled, last_seen_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, now())
		ON CONFLICT (tenant_id, token) DO UPDATE SET
			subscriber_id = EXCLUDED.subscriber_id,
			platform      = EXCLUDED.platform,
			app_id        = EXCLUDED.app_id,
			enabled       = EXCLUDED.enabled,
			last_seen_at  = now()
		RETURNING `+deviceSelectCols,
		tenantID, in.SubscriberID, in.Platform, in.Token, appID, in.Enabled).Scan(
		&row.ID, &row.SubscriberID, &row.Platform, &row.Token, &row.AppID,
		&row.Enabled, &row.LastSeenAt, &row.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DeviceRow{}, fmt.Errorf("pushsend: upsert device: no row returned")
		}
		return DeviceRow{}, err
	}
	return row, tx.Commit(ctx)
}
