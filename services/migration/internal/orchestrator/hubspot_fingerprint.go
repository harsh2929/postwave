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
	"github.com/postwave/migrate/hubspot"
)

const (
	hubSpotSourceFingerprintCursorKey = "__postwave_hubspot_source_fingerprint"
	hubSpotImportEpochCursorKey       = "__postwave_hubspot_import_epoch"
	hubSpotSourceFingerprintVersion   = 1
	maxHubSpotFingerprintBytes        = 16 << 10
)

var hubSpotFingerprintComponents = []string{
	"subscribers",
	"profiles_without_email",
	"additional_email_identities",
	"segments",
	"contact_properties",
}

type hubSpotSourceFingerprintEvidencer interface {
	SourceFingerprintEvidence(context.Context, adapter.Session) (hubspot.SourceFingerprintEvidence, error)
}

// HubSpotSourceFingerprint is a bounded, non-reversible digest of every exact
// source projection used by the HubSpot contact/list bridge. It detects
// same-count contact, consent/status, primary/additional-email identity,
// captured list-membership, allowlisted structural list-metadata, active
// subscription-definition, non-email identity, and non-sensitive
// contact-property-definition changes. Unrequested list predicates and
// unsupported HubSpot products are outside this projection.
type HubSpotSourceFingerprint struct {
	Version    int                                          `json:"version"`
	Digest     string                                       `json:"digest"`
	Components map[string]HubSpotSourceFingerprintComponent `json:"components"`
}

type HubSpotSourceFingerprintComponent struct {
	Count  int    `json:"count"`
	Digest string `json:"digest"`
}

type hubSpotFingerprintAccumulator struct {
	components map[string]*hubSpotFingerprintComponentAccumulator
}

type hubSpotFingerprintComponentAccumulator struct {
	count    int
	sum      [sha256.Size]byte
	complete bool
}

func newHubSpotFingerprintAccumulator() *hubSpotFingerprintAccumulator {
	components := make(map[string]*hubSpotFingerprintComponentAccumulator, len(hubSpotFingerprintComponents))
	for _, component := range hubSpotFingerprintComponents {
		components[component] = &hubSpotFingerprintComponentAccumulator{}
	}
	return &hubSpotFingerprintAccumulator{components: components}
}

func (a *hubSpotFingerprintAccumulator) observeSubscriber(subscriber canonical.Subscriber) error {
	copy := subscriber
	copy.Tags = append([]string(nil), subscriber.Tags...)
	sort.Strings(copy.Tags)
	return a.add("subscribers", copy)
}

func (a *hubSpotFingerprintAccumulator) observeSegment(segment canonical.Segment) error {
	return a.add("segments", segment)
}

func (a *hubSpotFingerprintAccumulator) observePrehashed(component string, count int, digest string) error {
	if a == nil {
		return fmt.Errorf("HubSpot source fingerprint accumulator is unavailable")
	}
	state, ok := a.components[component]
	if !ok || state == nil || state.complete || state.count != 0 {
		return fmt.Errorf("HubSpot source fingerprint component %q cannot accept prehashed evidence", component)
	}
	digest = strings.TrimSpace(digest)
	decoded, err := hex.DecodeString(digest)
	if count < 0 || err != nil || len(decoded) != sha256.Size || digest != strings.ToLower(digest) {
		return fmt.Errorf("HubSpot source fingerprint component %q prehashed evidence is invalid", component)
	}
	state.count = count
	copy(state.sum[:], decoded)
	return nil
}

