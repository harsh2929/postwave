package listmonk

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/postwave/migrate/canonical"
)

const (
	subscriberSourceProjectionVersion = 1
	maxSubscriberProjectionBytes      = 256 << 10
	maxSubscriberProjectionSetBytes   = maxSubscriberProjectionBytes * 8
	maxSubscriberProjectionIdentities = 32
	maxSubscriberProjectionFields     = 2_048
	maxSubscriberProjectionTags       = 4_096
	maxSubscriberProjectionAudiences  = 4_096
)

const subscriberSourceProjectionsMetadataKey = "postwave_source_projections"

const (
	subscriberSharedBaselinePresentMetadataKey = "postwave_shared_source_baseline_status_present"
	subscriberSharedBaselineStatusMetadataKey  = "postwave_shared_source_baseline_status"
)

type subscriberProjectedAudience struct {
	SourceID   string `json:"source_id"`
	Name       string `json:"name"`
	ListmonkID int    `json:"listmonk_id"`
	PostwaveID string `json:"postwave_id"`
}

// subscriberSourceProjection is the immutable, source-specific input needed
// to rebuild a shared destination after one source identity disappears. It is
// deliberately separate from destination after-images, which contain merged
// state and therefore cannot prove ownership of a shared tag or field.
type subscriberSourceProjection struct {
	Version    int                           `json:"version"`
	Subscriber canonical.Subscriber          `json:"subscriber"`
	Audiences  []subscriberProjectedAudience `json:"audiences"`
}

type subscriberProjectionReconciliation struct {
	Candidate             SourceSnapshotDeletionCandidate
	RetiringJobID         string
	RetiringMetadata      map[string]interface{}
	PrimaryJobID          string
	PrimaryProjection     subscriberSourceProjection
	AggregateSubscriber   canonical.Subscriber
	AggregateAudiences    map[string]AudienceMapping
	ActiveIdentityKeys    []string
	ActiveSourceIDs       []string
	BaselineStatus        canonical.SubscriberStatus
	BaselineStatusPresent bool
}

type subscriberProjectionSet struct {
	projections  map[string]subscriberSourceProjection
	encodedBytes int
}

func subscriberSourceIdentityKey(platform canonical.SourcePlatform, sourceID string) string {
	platformText := strings.ToLower(strings.TrimSpace(string(platform)))
	sourceID = strings.TrimSpace(sourceID)
	if platformText == "" || sourceID == "" {
		return ""
	}
	return platformText + ":" + sourceID
}

func newSubscriberSourceProjection(sub canonical.Subscriber, audiences map[string]AudienceMapping) (subscriberSourceProjection, error) {
	projection := subscriberSourceProjection{Version: subscriberSourceProjectionVersion, Subscriber: sub}
	projection.Subscriber.Email = strings.ToLower(strings.TrimSpace(projection.Subscriber.Email))
	projection.Subscriber.SourceID = strings.TrimSpace(projection.Subscriber.SourceID)
	projection.Subscriber.Tags = normalizeSubscriberTags(projection.Subscriber.Tags)
	if projection.Subscriber.Tags == nil {
		projection.Subscriber.Tags = []string{}
	}
	seenAudience := map[string]struct{}{}
	for _, tag := range projection.Subscriber.Tags {
		sourceID, ok := sourceAudienceIDFromTag(tag)
		if !ok {
			continue
		}
		mapping, ok := audiences[sourceID]
		if !ok || mapping.ListmonkID <= 0 || strings.TrimSpace(mapping.PostwaveID) == "" {
			return subscriberSourceProjection{}, fmt.Errorf("subscriber source projection references audience %q without a complete destination mapping", sourceID)
		}
		if _, duplicate := seenAudience[sourceID]; duplicate {
			continue
		}
		seenAudience[sourceID] = struct{}{}
		projection.Audiences = append(projection.Audiences, subscriberProjectedAudience{
			SourceID: sourceID, Name: mapping.Name, ListmonkID: mapping.ListmonkID, PostwaveID: mapping.PostwaveID,
		})
	}
	sort.Slice(projection.Audiences, func(i, j int) bool { return projection.Audiences[i].SourceID < projection.Audiences[j].SourceID })
	if err := validateSubscriberSourceProjection(projection); err != nil {
		return subscriberSourceProjection{}, err
	}
	return projection, nil
}

