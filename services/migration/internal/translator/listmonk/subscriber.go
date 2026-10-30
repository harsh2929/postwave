package listmonk

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"

	"github.com/postwave/migrate/canonical"
)

// WriteResult is a per-batch summary returned to the orchestrator.
type WriteResult struct {
	Created   int
	Updated   int
	Reused    int
	Protected int
	Failed    int
	Errors    []error
	Resources []ImportedResource
}

type writeOptions struct {
	migrationJobID          string
	authoritativeStatus     bool
	authoritativeTags       bool
	authoritativeFields     bool
	transferSourceFrom      string
	sourceSnapshotPresent   bool
	db                      *sql.DB
	tenantID                string
	audiences               map[string]AudienceMapping
	sourceProjection        *subscriberSourceProjection
	projectionReconcile     *subscriberProjectionReconciliation
	preserveSourceAudiences bool
	guardSourceEmailMove    bool
}

// SourceSnapshotDeletionCandidate is a same-job subscriber ledger row that is
// absent from a completed source snapshot. Destination identity is carried
// explicitly so the deletion guard can inspect every tenant ledger for the
// exact shared subscriber without scanning or trusting email-only matches.
type SourceSnapshotDeletionCandidate struct {
	Subscriber      canonical.Subscriber
	DestinationType string
	DestinationID   string
}

// WriteOption customises subscriber writes.
type WriteOption func(*writeOptions)

// WithMigrationJobID stamps Listmonk attribs and returned resource records
// with the owning migration job id.
func WithMigrationJobID(jobID string) WriteOption {
	return func(opts *writeOptions) {
		opts.migrationJobID = jobID
	}
}

// WithAuthoritativeStatus lets a source update subscriber status on conflict
// only when the destination row already carries the same source platform and
// source id. Existing unrelated suppressions stay protected.
func WithAuthoritativeStatus() WriteOption {
	return func(opts *writeOptions) {
		opts.authoritativeStatus = true
	}
}

// WithAuthoritativeTags replaces tags previously owned by the same source
// identity while preserving locally curated and unrelated-source tags. This is
// required for snapshot/delta sources such as ActiveCampaign where a removed
// list membership or contact tag must not remain targetable forever.
func WithAuthoritativeTags() WriteOption {
	return func(opts *writeOptions) {
		opts.authoritativeTags = true
	}
}

// WithAuthoritativeFields replaces custom fields previously owned by the same
// source identity while preserving local and unrelated-source attributes.
// Snapshot/delta sources use this so a value removed upstream does not survive
// indefinitely in the destination.
func WithAuthoritativeFields() WriteOption {
	return func(opts *writeOptions) {
		opts.authoritativeFields = true
	}
}

// WithSourceIdentityTransferFrom authorizes one reconciliation write to move
// a source-owned destination subscriber from a deleted source identity to a
// still-present, previously tracked identity for the same source/email. The
// persistence layer validates every part of that proof and fails closed if the
// requested transfer does not exactly match the locked before-image.
func WithSourceIdentityTransferFrom(sourceID string) WriteOption {
	return func(opts *writeOptions) {
		opts.transferSourceFrom = strings.TrimSpace(sourceID)
	}
}

// WithTenantPersistence enables the Moosewave canonical subscriber mirror and
// durable rollback ledger. Migration commits should always use this option;
// callers without it only exercise the legacy Listmonk compatibility path.
func WithTenantPersistence(db *sql.DB, tenantID string) WriteOption {
	return func(opts *writeOptions) {
		opts.db = db
		opts.tenantID = strings.TrimSpace(tenantID)
	}
}

// WithAudienceMappings subscribes imported contacts to their materialized
// source audiences in both Listmonk and list_subscribers.
func WithAudienceMappings(audiences map[string]AudienceMapping) WriteOption {
	return func(opts *writeOptions) {
		opts.audiences = audiences
	}
}

// WithPreservedSourceAudienceProjection keeps the last exact, durable
// per-source audience projection when an incremental feed updates subscriber
// status/fields without proving current list or segment membership. The
// destination tags remain non-authoritative; a later full snapshot replaces
// them through WithAuthoritativeTags.
func WithPreservedSourceAudienceProjection() WriteOption {
	return func(opts *writeOptions) {
		opts.preserveSourceAudiences = true
	}
}

