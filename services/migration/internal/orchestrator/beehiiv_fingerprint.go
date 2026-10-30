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
	beehiivSourceFingerprintCursorKey = "__postwave_beehiiv_source_fingerprint"
	beehiivImportEpochCursorKey       = "__postwave_beehiiv_import_epoch"
	beehiivSourceFingerprintVersion   = 1
	maxBeehiivFingerprintBytes        = 16 << 10
)

var beehiivFingerprintComponents = []string{
	"subscribers",
	"segments",
	"automations",
	"campaigns",
	"source_archive",
}

// BeehiivSourceFingerprint is a bounded, non-reversible digest of every
// source record that can affect a Beehiiv cutover. It is stored on the job only
// after a successful destination-writing run. Per-component digests let shadow
// checks identify which surface changed without exposing provider data.
type BeehiivSourceFingerprint struct {
	Version    int                                          `json:"version"`
	Digest     string                                       `json:"digest"`
	Components map[string]BeehiivSourceFingerprintComponent `json:"components"`
}

type BeehiivSourceFingerprintComponent struct {
	Count  int    `json:"count"`
	Digest string `json:"digest"`
}

type beehiivFingerprintAccumulator struct {
	components map[string]*beehiivFingerprintComponentAccumulator
}

type beehiivFingerprintComponentAccumulator struct {
	count int
	sum   [sha256.Size]byte
}

func newBeehiivFingerprintAccumulator() *beehiivFingerprintAccumulator {
	components := make(map[string]*beehiivFingerprintComponentAccumulator, len(beehiivFingerprintComponents))
	for _, component := range beehiivFingerprintComponents {
		components[component] = &beehiivFingerprintComponentAccumulator{}
	}
	return &beehiivFingerprintAccumulator{components: components}
}

func (a *beehiivFingerprintAccumulator) observeSubscriber(subscriber canonical.Subscriber) error {
	copy := subscriber
	copy.Tags = append([]string(nil), subscriber.Tags...)
	sort.Strings(copy.Tags)
	return a.add("subscribers", copy)
}

func (a *beehiivFingerprintAccumulator) observeSegment(segment canonical.Segment) error {
	return a.add("segments", segment)
}

func (a *beehiivFingerprintAccumulator) observeAutomation(automation canonical.Automation) error {
	return a.add("automations", automation)
}

func (a *beehiivFingerprintAccumulator) observeCampaign(campaign canonical.CampaignArchive) error {
	return a.add("campaigns", campaign)
}

func (a *beehiivFingerprintAccumulator) observeSourceArchive(item canonical.SourceArchiveItem) error {
	copy := item
	payload, err := cloneFingerprintMap(item.Payload)
	if err != nil {
		return fmt.Errorf("clone Beehiiv source-archive fingerprint payload: %w", err)
	}
	copy.Payload = payload
	// This is a Moosewave run marker, not source state. Including it would make
	// every later shadow check differ solely because it ran at another time.
	delete(copy.Payload, "postwave_classification_cutoff")
	return a.add("source_archive", copy)
}