func validateSubscriberSourceProjection(projection subscriberSourceProjection) error {
	if projection.Version != subscriberSourceProjectionVersion {
		return fmt.Errorf("subscriber source projection has unsupported version %d", projection.Version)
	}
	sub := projection.Subscriber
	if strings.TrimSpace(sub.Email) == "" || strings.TrimSpace(sub.SourceID) == "" || sub.SourcePlatform == "" {
		return fmt.Errorf("subscriber source projection has incomplete source identity")
	}
	if subscriberSourceIdentityKey(sub.SourcePlatform, sub.SourceID) == "" {
		return fmt.Errorf("subscriber source projection has invalid source identity")
	}
	if len(sub.CustomFields) > maxSubscriberProjectionFields || len(sub.Tags) > maxSubscriberProjectionTags || len(projection.Audiences) > maxSubscriberProjectionAudiences {
		return fmt.Errorf("subscriber source projection exceeds bounded field, tag, or audience limits")
	}
	seenAudience := map[string]struct{}{}
	for _, audience := range projection.Audiences {
		if strings.TrimSpace(audience.SourceID) == "" || audience.ListmonkID <= 0 || strings.TrimSpace(audience.PostwaveID) == "" {
			return fmt.Errorf("subscriber source projection contains an incomplete audience mapping")
		}
		if _, err := uuid.Parse(audience.PostwaveID); err != nil {
			return fmt.Errorf("subscriber source projection contains an invalid Moosewave audience identity")
		}
		if _, duplicate := seenAudience[audience.SourceID]; duplicate {
			return fmt.Errorf("subscriber source projection repeats audience %q", audience.SourceID)
		}
		seenAudience[audience.SourceID] = struct{}{}
	}
	raw, err := json.Marshal(projection)
	if err != nil {
		return fmt.Errorf("encode subscriber source projection: %w", err)
	}
	if len(raw) > maxSubscriberProjectionBytes {
		return fmt.Errorf("subscriber source projection is %d bytes; limit is %d", len(raw), maxSubscriberProjectionBytes)
	}
	return nil
}

func subscriberProjectionMetadata(projection subscriberSourceProjection) map[string]interface{} {
	raw, _ := json.Marshal(projection)
	var value map[string]interface{}
	_ = json.Unmarshal(raw, &value)
	return map[string]interface{}{
		subscriberSourceProjectionsMetadataKey: map[string]interface{}{
			subscriberSourceIdentityKey(projection.Subscriber.SourcePlatform, projection.Subscriber.SourceID): value,
		},
	}
}

func subscriberProjectionsFromMetadata(metadata map[string]interface{}) (map[string]subscriberSourceProjection, error) {
	value, ok := metadata[subscriberSourceProjectionsMetadataKey]
	if !ok {
		return nil, fmt.Errorf("subscriber ledger lacks bounded per-source projection metadata")
	}
	raw, err := json.Marshal(value)
	if err != nil || len(raw) > maxSubscriberProjectionSetBytes {
		return nil, fmt.Errorf("subscriber ledger source projections are invalid or exceed the aggregate bound")
	}
	var encoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &encoded); err != nil || len(encoded) == 0 || len(encoded) > maxSubscriberProjectionIdentities {
		return nil, fmt.Errorf("subscriber ledger source projections are invalid or exceed the identity bound")
	}
	out := make(map[string]subscriberSourceProjection, len(encoded))
	for key, item := range encoded {
		var projection subscriberSourceProjection
		decoder := json.NewDecoder(bytes.NewReader(item))
		decoder.UseNumber()
		if err := decoder.Decode(&projection); err != nil {
			return nil, fmt.Errorf("decode subscriber source projection %q: %w", key, err)
		}
		if err := validateSubscriberSourceProjection(projection); err != nil {
			return nil, fmt.Errorf("validate subscriber source projection %q: %w", key, err)
		}
		if canonicalKey := subscriberSourceIdentityKey(projection.Subscriber.SourcePlatform, projection.Subscriber.SourceID); canonicalKey != key {
			return nil, fmt.Errorf("subscriber source projection key %q does not match its canonical identity", key)
		}
		out[key] = projection
	}
	if err := validateSubscriberProjectionSet(out); err != nil {
		return nil, err
	}
	return out, nil
}

