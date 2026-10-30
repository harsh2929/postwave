// SPDX-License-Identifier: AGPL-3.0-only
//
// runner.go — executes a write-back: resolve the target's source audience, then
// for each member apply the configured tags + fields to the matching platform
// record via the provider adapter, aggregating into an audited run. Sequential
// per member (the adapters surface provider 429s as errors, counted as failures)
// — fine for the audience cap; high-volume batching is a follow-on.
package integration_writeback

import (
	"context"
	"fmt"
	"time"
)

// RunWriteback resolves the audience and pushes tags/fields to the platform.
func (d *Deps) RunWriteback(ctx context.Context, tenantID, targetID, runMode string) (RunSummary, *Run, error) {
	target, err := d.Repo.GetTarget(ctx, tenantID, targetID)
	if err != nil {
		return RunSummary{}, nil, err
	}
	if target.Status == "paused" || target.Status == "disconnected" {
		return RunSummary{}, nil, fmt.Errorf("write-back target is %s", target.Status)
	}
	adapter := d.adapter(target.Provider)
	if adapter == nil {
		return RunSummary{}, nil, fmt.Errorf("no write-back adapter for provider %q", target.Provider)
	}
	if d.Credentials == nil {
		return RunSummary{}, nil, fmt.Errorf("credential resolver not configured")
	}

	started := d.now()
	summary := RunSummary{Status: "completed"}

	creds, err := resolveTargetCredentials(ctx, d.Credentials, tenantID, target.CredentialsRef)
	if err != nil {
		return d.failRun(ctx, tenantID, targetID, runMode, started, fmt.Errorf("resolve credentials: %w", err))
	}
	members, err := d.Repo.ResolveAudience(ctx, tenantID, target)
	if err != nil {
		return d.failRun(ctx, tenantID, targetID, runMode, started, err)
	}

	tags := settingStrings(target.Settings, "tags")
	staticFields := settingStringMap(target.Settings, "field_map")
	traitMap := settingStringMap(target.Settings, "trait_field_map")
	summary.MembersSeen = len(members)

	// Resolve every member up front: the static field_map defaults overlaid with
	// each subscriber's own traits via trait_field_map (the Klaviyo-class
	// behaviour). With no trait_field_map this collapses to the static field set.
	profiles := make([]ProfileWrite, 0, len(members))
	for _, m := range members {
		profiles = append(profiles, ProfileWrite{
			Email:  m.Email,
			Tags:   tags,
			Fields: resolveMemberFields(staticFields, traitMap, m.Traits),
		})
	}

	// Prefer a bulk path when the adapter offers one and there's more than a
	// single member — a 50k-member Shopify/HubSpot audience should be a handful
	// of bulk calls, not 50k. Falls back to one-request-per-member otherwise.
	if batcher, ok := adapter.(Batcher); ok && len(profiles) > 1 {
		applyBatched(ctx, batcher, creds, target.Settings, profiles, &summary)
	} else {
		applySequential(ctx, adapter, creds, target.Settings, profiles, &summary)
	}
	if summary.RowsFailed > 0 && summary.Matched == 0 && summary.TagsWritten == 0 && summary.FieldsWritten == 0 {
		summary.Status = "failed"
	}

	completed := d.now()
	run, err := d.Repo.RecordRun(ctx, tenantID, targetID, runMode, summary, started, completed)
	if err != nil {
		return summary, nil, err
	}
	summary.RunID = run.ID
	return summary, run, nil
}

func resolveTargetCredentials(ctx context.Context, resolver CredentialResolver, tenantID, ref string) (map[string]string, error) {
	if resolver == nil {
		return nil, fmt.Errorf("credential resolver not configured")
	}
	if tenantResolver, ok := resolver.(TenantCredentialResolver); ok {
		return tenantResolver.ResolveForTenant(ctx, tenantID, ref)
	}
	return resolver.Resolve(ctx, ref)
}

// applySequential writes one member per request (the universal path; used when
// the adapter has no bulk capability or there's a single member).
func applySequential(ctx context.Context, adapter Adapter, creds map[string]string, settings map[string]any, profiles []ProfileWrite, summary *RunSummary) {
	for _, p := range profiles {
		res, werr := adapter.WriteProfile(ctx, creds, settings, p)
		if werr != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = werr.Error()
			continue
		}
		if res.Matched {
			summary.Matched++
		}
		summary.TagsWritten += res.TagsWritten
		summary.FieldsWritten += res.FieldsWritten
	}
}

// applyBatched writes the whole audience via the adapter's bulk path, folding the
// aggregate BatchResult into the run summary. A partial-batch failure marks the
// run partial; the matched/written counts still accrue.
func applyBatched(ctx context.Context, batcher Batcher, creds map[string]string, settings map[string]any, profiles []ProfileWrite, summary *RunSummary) {
	res, werr := batcher.BatchWrite(ctx, creds, settings, profiles)
	summary.Matched += res.Matched
	summary.TagsWritten += res.TagsWritten
	summary.FieldsWritten += res.FieldsWritten
	summary.RowsFailed += res.RowsFailed
	if res.RowsFailed > 0 {
		summary.Status = "partial"
	}
	if werr != nil {
		summary.Status = "partial"
		summary.ErrorMessage = werr.Error()
	}
}

// failRun records a failed run (credential/audience resolution failed before any
// member was attempted) and surfaces it as a status:failed summary rather than a
// 5xx, so the caller sees the audited reason.
func (d *Deps) failRun(ctx context.Context, tenantID, targetID, runMode string, started time.Time, cause error) (RunSummary, *Run, error) {
	summary := RunSummary{Status: "failed", ErrorMessage: cause.Error()}
	run, rerr := d.Repo.RecordRun(ctx, tenantID, targetID, runMode, summary, started, d.now())
	if rerr != nil {
		return summary, nil, cause
	}
	summary.RunID = run.ID
	return summary, run, nil
}
