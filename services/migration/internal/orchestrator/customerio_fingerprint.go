package orchestrator

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	customerIOSourceFingerprintCursorKey = "__postwave_customerio_source_fingerprint"
	customerIOImportEpochCursorKey       = "__postwave_customerio_import_epoch"
	customerIOSourceFingerprintVersion   = 2
	maxCustomerIOFingerprintBytes        = 16 << 10

	// The adapter exposes the already-inventoried sent-newsletter snapshot, so
	// the exact archive total alone bounds this traversal. No provider bucket
	// boundary or empty intermediary page is part of this adapter contract.
	customerIOArchiveEmptyPageAllowance = 0
)

var customerIOFingerprintComponents = []string{
	"subscribers",
	"profiles_without_email",
	"segments",
	"editable_templates",
	"sent_campaign_archive",
	"source_archive",
}

type customerIONonEmailIdentityFingerprinter interface {
	CustomerIONonEmailIdentityFingerprint(context.Context, adapter.Session) (int, string, error)
}

func observeCustomerIONonEmailIdentityFingerprint(
	ctx context.Context,
	ad adapter.Adapter,
	sess adapter.Session,
	discovery adapter.DiscoveryReport,
	accumulator *customerIOFingerprintAccumulator,
	scope string,
) error {
	nonEmailIdentities, ok := ad.(customerIONonEmailIdentityFingerprinter)
	if !ok {
		return fmt.Errorf("Customer.io %s source fingerprint requires non-email profile identity evidence", scope)
	}
	nonEmailCount, nonEmailDigest, err := nonEmailIdentities.CustomerIONonEmailIdentityFingerprint(ctx, sess)
	if err != nil {
		return fmt.Errorf("fingerprint Customer.io profiles without email: %w", err)
	}
	if nonEmailCount != discovery.ProfilesWithoutEmailTotal {
		return fmt.Errorf("Customer.io %s non-email identity evidence returned %d of %d profiles: %w", scope, nonEmailCount, discovery.ProfilesWithoutEmailTotal, adapter.ErrSourceUnavailable)
	}
	if err := accumulator.observePrehashed("profiles_without_email", nonEmailCount, nonEmailDigest); err != nil {
		return err
	}
	return accumulator.complete("profiles_without_email")
}

// CustomerIOSourceFingerprint is a bounded, non-reversible digest of every
// exact source projection that can affect a Customer.io cutover. Component
// digests detect same-count changes without storing provider profile data in
// the migration job cursor.
type CustomerIOSourceFingerprint struct {
	Version    int                                             `json:"version"`
	Digest     string                                          `json:"digest"`
	Components map[string]CustomerIOSourceFingerprintComponent `json:"components"`
}

type CustomerIOSourceFingerprintComponent struct {
	Count  int    `json:"count"`
	Digest string `json:"digest"`
}

type customerIOFingerprintAccumulator struct {
	components map[string]*customerIOFingerprintComponentAccumulator
}

type customerIOFingerprintComponentAccumulator struct {
	count    int
	sum      [sha256.Size]byte
	complete bool
}

func newCustomerIOFingerprintAccumulator() *customerIOFingerprintAccumulator {
	components := make(map[string]*customerIOFingerprintComponentAccumulator, len(customerIOFingerprintComponents))
	for _, component := range customerIOFingerprintComponents {
		components[component] = &customerIOFingerprintComponentAccumulator{}
	}
	return &customerIOFingerprintAccumulator{components: components}
}

func (a *customerIOFingerprintAccumulator) observeSubscriber(subscriber canonical.Subscriber) error {
	copy := subscriber
	copy.Tags = append([]string(nil), subscriber.Tags...)
	sort.Strings(copy.Tags)
	return a.add("subscribers", copy)
}

func (a *customerIOFingerprintAccumulator) observeSegment(segment canonical.Segment) error {
	return a.add("segments", segment)
}

func (a *customerIOFingerprintAccumulator) observeTemplate(template canonical.EmailTemplate) error {
	return a.add("editable_templates", template)
}

func (a *customerIOFingerprintAccumulator) observeCampaign(campaign canonical.CampaignArchive) error {
	return a.add("sent_campaign_archive", campaign)
}

func (a *customerIOFingerprintAccumulator) observeSourceArchive(item canonical.SourceArchiveItem) error {
	return a.add("source_archive", item)
}