func validateSubscriberProjectionSet(projections map[string]subscriberSourceProjection) error {
	if len(projections) == 0 || len(projections) > maxSubscriberProjectionIdentities {
		return fmt.Errorf("subscriber source projection set has %d identities; limit is %d", len(projections), maxSubscriberProjectionIdentities)
	}
	raw, err := json.Marshal(projections)
	if err != nil {
		return fmt.Errorf("encode subscriber source projection set: %w", err)
	}
	if len(raw) > maxSubscriberProjectionSetBytes {
		return fmt.Errorf("subscriber source projection set is %d bytes; limit is %d", len(raw), maxSubscriberProjectionSetBytes)
	}
	for key, projection := range projections {
		if err := validateSubscriberSourceProjection(projection); err != nil {
			return fmt.Errorf("validate subscriber source projection %q: %w", key, err)
		}
		if subscriberSourceIdentityKey(projection.Subscriber.SourcePlatform, projection.Subscriber.SourceID) != key {
			return fmt.Errorf("subscriber source projection key %q does not match its canonical identity", key)
		}
	}
	return nil
}

func newSubscriberProjectionSet() *subscriberProjectionSet {
	return &subscriberProjectionSet{projections: map[string]subscriberSourceProjection{}}
}

func (set *subscriberProjectionSet) add(key string, projection subscriberSourceProjection) error {
	if set == nil {
		return fmt.Errorf("subscriber source projection accumulator is nil")
	}
	if previous, exists := set.projections[key]; exists {
		if !reflect.DeepEqual(previous, projection) {
			return fmt.Errorf("active subscriber source identity %q has conflicting durable projections", key)
		}
		return nil
	}
	set.projections[key] = projection
	if err := validateSubscriberProjectionSet(set.projections); err != nil {
		delete(set.projections, key)
		return err
	}
	raw, _ := json.Marshal(set.projections)
	set.encodedBytes = len(raw)
	return nil
}

func mergeSubscriberProjectionMetadata(previous, incoming interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for _, value := range []interface{}{previous, incoming} {
		encoded, ok := value.(map[string]interface{})
		if !ok {
			continue
		}
		for key, projection := range encoded {
			out[key] = projection
		}
	}
	return out
}

// preflightSubscriberSourceProjection proves that adding/replacing this one
// source projection cannot make the durable same-job ledger ambiguous or
// exceed its hard bounds. It runs while the tenant subscriber lease is held
// and before intent persistence or any Listmonk request.
func preflightSubscriberSourceProjection(ctx context.Context, db *sql.DB, tenantID, jobID string, incoming subscriberSourceProjection, preserveSourceAudiences bool) (prepared subscriberSourceProjection, err error) {
	prepared = incoming
	if db == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(jobID) == "" {
		return prepared, fmt.Errorf("subscriber source projection preflight requires DB, tenant, and job")
	}
	if err := validateSubscriberSourceProjection(incoming); err != nil {
		return prepared, err
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return prepared, err
	}
	defer commitTx(tx, &err)
	rows, err := tx.QueryContext(ctx, `
		SELECT source_platform, COALESCE(source_id, ''), destination_metadata
		  FROM migration_imported_resources
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
		   AND resource_type = 'subscriber' AND rolled_back_at IS NULL
		   AND (
		       jsonb_typeof(destination_metadata -> 'email') IS DISTINCT FROM 'string'
		       OR
		       NULLIF(btrim(destination_metadata ->> 'email'), '') IS NULL
		       OR lower(btrim(destination_metadata ->> 'email')) = lower($3)
		   )
		 ORDER BY id
		 FOR UPDATE
	`, tenantID, jobID, strings.ToLower(strings.TrimSpace(incoming.Subscriber.Email)))
	if err != nil {
		return prepared, fmt.Errorf("load subscriber projection preflight ledger: %w", err)
	}
	defer func() { _ = rows.Close() }()
	type ledger struct {
		platform canonical.SourcePlatform
		sourceID string
		metadata map[string]interface{}
	}
	matches := []ledger{}
	for rows.Next() {
		var platform, sourceID string
		var raw []byte
		if err := rows.Scan(&platform, &sourceID, &raw); err != nil {
			return prepared, err
		}
		metadata := map[string]interface{}{}
		if err := json.Unmarshal(raw, &metadata); err != nil {
			return prepared, fmt.Errorf("decode subscriber projection preflight ledger: %w", err)
		}
		ledgerEmail, _ := metadata["email"].(string)
		if strings.TrimSpace(ledgerEmail) == "" {
			return prepared, fmt.Errorf("subscriber projection preflight found an active same-job ledger without a destination email")
		}
		matches = append(matches, ledger{platform: canonical.SourcePlatform(strings.TrimSpace(platform)), sourceID: strings.TrimSpace(sourceID), metadata: metadata})
		if len(matches) > 1 {
			return prepared, fmt.Errorf("subscriber projection preflight found multiple active same-job ledgers for email %q", incoming.Subscriber.Email)
		}
	}
	if err := rows.Err(); err != nil {
		return prepared, err
	}
	if len(matches) == 0 {
		return prepared, nil
	}
	return prepareSubscriberProjectionMerge(matches[0].platform, matches[0].sourceID, matches[0].metadata, incoming, preserveSourceAudiences)
}

