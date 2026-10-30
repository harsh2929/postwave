// SPDX-License-Identifier: AGPL-3.0-only
package audience_destinations

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	providerDiagnosticsPollInterval = 5 * time.Minute
	providerDiagnosticsMaxPerTick   = 50
	providerDiagnosticsMaxAttempts  = 12

	providerDiagnosticsKindJob = "audience_sync_job"
	providerDiagnosticsKindRun = "audience_sync_run"
)

type ProviderDiagnosticsPoller struct {
	Repo               *Repo
	Adapters           AdapterRegistry
	CredentialResolver AudienceCredentialResolver
	Logger             *slog.Logger
	Interval           time.Duration
	Limit              int
	MaxAttempts        int
	Now                func() time.Time
}

type providerDiagnosticsScheduleContext struct {
	Provider string
	Config   map[string]any
}

type providerDiagnosticsTarget struct {
	Kind               string
	TenantID           string
	DestinationID      string
	SyncID             string
	LedgerID           string
	Provider           string
	ExternalJobID      string
	ExternalAudienceID string
	ProviderMessage    string
	Config             map[string]any
	PollAttempts       int
}

type providerDiagnosticsUpdate struct {
	ProviderStatus       string
	ProviderCheckedAt    time.Time
	ProviderNextCheckAt  *time.Time
	ProviderPollAttempts int
}

func initialProviderDiagnosticsSchedule(evidence ProviderRunEvidence, schedule providerDiagnosticsScheduleContext) (string, *time.Time) {
	provider := strings.ToLower(strings.TrimSpace(schedule.Provider))
	if strings.TrimSpace(evidence.ExternalJobID) == "" && strings.TrimSpace(evidence.ExternalAudienceID) == "" {
		return "", nil
	}
	if provider == string(ProviderGoogleAds) && strings.TrimSpace(evidence.ExternalJobID) == "" {
		return "", nil
	}
	if !providerDiagnosticsSupported(schedule.Provider, schedule.Config, evidence.ExternalAudienceID) {
		return "", nil
	}
	now := time.Now().UTC()
	return "PENDING", &now
}

func providerDiagnosticsSupported(provider string, cfg map[string]any, externalAudienceID ...string) bool {
	provider = strings.ToLower(strings.TrimSpace(provider))
	externalID := ""
	if len(externalAudienceID) > 0 {
		externalID = externalAudienceID[0]
	}
	switch provider {
	case string(ProviderGoogleAds):
		return googleAdsCustomerMatchTransport(cfg) == googleAdsTransportDataMgr
	case string(ProviderTikTok):
		return configString(cfg, "advertiser_id") != "" &&
			firstNonEmpty(configString(cfg, "audience_id"), configString(cfg, "custom_audience_id"), externalID) != ""
	case string(ProviderLinkedIn):
		return firstNonEmpty(configString(cfg, "segment_id"), externalID) != ""
	case string(ProviderSnap):
		return firstNonEmpty(configString(cfg, "segment_id"), externalID) != ""
	default:
		return false
	}
}

func (p *ProviderDiagnosticsPoller) Run(ctx context.Context) error {
	if p == nil || p.Repo == nil {
		return nil
	}
	p.tick(ctx)
	t := time.NewTicker(p.interval())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			p.tick(ctx)
		}
	}
}

func (p *ProviderDiagnosticsPoller) tick(ctx context.Context) {
	targets, err := p.Repo.listProviderDiagnosticsTargets(ctx, p.now(), p.limit(), p.maxAttempts())
	if err != nil {
		if p.Logger != nil {
			p.Logger.Warn("audience_provider_diagnostics: scan failed", "err", err.Error())
		}
		return
	}
	for _, target := range targets {
		if ctx.Err() != nil {
			return
		}
		update, ok, err := p.pollTarget(ctx, target)
		if err != nil && p.Logger != nil {
			p.Logger.Warn("audience_provider_diagnostics: provider lookup failed",
				"tenant_id", target.TenantID,
				"kind", target.Kind,
				"ledger_id", target.LedgerID,
				"provider", target.Provider,
				"err", err.Error())
		}
		if !ok {
			continue
		}
		if err := p.Repo.updateProviderDiagnostics(ctx, target, update); err != nil && p.Logger != nil {
			p.Logger.Warn("audience_provider_diagnostics: ledger update failed",
				"tenant_id", target.TenantID,
				"kind", target.Kind,
				"ledger_id", target.LedgerID,
				"err", err.Error())
		}
	}
}

