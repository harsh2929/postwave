package reportstore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
)

// PostgresStore is the production report store for seed-list observations.
// Rows are upserted per tenant/campaign/mailbox so a repoll updates the latest
// placement rather than creating an unbounded duplicate stream.
type PostgresStore struct {
	Pool                *pgxpool.Pool
	DefaultTenantID     string
	ObservationObjects  ObservationObjectStore
	ObservationNotifier ObservationNotifier
	Now                 func() time.Time
}

type ObservationNotifier interface {
	NotifyObservation(context.Context, inboxrealitycontract.ObservationReceipt) error
}

func NewPostgresStore(pool *pgxpool.Pool, defaultTenantID string, objects ...ObservationObjectStore) *PostgresStore {
	if pool == nil {
		return nil
	}
	store := &PostgresStore{Pool: pool, DefaultTenantID: strings.TrimSpace(defaultTenantID), Now: time.Now}
	if len(objects) > 0 {
		store.ObservationObjects = objects[0]
	}
	return store
}

// ProjectionOnlyStore intentionally hides MessageObservationSink from the
// poller while the seed_mime_capture rollout flag is disabled. It prevents a
// typed PostgresStore with no object store from accidentally accepting raw
// bytes or emitting misleading partial persistence errors.
type ProjectionOnlyStore struct {
	store *PostgresStore
}

var _ seedlist.MailboxCursorStore = (*ProjectionOnlyStore)(nil)

func NewProjectionOnlyStore(store *PostgresStore) *ProjectionOnlyStore {
	if store == nil {
		return nil
	}
	return &ProjectionOnlyStore{store: store}
}

func (s *ProjectionOnlyStore) WriteReport(ctx context.Context, report domain.InboxReport) error {
	if s == nil || s.store == nil {
		return errors.New("postgres reportstore: nil projection store")
	}
	return s.store.WriteReport(ctx, report)
}

func (s *ProjectionOnlyStore) Get(ctx context.Context, tenantID, campaignID string) (domain.CampaignReport, error) {
	if s == nil || s.store == nil {
		return domain.CampaignReport{}, errors.New("postgres reportstore: nil projection store")
	}
	return s.store.Get(ctx, tenantID, campaignID)
}

// LoadSeedMailboxCursors and AdvanceSeedMailboxCursors intentionally remain
// available when raw MIME capture is disabled. Cursors contain no message
// content and are required to make the legacy placement-only poller restart
// safe. ProjectionOnlyStore still does not expose WriteMessageObservation, so
// raw bytes cannot cross the disabled rollout boundary.
func (s *ProjectionOnlyStore) LoadSeedMailboxCursors(ctx context.Context, mailboxID string) (map[string]seedlist.FolderCursor, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("postgres reportstore: nil projection store")
	}
	return s.store.LoadSeedMailboxCursors(ctx, mailboxID)
}

func (s *ProjectionOnlyStore) AdvanceSeedMailboxCursors(ctx context.Context, mailboxID string, watermarks []seedlist.FolderWatermark) error {
	if s == nil || s.store == nil {
		return errors.New("postgres reportstore: nil projection store")
	}
	return s.store.AdvanceSeedMailboxCursors(ctx, mailboxID, watermarks)
}