func (a *customerIOFingerprintAccumulator) observePrehashed(component string, count int, digest string) error {
	if a == nil {
		return fmt.Errorf("Customer.io source fingerprint accumulator is unavailable")
	}
	state, ok := a.components[component]
	if !ok || state == nil || state.complete || state.count != 0 {
		return fmt.Errorf("Customer.io source fingerprint component %q cannot accept prehashed evidence", component)
	}
	digest = strings.TrimSpace(digest)
	decoded, err := hex.DecodeString(digest)
	if count < 0 || err != nil || len(decoded) != sha256.Size || digest != strings.ToLower(digest) {
		return fmt.Errorf("Customer.io source fingerprint component %q prehashed evidence is invalid", component)
	}
	state.count = count
	copy(state.sum[:], decoded)
	return nil
}

func (a *customerIOFingerprintAccumulator) add(component string, value interface{}) error {
	if a == nil {
		return fmt.Errorf("Customer.io source fingerprint accumulator is unavailable")
	}
	state, ok := a.components[component]
	if !ok || state == nil {
		return fmt.Errorf("Customer.io source fingerprint component %q is invalid", component)
	}
	if state.complete {
		return fmt.Errorf("Customer.io source fingerprint component %q received data after traversal completion", component)
	}
	raw, err := json.Marshal(struct {
		Version   int         `json:"version"`
		Component string      `json:"component"`
		Value     interface{} `json:"value"`
	}{
		Version:   customerIOSourceFingerprintVersion,
		Component: component,
		Value:     value,
	})
	if err != nil {
		return fmt.Errorf("marshal Customer.io %s fingerprint record: %w", component, err)
	}
	recordDigest := sha256.Sum256(raw)
	addFingerprintDigest(&state.sum, recordDigest)
	state.count++
	return nil
}

func (a *customerIOFingerprintAccumulator) complete(component string) error {
	if a == nil {
		return fmt.Errorf("Customer.io source fingerprint accumulator is unavailable")
	}
	state, ok := a.components[component]
	if !ok || state == nil {
		return fmt.Errorf("Customer.io source fingerprint component %q is invalid", component)
	}
	if state.complete {
		return fmt.Errorf("Customer.io source fingerprint component %q completed more than once", component)
	}
	state.complete = true
	return nil
}

func (a *customerIOFingerprintAccumulator) fingerprint() (CustomerIOSourceFingerprint, error) {
	if a == nil {
		return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io source fingerprint accumulator is unavailable")
	}
	result := CustomerIOSourceFingerprint{
		Version:    customerIOSourceFingerprintVersion,
		Components: make(map[string]CustomerIOSourceFingerprintComponent, len(customerIOFingerprintComponents)),
	}
	for _, component := range customerIOFingerprintComponents {
		state := a.components[component]
		if state == nil || state.count < 0 || !state.complete {
			return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io source fingerprint component %q is incomplete", component)
		}
		digest := sha256.Sum256([]byte(strings.Join([]string{
			fmt.Sprintf("postwave-customerio-component-v%d", customerIOSourceFingerprintVersion),
			component,
			strconv.Itoa(state.count),
			hex.EncodeToString(state.sum[:]),
		}, "\x00")))
		result.Components[component] = CustomerIOSourceFingerprintComponent{
			Count:  state.count,
			Digest: hex.EncodeToString(digest[:]),
		}
	}
	digest, err := customerIOSourceFingerprintDigest(result.Components)
	if err != nil {
		return CustomerIOSourceFingerprint{}, err
	}
	result.Digest = digest
	return result, validateCustomerIOSourceFingerprint(result)
}

func customerIOSourceFingerprintDigest(components map[string]CustomerIOSourceFingerprintComponent) (string, error) {
	raw, err := json.Marshal(components)
	if err != nil {
		return "", fmt.Errorf("marshal Customer.io source fingerprint components: %w", err)
	}
	digest := sha256.Sum256(append([]byte(fmt.Sprintf("postwave-customerio-source-v%d\x00", customerIOSourceFingerprintVersion)), raw...))
	return hex.EncodeToString(digest[:]), nil
}