func (a *hubSpotFingerprintAccumulator) add(component string, value interface{}) error {
	if a == nil {
		return fmt.Errorf("HubSpot source fingerprint accumulator is unavailable")
	}
	state, ok := a.components[component]
	if !ok || state == nil {
		return fmt.Errorf("HubSpot source fingerprint component %q is invalid", component)
	}
	if state.complete {
		return fmt.Errorf("HubSpot source fingerprint component %q received data after traversal completion", component)
	}
	raw, err := json.Marshal(struct {
		Version   int         `json:"version"`
		Component string      `json:"component"`
		Value     interface{} `json:"value"`
	}{
		Version:   hubSpotSourceFingerprintVersion,
		Component: component,
		Value:     value,
	})
	if err != nil {
		return fmt.Errorf("marshal HubSpot %s fingerprint record: %w", component, err)
	}
	recordDigest := sha256.Sum256(raw)
	addFingerprintDigest(&state.sum, recordDigest)
	state.count++
	return nil
}

func (a *hubSpotFingerprintAccumulator) complete(component string) error {
	if a == nil {
		return fmt.Errorf("HubSpot source fingerprint accumulator is unavailable")
	}
	state, ok := a.components[component]
	if !ok || state == nil {
		return fmt.Errorf("HubSpot source fingerprint component %q is invalid", component)
	}
	if state.complete {
		return fmt.Errorf("HubSpot source fingerprint component %q completed more than once", component)
	}
	state.complete = true
	return nil
}

func (a *hubSpotFingerprintAccumulator) fingerprint() (HubSpotSourceFingerprint, error) {
	if a == nil {
		return HubSpotSourceFingerprint{}, fmt.Errorf("HubSpot source fingerprint accumulator is unavailable")
	}
	result := HubSpotSourceFingerprint{
		Version:    hubSpotSourceFingerprintVersion,
		Components: make(map[string]HubSpotSourceFingerprintComponent, len(hubSpotFingerprintComponents)),
	}
	for _, component := range hubSpotFingerprintComponents {
		state := a.components[component]
		if state == nil || state.count < 0 || !state.complete {
			return HubSpotSourceFingerprint{}, fmt.Errorf("HubSpot source fingerprint component %q is incomplete", component)
		}
		digest := sha256.Sum256([]byte(strings.Join([]string{
			"postwave-hubspot-component-v1",
			component,
			strconv.Itoa(state.count),
			hex.EncodeToString(state.sum[:]),
		}, "\x00")))
		result.Components[component] = HubSpotSourceFingerprintComponent{
			Count:  state.count,
			Digest: hex.EncodeToString(digest[:]),
		}
	}
	digest, err := hubSpotSourceFingerprintDigest(result.Components)
	if err != nil {
		return HubSpotSourceFingerprint{}, err
	}
	result.Digest = digest
	return result, validateHubSpotSourceFingerprint(result)
}

func hubSpotSourceFingerprintDigest(components map[string]HubSpotSourceFingerprintComponent) (string, error) {
	raw, err := json.Marshal(components)
	if err != nil {
		return "", fmt.Errorf("marshal HubSpot source fingerprint components: %w", err)
	}
	digest := sha256.Sum256(append([]byte("postwave-hubspot-source-v1\x00"), raw...))
	return hex.EncodeToString(digest[:]), nil
}

func validateHubSpotSourceFingerprint(fingerprint HubSpotSourceFingerprint) error {
	if fingerprint.Version != hubSpotSourceFingerprintVersion || len(fingerprint.Digest) != sha256.Size*2 {
		return fmt.Errorf("HubSpot source fingerprint has an unsupported version or digest")
	}
	if len(fingerprint.Components) != len(hubSpotFingerprintComponents) {
		return fmt.Errorf("HubSpot source fingerprint has an incomplete component set")
	}
	for _, name := range hubSpotFingerprintComponents {
		component, ok := fingerprint.Components[name]
		if !ok || component.Count < 0 || len(component.Digest) != sha256.Size*2 {
			return fmt.Errorf("HubSpot source fingerprint component %q is invalid", name)
		}
		if _, err := hex.DecodeString(component.Digest); err != nil || component.Digest != strings.ToLower(component.Digest) {
			return fmt.Errorf("HubSpot source fingerprint component %q digest is invalid", name)
		}
	}
	if _, err := hex.DecodeString(fingerprint.Digest); err != nil || fingerprint.Digest != strings.ToLower(fingerprint.Digest) {
		return fmt.Errorf("HubSpot source fingerprint digest is invalid")
	}
	want, err := hubSpotSourceFingerprintDigest(fingerprint.Components)
	if err != nil {
		return err
	}
	if fingerprint.Digest != want {
		return fmt.Errorf("HubSpot source fingerprint component integrity check failed")
	}
	return nil
}