func prepareSubscriberProjectionMerge(platform canonical.SourcePlatform, ledgerSourceID string, metadata map[string]interface{}, incoming subscriberSourceProjection, preserveSourceAudiences bool) (subscriberSourceProjection, error) {
	incomingKey := subscriberSourceIdentityKey(incoming.Subscriber.SourcePlatform, incoming.Subscriber.SourceID)
	projections, err := subscriberProjectionsFromMetadata(metadata)
	if err != nil {
		if !strings.Contains(err.Error(), "lacks bounded per-source projection metadata") {
			return incoming, err
		}
		legacyIDs := uniqueSortedStrings(append([]string{ledgerSourceID}, metadataStringSlice(metadata["source_ids"])...))
		if len(legacyIDs) != 1 || subscriberSourceIdentityKey(platform, legacyIDs[0]) != incomingKey {
			return incoming, fmt.Errorf("subscriber projection preflight refuses ambiguous legacy ledger with %d source identities", len(legacyIDs))
		}
		if preserveSourceAudiences {
			return incoming, fmt.Errorf("subscriber projection preflight cannot preserve source audiences from a legacy ledger; run a full snapshot first")
		}
		projections = map[string]subscriberSourceProjection{}
	}
	for key, projection := range projections {
		if !strings.EqualFold(strings.TrimSpace(projection.Subscriber.Email), strings.TrimSpace(incoming.Subscriber.Email)) {
			return incoming, fmt.Errorf("subscriber projection %q belongs to a different email", key)
		}
	}
	for _, sourceID := range uniqueSortedStrings(append([]string{ledgerSourceID}, metadataStringSlice(metadata["source_ids"])...)) {
		key := subscriberSourceIdentityKey(platform, sourceID)
		if key != "" {
			if _, projected := projections[key]; !projected && key != incomingKey {
				return incoming, fmt.Errorf("subscriber projection preflight refuses ledger identity %q without a durable projection", key)
			}
		}
	}
	if previous, ok := projections[incomingKey]; ok && preserveSourceAudiences {
		incoming, err = preserveSubscriberProjectionAudiences(previous, incoming)
		if err != nil {
			return incoming, fmt.Errorf("preserve subscriber source audiences: %w", err)
		}
	}
	projections[incomingKey] = incoming
	if err := validateSubscriberProjectionSet(projections); err != nil {
		return incoming, fmt.Errorf("subscriber projection preflight: %w", err)
	}
	return incoming, nil
}

func validateSubscriberProjectionMerge(platform canonical.SourcePlatform, ledgerSourceID string, metadata map[string]interface{}, incoming subscriberSourceProjection) error {
	_, err := prepareSubscriberProjectionMerge(platform, ledgerSourceID, metadata, incoming, false)
	return err
}