func (p *ProviderDiagnosticsPoller) pollTarget(ctx context.Context, target providerDiagnosticsTarget) (providerDiagnosticsUpdate, bool, error) {
	now := p.now().UTC()
	attempts := target.PollAttempts + 1
	pollFailed := providerDiagnosticsUpdate{
		ProviderStatus:       "POLL_FAILED",
		ProviderCheckedAt:    now,
		ProviderNextCheckAt:  providerDiagnosticsNextCheck(now, "POLL_FAILED", attempts),
		ProviderPollAttempts: attempts,
	}
	if strings.TrimSpace(target.ExternalJobID) == "" && strings.TrimSpace(target.ExternalAudienceID) == "" {
		return providerDiagnosticsUpdate{}, false, nil
	}
	provider := strings.ToLower(strings.TrimSpace(target.Provider))
	if provider == string(ProviderGoogleAds) && strings.TrimSpace(target.ExternalJobID) == "" {
		return providerDiagnosticsUpdate{}, false, nil
	}
	if !providerDiagnosticsSupported(provider, target.Config, target.ExternalAudienceID) {
		return providerDiagnosticsUpdate{}, false, nil
	}
	adapter := p.Adapters[provider]
	if adapter == nil {
		return pollFailed, true, fmt.Errorf("platform adapter %q not configured", provider)
	}
	diagnosticsAdapter, ok := adapter.(PlatformDiagnosticsAdapter)
	if !ok {
		return pollFailed, true, fmt.Errorf("provider %q does not implement diagnostics", provider)
	}
	cfg := enrichAudienceDestinationConfig(provider, cloneConfigMap(target.Config), target.ExternalAudienceID)
	hydrated, err := hydrateAdapterConfig(ctx, p.CredentialResolver, cfg)
	if err != nil {
		return pollFailed, true, err
	}
	result, err := diagnosticsAdapter.RetrieveDiagnostics(ctx, hydrated, ProviderRunEvidence{
		ExternalJobID:      target.ExternalJobID,
		ExternalAudienceID: target.ExternalAudienceID,
		ProviderMessage:    target.ProviderMessage,
	})
	if err != nil {
		return pollFailed, true, err
	}
	status := normalizeProviderDiagnosticsStatus(result.ProviderStatus)
	if status == "" {
		status = "UNKNOWN"
	}
	return providerDiagnosticsUpdate{
		ProviderStatus:       status,
		ProviderCheckedAt:    now,
		ProviderNextCheckAt:  providerDiagnosticsNextCheck(now, status, attempts),
		ProviderPollAttempts: attempts,
	}, true, nil
}

func (p *ProviderDiagnosticsPoller) interval() time.Duration {
	if p.Interval > 0 {
		return p.Interval
	}
	return providerDiagnosticsPollInterval
}

func (p *ProviderDiagnosticsPoller) limit() int {
	if p.Limit > 0 && p.Limit <= 500 {
		return p.Limit
	}
	return providerDiagnosticsMaxPerTick
}

func (p *ProviderDiagnosticsPoller) maxAttempts() int {
	if p.MaxAttempts > 0 {
		return p.MaxAttempts
	}
	return providerDiagnosticsMaxAttempts
}

func (p *ProviderDiagnosticsPoller) now() time.Time {
	if p.Now != nil {
		return p.Now().UTC()
	}
	return time.Now().UTC()
}