func validateHubSpotFingerprintAgainstDiscovery(fingerprint HubSpotSourceFingerprint, discovery adapter.DiscoveryReport) error {
	if err := validateHubSpotSourceFingerprint(fingerprint); err != nil {
		return err
	}
	expected := map[string]int{
		"subscribers":                 discovery.SubscribersTotal,
		"profiles_without_email":      discovery.ProfilesWithoutEmailTotal,
		"additional_email_identities": discovery.AdditionalEmailIdentitiesTotal,
		"segments":                    discovery.SegmentsTotal,
		"contact_properties":          discovery.GroupsTotal,
	}
	for _, component := range hubSpotFingerprintComponents {
		want := expected[component]
		if want < 0 {
			return fmt.Errorf("HubSpot discovery returned a negative %s total: %w", component, adapter.ErrSourceUnavailable)
		}
		if got := fingerprint.Components[component].Count; got != want {
			return fmt.Errorf("HubSpot %s fingerprint observed %d of %d exact source records: %w", component, got, want, adapter.ErrSourceUnavailable)
		}
	}
	return nil
}

func observeHubSpotProviderFingerprintEvidence(
	ctx context.Context,
	ad adapter.Adapter,
	sess adapter.Session,
	discovery adapter.DiscoveryReport,
	accumulator *hubSpotFingerprintAccumulator,
	scope string,
) error {
	evidencer, ok := ad.(hubSpotSourceFingerprintEvidencer)
	if !ok {
		return fmt.Errorf("HubSpot %s source fingerprint requires non-email, additional-email, and contact-property evidence", scope)
	}
	evidence, err := evidencer.SourceFingerprintEvidence(ctx, sess)
	if err != nil {
		return fmt.Errorf("fingerprint HubSpot provider inventory: %w", err)
	}
	if evidence.ProfilesWithoutEmailCount != discovery.ProfilesWithoutEmailTotal {
		return fmt.Errorf("HubSpot %s non-email identity evidence returned %d of %d profiles: %w", scope, evidence.ProfilesWithoutEmailCount, discovery.ProfilesWithoutEmailTotal, adapter.ErrSourceUnavailable)
	}
	if evidence.ContactPropertiesCount != discovery.GroupsTotal {
		return fmt.Errorf("HubSpot %s contact-property evidence returned %d of %d definitions: %w", scope, evidence.ContactPropertiesCount, discovery.GroupsTotal, adapter.ErrSourceUnavailable)
	}
	if evidence.AdditionalEmailCount != discovery.AdditionalEmailIdentitiesTotal {
		return fmt.Errorf("HubSpot %s additional-email identity evidence returned %d of %d identities: %w", scope, evidence.AdditionalEmailCount, discovery.AdditionalEmailIdentitiesTotal, adapter.ErrSourceUnavailable)
	}
	if err := accumulator.observePrehashed("profiles_without_email", evidence.ProfilesWithoutEmailCount, evidence.ProfilesWithoutEmailDigest); err != nil {
		return err
	}
	if err := accumulator.complete("profiles_without_email"); err != nil {
		return err
	}
	if err := accumulator.observePrehashed("additional_email_identities", evidence.AdditionalEmailCount, evidence.AdditionalEmailDigest); err != nil {
		return err
	}
	if err := accumulator.complete("additional_email_identities"); err != nil {
		return err
	}
	if err := accumulator.observePrehashed("contact_properties", evidence.ContactPropertiesCount, evidence.ContactPropertiesDigest); err != nil {
		return err
	}
	return accumulator.complete("contact_properties")
}

