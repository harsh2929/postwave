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
	klaviyoSourceFingerprintCursorKey = "__postwave_klaviyo_source_fingerprint"
	klaviyoImportEpochCursorKey       = "__postwave_klaviyo_import_epoch"
	klaviyoSourceFingerprintVersion   = 1
	maxKlaviyoFingerprintBytes        = 16 << 10
)

var klaviyoFingerprintComponents = []string{
	"subscribers",
	"segments",
	"editable_templates",
	"rebuild_flows",
	"sent_campaign_archive",
	"source_archive",
}

// KlaviyoSourceFingerprint is a bounded, non-reversible digest of every exact
// source projection that can affect a Klaviyo cutover. Per-component digests
// expose same-count source mutations without exposing provider data.
type KlaviyoSourceFingerprint struct {
	Version    int                                          `json:"version"`
	Digest     string                                       `json:"digest"`
	Components map[string]KlaviyoSourceFingerprintComponent `json:"components"`
}

type KlaviyoSourceFingerprintComponent struct {
	Count  int    `json:"count"`
	Digest string `json:"digest"`
}

type klaviyoFingerprintAccumulator struct {
	components map[string]*klaviyoFingerprintComponentAccumulator
}

type klaviyoFingerprintComponentAccumulator struct {
	count    int
	sum      [sha256.Size]byte
	complete bool
}

func newKlaviyoFingerprintAccumulator() *klaviyoFingerprintAccumulator {
	components := make(map[string]*klaviyoFingerprintComponentAccumulator, len(klaviyoFingerprintComponents))
	for _, component := range klaviyoFingerprintComponents {
		components[component] = &klaviyoFingerprintComponentAccumulator{}
	}
	return &klaviyoFingerprintAccumulator{components: components}
}

func (a *klaviyoFingerprintAccumulator) observeSubscriber(subscriber canonical.Subscriber) error {
	copy := subscriber
	copy.Tags = append([]string(nil), subscriber.Tags...)
	sort.Strings(copy.Tags)
	return a.add("subscribers", copy)
}

func (a *klaviyoFingerprintAccumulator) observeSegment(segment canonical.Segment) error {
	return a.add("segments", segment)
}

func (a *klaviyoFingerprintAccumulator) observeTemplate(template canonical.EmailTemplate) error {
	return a.add("editable_templates", template)
}

func (a *klaviyoFingerprintAccumulator) observeAutomation(automation canonical.Automation) error {
	return a.add("rebuild_flows", automation)
}

func (a *klaviyoFingerprintAccumulator) observeCampaign(campaign canonical.CampaignArchive) error {
	return a.add("sent_campaign_archive", campaign)
}

func (a *klaviyoFingerprintAccumulator) observeSourceArchive(item canonical.SourceArchiveItem) error {
	return a.add("source_archive", item)
}

func (a *klaviyoFingerprintAccumulator) add(component string, value interface{}) error {
	if a == nil {
		return fmt.Errorf("Klaviyo source fingerprint accumulator is unavailable")
	}
	state, ok := a.components[component]
	if !ok || state == nil {
		return fmt.Errorf("Klaviyo source fingerprint component %q is invalid", component)
	}
	if state.complete {
		return fmt.Errorf("Klaviyo source fingerprint component %q received data after traversal completion", component)
	}
	raw, err := json.Marshal(struct {
		Version   int         `json:"version"`
		Component string      `json:"component"`
		Value     interface{} `json:"value"`
	}{
		Version:   klaviyoSourceFingerprintVersion,
		Component: component,
		Value:     value,
	})
	if err != nil {
		return fmt.Errorf("marshal Klaviyo %s fingerprint record: %w", component, err)
	}
	recordDigest := sha256.Sum256(raw)
	addFingerprintDigest(&state.sum, recordDigest)
	state.count++
	return nil
}

func (a *klaviyoFingerprintAccumulator) complete(component string) error {
	if a == nil {
		return fmt.Errorf("Klaviyo source fingerprint accumulator is unavailable")
	}
	state, ok := a.components[component]
	if !ok || state == nil {
		return fmt.Errorf("Klaviyo source fingerprint component %q is invalid", component)
	}
	if state.complete {
		return fmt.Errorf("Klaviyo source fingerprint component %q completed more than once", component)
	}
	state.complete = true
	return nil
}