func cloneFingerprintMap(input map[string]interface{}) (map[string]interface{}, error) {
	if input == nil {
		return nil, nil
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	var output map[string]interface{}
	if err := json.Unmarshal(raw, &output); err != nil {
		return nil, err
	}
	return output, nil
}

func (a *beehiivFingerprintAccumulator) add(component string, value interface{}) error {
	if a == nil {
		return fmt.Errorf("Beehiiv source fingerprint accumulator is unavailable")
	}
	state, ok := a.components[component]
	if !ok || state == nil {
		return fmt.Errorf("Beehiiv source fingerprint component %q is invalid", component)
	}
	raw, err := json.Marshal(struct {
		Version   int         `json:"version"`
		Component string      `json:"component"`
		Value     interface{} `json:"value"`
	}{
		Version:   beehiivSourceFingerprintVersion,
		Component: component,
		Value:     value,
	})
	if err != nil {
		return fmt.Errorf("marshal Beehiiv %s fingerprint record: %w", component, err)
	}
	recordDigest := sha256.Sum256(raw)
	addFingerprintDigest(&state.sum, recordDigest)
	state.count++
	return nil
}

// addFingerprintDigest adds modulo 2^256. Together with the record count and a
// final SHA-256 compression this is an order-independent, fixed-size multiset
// digest; provider page ordering cannot create a false source delta.
func addFingerprintDigest(total *[sha256.Size]byte, value [sha256.Size]byte) {
	carry := uint16(0)
	for index := sha256.Size - 1; index >= 0; index-- {
		sum := uint16(total[index]) + uint16(value[index]) + carry
		total[index] = byte(sum)
		carry = sum >> 8
	}
}

func (a *beehiivFingerprintAccumulator) fingerprint() (BeehiivSourceFingerprint, error) {
	if a == nil {
		return BeehiivSourceFingerprint{}, fmt.Errorf("Beehiiv source fingerprint accumulator is unavailable")
	}
	result := BeehiivSourceFingerprint{
		Version:    beehiivSourceFingerprintVersion,
		Components: make(map[string]BeehiivSourceFingerprintComponent, len(beehiivFingerprintComponents)),
	}
	for _, component := range beehiivFingerprintComponents {
		state := a.components[component]
		if state == nil || state.count < 0 {
			return BeehiivSourceFingerprint{}, fmt.Errorf("Beehiiv source fingerprint component %q is incomplete", component)
		}
		digest := sha256.Sum256([]byte(strings.Join([]string{
			"postwave-beehiiv-component-v1",
			component,
			strconv.Itoa(state.count),
			hex.EncodeToString(state.sum[:]),
		}, "\x00")))
		result.Components[component] = BeehiivSourceFingerprintComponent{
			Count:  state.count,
			Digest: hex.EncodeToString(digest[:]),
		}
	}
	digest, err := beehiivSourceFingerprintDigest(result.Components)
	if err != nil {
		return BeehiivSourceFingerprint{}, err
	}
	result.Digest = digest
	return result, validateBeehiivSourceFingerprint(result)
}

func beehiivSourceFingerprintDigest(components map[string]BeehiivSourceFingerprintComponent) (string, error) {
	raw, err := json.Marshal(components)
	if err != nil {
		return "", fmt.Errorf("marshal Beehiiv source fingerprint components: %w", err)
	}
	digest := sha256.Sum256(append([]byte("postwave-beehiiv-source-v1\x00"), raw...))
	return hex.EncodeToString(digest[:]), nil
}

func validateBeehiivSourceFingerprint(fingerprint BeehiivSourceFingerprint) error {
	if fingerprint.Version != beehiivSourceFingerprintVersion || len(fingerprint.Digest) != sha256.Size*2 {
		return fmt.Errorf("Beehiiv source fingerprint has an unsupported version or digest")
	}
	if len(fingerprint.Components) != len(beehiivFingerprintComponents) {
		return fmt.Errorf("Beehiiv source fingerprint has an incomplete component set")
	}
	for _, name := range beehiivFingerprintComponents {
		component, ok := fingerprint.Components[name]
		if !ok || component.Count < 0 || len(component.Digest) != sha256.Size*2 {
			return fmt.Errorf("Beehiiv source fingerprint component %q is invalid", name)
		}
		if _, err := hex.DecodeString(component.Digest); err != nil {
			return fmt.Errorf("Beehiiv source fingerprint component %q digest is invalid", name)
		}
	}
	if _, err := hex.DecodeString(fingerprint.Digest); err != nil {
		return fmt.Errorf("Beehiiv source fingerprint digest is invalid")
	}
	wantDigest, err := beehiivSourceFingerprintDigest(fingerprint.Components)
	if err != nil {
		return err
	}
	if fingerprint.Digest != wantDigest {
		return fmt.Errorf("Beehiiv source fingerprint component integrity check failed")
	}
	return nil
}

func persistBeehiivSourceFingerprint(job *canonical.MigrationJob, fingerprint BeehiivSourceFingerprint) error {
	if job == nil || job.Source != canonical.SourceBeehiiv {
		return fmt.Errorf("Beehiiv source fingerprint requires a Beehiiv migration job")
	}
	if err := validateBeehiivSourceFingerprint(fingerprint); err != nil {
		return err
	}
	raw, err := json.Marshal(fingerprint)
	if err != nil {
		return fmt.Errorf("marshal Beehiiv source fingerprint: %w", err)
	}
	if len(raw) > maxBeehiivFingerprintBytes {
		return fmt.Errorf("Beehiiv source fingerprint is %d bytes (limit %d)", len(raw), maxBeehiivFingerprintBytes)
	}
	epochBytes := make([]byte, sha256.Size)
	if _, err := rand.Read(epochBytes); err != nil {
		return fmt.Errorf("generate Beehiiv import epoch: %w", err)
	}
	epoch := hex.EncodeToString(epochBytes)
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	value := string(raw)
	job.Cursor[beehiivSourceFingerprintCursorKey] = &value
	job.Cursor[beehiivImportEpochCursorKey] = &epoch
	return nil
}

// BeehiivImportEpochFromJob loads the opaque epoch generated for the latest
// successful destination-writing Beehiiv run. Unlike wall-clock timestamps,
// this value is safe to compare across service replicas: every successful
// final delta receives a new epoch even when its source fingerprint is
// unchanged.
func BeehiivImportEpochFromJob(job *canonical.MigrationJob) (string, bool, error) {
	if job == nil || job.Source != canonical.SourceBeehiiv || job.Cursor == nil || job.Cursor[beehiivImportEpochCursorKey] == nil {
		return "", false, nil
	}
	epoch := strings.TrimSpace(*job.Cursor[beehiivImportEpochCursorKey])
	decoded, err := hex.DecodeString(epoch)
	if err != nil || len(decoded) != sha256.Size || epoch != strings.ToLower(epoch) {
		return "", true, fmt.Errorf("Beehiiv final-delta import epoch is invalid")
	}
	return epoch, true, nil
}

// BeehiivSourceFingerprintFromJob loads the durable fingerprint established by
// the latest successful destination-writing run. A missing value is reported
// separately so callers can direct the operator to rerun final delta.
func BeehiivSourceFingerprintFromJob(job *canonical.MigrationJob) (BeehiivSourceFingerprint, bool, error) {
	if job == nil || job.Source != canonical.SourceBeehiiv || job.Cursor == nil || job.Cursor[beehiivSourceFingerprintCursorKey] == nil {
		return BeehiivSourceFingerprint{}, false, nil
	}
	raw := strings.TrimSpace(*job.Cursor[beehiivSourceFingerprintCursorKey])
	if raw == "" || len(raw) > maxBeehiivFingerprintBytes {
		return BeehiivSourceFingerprint{}, true, fmt.Errorf("Beehiiv final-delta source fingerprint is invalid")
	}
	var fingerprint BeehiivSourceFingerprint
	if err := json.Unmarshal([]byte(raw), &fingerprint); err != nil {
		return BeehiivSourceFingerprint{}, true, fmt.Errorf("decode Beehiiv final-delta source fingerprint: %w", err)
	}
	if err := validateBeehiivSourceFingerprint(fingerprint); err != nil {
		return BeehiivSourceFingerprint{}, true, err
	}
	return fingerprint, true, nil
}

// BuildBeehiivSourceFingerprint performs the same validated traversals used by
// a migration, without destination writes. Shadow mode uses it to detect
// same-count mutations that Discover totals cannot represent.
func BuildBeehiivSourceFingerprint(ctx context.Context, ad adapter.Adapter, sess adapter.Session, discovery adapter.DiscoveryReport) (BeehiivSourceFingerprint, error) {
	if ad == nil || ad.Capabilities().Source != canonical.SourceBeehiiv || sess.Source != canonical.SourceBeehiiv {
		return BeehiivSourceFingerprint{}, fmt.Errorf("Beehiiv source fingerprint requires a bound Beehiiv adapter session")
	}
	accumulator := newBeehiivFingerprintAccumulator()
	verifier := NewVerifierInput()
	verifier.Discovery = discovery

	cursor := ""
	seenCursors := newTraversalCursorSet()
	pageLimit, err := subscriberTraversalPageLimit(discovery.SubscribersTotal, len(discovery.Audiences))
	if err != nil {
		return BeehiivSourceFingerprint{}, err
	}
	for page := 0; ; page++ {
		if page >= pageLimit {
			return BeehiivSourceFingerprint{}, fmt.Errorf("Beehiiv shadow subscriber traversal exceeded %d page calls: %w", pageLimit, adapter.ErrSourceUnavailable)
		}
		batch, next, err := ad.ListSubscribers(ctx, sess, cursor)
		if err != nil {
			return BeehiivSourceFingerprint{}, fmt.Errorf("fingerprint Beehiiv subscribers: %w", err)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "Beehiiv shadow subscribers"); err != nil {
				return BeehiivSourceFingerprint{}, err
			}
		}
		for _, subscriber := range batch {
			verifier.ObserveSubscriber(subscriber)
			if err := accumulator.observeSubscriber(subscriber); err != nil {
				return BeehiivSourceFingerprint{}, err
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if err := validateBeehiivSubscriberTraversalEvidence(verifier); err != nil {
		return BeehiivSourceFingerprint{}, err
	}

	segments, err := ad.ListSegments(ctx, sess)
	if err != nil {
		return BeehiivSourceFingerprint{}, fmt.Errorf("fingerprint Beehiiv segments: %w", err)
	}
	if len(segments) != discovery.SegmentsTotal {
		return BeehiivSourceFingerprint{}, fmt.Errorf("Beehiiv shadow segment traversal returned %d of %d records: %w", len(segments), discovery.SegmentsTotal, adapter.ErrSourceUnavailable)
	}
	for _, segment := range segments {
		if err := accumulator.observeSegment(segment); err != nil {
			return BeehiivSourceFingerprint{}, err
		}
	}

	automations, err := ad.ListAutomations(ctx, sess)
	if err != nil {
		return BeehiivSourceFingerprint{}, fmt.Errorf("fingerprint Beehiiv automations: %w", err)
	}
	if len(automations) != discovery.AutomationsTotal {
		return BeehiivSourceFingerprint{}, fmt.Errorf("Beehiiv shadow automation traversal returned %d of %d records: %w", len(automations), discovery.AutomationsTotal, adapter.ErrSourceUnavailable)
	}
	for _, automation := range automations {
		if err := accumulator.observeAutomation(automation); err != nil {
			return BeehiivSourceFingerprint{}, err
		}
	}

	cursor = ""
	seenCursors = newTraversalCursorSet()
	seenCampaignIDs := map[[sha256.Size]byte]struct{}{}
	campaignCount := 0
	for page := 0; ; page++ {
		if page >= maxArchiveTraversalPageCalls {
			return BeehiivSourceFingerprint{}, fmt.Errorf("Beehiiv shadow campaign traversal exceeded %d page calls: %w", maxArchiveTraversalPageCalls, adapter.ErrSourceUnavailable)
		}
		batch, next, err := ad.ListCampaignArchive(ctx, sess, cursor)
		if err != nil {
			return BeehiivSourceFingerprint{}, fmt.Errorf("fingerprint Beehiiv campaigns: %w", err)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "Beehiiv shadow campaigns"); err != nil {
				return BeehiivSourceFingerprint{}, err
			}
		}
		for _, campaign := range batch {
			duplicate, err := addBoundedIdentity(seenCampaignIDs, "campaign_archive", campaign.SourceID, maxArchiveTrackedIdentities)
			if err != nil {
				return BeehiivSourceFingerprint{}, err
			}
			if duplicate {
				return BeehiivSourceFingerprint{}, fmt.Errorf("Beehiiv shadow campaign traversal returned duplicate source identity %q: %w", campaign.SourceID, adapter.ErrSourceUnavailable)
			}
			campaignCount++
			if err := accumulator.observeCampaign(campaign); err != nil {
				return BeehiivSourceFingerprint{}, err
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if campaignCount != discovery.ArchiveTotal {
		return BeehiivSourceFingerprint{}, fmt.Errorf("Beehiiv shadow campaign traversal returned %d of %d records: %w", campaignCount, discovery.ArchiveTotal, adapter.ErrSourceUnavailable)
	}

	if sourceArchiver, ok := ad.(adapter.SourceArchiveAdapter); ok {
		cursor = ""
		seenCursors = newTraversalCursorSet()
		seenSourceIDs := map[[sha256.Size]byte]struct{}{}
		for page := 0; ; page++ {
			if page >= maxArchiveTraversalPageCalls {
				return BeehiivSourceFingerprint{}, fmt.Errorf("Beehiiv shadow source-archive traversal exceeded %d page calls: %w", maxArchiveTraversalPageCalls, adapter.ErrSourceUnavailable)
			}
			batch, next, err := sourceArchiver.ListSourceArchive(ctx, sess, cursor)
			if err != nil {
				return BeehiivSourceFingerprint{}, fmt.Errorf("fingerprint Beehiiv source archive: %w", err)
			}
			if next != "" {
				if err := recordTraversalCursor(seenCursors, cursor, next, "Beehiiv shadow source archive"); err != nil {
					return BeehiivSourceFingerprint{}, err
				}
			}
			for _, item := range batch {
				if !sourceArchiveWarningOnly(item) && sourceArchiveRequiresGlobalIdentityCheck(canonical.SourceBeehiiv, item.ResourceType) {
					identity := strings.TrimSpace(item.ResourceType) + "\x00" + strings.TrimSpace(item.SourceID)
					duplicate, err := addBoundedIdentity(seenSourceIDs, "source_archive", identity, maxArchiveTrackedIdentities)
					if err != nil {
						return BeehiivSourceFingerprint{}, err
					}
					if duplicate {
						return BeehiivSourceFingerprint{}, fmt.Errorf("Beehiiv shadow source archive returned duplicate %s identity %q: %w", item.ResourceType, item.SourceID, adapter.ErrSourceUnavailable)
					}
				}
				if err := accumulator.observeSourceArchive(item); err != nil {
					return BeehiivSourceFingerprint{}, err
				}
			}
			if next == "" {
				break
			}
			cursor = next
		}
	}

	return accumulator.fingerprint()
}

// ChangedBeehiivFingerprintComponents returns deterministic component names
// whose count or digest differs from the successful import baseline.
func ChangedBeehiivFingerprintComponents(baseline, current BeehiivSourceFingerprint) ([]string, error) {
	if err := validateBeehiivSourceFingerprint(baseline); err != nil {
		return nil, fmt.Errorf("invalid Beehiiv baseline fingerprint: %w", err)
	}
	if err := validateBeehiivSourceFingerprint(current); err != nil {
		return nil, fmt.Errorf("invalid current Beehiiv fingerprint: %w", err)
	}
	changed := make([]string, 0, len(beehiivFingerprintComponents))
	for _, name := range beehiivFingerprintComponents {
		if baseline.Components[name] != current.Components[name] {
			changed = append(changed, name)
		}
	}
	return changed, nil
}