func preserveSubscriberProjectionAudiences(previous, incoming subscriberSourceProjection) (subscriberSourceProjection, error) {
	previousKey := subscriberSourceIdentityKey(previous.Subscriber.SourcePlatform, previous.Subscriber.SourceID)
	incomingKey := subscriberSourceIdentityKey(incoming.Subscriber.SourcePlatform, incoming.Subscriber.SourceID)
	if previousKey == "" || previousKey != incomingKey || !strings.EqualFold(strings.TrimSpace(previous.Subscriber.Email), strings.TrimSpace(incoming.Subscriber.Email)) {
		return incoming, fmt.Errorf("source projection identity changed")
	}
	audiences := make(map[string]subscriberProjectedAudience, len(previous.Audiences)+len(incoming.Audiences))
	for _, audience := range previous.Audiences {
		audiences[audience.SourceID] = audience
	}
	for _, audience := range incoming.Audiences {
		if existing, ok := audiences[audience.SourceID]; ok && existing != audience {
			return incoming, fmt.Errorf("source audience %q changed destination identity", audience.SourceID)
		}
		audiences[audience.SourceID] = audience
	}
	incoming.Audiences = incoming.Audiences[:0]
	for _, audience := range audiences {
		incoming.Audiences = append(incoming.Audiences, audience)
	}
	sort.Slice(incoming.Audiences, func(i, j int) bool { return incoming.Audiences[i].SourceID < incoming.Audiences[j].SourceID })

	tags := append([]string(nil), incoming.Subscriber.Tags...)
	for _, tag := range previous.Subscriber.Tags {
		sourceID, ok := sourceAudienceIDFromTag(tag)
		if !ok {
			continue
		}
		if _, preserved := audiences[sourceID]; preserved {
			tags = append(tags, tag)
		}
	}
	incoming.Subscriber.Tags = normalizeSubscriberTags(tags)
	if err := validateSubscriberSourceProjection(incoming); err != nil {
		return incoming, err
	}
	return incoming, nil
}