func providerDiagnosticsNextCheck(now time.Time, status string, attempts int) *time.Time {
	if providerDiagnosticsTerminalStatus(status) {
		return nil
	}
	if attempts < 1 {
		attempts = 1
	}
	shift := attempts - 1
	if shift > 6 {
		shift = 6
	}
	delay := providerDiagnosticsPollInterval * time.Duration(1<<shift)
	if delay > 6*time.Hour {
		delay = 6 * time.Hour
	}
	next := now.UTC().Add(delay)
	return &next
}

func providerDiagnosticsTerminalStatus(status string) bool {
	switch normalizeProviderDiagnosticsStatus(status) {
	case "SUCCESS", "SUCCEEDED", "FAILED", "FAILURE", "PARTIAL_SUCCESS", "PARTIAL_FAILURE", "CANCELED", "CANCELLED":
		return true
	default:
		return false
	}
}

func normalizeProviderDiagnosticsStatus(status string) string {
	return strings.ToUpper(strings.TrimSpace(status))
}

func cloneConfigMap(cfg map[string]any) map[string]any {
	if len(cfg) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(cfg))
	for k, v := range cfg {
		out[k] = v
	}
	return out
}

func (r *Repo) listProviderDiagnosticsTargets(ctx context.Context, now time.Time, limit, maxAttempts int) ([]providerDiagnosticsTarget, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("audience_destinations: repo pool is required")
	}
	if limit <= 0 {
		limit = providerDiagnosticsMaxPerTick
	}
	if maxAttempts <= 0 {
		maxAttempts = providerDiagnosticsMaxAttempts
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	targets := make([]providerDiagnosticsTarget, 0, limit)
	jobRows, err := tx.Query(ctx, `
SELECT j.tenant_id::text, d.id::text, j.id::text, d.provider,
       COALESCE(j.external_job_id,''), COALESCE(j.external_audience_id, d.external_audience_id, ''),
       COALESCE(j.provider_message,''), COALESCE(d.config::text, '{}'),
       COALESCE(j.provider_poll_attempts,0)
  FROM audience_sync_jobs j
  JOIN audience_destinations d
    ON d.tenant_id = j.tenant_id AND d.id = j.destination_id
 WHERE d.provider IN ('google_ads','tiktok','linkedin','snap')
   AND d.status <> 'disconnected'
   AND (
        NULLIF(j.external_job_id,'') IS NOT NULL
        OR NULLIF(COALESCE(j.external_audience_id, d.external_audience_id, ''),'') IS NOT NULL
   )
   AND COALESCE(j.provider_poll_attempts,0) < $1
   AND (j.provider_next_check_at IS NULL OR j.provider_next_check_at <= $2)
   AND COALESCE(upper(j.provider_status),'') NOT IN
       ('SUCCESS','SUCCEEDED','FAILED','FAILURE','PARTIAL_SUCCESS','PARTIAL_FAILURE','CANCELED','CANCELLED')
 ORDER BY COALESCE(j.provider_next_check_at, j.finished_at, j.started_at) ASC
 LIMIT $3`, maxAttempts, now.UTC(), limit)
	if err != nil {
		return nil, err
	}
	for jobRows.Next() {
		var target providerDiagnosticsTarget
		var cfgText string
		target.Kind = providerDiagnosticsKindJob
		if err := jobRows.Scan(
			&target.TenantID, &target.DestinationID, &target.LedgerID, &target.Provider,
			&target.ExternalJobID, &target.ExternalAudienceID, &target.ProviderMessage,
			&cfgText, &target.PollAttempts,
		); err != nil {
			jobRows.Close()
			return nil, err
		}
		target.Config = parseDestinationConfig(cfgText)
		if providerDiagnosticsSupported(target.Provider, target.Config, target.ExternalAudienceID) &&
			(strings.TrimSpace(target.ExternalJobID) != "" || strings.TrimSpace(target.ExternalAudienceID) != "") {
			targets = append(targets, target)
		}
	}
	if err := jobRows.Err(); err != nil {
		jobRows.Close()
		return nil, err
	}
	jobRows.Close()

	remaining := limit - len(targets)
	if remaining <= 0 {
		return targets, nil
	}
	runRows, err := tx.Query(ctx, `
SELECT r.tenant_id::text, s.id::text, r.id::text, s.destination_type,
       COALESCE(r.external_job_id,''), COALESCE(r.external_audience_id,''),
       COALESCE(r.provider_message,''), COALESCE(s.destination_config::text, '{}'),
       COALESCE(r.provider_poll_attempts,0)
  FROM audience_sync_runs r
  JOIN audience_syncs s
    ON s.tenant_id = r.tenant_id AND s.id = r.sync_id
 WHERE s.destination_type IN ('google_ads','tiktok','linkedin','snap')
   AND (
        NULLIF(r.external_job_id,'') IS NOT NULL
        OR NULLIF(r.external_audience_id,'') IS NOT NULL
   )
   AND COALESCE(r.provider_poll_attempts,0) < $1
   AND (r.provider_next_check_at IS NULL OR r.provider_next_check_at <= $2)
   AND COALESCE(upper(r.provider_status),'') NOT IN
       ('SUCCESS','SUCCEEDED','FAILED','FAILURE','PARTIAL_SUCCESS','PARTIAL_FAILURE','CANCELED','CANCELLED')
 ORDER BY COALESCE(r.provider_next_check_at, r.finished_at, r.started_at) ASC
 LIMIT $3`, maxAttempts, now.UTC(), remaining)
	if err != nil {
		return nil, err
	}
	defer runRows.Close()
	for runRows.Next() {
		var target providerDiagnosticsTarget
		var cfgText string
		target.Kind = providerDiagnosticsKindRun
		if err := runRows.Scan(
			&target.TenantID, &target.SyncID, &target.LedgerID, &target.Provider,
			&target.ExternalJobID, &target.ExternalAudienceID, &target.ProviderMessage,
			&cfgText, &target.PollAttempts,
		); err != nil {
			return nil, err
		}
		target.Config = parseDestinationConfig(cfgText)
		if providerDiagnosticsSupported(target.Provider, target.Config, target.ExternalAudienceID) &&
			(strings.TrimSpace(target.ExternalJobID) != "" || strings.TrimSpace(target.ExternalAudienceID) != "") {
			targets = append(targets, target)
		}
	}
	if err := runRows.Err(); err != nil {
		return nil, err
	}
	return targets, nil
}