func persistHubSpotSourceFingerprint(job *canonical.MigrationJob, fingerprint HubSpotSourceFingerprint) error {
	if job == nil || job.Source != canonical.SourceHubSpot {
		return fmt.Errorf("HubSpot source fingerprint requires a HubSpot migration job")
	}
	if err := validateHubSpotSourceFingerprint(fingerprint); err != nil {
		return err
	}
	raw, err := json.Marshal(fingerprint)
	if err != nil {
		return fmt.Errorf("marshal HubSpot source fingerprint: %w", err)
	}
	if len(raw) > maxHubSpotFingerprintBytes {
		return fmt.Errorf("HubSpot source fingerprint is %d bytes (limit %d)", len(raw), maxHubSpotFingerprintBytes)
	}
	epochBytes := make([]byte, sha256.Size)
	if _, err := rand.Read(epochBytes); err != nil {
		return fmt.Errorf("generate HubSpot import epoch: %w", err)
	}
	epoch := hex.EncodeToString(epochBytes)
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	value := string(raw)
	job.Cursor[hubSpotSourceFingerprintCursorKey] = &value
	job.Cursor[hubSpotImportEpochCursorKey] = &epoch
	return nil
}

// HubSpotImportEpochFromJob loads the opaque epoch generated for the latest
// successful destination-writing HubSpot full snapshot.
func HubSpotImportEpochFromJob(job *canonical.MigrationJob) (string, bool, error) {
	if job == nil || job.Source != canonical.SourceHubSpot || job.Cursor == nil || job.Cursor[hubSpotImportEpochCursorKey] == nil {
		return "", false, nil
	}
	epoch := strings.TrimSpace(*job.Cursor[hubSpotImportEpochCursorKey])
	decoded, err := hex.DecodeString(epoch)
	if err != nil || len(decoded) != sha256.Size || epoch != strings.ToLower(epoch) {
		return "", true, fmt.Errorf("HubSpot final-delta import epoch is invalid")
	}
	return epoch, true, nil
}

// HubSpotSourceFingerprintFromJob loads the durable exact-source fingerprint
// established by the latest successful destination-writing run.
func HubSpotSourceFingerprintFromJob(job *canonical.MigrationJob) (HubSpotSourceFingerprint, bool, error) {
	if job == nil || job.Source != canonical.SourceHubSpot || job.Cursor == nil || job.Cursor[hubSpotSourceFingerprintCursorKey] == nil {
		return HubSpotSourceFingerprint{}, false, nil
	}
	raw := strings.TrimSpace(*job.Cursor[hubSpotSourceFingerprintCursorKey])
	if raw == "" || len(raw) > maxHubSpotFingerprintBytes {
		return HubSpotSourceFingerprint{}, true, fmt.Errorf("HubSpot final-delta source fingerprint is invalid")
	}
	var fingerprint HubSpotSourceFingerprint
	if err := json.Unmarshal([]byte(raw), &fingerprint); err != nil {
		return HubSpotSourceFingerprint{}, true, fmt.Errorf("decode HubSpot final-delta source fingerprint: %w", err)
	}
	if err := validateHubSpotSourceFingerprint(fingerprint); err != nil {
		return HubSpotSourceFingerprint{}, true, err
	}
	return fingerprint, true, nil
}