// WithSourceIdentityEmailGuard rejects an incremental write when the same
// stable source identity is still attached to a different, source-owned email
// in this job's active snapshot ledger. A later complete source snapshot can
// safely materialize the new address and disable the old destination under the
// existing reconciliation proof; an incremental event cannot prove both sides
// of that move and therefore must not leave two targetable identities.
func WithSourceIdentityEmailGuard() WriteOption {
	return func(opts *writeOptions) {
		opts.guardSourceEmailMove = true
	}
}

// WriteSubscribers upserts a slice of canonical subscribers via the Listmonk
// admin API. Each subscriber is sent individually (Listmonk's bulk import is
// CSV-only and goroutine-driven; we prefer per-row idempotency).
//
// Custom fields land in subscribers.attribs (JSONB), tags become CSV-encoded
// `tags` on the create payload (Listmonk stores them on subscribers.tags).
func WriteSubscribers(ctx context.Context, client *Client, subs []canonical.Subscriber, options ...WriteOption) WriteResult {
	opts := writeOptions{sourceSnapshotPresent: true}
	for _, option := range options {
		option(&opts)
	}
	return writeSubscribersWithOptions(ctx, client, subs, opts, false)
}

// WriteSourceSnapshotDeletionDisables applies authoritative source-deletion
// disables only after checking tenant-wide migration ownership under the same
// subscriber batch lease used by every migration writer. A different active
// source identity for the exact destination protects the shared subscriber.
func WriteSourceSnapshotDeletionDisables(ctx context.Context, client *Client, candidates []SourceSnapshotDeletionCandidate, options ...WriteOption) (res WriteResult) {
	opts := writeOptions{sourceSnapshotPresent: false, authoritativeStatus: true}
	for _, option := range options {
		option(&opts)
	}
	if len(candidates) == 0 {
		return res
	}
	if opts.migrationJobID == "" || opts.db == nil || opts.tenantID == "" {
		res.Failed = len(candidates)
		res.Errors = append(res.Errors, fmt.Errorf("source snapshot deletion reconciliation requires tenant-scoped job persistence"))
		return res
	}
	lease, err := acquireSubscriberBatchLease(ctx, opts.db, opts.tenantID)
	if err != nil {
		res.Failed = len(candidates)
		res.Errors = append(res.Errors, err)
		return res
	}
	defer func() {
		if err := lease.Release(); err != nil {
			res.Failed++
			res.Errors = append(res.Errors, err)
		}
	}()

	allowed, reconciliations, protected, err := guardSourceSnapshotDeletionCandidates(ctx, opts.db, opts.tenantID, opts.migrationJobID, candidates)
	if err != nil {
		res.Failed = len(candidates)
		res.Errors = append(res.Errors, err)
		return res
	}
	for _, reconciliation := range reconciliations {
		reconcileOpts := opts
		reconcileOpts.migrationJobID = reconciliation.PrimaryJobID
		reconcileOpts.authoritativeStatus = true
		reconcileOpts.authoritativeTags = true
		reconcileOpts.authoritativeFields = true
		reconcileOpts.transferSourceFrom = reconciliation.Candidate.Subscriber.SourceID
		reconcileOpts.sourceSnapshotPresent = true
		reconcileOpts.audiences = reconciliation.AggregateAudiences
		reconcileOpts.sourceProjection = &reconciliation.PrimaryProjection
		reconcileOpts.projectionReconcile = reconciliation
		written := writeSubscribersWithOptions(ctx, client, []canonical.Subscriber{reconciliation.AggregateSubscriber}, reconcileOpts, true)
		mergeWriteResult(&res, written)
	}
	res.Protected += protected
	if len(allowed) > 0 {
		mergeWriteResult(&res, writeSubscribersWithOptions(ctx, client, allowed, opts, true))
	}
	return res
}