func (s *PostgresStore) WriteReport(ctx context.Context, r domain.InboxReport) error {
	if s == nil || s.Pool == nil {
		return errors.New("postgres reportstore: nil pool")
	}
	r.TenantID = s.tenantOrDefault(r.TenantID)
	if strings.TrimSpace(r.TenantID) == "" {
		return ErrTenantRequired
	}
	if strings.TrimSpace(r.CampaignID) == "" {
		return errors.New("campaign id required")
	}
	if strings.TrimSpace(r.MailboxID) == "" {
		return errors.New("mailbox id required")
	}
	recipient := strings.TrimSpace(r.RecipientEmail)
	if recipient == "" {
		recipient = r.MailboxID
	}
	if r.CheckedAt.IsZero() {
		r.CheckedAt = time.Now().UTC()
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin seedlist outcome write: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, r.TenantID); err != nil {
		return fmt.Errorf("scope seedlist outcome write: %w", err)
	}
	const q = `
INSERT INTO seedlist_outcomes (
    tenant_id, campaign_id, recipient_email, mailbox_id, provider, folder, checked_at
) VALUES (
    $1::uuid, $2::uuid, $3, $4, $5, $6, $7
)
ON CONFLICT (tenant_id, campaign_id, mailbox_id)
DO UPDATE SET
    recipient_email = EXCLUDED.recipient_email,
    provider = EXCLUDED.provider,
    folder = EXCLUDED.folder,
    checked_at = EXCLUDED.checked_at,
    updated_at = now()
`
	if _, err := tx.Exec(ctx, q,
		r.TenantID,
		r.CampaignID,
		recipient,
		r.MailboxID,
		string(r.Provider),
		string(r.Placement),
		r.CheckedAt.UTC(),
	); err != nil {
		return fmt.Errorf("write seedlist outcome: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit seedlist outcome write: %w", err)
	}
	return nil
}

func (s *PostgresStore) Get(ctx context.Context, tenantID string, campaignID string) (domain.CampaignReport, error) {
	if s == nil || s.Pool == nil {
		return domain.CampaignReport{}, errors.New("postgres reportstore: nil pool")
	}
	tenantID = s.tenantOrDefault(tenantID)
	if strings.TrimSpace(tenantID) == "" {
		return domain.CampaignReport{}, ErrTenantRequired
	}
	if strings.TrimSpace(campaignID) == "" {
		return domain.CampaignReport{}, ErrNotFound
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return domain.CampaignReport{}, fmt.Errorf("begin seedlist outcome read: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return domain.CampaignReport{}, fmt.Errorf("scope seedlist outcome read: %w", err)
	}
	const q = `
SELECT
    tenant_id::text,
    campaign_id::text,
    recipient_email::text,
    mailbox_id,
    provider,
    folder,
    checked_at
FROM seedlist_outcomes
WHERE tenant_id = $1::uuid
  AND campaign_id = $2::uuid
ORDER BY provider, mailbox_id
`
	rows, err := tx.Query(ctx, q, tenantID, campaignID)
	if err != nil {
		return domain.CampaignReport{}, fmt.Errorf("get seedlist outcomes: %w", err)
	}
	defer rows.Close()

	var reports []domain.InboxReport
	for rows.Next() {
		var r domain.InboxReport
		var provider, placement string
		if err := rows.Scan(
			&r.TenantID,
			&r.CampaignID,
			&r.RecipientEmail,
			&r.MailboxID,
			&provider,
			&placement,
			&r.CheckedAt,
		); err != nil {
			return domain.CampaignReport{}, err
		}
		r.Provider = domain.Provider(provider)
		r.Placement = domain.Placement(placement)
		reports = append(reports, r)
	}
	if err := rows.Err(); err != nil {
		return domain.CampaignReport{}, err
	}
	if len(reports) == 0 {
		return domain.CampaignReport{}, ErrNotFound
	}
	var campaignName string
	var sentAt *time.Time
	if err := tx.QueryRow(ctx, `
SELECT name, sent_at
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`, tenantID, campaignID).Scan(&campaignName, &sentAt); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return domain.CampaignReport{}, fmt.Errorf("get campaign report metadata: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.CampaignReport{}, fmt.Errorf("commit seedlist outcome read: %w", err)
	}
	report := Aggregate(campaignID, reports, time.Now().UTC())
	report.CampaignName = campaignName
	report.SentAt = sentAt
	return report, nil
}

func (s *PostgresStore) tenantOrDefault(tenantID string) string {
	tenantID = strings.TrimSpace(tenantID)
	if tenantID != "" {
		return tenantID
	}
	return s.DefaultTenantID
}