func (r *Repo) updateProviderDiagnostics(ctx context.Context, target providerDiagnosticsTarget, update providerDiagnosticsUpdate) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("audience_destinations: repo pool is required")
	}
	tx, err := db.WithTenant(ctx, r.Pool, target.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var sql string
	switch target.Kind {
	case providerDiagnosticsKindJob:
		sql = `
UPDATE audience_sync_jobs
   SET provider_status = NULLIF($3,''),
       provider_checked_at = $4,
       provider_next_check_at = $5,
       provider_poll_attempts = $6
 WHERE tenant_id = $1::uuid AND id = $2::uuid`
	case providerDiagnosticsKindRun:
		sql = `
UPDATE audience_sync_runs
   SET provider_status = NULLIF($3,''),
       provider_checked_at = $4,
       provider_next_check_at = $5,
       provider_poll_attempts = $6
 WHERE tenant_id = $1::uuid AND id = $2::uuid`
	default:
		return fmt.Errorf("audience_destinations: unknown diagnostics target kind %q", target.Kind)
	}
	tag, err := tx.Exec(ctx, sql,
		target.TenantID, target.LedgerID, normalizeProviderDiagnosticsStatus(update.ProviderStatus),
		update.ProviderCheckedAt.UTC(), update.ProviderNextCheckAt, update.ProviderPollAttempts)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}