func mergeWriteResult(destination *WriteResult, incoming WriteResult) {
	if destination == nil {
		return
	}
	destination.Created += incoming.Created
	destination.Updated += incoming.Updated
	destination.Reused += incoming.Reused
	destination.Protected += incoming.Protected
	destination.Failed += incoming.Failed
	destination.Errors = append(destination.Errors, incoming.Errors...)
	destination.Resources = append(destination.Resources, incoming.Resources...)
}

func writeSubscribersWithOptions(ctx context.Context, client *Client, subs []canonical.Subscriber, opts writeOptions, batchLeaseHeld bool) WriteResult {
	res := WriteResult{}
	if opts.migrationJobID != "" && (opts.db == nil || opts.tenantID == "") {
		res.Failed = len(subs)
		res.Errors = append(res.Errors, fmt.Errorf("subscriber migration writes require tenant-scoped durable intent and ledger persistence"))
		return res
	}
	if opts.tenantID != "" {
		client = client.ForTenant(opts.tenantID)
	}
	var batchLease *subscriberBatchLease
	if !batchLeaseHeld && opts.db != nil && opts.tenantID != "" && opts.migrationJobID != "" && len(subs) > 0 {
		var err error
		batchLease, err = acquireSubscriberBatchLease(ctx, opts.db, opts.tenantID)
		if err != nil {
			res.Failed = len(subs)
			res.Errors = append(res.Errors, err)
			return res
		}
		defer func() { _ = batchLease.Release() }()
	}
	if opts.guardSourceEmailMove {
		for _, sub := range subs {
			if err := validateIncrementalSubscriberEmailIdentity(ctx, opts.db, opts.tenantID, opts.migrationJobID, sub); err != nil {
				res.Failed = len(subs)
				res.Errors = append(res.Errors, err)
				return res
			}
		}
	}
	for _, sub := range subs {
		if err := validateKlaviyoSubscriberAccountLineage(ctx, opts.db, opts.tenantID, opts.migrationJobID, sub); err != nil {
			res.Failed = len(subs)
			res.Errors = append(res.Errors, err)
			return res
		}
		if err := validateCustomerIOSubscriberWorkspaceLineage(ctx, opts.db, opts.tenantID, opts.migrationJobID, sub); err != nil {
			res.Failed = len(subs)
			res.Errors = append(res.Errors, err)
			return res
		}
	}
	capacityPrevalidated := false
	if opts.db != nil && opts.tenantID != "" && len(subs) > 0 {
		prepared, _, err := PrepareSubscriberBatchForWrite(ctx, opts.db, opts.tenantID, subs, 0)
		if err != nil {
			res.Failed = len(subs)
			res.Errors = append(res.Errors, fmt.Errorf("subscriber batch preflight: %w", err))
			return res
		}
		subs = prepared
		capacityPrevalidated = true
	}
	for _, s := range subs {
		payload := toListmonkPayloadWithOptions(s, opts)
		var projection *subscriberSourceProjection
		if opts.migrationJobID != "" {
			built, projectionErr := newSubscriberSourceProjection(s, opts.audiences)
			if opts.sourceProjection != nil {
				built = *opts.sourceProjection
				projectionErr = validateSubscriberSourceProjection(built)
			}
			if projectionErr != nil {
				res.Failed++
				res.Errors = append(res.Errors, fmt.Errorf("build subscriber source projection %q: %w", s.Email, projectionErr))
				continue
			}
			built, projectionErr = preflightSubscriberSourceProjection(ctx, opts.db, opts.tenantID, opts.migrationJobID, built, opts.preserveSourceAudiences)
			if projectionErr != nil {
				res.Failed++
				res.Errors = append(res.Errors, fmt.Errorf("preflight subscriber source projection %q: %w", s.Email, projectionErr))
				continue
			}
			projection = &built
		}
		var intent ExternalWriteIntent
		if opts.migrationJobID != "" {
			builtIntent, intentErr := subscriberIntent(opts.tenantID, opts.migrationJobID, s, payload)
			if intentErr != nil {
				res.Failed++
				res.Errors = append(res.Errors, intentErr)
				continue
			}
			intent = builtIntent
			if err := RecordExternalWriteIntents(ctx, opts.db, intent); err != nil {
				res.Failed++
				res.Errors = append(res.Errors, fmt.Errorf("record subscriber intent %q before external mutation: %w", s.Email, err))
				continue
			}
		}
		upsert, err := client.UpsertSubscriberWithSnapshot(ctx, payload)
		if err != nil {
			res.Failed++
			res.Errors = append(res.Errors, fmt.Errorf("upsert %q: %w", s.Email, err))
			continue
		}
		resp, outcome := upsert.Subscriber, upsert.Outcome
		var tracked ImportedResource
		var existingLedger *ImportedResource
		if opts.migrationJobID != "" && resp != nil && resp.ID > 0 {
			if opts.db != nil && opts.tenantID != "" {
				existingLedger, err = FindImportedResourceByDestination(ctx, opts.db, opts.tenantID, opts.migrationJobID,
					ResourceSubscriber, DestinationListmonkSubscriber, fmt.Sprintf("%d", resp.ID))
				if err != nil {
					// Cancellation may arrive after the external write but before the
					// ledger lookup. Retry the read on a detached bounded context so we
					// can distinguish a prior same-job ledger on recovery.
					reconcileCtx, cancel := detachedMigrationContext(ctx)
					existingLedger, err = FindImportedResourceByDestination(reconcileCtx, opts.db, opts.tenantID, opts.migrationJobID,
						ResourceSubscriber, DestinationListmonkSubscriber, fmt.Sprintf("%d", resp.ID))
					cancel()
					if err != nil {
						res.Failed++
						res.Errors = append(res.Errors, fmt.Errorf("reconcile subscriber ledger %q: %w (the same-job fingerprinted Listmonk state was retained for safe retry)", s.Email, err))
						continue
					}
				}
			}
			tracked = subscriberResource(opts.migrationJobID, s, resp.ID, outcome, upsert.Before, resp)
			tracked.DestinationMetadata["postwave_source_snapshot_present"] = opts.sourceSnapshotPresent
			if projection != nil {
				for key, value := range subscriberProjectionMetadata(*projection) {
					tracked.DestinationMetadata[key] = value
				}
			}
			if opts.db != nil && opts.tenantID != "" {
				tracked.TenantID = opts.tenantID
				if err := persistSubscriberMirrorWithSourceIdentityTransfer(ctx, opts.db, tracked, s, opts.audiences, opts.authoritativeStatus, opts.authoritativeTags, opts.authoritativeFields, opts.transferSourceFrom, opts.projectionReconcile, capacityPrevalidated); err != nil {
					res.Failed++
					// Listmonk has no conditional DELETE/PUT. Even an exact GET check
					// leaves a race in which a user changes the row before compensation.
					// Retain the same-job fingerprint for safe retry instead of risking
					// deletion or overwrite of that concurrent winner.
					res.Errors = append(res.Errors, fmt.Errorf("persist Moosewave subscriber %q: %w (same-job fingerprinted Listmonk state retained for safe retry)", s.Email, err))
					continue
				}
			}
		}
		if opts.migrationJobID != "" && (resp == nil || resp.ID <= 0) {
			res.Failed++
			res.Errors = append(res.Errors, fmt.Errorf("upsert %q returned no durable destination identity; external intent retained", s.Email))
			continue
		}
		if opts.migrationJobID != "" {
			if err := DeleteExternalWriteIntents(ctx, opts.db, opts.tenantID, opts.migrationJobID, intent); err != nil {
				res.Failed++
				res.Errors = append(res.Errors, fmt.Errorf("clear subscriber external intent %q after ledger persistence: %w", s.Email, err))
				continue
			}
		}
		// UpsertSubscriber tells us which path it took (Create vs
		// conflict→PUT). Counting accurately matters for re-run
		// migrations where existing subscribers should show as Updated,
		// not double-counted as Created.
		if existingLedger != nil && metadataHasSourceID(existingLedger.DestinationMetadata, s.SourceID) {
			res.Reused++
		} else {
			switch outcome {
			case UpsertUpdated:
				res.Updated++
			default:
				res.Created++
			}
		}
		if tracked.DestinationID != "" {
			res.Resources = append(res.Resources, tracked)
		}
	}
	return res
}

