// SPDX-License-Identifier: AGPL-3.0-only
//
// backfill_on_connect.go — Klaviyo-style "import your history the moment you
// connect". When a provider-managed-puller integration is created, we kick off a
// bounded background drain that walks the connector's backfill pages to
// completion (or the page cap), so the operator doesn't have to manually trigger
// POST /backfill. Gated per integration by settings["backfill_on_connect"]
// (default on); a no-op for webhook-only providers that have no puller.
package lead_integrations

import (
	"context"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_backfill"
	"github.com/postwave/postwave/apps/api/internal/safego"
)

// backfillOnConnectPageDelay paces provider calls during the connect-time drain
// so a fresh connection doesn't burst the source's rate limit.
const backfillOnConnectPageDelay = 300 * time.Millisecond

// maybeBackfillOnConnect starts a background history import for a freshly created
// integration, unless the tenant disabled it or the provider has no puller.
func (d *Deps) maybeBackfillOnConnect(integration *Integration) {
	if d == nil || d.Repo == nil || integration == nil {
		return
	}
	if settingDisabled(integration.Settings, "backfill_on_connect") {
		return
	}
	if !d.hasProviderPuller(integration.Provider) {
		return // webhook-only provider: nothing to import historically
	}
	tenantID := integration.TenantID
	// Copy so the goroutine never races the handler's value after it returns.
	snapshot := *integration
	safego.Go(d.Logger, "lead_integrations.backfill_on_connect", func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		res := integration_backfill.Drain(ctx, integration_backfill.Options{
			StartCursor: snapshot.SyncCursor,
			PageDelay:   backfillOnConnectPageDelay,
		}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
			return d.backfillPageOnce(ctx, tenantID, &snapshot, cursor)
		})
		if d.Logger != nil {
			d.Logger.Info("lead backfill-on-connect finished",
				"provider", snapshot.Provider, "integration_id", snapshot.ID,
				"pages", res.PagesRun, "rows", res.RowsTotal, "stop", string(res.Stop))
		}
	})
}

// backfillPageOnce pulls + applies a single provider-managed backfill page and
// records the run, returning the rows processed and the next cursor. It is the
// PageFunc the drainer walks. ok==false (no puller) yields an empty page so the
// drain stops immediately.
func (d *Deps) backfillPageOnce(ctx context.Context, tenantID string, integration *Integration, cursor string) (integration_backfill.PageResult, error) {
	req := normalizeSyncRequest(SyncRequest{RunMode: "backfill", Cursor: cursor})
	pulled, ok, err := d.providerManagedSyncRequest(ctx, tenantID, integration, req)
	if err != nil {
		return integration_backfill.PageResult{}, err
	}
	if !ok {
		return integration_backfill.PageResult{}, nil
	}
	if max := d.maxSyncRows(); len(pulled.Submissions) > max {
		pulled.Submissions = pulled.Submissions[:max]
	}
	started := d.now()
	summary := d.executeSync(ctx, tenantID, integration, pulled)
	completed := d.now()
	// Audit productive or failed pages only; the terminal empty page that merely
	// signals "no more history" would otherwise add a noisy 0-row run per connect.
	if summary.SubmissionsSeen > 0 || summary.Status != "completed" {
		if _, err := d.Repo.RecordSyncRun(ctx, tenantID, integration.ID, summary, pulled, started, completed); err != nil {
			return integration_backfill.PageResult{}, fmt.Errorf("record backfill run: %w", err)
		}
	}
	// Thread the advanced cursor onto the snapshot so the next page resumes from
	// it even before the persisted integration row is re-read.
	integration.SyncCursor = summary.Cursor
	return integration_backfill.PageResult{Rows: summary.SubmissionsSeen, NextCursor: summary.Cursor}, nil
}

// hasProviderPuller reports whether the provider has a configured backfiller —
// i.e. whether providerManagedSyncRequest can pull history for it.
func (d *Deps) hasProviderPuller(provider string) bool {
	switch provider {
	case ProviderTypeform:
		return d.typeformBackfiller() != nil
	case ProviderSurveyMonkey:
		return d.surveyMonkeyBackfiller() != nil
	case ProviderUnbounce:
		return d.unbounceBackfiller() != nil
	case ProviderLeadpages:
		return d.leadpagesBackfiller() != nil
	case Provider123FormBuilder:
		return d.formBuilder123Backfiller() != nil
	case ProviderInstapage:
		return d.instapageBackfiller() != nil
	case ProviderWix:
		return d.wixBackfiller() != nil
	case ProviderJotform:
		return d.jotformBackfiller() != nil
	case ProviderWebflow:
		return d.webflowBackfiller() != nil
	case ProviderPaperform:
		return d.paperformBackfiller() != nil
	case ProviderFormstack:
		return d.formstackBackfiller() != nil
	case ProviderFormsite:
		return d.formsiteBackfiller() != nil
	case ProviderCognitoForms:
		return d.cognitoFormsBackfiller() != nil
	case ProviderGravityForms:
		return d.gravityFormsBackfiller() != nil
	case ProviderWPForms:
		return d.wpformsBackfiller() != nil
	case ProviderFormidableForms:
		return d.formidableFormsBackfiller() != nil
	case ProviderFeathery:
		return d.featheryBackfiller() != nil
	case ProviderFormaloo:
		return d.formalooBackfiller() != nil
	case ProviderFillout:
		return d.filloutBackfiller() != nil
	case ProviderTally:
		return d.tallyBackfiller() != nil
	case ProviderGoogleForms:
		return d.googleFormsBackfiller() != nil
	case ProviderFacebookLeadAds:
		return d.facebookLeadAdsBackfiller() != nil
	case ProviderGoogleLeadForms:
		return d.googleLeadFormsBackfiller() != nil
	default:
		return false
	}
}

// settingDisabled reports whether a boolean-ish setting is explicitly turned off.
// An absent value means enabled (opt-out, not opt-in).
func settingDisabled(settings map[string]any, key string) bool {
	if settings == nil {
		return false
	}
	v, ok := settings[key]
	if !ok || v == nil {
		return false
	}
	switch t := v.(type) {
	case bool:
		return !t
	case string:
		switch t {
		case "false", "0", "no", "off", "disabled":
			return true
		}
	}
	return false
}