// BuildHubSpotSourceFingerprint repeats the bounded exact subscriber/list and
// provider-inventory traversals without destination writes for shadow checks.
func BuildHubSpotSourceFingerprint(ctx context.Context, ad adapter.Adapter, sess adapter.Session, discovery adapter.DiscoveryReport) (HubSpotSourceFingerprint, error) {
	if ad == nil || ad.Capabilities().Source != canonical.SourceHubSpot || sess.Source != canonical.SourceHubSpot {
		return HubSpotSourceFingerprint{}, fmt.Errorf("HubSpot source fingerprint requires a bound HubSpot adapter session")
	}
	accumulator := newHubSpotFingerprintAccumulator()
	if err := observeHubSpotProviderFingerprintEvidence(ctx, ad, sess, discovery, accumulator, "shadow"); err != nil {
		return HubSpotSourceFingerprint{}, err
	}

	verifier := NewVerifierInput()
	verifier.Discovery = discovery
	cursor := ""
	seenCursors := newTraversalCursorSet()
	pageLimit, err := subscriberTraversalPageLimit(discovery.SubscribersTotal, discovery.ProfilesWithoutEmailTotal)
	if err != nil {
		return HubSpotSourceFingerprint{}, err
	}
	for page := 0; ; page++ {
		if page >= pageLimit {
			return HubSpotSourceFingerprint{}, fmt.Errorf("HubSpot shadow subscriber traversal exceeded %d page calls: %w", pageLimit, adapter.ErrSourceUnavailable)
		}
		batch, next, err := ad.ListSubscribers(ctx, sess, cursor)
		if err != nil {
			return HubSpotSourceFingerprint{}, fmt.Errorf("fingerprint HubSpot subscribers: %w", err)
		}
		if next != "" {
			if err := recordTraversalCursor(seenCursors, cursor, next, "HubSpot shadow subscribers"); err != nil {
				return HubSpotSourceFingerprint{}, err
			}
		}
		for _, subscriber := range batch {
			verifier.ObserveSubscriber(subscriber)
			if err := accumulator.observeSubscriber(subscriber); err != nil {
				return HubSpotSourceFingerprint{}, err
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if err := validateSnapshotSubscriberTraversalEvidence(verifier, canonical.SourceHubSpot); err != nil {
		return HubSpotSourceFingerprint{}, err
	}
	if err := accumulator.complete("subscribers"); err != nil {
		return HubSpotSourceFingerprint{}, err
	}

	segments, err := ad.ListSegments(ctx, sess)
	if err != nil {
		return HubSpotSourceFingerprint{}, fmt.Errorf("fingerprint HubSpot lists: %w", err)
	}
	if len(segments) != discovery.SegmentsTotal {
		return HubSpotSourceFingerprint{}, fmt.Errorf("HubSpot shadow list traversal returned %d of %d records: %w", len(segments), discovery.SegmentsTotal, adapter.ErrSourceUnavailable)
	}
	for _, segment := range segments {
		if err := accumulator.observeSegment(segment); err != nil {
			return HubSpotSourceFingerprint{}, err
		}
	}
	if err := accumulator.complete("segments"); err != nil {
		return HubSpotSourceFingerprint{}, err
	}

	fingerprint, err := accumulator.fingerprint()
	if err != nil {
		return HubSpotSourceFingerprint{}, err
	}
	if err := validateHubSpotFingerprintAgainstDiscovery(fingerprint, discovery); err != nil {
		return HubSpotSourceFingerprint{}, err
	}
	return fingerprint, nil
}

// ChangedHubSpotFingerprintComponents returns deterministic component names
// whose exact source count or digest differs from the successful baseline.
func ChangedHubSpotFingerprintComponents(baseline, current HubSpotSourceFingerprint) ([]string, error) {
	if err := validateHubSpotSourceFingerprint(baseline); err != nil {
		return nil, fmt.Errorf("invalid HubSpot baseline fingerprint: %w", err)
	}
	if err := validateHubSpotSourceFingerprint(current); err != nil {
		return nil, fmt.Errorf("invalid current HubSpot fingerprint: %w", err)
	}
	changed := make([]string, 0, len(hubSpotFingerprintComponents))
	for _, name := range hubSpotFingerprintComponents {
		if baseline.Components[name] != current.Components[name] {
			changed = append(changed, name)
		}
	}
	return changed, nil
}