func buildSubscriberProjectionReconciliation(candidate SourceSnapshotDeletionCandidate, currentJobID string, ledgers []subscriberSourceLedgerState) (*subscriberProjectionReconciliation, error) {
	retiringKey := subscriberSourceIdentityKey(candidate.Subscriber.SourcePlatform, candidate.Subscriber.SourceID)
	email := strings.ToLower(strings.TrimSpace(candidate.Subscriber.Email))
	if retiringKey == "" || email == "" || strings.TrimSpace(currentJobID) == "" {
		return nil, fmt.Errorf("subscriber projection reconciliation requires an exact retiring identity")
	}
	var retiring *subscriberSourceLedgerState
	activeSet := newSubscriberProjectionSet()
	activeJobs := map[string]string{}
	for i := range ledgers {
		ledger := &ledgers[i]
		ledgerEmail, _ := ledger.Metadata["email"].(string)
		if strings.TrimSpace(ledgerEmail) != "" && !strings.EqualFold(strings.TrimSpace(ledgerEmail), email) {
			return nil, fmt.Errorf("subscriber ownership ledger %q destination email does not match reconciliation candidate", ledger.JobID)
		}
		present, explicit := ledger.Metadata["postwave_source_snapshot_present"].(bool)
		if explicit && !present {
			if ledger.JobID == currentJobID {
				retiring = ledger
			}
			continue
		}
		projections, err := subscriberProjectionsFromMetadata(ledger.Metadata)
		if err != nil {
			return nil, fmt.Errorf("active subscriber ownership ledger %q cannot be reconciled safely: %w", ledger.JobID, err)
		}
		for key, projection := range projections {
			if key == retiringKey {
				// A prior job for the same upstream identity does not outvote the
				// completed authoritative snapshot that just proved it absent.
				continue
			}
			if !strings.EqualFold(projection.Subscriber.Email, email) {
				return nil, fmt.Errorf("active subscriber source projection %q targets a different email", key)
			}
			if err := activeSet.add(key, projection); err != nil {
				return nil, fmt.Errorf("active subscriber projection bound: %w", err)
			}
			if owner, exists := activeJobs[key]; !exists || ledger.JobID < owner {
				activeJobs[key] = ledger.JobID
			}
		}
	}
	if retiring == nil {
		return nil, fmt.Errorf("subscriber projection reconciliation cannot identify the current retiring ledger")
	}
	active := activeSet.projections
	if len(active) == 0 {
		return nil, nil
	}
	retiringProjections, err := subscriberProjectionsFromMetadata(retiring.Metadata)
	if err != nil {
		return nil, fmt.Errorf("retiring subscriber ownership ledger %q cannot be reconciled safely: %w", retiring.JobID, err)
	}
	if _, ok := retiringProjections[retiringKey]; !ok {
		return nil, fmt.Errorf("retiring subscriber ownership ledger %q lacks projection %q", retiring.JobID, retiringKey)
	}

	keys := make([]string, 0, len(active))
	for key := range active {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	primary := active[keys[0]]
	for _, key := range keys[1:] {
		if active[key].Subscriber.SourcePlatform != primary.Subscriber.SourcePlatform {
			return nil, fmt.Errorf("active subscriber projections span multiple providers; exact provider-specific field reconciliation is not provable")
		}
	}
	aggregate := primary.Subscriber
	aggregate.Email = email
	aggregate.Tags = []string{}
	aggregate.CustomFields = cloneMetadata(primary.Subscriber.CustomFields)
	aggregate.Status = ""
	audiences := map[string]AudienceMapping{}
	sourceIDs := make([]string, 0, len(keys))
	for _, key := range keys {
		projection := active[key]
		sourceIDs = append(sourceIDs, projection.Subscriber.SourceID)
		aggregate.Status = strongerCanonicalSubscriberStatus(aggregate.Status, projection.Subscriber.Status)
		aggregate.Tags = mergeStringUnion(aggregate.Tags, projection.Subscriber.Tags)
		for field, value := range projection.Subscriber.CustomFields {
			if projection.Subscriber.SourcePlatform == canonical.SourceBeehiiv && field == "beehiiv" {
				continue
			}
			if current, exists := aggregate.CustomFields[field]; exists && !reflect.DeepEqual(current, value) {
				return nil, fmt.Errorf("active subscriber source projections disagree on field %q", field)
			}
			aggregate.CustomFields[field] = value
		}
		for _, audience := range projection.Audiences {
			mapping := AudienceMapping{SourceID: audience.SourceID, Name: audience.Name, ListmonkID: audience.ListmonkID, PostwaveID: audience.PostwaveID}
			if current, exists := audiences[audience.SourceID]; exists && current != mapping {
				return nil, fmt.Errorf("active subscriber source projections disagree on audience %q", audience.SourceID)
			}
			audiences[audience.SourceID] = mapping
		}
	}
	baseline, baselinePresent, baselineErr := subscriberProjectionBaselineStatus(retiring.Metadata)
	if baselineErr != nil {
		return nil, fmt.Errorf("derive shared subscriber baseline status: %w", baselineErr)
	}
	if baselinePresent {
		aggregate.Status = strongerCanonicalSubscriberStatus(aggregate.Status, baseline)
	}
	if aggregate.Status == "" {
		aggregate.Status = canonical.StatusDisabled
	}
	if _, err := newSubscriberSourceProjection(aggregate, audiences); err != nil {
		return nil, fmt.Errorf("aggregate active subscriber projection exceeds destination bounds: %w", err)
	}
	return &subscriberProjectionReconciliation{
		Candidate: candidate, RetiringJobID: currentJobID, RetiringMetadata: cloneMetadata(retiring.Metadata),
		PrimaryJobID: activeJobs[keys[0]], PrimaryProjection: primary, AggregateSubscriber: aggregate,
		AggregateAudiences: audiences, ActiveIdentityKeys: keys, ActiveSourceIDs: uniqueSortedStrings(sourceIDs),
		BaselineStatus: baseline, BaselineStatusPresent: baselinePresent,
	}, nil
}

func subscriberProjectionBaselineStatus(metadata map[string]interface{}) (canonical.SubscriberStatus, bool, error) {
	if metadataBool(metadata, "postwave_shared_source_reconciliation") {
		presentValue, explicit := metadata[subscriberSharedBaselinePresentMetadataKey].(bool)
		if !explicit {
			return "", false, fmt.Errorf("shared-source ledger lacks an explicit local status baseline marker")
		}
		if !presentValue {
			return "", false, nil
		}
		status := normalizedCanonicalSubscriberStatus(metadata[subscriberSharedBaselineStatusMetadataKey])
		if status == "" {
			return "", false, fmt.Errorf("shared-source ledger has an invalid local status baseline")
		}
		return status, true, nil
	}
	status := canonical.SubscriberStatus("")
	present := false
	operation, _ := metadata["postwave_operation"].(string)
	if operation == "updated" {
		before, _ := metadata["postwave_before"].(map[string]interface{})
		if candidate := normalizedCanonicalSubscriberStatus(before["status"]); candidate != "" {
			status = candidate
			present = true
		}
	}
	listmonkOperation, _ := metadata["listmonk_operation"].(string)
	if listmonkOperation == string(UpsertUpdated) {
		before, _ := metadata["listmonk_before"].(map[string]interface{})
		if candidate := normalizedCanonicalSubscriberStatus(before["status"]); candidate != "" {
			status = strongerCanonicalSubscriberStatus(status, candidate)
			present = true
		}
	}
	return status, present, nil
}

func normalizedCanonicalSubscriberStatus(value interface{}) canonical.SubscriberStatus {
	switch canonical.SubscriberStatus(strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))) {
	case canonical.StatusEnabled, canonical.StatusDisabled, canonical.StatusUnconfirmed, canonical.StatusBlocklisted:
		return canonical.SubscriberStatus(strings.ToLower(strings.TrimSpace(fmt.Sprint(value))))
	default:
		return ""
	}
}