func metadataHasSourceID(metadata map[string]interface{}, sourceID string) bool {
	if strings.TrimSpace(sourceID) == "" {
		return false
	}
	for _, value := range metadataStringSlice(metadata["source_ids"]) {
		if value == sourceID {
			return true
		}
	}
	return false
}

// toListmonkPayload maps canonical → Listmonk wire format. Tags are written to
// Listmonk's native subscribers.tags column and also retained in attribs for
// audit/debug visibility.
func toListmonkPayload(s canonical.Subscriber, migrationJobID ...string) SubscriberPayload {
	opts := writeOptions{}
	if len(migrationJobID) > 0 {
		opts.migrationJobID = migrationJobID[0]
	}
	return toListmonkPayloadWithOptions(s, opts)
}

func toListmonkPayloadWithOptions(s canonical.Subscriber, opts writeOptions) SubscriberPayload {
	// FAILS CLOSED. The zero value used to be "enabled", and the switch had no
	// default, so any status outside the four canonical values — including the
	// empty string — produced a MAILABLE contact.
	//
	// canonical.SubscriberStatus is a bare string type with no validator, and
	// the values that fall through are not hypothetical: "pending", "cleaned"
	// and "archived" are Mailchimp's own subscriber statuses, meaning
	// respectively an unconfirmed double-opt-in, a hard-bounced or invalid
	// address, and one deliberately removed from the audience. Importing any of
	// them as enabled mails somebody who opted out of the platform being
	// migrated FROM — the single worst outcome of a migration, and one nothing
	// downstream would flag.
	//
	// Today's Mailchimp path does map correctly (source statuses live in a
	// separate mirror field, ranked by mailchimpStatusRank), so this was latent
	// rather than live. It is written down because the next adapter has no
	// type-level obligation to map anything, and because two sibling files —
	// subscriber_store.go and subscriber_projection.go — already resolve an
	// empty status to DISABLED. This one disagreed with both, and it is the one
	// that builds the payload actually written to the send store.
	var status string
	switch s.Status {
	case canonical.StatusEnabled:
		status = "enabled"
	case canonical.StatusDisabled, canonical.StatusUnconfirmed:
		// Listmonk doesn't track unconfirmed at the subscriber level the same
		// way; treat as disabled with a flag in attribs for traceability.
		status = "disabled"
	case canonical.StatusBlocklisted:
		status = "blocklisted"
	default:
		// Explicit so the choice is visible at the point of decision; there is
		// deliberately no initializer for it to fall back on.
		status = "disabled"
	}

	attribs := map[string]interface{}{}
	sourceFieldKeys := make([]string, 0, len(s.CustomFields))
	reservedFieldCollisions := map[string]interface{}{}
	for k, v := range s.CustomFields {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		if s.SourcePlatform == canonical.SourceBeehiiv && k == "beehiiv" {
			// Keep provider provenance in Moosewave's canonical mirror/source
			// archive; it is not user targeting data for the Listmonk send store.
			continue
		}
		if reservedListmonkAttribName(k) {
			// Provider field names are untrusted data. Never let one overwrite
			// identity/authority/rollback control attributes; retain its value in
			// an explicit collision ledger instead.
			reservedFieldCollisions[k] = []interface{}{v}
			continue
		}
		attribs[k] = v
		if opts.authoritativeFields {
			sourceFieldKeys = append(sourceFieldKeys, k)
		}
	}
	if len(reservedFieldCollisions) > 0 {
		attribs[sourceFieldNameCollisionAttrib] = reservedFieldCollisions
	}
	if opts.authoritativeFields {
		sort.Strings(sourceFieldKeys)
		attribs["postwave_source_field_keys"] = sourceFieldKeys
	}
	if s.SourceID != "" {
		attribs["postwave_source_id"] = s.SourceID
	}
	if s.SourcePlatform != "" {
		attribs["postwave_source_platform"] = string(s.SourcePlatform)
	}
	if opts.migrationJobID != "" {
		attribs["postwave_migration_job_id"] = opts.migrationJobID
		attribs[migrationOperationAttrib] = string(UpsertCreated)
	}
	if opts.tenantID != "" {
		attribs["postwave_tenant_id"] = opts.tenantID
	}
	if s.ConsentTimestamp != nil {
		attribs["postwave_consent_at"] = s.ConsentTimestamp.UTC().Format("2006-01-02T15:04:05Z")
	}
	if s.ConsentSource != "" {
		attribs["postwave_consent_source"] = string(s.ConsentSource)
	}
	tags := normalizeSubscriberTags(s.Tags)
	if tags == nil {
		tags = []string{}
	}
	if len(tags) > 0 {
		attribs["postwave_tags"] = tags
	}
	if s.Status == canonical.StatusUnconfirmed {
		attribs["postwave_status_raw"] = "unconfirmed"
	}
	identityKey := subscriberSourceIdentityKey(s.SourcePlatform, s.SourceID)
	if identityKey != "" {
		attribs["postwave_source_identity_keys"] = []string{identityKey}
	}

	name := ""
	if v, ok := s.CustomFields["name"].(string); ok {
		name = v
	}

	lists := listmonkAudienceIDs(tags, opts.audiences)
	if lists == nil {
		lists = []int{}
	}
	attribs["postwave_source_list_ids"] = lists
	payload := SubscriberPayload{
		Email:                  s.Email,
		Name:                   name,
		Status:                 status,
		Tags:                   tags,
		Lists:                  lists,
		Attribs:                attribs,
		PreconfirmSubscription: true,
		AuthoritativeStatus:    opts.authoritativeStatus,
		AuthoritativeTags:      opts.authoritativeTags,
		AuthoritativeFields:    opts.authoritativeFields,
		TransferSourceFrom:     opts.transferSourceFrom,
	}
	if opts.projectionReconcile != nil {
		payload.ProjectionReconciliation = opts.projectionReconcile
		payload.PreserveExistingConsent = defensibleImportedConsentAt(s, string(s.Status), subscriberMirrorFields(s).MailchimpStatus) == nil
	}
	return payload
}