func validateCustomerIOSourceFingerprint(fingerprint CustomerIOSourceFingerprint) error {
	if fingerprint.Version != customerIOSourceFingerprintVersion || len(fingerprint.Digest) != sha256.Size*2 {
		return fmt.Errorf("Customer.io source fingerprint has an unsupported version or digest")
	}
	if len(fingerprint.Components) != len(customerIOFingerprintComponents) {
		return fmt.Errorf("Customer.io source fingerprint has an incomplete component set")
	}
	for _, name := range customerIOFingerprintComponents {
		component, ok := fingerprint.Components[name]
		if !ok || component.Count < 0 || len(component.Digest) != sha256.Size*2 {
			return fmt.Errorf("Customer.io source fingerprint component %q is invalid", name)
		}
		if _, err := hex.DecodeString(component.Digest); err != nil {
			return fmt.Errorf("Customer.io source fingerprint component %q digest is invalid", name)
		}
	}
	if _, err := hex.DecodeString(fingerprint.Digest); err != nil {
		return fmt.Errorf("Customer.io source fingerprint digest is invalid")
	}
	wantDigest, err := customerIOSourceFingerprintDigest(fingerprint.Components)
	if err != nil {
		return err
	}
	if fingerprint.Digest != wantDigest {
		return fmt.Errorf("Customer.io source fingerprint component integrity check failed")
	}
	return nil
}

func validateCustomerIOFingerprintAgainstDiscovery(fingerprint CustomerIOSourceFingerprint, discovery adapter.DiscoveryReport) error {
	if err := validateCustomerIOSourceFingerprint(fingerprint); err != nil {
		return err
	}
	expected := map[string]int{
		"subscribers":            discovery.SubscribersTotal,
		"profiles_without_email": discovery.ProfilesWithoutEmailTotal,
		"segments":               discovery.SegmentsTotal,
		"editable_templates":     discovery.TemplatesTotal,
		"sent_campaign_archive":  discovery.ArchiveTotal,
		"source_archive":         discovery.SourceArchiveTotal,
	}
	for _, component := range customerIOFingerprintComponents {
		want := expected[component]
		if want < 0 {
			return fmt.Errorf("Customer.io discovery returned a negative %s total: %w", component, adapter.ErrSourceUnavailable)
		}
		if got := fingerprint.Components[component].Count; got != want {
			return fmt.Errorf("Customer.io %s fingerprint observed %d of %d exact source records: %w", component, got, want, adapter.ErrSourceUnavailable)
		}
	}
	return nil
}

func persistCustomerIOSourceFingerprint(job *canonical.MigrationJob, fingerprint CustomerIOSourceFingerprint) error {
	if job == nil || job.Source != canonical.SourceCustomerIO {
		return fmt.Errorf("Customer.io source fingerprint requires a Customer.io migration job")
	}
	if err := validateCustomerIOSourceFingerprint(fingerprint); err != nil {
		return err
	}
	raw, err := json.Marshal(fingerprint)
	if err != nil {
		return fmt.Errorf("marshal Customer.io source fingerprint: %w", err)
	}
	if len(raw) > maxCustomerIOFingerprintBytes {
		return fmt.Errorf("Customer.io source fingerprint is %d bytes (limit %d)", len(raw), maxCustomerIOFingerprintBytes)
	}
	epochBytes := make([]byte, sha256.Size)
	if _, err := rand.Read(epochBytes); err != nil {
		return fmt.Errorf("generate Customer.io import epoch: %w", err)
	}
	epoch := hex.EncodeToString(epochBytes)
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	value := string(raw)
	job.Cursor[customerIOSourceFingerprintCursorKey] = &value
	job.Cursor[customerIOImportEpochCursorKey] = &epoch
	return nil
}

// CustomerIOImportEpochFromJob loads the opaque epoch generated for the latest
// successful destination-writing Customer.io run.
func CustomerIOImportEpochFromJob(job *canonical.MigrationJob) (string, bool, error) {
	if job == nil || job.Source != canonical.SourceCustomerIO || job.Cursor == nil || job.Cursor[customerIOImportEpochCursorKey] == nil {
		return "", false, nil
	}
	epoch := strings.TrimSpace(*job.Cursor[customerIOImportEpochCursorKey])
	decoded, err := hex.DecodeString(epoch)
	if err != nil || len(decoded) != sha256.Size || epoch != strings.ToLower(epoch) {
		return "", true, fmt.Errorf("Customer.io final-delta import epoch is invalid")
	}
	return epoch, true, nil
}

