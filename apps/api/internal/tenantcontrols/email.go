package tenantcontrols

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Repo owns tenant-scoped operational controls that live in tenants.metadata.
// These are deliberately coarse controls: when a tenant-level email pause is
// active, no production email path should enqueue or dispatch.
type Repo struct {
	Pool *db.Pool
}

type EmailSendingControl struct {
	TenantID       string `json:"tenant_id"`
	Paused         bool   `json:"paused"`
	PauseReason    string `json:"pause_reason,omitempty"`
	PauseChangedAt string `json:"pause_changed_at,omitempty"`
	PauseChangedBy string `json:"pause_changed_by,omitempty"`
	Source         string `json:"source"`
}

type EmailComplianceSummary struct {
	Exists                 bool   `json:"exists"`
	Complete               bool   `json:"complete"`
	VerifiedSenderDomain   bool   `json:"verified_sender_domain"`
	ListUnsubscribeEnabled bool   `json:"list_unsubscribe_enabled"`
	OneClickEnabled        bool   `json:"one_click_unsubscribe_enabled"`
	LegalSenderName        string `json:"legal_sender_name,omitempty"`
	ComplianceContactEmail string `json:"compliance_contact_email,omitempty"`
	MissingPhysicalAddress bool   `json:"missing_physical_address"`
	MissingComplianceEmail bool   `json:"missing_compliance_email"`
	MissingLegalSenderName bool   `json:"missing_legal_sender_name"`
}

type SendingSettingsSummary struct {
	Exists            bool   `json:"exists"`
	MaxSendsPerHour   *int   `json:"max_sends_per_hour,omitempty"`
	QuietHoursStart   string `json:"quiet_hours_start,omitempty"`
	QuietHoursEnd     string `json:"quiet_hours_end,omitempty"`
	QuietHoursTZ      string `json:"quiet_hours_tz,omitempty"`
	QuietHoursEnabled bool   `json:"quiet_hours_enabled"`
	// FallbackHourUTC (SETA-041) surfaces the STO cold-start fallback so the
	// sending-limits editor seeds + preserves it across its full-replace PUT.
	FallbackHourUTC *int `json:"fallback_hour_utc,omitempty"`
}