func reservedListmonkAttribName(name string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(name)), "postwave_")
}

func listmonkAudienceIDs(tags []string, audiences map[string]AudienceMapping) []int {
	if len(audiences) == 0 {
		return nil
	}
	ids := make([]int, 0, len(audiences))
	seen := map[int]struct{}{}
	for _, tag := range tags {
		audienceID, ok := sourceAudienceIDFromTag(tag)
		if !ok {
			continue
		}
		mapping, ok := audiences[audienceID]
		if !ok || mapping.ListmonkID <= 0 {
			continue
		}
		if _, ok := seen[mapping.ListmonkID]; ok {
			continue
		}
		seen[mapping.ListmonkID] = struct{}{}
		ids = append(ids, mapping.ListmonkID)
	}
	return ids
}

func sourceAudienceIDFromTag(tag string) (string, bool) {
	tag = strings.TrimSpace(tag)
	for _, prefix := range []string{"klaviyo:list:", "klaviyo:segment:"} {
		if strings.HasPrefix(tag, prefix) && strings.TrimSpace(strings.TrimPrefix(tag, prefix)) != "" {
			// Klaviyo discovery audiences use the qualified tag itself as the
			// stable source identity so list and segment IDs cannot collide.
			return tag, true
		}
	}
	const prefix = "mailchimp:list:"
	if !strings.HasPrefix(tag, prefix) {
		return "", false
	}
	rest := strings.TrimPrefix(tag, prefix)
	if idx := strings.Index(rest, ":segment:"); idx >= 0 {
		rest = rest[:idx]
	}
	rest = strings.TrimSpace(rest)
	return rest, rest != ""
}

func normalizeSubscriberTags(tags []string) []string {
	if len(tags) == 0 {
		return nil
	}
	out := make([]string, 0, len(tags))
	seen := map[string]struct{}{}
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		key := strings.ToLower(tag)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, tag)
	}
	return out
}