func (a *klaviyoFingerprintAccumulator) fingerprint() (KlaviyoSourceFingerprint, error) {
	if a == nil {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo source fingerprint accumulator is unavailable")
	}
	result := KlaviyoSourceFingerprint{
		Version:    klaviyoSourceFingerprintVersion,
		Components: make(map[string]KlaviyoSourceFingerprintComponent, len(klaviyoFingerprintComponents)),
	}
	for _, component := range klaviyoFingerprintComponents {
		state := a.components[component]
		if state == nil || state.count < 0 || !state.complete {
			return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo source fingerprint component %q is incomplete", component)
		}
		digest := sha256.Sum256([]byte(strings.Join([]string{
			"postwave-klaviyo-component-v1",
			component,
			strconv.Itoa(state.count),
			hex.EncodeToString(state.sum[:]),
		}, "\x00")))
		result.Components[component] = KlaviyoSourceFingerprintComponent{
			Count:  state.count,
			Digest: hex.EncodeToString(digest[:]),
		}
	}
	digest, err := klaviyoSourceFingerprintDigest(result.Components)
	if err != nil {
		return KlaviyoSourceFingerprint{}, err
	}
	result.Digest = digest
	return result, validateKlaviyoSourceFingerprint(result)
}

func klaviyoSourceFingerprintDigest(components map[string]KlaviyoSourceFingerprintComponent) (string, error) {
	raw, err := json.Marshal(components)
	if err != nil {
		return "", fmt.Errorf("marshal Klaviyo source fingerprint components: %w", err)
	}
	digest := sha256.Sum256(append([]byte("postwave-klaviyo-source-v1\x00"), raw...))
	return hex.EncodeToString(digest[:]), nil
}

func validateKlaviyoSourceFingerprint(fingerprint KlaviyoSourceFingerprint) error {
	if fingerprint.Version != klaviyoSourceFingerprintVersion || len(fingerprint.Digest) != sha256.Size*2 {
		return fmt.Errorf("Klaviyo source fingerprint has an unsupported version or digest")
	}
	if len(fingerprint.Components) != len(klaviyoFingerprintComponents) {
		return fmt.Errorf("Klaviyo source fingerprint has an incomplete component set")
	}
	for _, name := range klaviyoFingerprintComponents {
		component, ok := fingerprint.Components[name]
		if !ok || component.Count < 0 || len(component.Digest) != sha256.Size*2 {
			return fmt.Errorf("Klaviyo source fingerprint component %q is invalid", name)
		}
		if _, err := hex.DecodeString(component.Digest); err != nil {
			return fmt.Errorf("Klaviyo source fingerprint component %q digest is invalid", name)
		}
	}
	if _, err := hex.DecodeString(fingerprint.Digest); err != nil {
		return fmt.Errorf("Klaviyo source fingerprint digest is invalid")
	}
	wantDigest, err := klaviyoSourceFingerprintDigest(fingerprint.Components)
	if err != nil {
		return err
	}
	if fingerprint.Digest != wantDigest {
		return fmt.Errorf("Klaviyo source fingerprint component integrity check failed")
	}
	return nil
}

func validateKlaviyoFingerprintAgainstDiscovery(fingerprint KlaviyoSourceFingerprint, discovery adapter.DiscoveryReport) error {
	if err := validateKlaviyoSourceFingerprint(fingerprint); err != nil {
		return err
	}
	expected := map[string]int{
		"subscribers":           discovery.SubscribersTotal,
		"segments":              discovery.SegmentsTotal,
		"editable_templates":    discovery.TemplatesTotal,
		"rebuild_flows":         discovery.AutomationsTotal,
		"sent_campaign_archive": discovery.ArchiveTotal,
		"source_archive":        discovery.SourceArchiveTotal,
	}
	for _, component := range klaviyoFingerprintComponents {
		want := expected[component]
		if want < 0 {
			return fmt.Errorf("Klaviyo discovery returned a negative %s total: %w", component, adapter.ErrSourceUnavailable)
		}
		if got := fingerprint.Components[component].Count; got != want {
			return fmt.Errorf("Klaviyo %s fingerprint observed %d of %d exact source records: %w", component, got, want, adapter.ErrSourceUnavailable)
		}
	}
	return nil
}