func (r *Repo) EmailSendingControl(ctx context.Context, tenantID string) (EmailSendingControl, error) {
	if r == nil || r.Pool == nil {
		return EmailSendingControl{}, errors.New("tenantcontrols: nil repo")
	}
	tx, err := db.WithTenant(ctx, r.Pool, strings.TrimSpace(tenantID))
	if err != nil {
		return EmailSendingControl{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var out EmailSendingControl
	var pausedRaw string
	err = tx.QueryRow(ctx, `
SELECT id::text,
       COALESCE(metadata #>> '{sending,email_paused}', metadata->>'email_sending_paused', 'false') AS paused,
       COALESCE(metadata #>> '{sending,email_pause_reason}', metadata->>'email_pause_reason', '') AS reason,
       COALESCE(metadata #>> '{sending,email_pause_changed_at}', metadata->>'email_pause_changed_at', '') AS changed_at,
       COALESCE(metadata #>> '{sending,email_pause_changed_by}', metadata->>'email_pause_changed_by', '') AS changed_by
FROM tenants
WHERE id = $1::uuid`, tenantID).Scan(
		&out.TenantID,
		&pausedRaw,
		&out.PauseReason,
		&out.PauseChangedAt,
		&out.PauseChangedBy,
	)
	if err != nil {
		return EmailSendingControl{}, err
	}
	out.Paused = Truthy(pausedRaw)
	out.Source = "tenants.metadata.sending.email_paused"
	if err := tx.Commit(ctx); err != nil {
		return EmailSendingControl{}, err
	}
	return out, nil
}

// EmailSendingPaused is the narrow production-send gate used by campaigns and
// the queued send loop.
func (r *Repo) EmailSendingPaused(ctx context.Context, tenantID string) (bool, string, error) {
	ctrl, err := r.EmailSendingControl(ctx, tenantID)
	if err != nil {
		return false, "", err
	}
	return ctrl.Paused, ctrl.PauseReason, nil
}

func (r *Repo) SetEmailSendingPaused(ctx context.Context, tenantID string, paused bool, reason, actor string) (EmailSendingControl, error) {
	if r == nil || r.Pool == nil {
		return EmailSendingControl{}, errors.New("tenantcontrols: nil repo")
	}
	tenantID = strings.TrimSpace(tenantID)
	reason = strings.TrimSpace(reason)
	if paused && reason == "" {
		reason = "operator pause"
	}
	actor = strings.TrimSpace(actor)
	changedAt := time.Now().UTC().Format(time.RFC3339)

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return EmailSendingControl{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var out EmailSendingControl
	var pausedRaw string
	err = tx.QueryRow(ctx, `
UPDATE tenants
SET metadata = COALESCE(metadata, '{}'::jsonb) ||
    jsonb_build_object(
      'sending',
      COALESCE(metadata->'sending', '{}'::jsonb) ||
      jsonb_build_object(
        'email_paused', $2::boolean,
        'email_pause_reason', $3::text,
        'email_pause_changed_at', $4::text,
        'email_pause_changed_by', $5::text
      )
    )
WHERE id = $1::uuid
RETURNING id::text,
       COALESCE(metadata #>> '{sending,email_paused}', 'false'),
       COALESCE(metadata #>> '{sending,email_pause_reason}', ''),
       COALESCE(metadata #>> '{sending,email_pause_changed_at}', ''),
       COALESCE(metadata #>> '{sending,email_pause_changed_by}', '')`,
		tenantID, paused, reason, changedAt, actor).Scan(
		&out.TenantID,
		&pausedRaw,
		&out.PauseReason,
		&out.PauseChangedAt,
		&out.PauseChangedBy,
	)
	if err != nil {
		return EmailSendingControl{}, err
	}
	out.Paused = Truthy(pausedRaw)
	out.Source = "tenants.metadata.sending.email_paused"
	if err := tx.Commit(ctx); err != nil {
		return EmailSendingControl{}, err
	}
	return out, nil
}

func (r *Repo) EmailComplianceSummary(ctx context.Context, tenantID string) (EmailComplianceSummary, error) {
	if r == nil || r.Pool == nil {
		return EmailComplianceSummary{}, errors.New("tenantcontrols: nil repo")
	}
	tx, err := db.WithTenant(ctx, r.Pool, strings.TrimSpace(tenantID))
	if err != nil {
		return EmailComplianceSummary{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var out EmailComplianceSummary
	var line1, city, country string
	err = tx.QueryRow(ctx, `
SELECT legal_sender_name,
       physical_address_line1,
       physical_address_city,
       physical_address_country,
       COALESCE(compliance_contact_email::text, ''),
       list_unsubscribe_enabled,
       one_click_unsubscribe_enabled,
       verified_sender_domain
FROM email_compliance_profiles
WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&out.LegalSenderName,
		&line1,
		&city,
		&country,
		&out.ComplianceContactEmail,
		&out.ListUnsubscribeEnabled,
		&out.OneClickEnabled,
		&out.VerifiedSenderDomain,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			out.Exists = false
			return out, tx.Commit(ctx)
		}
		return EmailComplianceSummary{}, err
	}
	out.Exists = true
	out.MissingLegalSenderName = strings.TrimSpace(out.LegalSenderName) == ""
	out.MissingComplianceEmail = strings.TrimSpace(out.ComplianceContactEmail) == ""
	out.MissingPhysicalAddress = strings.TrimSpace(line1) == "" ||
		strings.TrimSpace(city) == "" ||
		strings.TrimSpace(country) == ""
	out.Complete = !out.MissingLegalSenderName &&
		!out.MissingComplianceEmail &&
		!out.MissingPhysicalAddress &&
		out.ListUnsubscribeEnabled &&
		out.OneClickEnabled &&
		out.VerifiedSenderDomain
	if err := tx.Commit(ctx); err != nil {
		return EmailComplianceSummary{}, err
	}
	return out, nil
}

func (r *Repo) SendingSettingsSummary(ctx context.Context, tenantID string) (SendingSettingsSummary, error) {
	if r == nil || r.Pool == nil {
		return SendingSettingsSummary{}, errors.New("tenantcontrols: nil repo")
	}
	tx, err := db.WithTenant(ctx, r.Pool, strings.TrimSpace(tenantID))
	if err != nil {
		return SendingSettingsSummary{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var out SendingSettingsSummary
	err = tx.QueryRow(ctx, `
SELECT max_sends_per_hour,
       COALESCE(quiet_hours_start, ''),
       COALESCE(quiet_hours_end, ''),
       COALESCE(quiet_hours_tz, ''),
       fallback_hour_utc
FROM tenant_sending_settings
WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&out.MaxSendsPerHour,
		&out.QuietHoursStart,
		&out.QuietHoursEnd,
		&out.QuietHoursTZ,
		&out.FallbackHourUTC,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			out.Exists = false
			return out, tx.Commit(ctx)
		}
		return SendingSettingsSummary{}, err
	}
	out.Exists = true
	out.QuietHoursEnabled = strings.TrimSpace(out.QuietHoursStart) != "" &&
		strings.TrimSpace(out.QuietHoursEnd) != "" &&
		strings.TrimSpace(out.QuietHoursTZ) != ""
	if err := tx.Commit(ctx); err != nil {
		return SendingSettingsSummary{}, err
	}
	return out, nil
}

func Truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "t", "true", "yes", "y", "on":
		return true
	default:
		return false
	}
}