func strongerCanonicalSubscriberStatus(left, right canonical.SubscriberStatus) canonical.SubscriberStatus {
	rank := func(status canonical.SubscriberStatus) int {
		switch status {
		case canonical.StatusBlocklisted:
			return 4
		case canonical.StatusDisabled:
			return 3
		case canonical.StatusUnconfirmed:
			return 2
		case canonical.StatusEnabled:
			return 1
		default:
			return 0
		}
	}
	if rank(right) > rank(left) {
		return right
	}
	return left
}

func uniqueSortedStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func validateSubscriberProjectionReconciliationTx(ctx context.Context, tx *sql.Tx, resource ImportedResource, sub canonical.Subscriber, transferSourceFrom string, expected *subscriberProjectionReconciliation) (*subscriberProjectionReconciliation, error) {
	if expected == nil || tx == nil {
		return nil, fmt.Errorf("subscriber projection reconciliation proof is required")
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT job_id::text, source_platform, COALESCE(source_id, ''), destination_metadata
		  FROM migration_imported_resources
		 WHERE tenant_id = $1::uuid AND resource_type = 'subscriber'
		   AND destination_type = $2 AND destination_id = $3
		   AND rolled_back_at IS NULL
		 ORDER BY job_id
		 FOR UPDATE
	`, resource.TenantID, resource.DestinationType, resource.DestinationID)
	if err != nil {
		return nil, fmt.Errorf("load subscriber projection reconciliation ledgers: %w", err)
	}
	ledgers := []subscriberSourceLedgerState{}
	for rows.Next() {
		var ledger subscriberSourceLedgerState
		var platform string
		var raw []byte
		if err := rows.Scan(&ledger.JobID, &platform, &ledger.SourceID, &raw); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ledger.SourcePlatform = canonical.SourcePlatform(strings.TrimSpace(platform))
		if err := json.Unmarshal(raw, &ledger.Metadata); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("decode subscriber projection reconciliation ledger: %w", err)
		}
		ledgers = append(ledgers, ledger)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	fresh, err := buildSubscriberProjectionReconciliation(expected.Candidate, expected.RetiringJobID, ledgers)
	if err != nil {
		return nil, err
	}
	if fresh == nil {
		return nil, fmt.Errorf("subscriber projection reconciliation no longer has an active survivor")
	}
	if strings.TrimSpace(transferSourceFrom) != strings.TrimSpace(expected.Candidate.Subscriber.SourceID) ||
		resource.JobID != fresh.PrimaryJobID || resource.JobID != expected.PrimaryJobID ||
		subscriberSourceIdentityKey(sub.SourcePlatform, sub.SourceID) != subscriberSourceIdentityKey(fresh.PrimaryProjection.Subscriber.SourcePlatform, fresh.PrimaryProjection.Subscriber.SourceID) ||
		!reflect.DeepEqual(fresh.AggregateSubscriber, expected.AggregateSubscriber) ||
		!reflect.DeepEqual(fresh.AggregateAudiences, expected.AggregateAudiences) ||
		!reflect.DeepEqual(fresh.ActiveIdentityKeys, expected.ActiveIdentityKeys) ||
		fresh.BaselineStatusPresent != expected.BaselineStatusPresent || fresh.BaselineStatus != expected.BaselineStatus {
		return nil, fmt.Errorf("subscriber projection reconciliation proof changed after the external write; refusing mirror mutation")
	}
	return fresh, nil
}

func reconcileRetiringSubscriberMembershipsTx(ctx context.Context, tx *sql.Tx, resource ImportedResource, sub canonical.Subscriber, subscriberID, retiringJobID string, retiringMetadata map[string]interface{}, touched []string) ([]string, []map[string]interface{}, error) {
	touchedSet := map[string]struct{}{}
	for _, id := range touched {
		touchedSet[id] = struct{}{}
	}
	transferredCreated := []string{}
	for _, id := range metadataStringSlice(retiringMetadata["postwave_membership_created"]) {
		if _, retained := touchedSet[id]; retained {
			result, err := tx.ExecContext(ctx, `
				UPDATE list_subscribers
				   SET source = 'migration',
				       source_id = CONCAT('migration:', $4::text, ':', COALESCE(metadata ->> 'source_audience_id', ''), ':', $5::text),
				       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
				           'migration_job_id', $4::text, 'source_member_id', $5::text)
				 WHERE tenant_id = $1::uuid AND id = $2::uuid AND subscriber_id = $3::uuid
				   AND source = 'migration'
			`, resource.TenantID, id, subscriberID, resource.JobID, sub.SourceID)
			if err != nil {
				return nil, nil, err
			}
			if affected, err := result.RowsAffected(); err != nil || affected != 1 {
				return nil, nil, fmt.Errorf("transfer retiring subscriber membership %s: affected=%d err=%v", id, affected, err)
			}
			transferredCreated = append(transferredCreated, id)
			continue
		}
		result, err := tx.ExecContext(ctx, `
			DELETE FROM list_subscribers
			 WHERE tenant_id = $1::uuid AND id = $2::uuid AND subscriber_id = $3::uuid
			   AND source = 'migration'
		`, resource.TenantID, id, subscriberID)
		if err != nil {
			return nil, nil, err
		}
		if affected, err := result.RowsAffected(); err != nil || affected != 1 {
			return nil, nil, fmt.Errorf("remove retiring subscriber membership %s: affected=%d err=%v", id, affected, err)
		}
	}
	transferredBefore := []map[string]interface{}{}
	for _, before := range metadataObjectSlice(retiringMetadata["postwave_membership_before"]) {
		id, _ := before["id"].(string)
		if strings.TrimSpace(id) == "" {
			return nil, nil, fmt.Errorf("retiring subscriber membership before-image lacks identity")
		}
		if _, retained := touchedSet[id]; retained {
			transferredBefore = append(transferredBefore, before)
			continue
		}
		raw, _ := json.Marshal(before)
		result, err := tx.ExecContext(ctx, `
			UPDATE list_subscribers SET
				removed_at = NULLIF($4::jsonb ->> 'removed_at', '')::timestamptz,
				listmonk_list_id = NULLIF($4::jsonb ->> 'listmonk_list_id', '')::bigint,
				email = CASE WHEN jsonb_typeof($4::jsonb -> 'email') = 'string' THEN ($4::jsonb ->> 'email')::citext ELSE NULL END,
				source = COALESCE(NULLIF($4::jsonb ->> 'source', ''), source),
				source_id = NULLIF($4::jsonb ->> 'source_id', ''),
				metadata = COALESCE($4::jsonb -> 'metadata', '{}'::jsonb)
			 WHERE tenant_id = $1::uuid AND id = $2::uuid AND subscriber_id = $3::uuid
			   AND COALESCE(metadata ->> 'migration_job_id', '') = $5::text
		`, resource.TenantID, id, subscriberID, string(raw), retiringJobID)
		if err != nil {
			return nil, nil, err
		}
		if affected, err := result.RowsAffected(); err != nil || affected != 1 {
			return nil, nil, fmt.Errorf("restore retiring subscriber membership %s: affected=%d err=%v", id, affected, err)
		}
	}
	return uniqueSortedStrings(transferredCreated), transferredBefore, nil
}

func cleanupRetiringSubscriberRegistriesTx(ctx context.Context, tx *sql.Tx, tenantID string, metadata map[string]interface{}) error {
	for _, tagID := range metadataStringSlice(metadata["postwave_tag_registry_created"]) {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM tags t
			 WHERE t.tenant_id = $1::uuid AND t.id = $2::uuid
			   AND NOT EXISTS (
				SELECT 1 FROM subscriber_tags st
				 WHERE st.tenant_id = t.tenant_id AND st.tag_id = t.id
			   )
		`, tenantID, tagID); err != nil {
			return err
		}
	}
	return restoreImportedCustomFieldsTx(ctx, tx, tenantID, metadata)
}