func persistKlaviyoSourceFingerprint(job *canonical.MigrationJob, fingerprint KlaviyoSourceFingerprint) error {
	if job == nil || job.Source != canonical.SourceKlaviyo {
		return fmt.Errorf("Klaviyo source fingerprint requires a Klaviyo migration job")
	}
	if err := validateKlaviyoSourceFingerprint(fingerprint); err != nil {
		return err
	}
	raw, err := json.Marshal(fingerprint)
	if err != nil {
		return fmt.Errorf("marshal Klaviyo source fingerprint: %w", err)
	}
	if len(raw) > maxKlaviyoFingerprintBytes {
		return fmt.Errorf("Klaviyo source fingerprint is %d bytes (limit %d)", len(raw), maxKlaviyoFingerprintBytes)
	}
	epochBytes := make([]byte, sha256.Size)
	if _, err := rand.Read(epochBytes); err != nil {
		return fmt.Errorf("generate Klaviyo import epoch: %w", err)
	}
	epoch := hex.EncodeToString(epochBytes)
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	value := string(raw)
	job.Cursor[klaviyoSourceFingerprintCursorKey] = &value
	job.Cursor[klaviyoImportEpochCursorKey] = &epoch
	return nil
}

// KlaviyoImportEpochFromJob loads the opaque epoch generated for the latest
// successful destination-writing Klaviyo run.
func KlaviyoImportEpochFromJob(job *canonical.MigrationJob) (string, bool, error) {
	if job == nil || job.Source != canonical.SourceKlaviyo || job.Cursor == nil || job.Cursor[klaviyoImportEpochCursorKey] == nil {
		return "", false, nil
	}
	epoch := strings.TrimSpace(*job.Cursor[klaviyoImportEpochCursorKey])
	decoded, err := hex.DecodeString(epoch)
	if err != nil || len(decoded) != sha256.Size || epoch != strings.ToLower(epoch) {
		return "", true, fmt.Errorf("Klaviyo final-delta import epoch is invalid")
	}
	return epoch, true, nil
}

// KlaviyoSourceFingerprintFromJob loads the durable full-source fingerprint
// established by the latest successful destination-writing run.
func KlaviyoSourceFingerprintFromJob(job *canonical.MigrationJob) (KlaviyoSourceFingerprint, bool, error) {
	if job == nil || job.Source != canonical.SourceKlaviyo || job.Cursor == nil || job.Cursor[klaviyoSourceFingerprintCursorKey] == nil {
		return KlaviyoSourceFingerprint{}, false, nil
	}
	raw := strings.TrimSpace(*job.Cursor[klaviyoSourceFingerprintCursorKey])
	if raw == "" || len(raw) > maxKlaviyoFingerprintBytes {
		return KlaviyoSourceFingerprint{}, true, fmt.Errorf("Klaviyo final-delta source fingerprint is invalid")
	}
	var fingerprint KlaviyoSourceFingerprint
	if err := json.Unmarshal([]byte(raw), &fingerprint); err != nil {
		return KlaviyoSourceFingerprint{}, true, fmt.Errorf("decode Klaviyo final-delta source fingerprint: %w", err)
	}
	if err := validateKlaviyoSourceFingerprint(fingerprint); err != nil {
		return KlaviyoSourceFingerprint{}, true, err
	}
	return fingerprint, true, nil
}