// CustomerIOSourceFingerprintFromJob loads the durable full-source
// fingerprint established by the latest successful destination-writing run.
func CustomerIOSourceFingerprintFromJob(job *canonical.MigrationJob) (CustomerIOSourceFingerprint, bool, error) {
	if job == nil || job.Source != canonical.SourceCustomerIO || job.Cursor == nil || job.Cursor[customerIOSourceFingerprintCursorKey] == nil {
		return CustomerIOSourceFingerprint{}, false, nil
	}
	raw := strings.TrimSpace(*job.Cursor[customerIOSourceFingerprintCursorKey])
	if raw == "" || len(raw) > maxCustomerIOFingerprintBytes {
		return CustomerIOSourceFingerprint{}, true, fmt.Errorf("Customer.io final-delta source fingerprint is invalid")
	}
	var fingerprint CustomerIOSourceFingerprint
	if err := json.Unmarshal([]byte(raw), &fingerprint); err != nil {
		return CustomerIOSourceFingerprint{}, true, fmt.Errorf("decode Customer.io final-delta source fingerprint: %w", err)
	}
	if err := validateCustomerIOSourceFingerprint(fingerprint); err != nil {
		return CustomerIOSourceFingerprint{}, true, err
	}
	return fingerprint, true, nil
}

// BuildCustomerIOSourceFingerprint performs the same exact, bounded source
// traversals as the migration without destination writes. It therefore catches
// same-count mutations that discovery totals cannot expose.
func BuildCustomerIOSourceFingerprint(ctx context.Context, ad adapter.Adapter, sess adapter.Session, discovery adapter.DiscoveryReport) (CustomerIOSourceFingerprint, error) {
	if ad == nil || ad.Capabilities().Source != canonical.SourceCustomerIO || sess.Source != canonical.SourceCustomerIO {
		return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io source fingerprint requires a bound Customer.io adapter session")
	}
	accumulator := newCustomerIOFingerprintAccumulator()
	verifier := NewVerifierInput()
	verifier.Discovery = discovery

	cursor := ""
	seenCursors := newTraversalCursorSet()
	pageLimit, err := subscriberTraversalPageLimit(discovery.SubscribersTotal, discovery.ProfilesWithoutEmailTotal)
	if err != nil {
		return CustomerIOSourceFingerprint{}, err
	}
	for page := 0; ; page++ {
		if page >= pageLimit {
			return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow subscriber traversal exceeded %d page calls: %w", pageLimit, adapter.ErrSourceUnavailable)
		}
		batch, next, err := ad.ListSubscribers(ctx, sess, cursor)
		if err != nil {
			return CustomerIOSourceFingerprint{}, fmt.Errorf("fingerprint Customer.io subscribers: %w", err)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "Customer.io shadow subscribers"); err != nil {
				return CustomerIOSourceFingerprint{}, err
			}
		}
		for _, subscriber := range batch {
			observeCustomerIOSubscriberTraversalEvidence(verifier, subscriber)
			if err := accumulator.observeSubscriber(subscriber); err != nil {
				return CustomerIOSourceFingerprint{}, err
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if err := validateSnapshotSubscriberTraversalEvidence(verifier, canonical.SourceCustomerIO); err != nil {
		return CustomerIOSourceFingerprint{}, err
	}
	if err := accumulator.complete("subscribers"); err != nil {
		return CustomerIOSourceFingerprint{}, err
	}

	if err := observeCustomerIONonEmailIdentityFingerprint(ctx, ad, sess, discovery, accumulator, "shadow"); err != nil {
		return CustomerIOSourceFingerprint{}, err
	}

	segments, err := ad.ListSegments(ctx, sess)
	if err != nil {
		return CustomerIOSourceFingerprint{}, fmt.Errorf("fingerprint Customer.io segments: %w", err)
	}
	if len(segments) != discovery.SegmentsTotal {
		return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow segment traversal returned %d of %d records: %w", len(segments), discovery.SegmentsTotal, adapter.ErrSourceUnavailable)
	}
	for _, segment := range segments {
		if err := accumulator.observeSegment(segment); err != nil {
			return CustomerIOSourceFingerprint{}, err
		}
	}
	if err := accumulator.complete("segments"); err != nil {
		return CustomerIOSourceFingerprint{}, err
	}

	templates, ok := ad.(templateLister)
	if !ok {
		return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io source fingerprint requires exact editable-template traversal")
	}
	pageLimit, err = subscriberTraversalPageLimit(discovery.TemplatesTotal, 0)
	if err != nil {
		return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow template traversal bound: %w", err)
	}
	cursor = ""
	seenCursors = newTraversalCursorSet()
	seenTemplateIDs := map[[sha256.Size]byte]struct{}{}
	templateCount := 0
	for page := 0; ; page++ {
		if page >= pageLimit {
			return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow template traversal exceeded %d page calls: %w", pageLimit, adapter.ErrSourceUnavailable)
		}
		batch, next, err := templates.ListTemplates(ctx, sess, cursor)
		if err != nil {
			return CustomerIOSourceFingerprint{}, fmt.Errorf("fingerprint Customer.io editable templates: %w", err)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "Customer.io shadow templates"); err != nil {
				return CustomerIOSourceFingerprint{}, err
			}
		}
		for _, template := range batch {
			duplicate, err := addBoundedIdentity(seenTemplateIDs, "editable_template", template.SourceID, maxArchiveTrackedIdentities)
			if err != nil {
				return CustomerIOSourceFingerprint{}, err
			}
			if strings.TrimSpace(template.SourceID) == "" || duplicate {
				return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow template traversal returned an invalid or duplicate source identity %q: %w", template.SourceID, adapter.ErrSourceUnavailable)
			}
			templateCount++
			if err := accumulator.observeTemplate(template); err != nil {
				return CustomerIOSourceFingerprint{}, err
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if templateCount != discovery.TemplatesTotal {
		return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow template traversal returned %d of %d editable templates: %w", templateCount, discovery.TemplatesTotal, adapter.ErrSourceUnavailable)
	}
	if err := accumulator.complete("editable_templates"); err != nil {
		return CustomerIOSourceFingerprint{}, err
	}

	pageLimit, err = subscriberTraversalPageLimit(discovery.ArchiveTotal, customerIOArchiveEmptyPageAllowance)
	if err != nil {
		return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow sent-campaign traversal bound: %w", err)
	}
	cursor = ""
	seenCursors = newTraversalCursorSet()
	seenCampaignIDs := map[[sha256.Size]byte]struct{}{}
	campaignCount := 0
	for page := 0; ; page++ {
		if page >= pageLimit {
			return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow sent-campaign traversal exceeded %d page calls: %w", pageLimit, adapter.ErrSourceUnavailable)
		}
		batch, next, err := ad.ListCampaignArchive(ctx, sess, cursor)
		if err != nil {
			return CustomerIOSourceFingerprint{}, fmt.Errorf("fingerprint Customer.io sent campaign archive: %w", err)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "Customer.io shadow sent campaigns"); err != nil {
				return CustomerIOSourceFingerprint{}, err
			}
		}
		for _, campaign := range batch {
			duplicate, err := addBoundedIdentity(seenCampaignIDs, "sent_campaign", campaign.SourceID, maxArchiveTrackedIdentities)
			if err != nil {
				return CustomerIOSourceFingerprint{}, err
			}
			if strings.TrimSpace(campaign.SourceID) == "" || duplicate {
				return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow sent-campaign traversal returned an invalid or duplicate source identity %q: %w", campaign.SourceID, adapter.ErrSourceUnavailable)
			}
			campaignCount++
			if err := accumulator.observeCampaign(campaign); err != nil {
				return CustomerIOSourceFingerprint{}, err
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if campaignCount != discovery.ArchiveTotal {
		return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow sent-campaign traversal returned %d of %d records: %w", campaignCount, discovery.ArchiveTotal, adapter.ErrSourceUnavailable)
	}
	if err := accumulator.complete("sent_campaign_archive"); err != nil {
		return CustomerIOSourceFingerprint{}, err
	}

	sourceArchiver, ok := ad.(adapter.SourceArchiveAdapter)
	if !ok {
		return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io source fingerprint requires exact source-archive traversal")
	}
	pageLimit, err = subscriberTraversalPageLimit(discovery.SourceArchiveTotal, 0)
	if err != nil {
		return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow source-archive traversal bound: %w", err)
	}
	cursor = ""
	seenCursors = newTraversalCursorSet()
	seenSourceIDs := map[[sha256.Size]byte]struct{}{}
	sourceArchiveCount := 0
	for page := 0; ; page++ {
		if page >= pageLimit {
			return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow source-archive traversal exceeded %d page calls: %w", pageLimit, adapter.ErrSourceUnavailable)
		}
		batch, next, err := sourceArchiver.ListSourceArchive(ctx, sess, cursor)
		if err != nil {
			return CustomerIOSourceFingerprint{}, fmt.Errorf("fingerprint Customer.io source archive: %w", err)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "Customer.io shadow source archive"); err != nil {
				return CustomerIOSourceFingerprint{}, err
			}
		}
		for _, item := range batch {
			identity := strings.TrimSpace(item.ResourceType) + "\x00" + strings.TrimSpace(item.SourceID)
			duplicate, err := addBoundedIdentity(seenSourceIDs, "source_archive", identity, maxArchiveTrackedIdentities)
			if err != nil {
				return CustomerIOSourceFingerprint{}, err
			}
			if strings.TrimSpace(item.ResourceType) == "" || strings.TrimSpace(item.SourceID) == "" || duplicate {
				return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow source archive returned an invalid or duplicate %s identity %q: %w", item.ResourceType, item.SourceID, adapter.ErrSourceUnavailable)
			}
			sourceArchiveCount++
			if err := accumulator.observeSourceArchive(item); err != nil {
				return CustomerIOSourceFingerprint{}, err
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if sourceArchiveCount != discovery.SourceArchiveTotal {
		return CustomerIOSourceFingerprint{}, fmt.Errorf("Customer.io shadow source-archive traversal returned %d of %d records: %w", sourceArchiveCount, discovery.SourceArchiveTotal, adapter.ErrSourceUnavailable)
	}
	if err := accumulator.complete("source_archive"); err != nil {
		return CustomerIOSourceFingerprint{}, err
	}

	fingerprint, err := accumulator.fingerprint()
	if err != nil {
		return CustomerIOSourceFingerprint{}, err
	}
	if err := validateCustomerIOFingerprintAgainstDiscovery(fingerprint, discovery); err != nil {
		return CustomerIOSourceFingerprint{}, err
	}
	return fingerprint, nil
}

// Customer.io membership tags are deliberately counted here instead of via
// VerifierInput.ObserveSubscriber. The shared verifier only collects the
// providers it knows how to reconcile, while this exact snapshot must fail
// closed for both Customer.io segment and subscription-topic memberships.
func observeCustomerIOSubscriberTraversalEvidence(verifier *VerifierInput, subscriber canonical.Subscriber) {
	if verifier == nil {
		return
	}
	if sourceID := strings.TrimSpace(subscriber.SourceID); sourceID != "" {
		if verifier.SubscriberSourceIDs == nil {
			verifier.SubscriberSourceIDs = map[string]struct{}{}
		}
		verifier.SubscriberSourceIDs[sourceID] = struct{}{}
	}
	if verifier.SubscriberTagCounts == nil {
		verifier.SubscriberTagCounts = map[string]int{}
	}
	for _, rawTag := range subscriber.Tags {
		tag := strings.TrimSpace(rawTag)
		if snapshotMembershipTagForSource(canonical.SourceCustomerIO, tag) {
			verifier.SubscriberTagCounts[tag]++
		}
	}
}

// ChangedCustomerIOFingerprintComponents returns deterministic component names
// whose exact source count or digest differs from the successful baseline.
func ChangedCustomerIOFingerprintComponents(baseline, current CustomerIOSourceFingerprint) ([]string, error) {
	if err := validateCustomerIOSourceFingerprint(baseline); err != nil {
		return nil, fmt.Errorf("invalid Customer.io baseline fingerprint: %w", err)
	}
	if err := validateCustomerIOSourceFingerprint(current); err != nil {
		return nil, fmt.Errorf("invalid current Customer.io fingerprint: %w", err)
	}
	changed := make([]string, 0, len(customerIOFingerprintComponents))
	for _, name := range customerIOFingerprintComponents {
		if baseline.Components[name] != current.Components[name] {
			changed = append(changed, name)
		}
	}
	return changed, nil
}