// BuildKlaviyoSourceFingerprint performs the same bounded, exact traversals as
// the migration without destination writes. It therefore detects same-count
// mutations that discovery totals alone cannot represent.
func BuildKlaviyoSourceFingerprint(ctx context.Context, ad adapter.Adapter, sess adapter.Session, discovery adapter.DiscoveryReport) (KlaviyoSourceFingerprint, error) {
	if ad == nil || ad.Capabilities().Source != canonical.SourceKlaviyo || sess.Source != canonical.SourceKlaviyo {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo source fingerprint requires a bound Klaviyo adapter session")
	}
	accumulator := newKlaviyoFingerprintAccumulator()
	verifier := NewVerifierInput()
	verifier.Discovery = discovery

	cursor := ""
	seenCursors := newTraversalCursorSet()
	pageLimit, err := subscriberTraversalPageLimit(discovery.SubscribersTotal, discovery.ProfilesWithoutEmailTotal)
	if err != nil {
		return KlaviyoSourceFingerprint{}, err
	}
	for page := 0; ; page++ {
		if page >= pageLimit {
			return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow subscriber traversal exceeded %d page calls: %w", pageLimit, adapter.ErrSourceUnavailable)
		}
		batch, next, err := ad.ListSubscribers(ctx, sess, cursor)
		if err != nil {
			return KlaviyoSourceFingerprint{}, fmt.Errorf("fingerprint Klaviyo subscribers: %w", err)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "Klaviyo shadow subscribers"); err != nil {
				return KlaviyoSourceFingerprint{}, err
			}
		}
		for _, subscriber := range batch {
			verifier.ObserveSubscriber(subscriber)
			if err := accumulator.observeSubscriber(subscriber); err != nil {
				return KlaviyoSourceFingerprint{}, err
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if err := validateSnapshotSubscriberTraversalEvidence(verifier, canonical.SourceKlaviyo); err != nil {
		return KlaviyoSourceFingerprint{}, err
	}
	if err := accumulator.complete("subscribers"); err != nil {
		return KlaviyoSourceFingerprint{}, err
	}

	segments, err := ad.ListSegments(ctx, sess)
	if err != nil {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("fingerprint Klaviyo segments: %w", err)
	}
	if len(segments) != discovery.SegmentsTotal {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow segment traversal returned %d of %d records: %w", len(segments), discovery.SegmentsTotal, adapter.ErrSourceUnavailable)
	}
	for _, segment := range segments {
		if err := accumulator.observeSegment(segment); err != nil {
			return KlaviyoSourceFingerprint{}, err
		}
	}
	if err := accumulator.complete("segments"); err != nil {
		return KlaviyoSourceFingerprint{}, err
	}

	templates, ok := ad.(templateLister)
	if !ok {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo source fingerprint requires editable-template traversal")
	}
	cursor = ""
	seenCursors = newTraversalCursorSet()
	seenTemplateIDs := map[[sha256.Size]byte]struct{}{}
	templateCount := 0
	pageLimit, err = subscriberTraversalPageLimit(discovery.TemplatesTotal, discovery.SourceArchiveTotal)
	if err != nil {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow template traversal bound: %w", err)
	}
	for page := 0; ; page++ {
		if page >= pageLimit {
			return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow template traversal exceeded %d page calls: %w", pageLimit, adapter.ErrSourceUnavailable)
		}
		batch, next, err := templates.ListTemplates(ctx, sess, cursor)
		if err != nil {
			return KlaviyoSourceFingerprint{}, fmt.Errorf("fingerprint Klaviyo editable templates: %w", err)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "Klaviyo shadow templates"); err != nil {
				return KlaviyoSourceFingerprint{}, err
			}
		}
		for _, template := range batch {
			duplicate, err := addBoundedIdentity(seenTemplateIDs, "editable_template", template.SourceID, maxArchiveTrackedIdentities)
			if err != nil {
				return KlaviyoSourceFingerprint{}, err
			}
			if strings.TrimSpace(template.SourceID) == "" || duplicate {
				return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow template traversal returned an invalid or duplicate source identity %q: %w", template.SourceID, adapter.ErrSourceUnavailable)
			}
			templateCount++
			if err := accumulator.observeTemplate(template); err != nil {
				return KlaviyoSourceFingerprint{}, err
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if templateCount != discovery.TemplatesTotal {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow template traversal returned %d of %d editable templates: %w", templateCount, discovery.TemplatesTotal, adapter.ErrSourceUnavailable)
	}
	if err := accumulator.complete("editable_templates"); err != nil {
		return KlaviyoSourceFingerprint{}, err
	}

	automations, err := ad.ListAutomations(ctx, sess)
	if err != nil {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("fingerprint Klaviyo rebuild-only flows: %w", err)
	}
	if len(automations) != discovery.AutomationsTotal {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow flow traversal returned %d of %d records: %w", len(automations), discovery.AutomationsTotal, adapter.ErrSourceUnavailable)
	}
	for _, automation := range automations {
		if err := accumulator.observeAutomation(automation); err != nil {
			return KlaviyoSourceFingerprint{}, err
		}
	}
	if err := accumulator.complete("rebuild_flows"); err != nil {
		return KlaviyoSourceFingerprint{}, err
	}

	if discovery.CampaignsTotal < discovery.ArchiveTotal {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo discovery campaign totals are inconsistent: %w", adapter.ErrSourceUnavailable)
	}
	campaignEmptyAllowance := discovery.CampaignsTotal - discovery.ArchiveTotal + 3
	pageLimit, err = subscriberTraversalPageLimit(discovery.ArchiveTotal, campaignEmptyAllowance)
	if err != nil {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow sent-campaign traversal bound: %w", err)
	}
	cursor = ""
	seenCursors = newTraversalCursorSet()
	seenCampaignIDs := map[[sha256.Size]byte]struct{}{}
	campaignCount := 0
	for page := 0; ; page++ {
		if page >= pageLimit {
			return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow sent-campaign traversal exceeded %d page calls: %w", pageLimit, adapter.ErrSourceUnavailable)
		}
		batch, next, err := ad.ListCampaignArchive(ctx, sess, cursor)
		if err != nil {
			return KlaviyoSourceFingerprint{}, fmt.Errorf("fingerprint Klaviyo sent campaign archive: %w", err)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "Klaviyo shadow sent campaigns"); err != nil {
				return KlaviyoSourceFingerprint{}, err
			}
		}
		for _, campaign := range batch {
			duplicate, err := addBoundedIdentity(seenCampaignIDs, "sent_campaign", campaign.SourceID, maxArchiveTrackedIdentities)
			if err != nil {
				return KlaviyoSourceFingerprint{}, err
			}
			if strings.TrimSpace(campaign.SourceID) == "" || duplicate {
				return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow sent-campaign traversal returned an invalid or duplicate source identity %q: %w", campaign.SourceID, adapter.ErrSourceUnavailable)
			}
			campaignCount++
			if err := accumulator.observeCampaign(campaign); err != nil {
				return KlaviyoSourceFingerprint{}, err
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if campaignCount != discovery.ArchiveTotal {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow sent-campaign traversal returned %d of %d records: %w", campaignCount, discovery.ArchiveTotal, adapter.ErrSourceUnavailable)
	}
	if err := accumulator.complete("sent_campaign_archive"); err != nil {
		return KlaviyoSourceFingerprint{}, err
	}

	sourceArchiver, ok := ad.(adapter.SourceArchiveAdapter)
	if !ok {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo source fingerprint requires exact source-archive traversal")
	}
	pageLimit, err = subscriberTraversalPageLimit(discovery.SourceArchiveTotal, 0)
	if err != nil {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow source-archive traversal bound: %w", err)
	}
	cursor = ""
	seenCursors = newTraversalCursorSet()
	seenSourceIDs := map[[sha256.Size]byte]struct{}{}
	sourceArchiveCount := 0
	for page := 0; ; page++ {
		if page >= pageLimit {
			return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow source-archive traversal exceeded %d page calls: %w", pageLimit, adapter.ErrSourceUnavailable)
		}
		batch, next, err := sourceArchiver.ListSourceArchive(ctx, sess, cursor)
		if err != nil {
			return KlaviyoSourceFingerprint{}, fmt.Errorf("fingerprint Klaviyo source archive: %w", err)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "Klaviyo shadow source archive"); err != nil {
				return KlaviyoSourceFingerprint{}, err
			}
		}
		for _, item := range batch {
			identity := strings.TrimSpace(item.ResourceType) + "\x00" + strings.TrimSpace(item.SourceID)
			duplicate, err := addBoundedIdentity(seenSourceIDs, "source_archive", identity, maxArchiveTrackedIdentities)
			if err != nil {
				return KlaviyoSourceFingerprint{}, err
			}
			if strings.TrimSpace(item.ResourceType) == "" || strings.TrimSpace(item.SourceID) == "" || duplicate {
				return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow source archive returned an invalid or duplicate %s identity %q: %w", item.ResourceType, item.SourceID, adapter.ErrSourceUnavailable)
			}
			sourceArchiveCount++
			if err := accumulator.observeSourceArchive(item); err != nil {
				return KlaviyoSourceFingerprint{}, err
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if sourceArchiveCount != discovery.SourceArchiveTotal {
		return KlaviyoSourceFingerprint{}, fmt.Errorf("Klaviyo shadow source-archive traversal returned %d of %d records: %w", sourceArchiveCount, discovery.SourceArchiveTotal, adapter.ErrSourceUnavailable)
	}
	if err := accumulator.complete("source_archive"); err != nil {
		return KlaviyoSourceFingerprint{}, err
	}

	fingerprint, err := accumulator.fingerprint()
	if err != nil {
		return KlaviyoSourceFingerprint{}, err
	}
	if err := validateKlaviyoFingerprintAgainstDiscovery(fingerprint, discovery); err != nil {
		return KlaviyoSourceFingerprint{}, err
	}
	return fingerprint, nil
}

// ChangedKlaviyoFingerprintComponents returns deterministic component names
// whose exact source count or digest differs from the successful baseline.
func ChangedKlaviyoFingerprintComponents(baseline, current KlaviyoSourceFingerprint) ([]string, error) {
	if err := validateKlaviyoSourceFingerprint(baseline); err != nil {
		return nil, fmt.Errorf("invalid Klaviyo baseline fingerprint: %w", err)
	}
	if err := validateKlaviyoSourceFingerprint(current); err != nil {
		return nil, fmt.Errorf("invalid current Klaviyo fingerprint: %w", err)
	}
	changed := make([]string, 0, len(klaviyoFingerprintComponents))
	for _, name := range klaviyoFingerprintComponents {
		if baseline.Components[name] != current.Components[name] {
			changed = append(changed, name)
		}
	}
	return changed, nil
}
