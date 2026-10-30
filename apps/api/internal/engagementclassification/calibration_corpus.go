// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"regexp"
	"strings"
	"time"
)

const (
	CalibrationCorpusContractV2 = "postwave.engagement-calibration-corpus.v2"
	calibrationManifestFilename = "manifest.json"
	maxCalibrationManifestBytes = 64 << 10
	maxCalibrationExamplesBytes = 128 << 20
	maxCalibrationExampleBytes  = 256 << 10
	maxCalibrationExamples      = 100_000
	maxCalibrationCorpora       = 32
	maxCalibrationSources       = 64
)

var calibrationExampleIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$`)

// CalibrationCorpusManifestV2 is the portable, closed-schema receipt placed
// next to a JSONL evidence file. examples_sha256 covers the exact file bytes;
// CorpusManifest.ManifestHash covers the exact manifest bytes. Neither raw
// message bodies nor recipient addresses are part of this contract.
type CalibrationCorpusManifestV2 struct {
	ContractVersion string     `json:"contract_version"`
	Name            string     `json:"name"`
	Kind            CorpusKind `json:"kind"`
	Version         string     `json:"version"`
	Provider        string     `json:"provider,omitempty"`
	SamplingUnit    string     `json:"sampling_unit"`
	SampleCount     int        `json:"sample_count"`
	ExamplesFile    string     `json:"examples_file"`
	ExamplesSHA256  string     `json:"examples_sha256"`
}

// CalibrationExampleV2 intentionally exposes only classifier evidence. The
// loader supplies synthetic canonical IDs and privacy bookkeeping locally;
// those fields are not evidence and therefore cannot be smuggled in by a
// corpus producer.
type CalibrationExampleV2 struct {
	ID                     string         `json:"id"`
	Provider               string         `json:"provider,omitempty"`
	SamplingUnitHash       string         `json:"sampling_unit_hash"`
	GroundTruth            Classification `json:"ground_truth"`
	Source                 string         `json:"source"`
	EventType              string         `json:"event_type"`
	OccurredAt             time.Time      `json:"occurred_at"`
	DeliveredAt            *time.Time     `json:"delivered_at,omitempty"`
	IsSeed                 bool           `json:"is_seed,omitempty"`
	OrderedHeaders         []Header       `json:"ordered_headers,omitempty"`
	OrderedHeadersComplete bool           `json:"ordered_headers_complete,omitempty"`
	UserAgent              string         `json:"user_agent,omitempty"`
	IP                     string         `json:"ip,omitempty"`
	NetworkASN             *uint32        `json:"network_asn,omitempty"`
	// NetworkASNSource is REQUIRED whenever NetworkASN is present. A labelled
	// corpus is ground truth used to calibrate a shipped classifier; an ASN in it
	// whose origin nobody can state is evidence that cannot be audited, and the
	// loader refuses it rather than letting an unattributed number set a
	// threshold. See network_asn.go.
	NetworkASNSource  NetworkASNSource `json:"network_asn_source,omitempty"`
	NetworkRegion     string           `json:"network_region,omitempty"`
	ReverseDNS        string           `json:"reverse_dns,omitempty"`
	TLSJA4            string           `json:"tls_ja4,omitempty"`
	ProviderSignals   map[string]any   `json:"provider_signals,omitempty"`
	DwellMilliseconds *int64           `json:"dwell_milliseconds,omitempty"`
	MessageLinkCount  *int             `json:"message_link_count,omitempty"`
	Aggregate         AggregateV1      `json:"aggregate,omitempty"`
}

type AggregateV1 struct {
	Complete             bool       `json:"complete,omitempty"`
	DeliveredAt          *time.Time `json:"delivered_at,omitempty"`
	DistinctLinksFetched int        `json:"distinct_links_fetched,omitempty"`
	TotalLinks           int        `json:"total_links,omitempty"`
	EventCount           int        `json:"event_count,omitempty"`
	BurstWindowMS        int64      `json:"burst_window_ms,omitempty"`
	HasPrecedingOpen     bool       `json:"has_preceding_open,omitempty"`
	OpenUserAgents       []string   `json:"open_user_agents,omitempty"`
	ClickUserAgents      []string   `json:"click_user_agents,omitempty"`
}

// FileCalibrationCorpus is immutable after loading. Keeping the verified
// examples in memory prevents a manifest/file swap between Manifest and
// ForEach. The file and sample limits make that trade-off explicit.
type FileCalibrationCorpus struct {
	manifest      CorpusManifest
	examples      []LabeledExample
	evidenceBytes int64
}

// LoadCalibrationCorpusDirectory opens one rooted directory containing
// manifest.json and its referenced JSONL file. os.Root prevents traversal and
// out-of-root symlink escapes while the loader rejects non-regular files.
func LoadCalibrationCorpusDirectory(directory string) (*FileCalibrationCorpus, error) {
	return LoadCalibrationCorpusDirectoryWithEvidenceLimit(
		directory,
		maxCalibrationManifestBytes+maxCalibrationExamplesBytes,
	)
}

// LoadCalibrationCorpusDirectoryWithEvidenceLimit is the bounded form of
// LoadCalibrationCorpusDirectory. maximumEvidenceBytes covers the exact
// manifest and examples-file bytes together. The examples file is size-checked
// through the rooted file descriptor before it is read, so callers can safely
// apply a remaining aggregate budget while retaining previously loaded
// corpora.
func LoadCalibrationCorpusDirectoryWithEvidenceLimit(
	directory string,
	maximumEvidenceBytes int64,
) (*FileCalibrationCorpus, error) {
	if strings.TrimSpace(directory) == "" {
		return nil, fmt.Errorf("%w: calibration corpus directory is required", ErrInvalidInput)
	}
	if maximumEvidenceBytes <= 0 {
		return nil, fmt.Errorf("%w: calibration corpus evidence byte limit must be positive", ErrInvalidInput)
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, fmt.Errorf("open calibration corpus root: %w", err)
	}
	defer func() { _ = root.Close() }()

	manifestLimit := min(maximumEvidenceBytes, int64(maxCalibrationManifestBytes))
	manifestBytes, err := readBoundedRootFile(root, calibrationManifestFilename, manifestLimit)
	if err != nil {
		return nil, fmt.Errorf("read calibration corpus manifest within evidence byte limit: %w", err)
	}
	wireManifest, err := decodeCalibrationManifest(manifestBytes)
	if err != nil {
		return nil, err
	}
	if !validCorpusLeafName(wireManifest.ExamplesFile) {
		return nil, fmt.Errorf("%w: examples_file must be one regular file in the corpus root", ErrInvalidInput)
	}
	remainingEvidenceBytes := maximumEvidenceBytes - int64(len(manifestBytes))
	examplesLimit := min(remainingEvidenceBytes, int64(maxCalibrationExamplesBytes))
	examplesBytes, err := readBoundedRootFile(root, wireManifest.ExamplesFile, examplesLimit)
	if err != nil {
		return nil, fmt.Errorf("read calibration examples within evidence byte limit: %w", err)
	}
	corpus, err := buildFileCalibrationCorpus(manifestBytes, wireManifest, examplesBytes)
	if err != nil {
		return nil, err
	}
	corpus.evidenceBytes = int64(len(manifestBytes)) + int64(len(examplesBytes))
	return corpus, nil
}

// EvidenceBytes reports the exact hash-verified manifest and examples input
// bytes represented by this corpus's immutable logical snapshot. It excludes
// Go object overhead and is intended for enforcing a deterministic aggregate
// input budget across several corpora.
func (corpus *FileCalibrationCorpus) EvidenceBytes() int64 {
	if corpus == nil {
		return 0
	}
	return corpus.evidenceBytes
}

func (corpus *FileCalibrationCorpus) Manifest(ctx context.Context) (CorpusManifest, error) {
	if corpus == nil {
		return CorpusManifest{}, fmt.Errorf("%w: nil calibration corpus", ErrInvalidInput)
	}
	if err := ctx.Err(); err != nil {
		return CorpusManifest{}, err
	}
	return corpus.manifest, nil
}

func (corpus *FileCalibrationCorpus) ForEach(
	ctx context.Context,
	visit func(LabeledExample) error,
) error {
	if corpus == nil || visit == nil {
		return fmt.Errorf("%w: corpus and visitor are required", ErrInvalidInput)
	}
	for _, example := range corpus.examples {
		if err := ctx.Err(); err != nil {
			return err
		}
		// LabeledExample contains slices, pointers, and recursively nested JSON
		// maps. Never expose aliases into the verified in-memory snapshot: a
		// visitor may mutate its argument or several visitors may run in
		// parallel.
		if err := visit(cloneCalibrationExample(example)); err != nil {
			return err
		}
	}
	return nil
}

func cloneCalibrationExample(example LabeledExample) LabeledExample {
	cloned := example
	cloned.Observation = cloneCalibrationObservation(example.Observation)
	cloned.Aggregate = cloneCalibrationAggregate(example.Aggregate)
	return cloned
}

func cloneCalibrationObservation(observation ObservationInput) ObservationInput {
	cloned := observation
	cloned.DeliveredAt = cloneTimePointer(observation.DeliveredAt)
	cloned.NetworkASN = clonePointer(observation.NetworkASN)
	cloned.DwellMilliseconds = clonePointer(observation.DwellMilliseconds)
	cloned.MessageLinkCount = clonePointer(observation.MessageLinkCount)
	cloned.OrderedHeaders = cloneCalibrationSlice(observation.OrderedHeaders)
	cloned.ProviderSignals = cloneCalibrationJSONMap(observation.ProviderSignals)
	return cloned
}

func cloneCalibrationAggregate(aggregate MessageAggregate) MessageAggregate {
	cloned := aggregate
	cloned.DeliveredAt = cloneTimePointer(aggregate.DeliveredAt)
	cloned.OpenUserAgents = cloneCalibrationSlice(aggregate.OpenUserAgents)
	cloned.ClickUserAgents = cloneCalibrationSlice(aggregate.ClickUserAgents)
	return cloned
}

func cloneTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func clonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneCalibrationSlice[T any](input []T) []T {
	if input == nil {
		return nil
	}
	cloned := make([]T, len(input))
	copy(cloned, input)
	return cloned
}

func cloneCalibrationJSONMap(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	cloned := make(map[string]any, len(input))
	for key, value := range input {
		cloned[key] = cloneCalibrationJSONValue(value)
	}
	return cloned
}

func cloneCalibrationJSONValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return cloneCalibrationJSONMap(typed)
	case []any:
		cloned := make([]any, len(typed))
		for index, item := range typed {
			cloned[index] = cloneCalibrationJSONValue(item)
		}
		return cloned
	case []byte:
		return cloneCalibrationSlice(typed)
	default:
		// JSON scalars (nil, bool, float64, and string) are immutable values.
		return typed
	}
}

func readBoundedRootFile(root *os.Root, name string, maximum int64) ([]byte, error) {
	linkInfo, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if linkInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: %q must not be a symbolic link", ErrInvalidInput, name)
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > maximum {
		return nil, fmt.Errorf("%w: %q must be a regular file no larger than %d bytes", ErrInvalidInput, name, maximum)
	}
	raw, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maximum {
		return nil, fmt.Errorf("%w: %q exceeds %d bytes", ErrInvalidInput, name, maximum)
	}
	return raw, nil
}

func decodeCalibrationManifest(raw []byte) (CalibrationCorpusManifestV2, error) {
	var manifest CalibrationCorpusManifestV2
	if err := decodeStrictJSON(raw, &manifest); err != nil {
		return manifest, fmt.Errorf("%w: decode calibration corpus manifest: %v", ErrInvalidInput, err)
	}
	if manifest.ContractVersion != CalibrationCorpusContractV2 ||
		strings.TrimSpace(manifest.Name) == "" || len(manifest.Name) > 200 ||
		strings.ContainsAny(manifest.Name, "\x00\r\n") ||
		!versionPattern.MatchString(manifest.Version) ||
		manifest.SampleCount < 0 || manifest.SampleCount > maxCalibrationExamples ||
		!hashPattern.MatchString(manifest.ExamplesSHA256) {
		return manifest, fmt.Errorf("%w: calibration corpus manifest fields are invalid", ErrInvalidInput)
	}
	switch manifest.Kind {
	case ControlledMachineCorpus, LabeledHumanCorpus, CorrelatedHumanCorpus:
	default:
		return manifest, fmt.Errorf("%w: calibration corpus kind %q is invalid", ErrInvalidInput, manifest.Kind)
	}
	manifest.Provider = strings.ToLower(strings.TrimSpace(manifest.Provider))
	manifest.SamplingUnit = strings.ToLower(strings.TrimSpace(manifest.SamplingUnit))
	if manifest.Provider != "" && !versionPattern.MatchString(manifest.Provider) {
		return manifest, fmt.Errorf("%w: calibration corpus provider is invalid", ErrInvalidInput)
	}
	if !versionPattern.MatchString(manifest.SamplingUnit) {
		return manifest, fmt.Errorf("%w: calibration corpus sampling_unit is invalid", ErrInvalidInput)
	}
	return manifest, nil
}

func buildFileCalibrationCorpus(
	manifestBytes []byte,
	wireManifest CalibrationCorpusManifestV2,
	examplesBytes []byte,
) (*FileCalibrationCorpus, error) {
	examplesDigest := sha256.Sum256(examplesBytes)
	if actual := hex.EncodeToString(examplesDigest[:]); actual != wireManifest.ExamplesSHA256 {
		return nil, fmt.Errorf("%w: calibration examples sha256 mismatch", ErrInvalidInput)
	}
	manifestDigest := sha256.Sum256(manifestBytes)
	manifest := CorpusManifest{
		Name:         strings.TrimSpace(wireManifest.Name),
		Kind:         wireManifest.Kind,
		Version:      wireManifest.Version,
		ManifestHash: hex.EncodeToString(manifestDigest[:]),
		Provider:     wireManifest.Provider,
		SamplingUnit: wireManifest.SamplingUnit,
		SampleCount:  wireManifest.SampleCount,
	}
	if err := validateCorpusManifest(manifest); err != nil {
		return nil, err
	}

	lines := bytes.Split(examplesBytes, []byte{'\n'})
	examples := make([]LabeledExample, 0, wireManifest.SampleCount)
	seenIDs := make(map[string]struct{}, wireManifest.SampleCount)
	for index, line := range lines {
		lineNumber := index + 1
		line = bytes.TrimSuffix(line, []byte{'\r'})
		if len(bytes.TrimSpace(line)) == 0 {
			if index == len(lines)-1 {
				continue
			}
			return nil, fmt.Errorf("%w: empty calibration example at line %d", ErrInvalidInput, lineNumber)
		}
		if len(line) > maxCalibrationExampleBytes {
			return nil, fmt.Errorf("%w: calibration example line %d exceeds %d bytes", ErrInvalidInput, lineNumber, maxCalibrationExampleBytes)
		}
		if len(examples) >= maxCalibrationExamples {
			return nil, fmt.Errorf("%w: calibration corpus exceeds %d examples", ErrInvalidInput, maxCalibrationExamples)
		}
		var wire CalibrationExampleV2
		if err := decodeStrictJSON(line, &wire); err != nil {
			return nil, fmt.Errorf("%w: decode calibration example line %d: %v", ErrInvalidInput, lineNumber, err)
		}
		if !calibrationExampleIDPattern.MatchString(wire.ID) {
			return nil, fmt.Errorf("%w: calibration example line %d has invalid id", ErrInvalidInput, lineNumber)
		}
		if _, exists := seenIDs[wire.ID]; exists {
			return nil, fmt.Errorf("%w: duplicate calibration example id %q", ErrInvalidInput, wire.ID)
		}
		seenIDs[wire.ID] = struct{}{}
		example, err := materializeCalibrationExample(wireManifest, wire, len(examples)+1)
		if err != nil {
			return nil, fmt.Errorf("calibration example %q: %w", wire.ID, err)
		}
		examples = append(examples, example)
	}
	if len(examples) != wireManifest.SampleCount {
		return nil, fmt.Errorf("%w: corpus %q manifest count=%d observed=%d", ErrInvalidInput, manifest.Name, wireManifest.SampleCount, len(examples))
	}
	return &FileCalibrationCorpus{manifest: manifest, examples: examples}, nil
}

func materializeCalibrationExample(
	manifest CalibrationCorpusManifestV2,
	wire CalibrationExampleV2,
	sequence int,
) (LabeledExample, error) {
	if wire.GroundTruth != Human && wire.GroundTruth != Machine {
		return LabeledExample{}, fmt.Errorf("%w: ground_truth must be human or machine", ErrInvalidInput)
	}
	if manifest.Kind == ControlledMachineCorpus && wire.GroundTruth != Machine {
		return LabeledExample{}, fmt.Errorf("%w: controlled-machine truth must be machine", ErrInvalidInput)
	}
	if (manifest.Kind == LabeledHumanCorpus || manifest.Kind == CorrelatedHumanCorpus) && wire.GroundTruth != Human {
		return LabeledExample{}, fmt.Errorf("%w: human-corpus truth must be human", ErrInvalidInput)
	}
	provider := strings.ToLower(strings.TrimSpace(wire.Provider))
	if provider != "" && !versionPattern.MatchString(provider) {
		return LabeledExample{}, fmt.Errorf("%w: provider is invalid", ErrInvalidInput)
	}
	if provider == "" {
		provider = manifest.Provider
	}
	if wire.OccurredAt.IsZero() {
		return LabeledExample{}, fmt.Errorf("%w: occurred_at is required", ErrInvalidInput)
	}
	wire.SamplingUnitHash = strings.ToLower(strings.TrimSpace(wire.SamplingUnitHash))
	if !hashPattern.MatchString(wire.SamplingUnitHash) {
		return LabeledExample{}, fmt.Errorf("%w: sampling_unit_hash is invalid", ErrInvalidInput)
	}
	if err := validateAggregateV1(wire.Aggregate); err != nil {
		return LabeledExample{}, err
	}
	occurredAt := wire.OccurredAt.UTC()
	observation, err := normalizeObservation(ObservationInput{
		EventRef:               EventRef{ID: int64(sequence), At: occurredAt},
		Source:                 wire.Source,
		IdempotencyKey:         "calibration:" + manifest.Version + ":" + wire.ID,
		EventSchemaVersion:     ObservationSchemaV1,
		EventType:              wire.EventType,
		OccurredAt:             occurredAt,
		IngestedAt:             occurredAt,
		DeliveredAt:            wire.DeliveredAt,
		IsSeed:                 wire.IsSeed,
		OrderedHeaders:         wire.OrderedHeaders,
		OrderedHeadersComplete: wire.OrderedHeadersComplete,
		UserAgent:              wire.UserAgent,
		IP:                     wire.IP,
		NetworkASN:             wire.NetworkASN,
		NetworkASNSource:       wire.NetworkASNSource,
		NetworkRegion:          wire.NetworkRegion,
		ReverseDNS:             wire.ReverseDNS,
		TLSJA4:                 wire.TLSJA4,
		ProviderSignals:        wire.ProviderSignals,
		DwellMilliseconds:      wire.DwellMilliseconds,
		MessageLinkCount:       wire.MessageLinkCount,
		PrivacyExpiryAt:        occurredAt.Add(365 * 24 * time.Hour),
	}, occurredAt)
	if err != nil {
		return LabeledExample{}, err
	}
	aggregate := MessageAggregate{
		Complete:             wire.Aggregate.Complete,
		DeliveredAt:          wire.Aggregate.DeliveredAt,
		DistinctLinksFetched: wire.Aggregate.DistinctLinksFetched,
		TotalLinks:           wire.Aggregate.TotalLinks,
		EventCount:           wire.Aggregate.EventCount,
		BurstWindow:          time.Duration(wire.Aggregate.BurstWindowMS) * time.Millisecond,
		HasPrecedingOpen:     wire.Aggregate.HasPrecedingOpen,
		OpenUserAgents:       append([]string(nil), wire.Aggregate.OpenUserAgents...),
		ClickUserAgents:      append([]string(nil), wire.Aggregate.ClickUserAgents...),
	}
	if aggregate.DeliveredAt != nil {
		value := aggregate.DeliveredAt.UTC()
		aggregate.DeliveredAt = &value
	}
	return LabeledExample{
		ID: wire.ID, Provider: provider, SamplingUnitHash: wire.SamplingUnitHash, GroundTruth: wire.GroundTruth,
		Observation: observation, Aggregate: aggregate,
	}, nil
}

func validateAggregateV1(aggregate AggregateV1) error {
	if aggregate.DistinctLinksFetched < 0 || aggregate.DistinctLinksFetched > 10_000 ||
		aggregate.TotalLinks < 0 || aggregate.TotalLinks > 10_000 ||
		aggregate.DistinctLinksFetched > aggregate.TotalLinks ||
		aggregate.EventCount < 0 || aggregate.EventCount > 10_000 ||
		aggregate.BurstWindowMS < 0 || aggregate.BurstWindowMS > int64((24*time.Hour)/time.Millisecond) ||
		len(aggregate.OpenUserAgents) > 128 || len(aggregate.ClickUserAgents) > 128 {
		return fmt.Errorf("%w: aggregate bounds are invalid", ErrInvalidInput)
	}
	for _, userAgent := range append(append([]string(nil), aggregate.OpenUserAgents...), aggregate.ClickUserAgents...) {
		if len(userAgent) > 4096 || strings.ContainsAny(userAgent, "\x00\r\n") {
			return fmt.Errorf("%w: aggregate user agent is invalid", ErrInvalidInput)
		}
	}
	return nil
}

func decodeStrictJSON(raw []byte, destination any) error {
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values")
		}
		return err
	}
	return nil
}

func rejectDuplicateJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var walkValue func() error
	walkValue = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, composite := token.(json.Delim)
		if !composite {
			return nil
		}
		switch delimiter {
		case '{':
			seen := make(map[string]struct{})
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return fmt.Errorf("JSON object key is not a string")
				}
				if _, duplicate := seen[key]; duplicate {
					return fmt.Errorf("duplicate JSON object key %q", key)
				}
				seen[key] = struct{}{}
				if err := walkValue(); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil {
				return err
			}
			if closing != json.Delim('}') {
				return fmt.Errorf("invalid JSON object terminator")
			}
		case '[':
			for decoder.More() {
				if err := walkValue(); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil {
				return err
			}
			if closing != json.Delim(']') {
				return fmt.Errorf("invalid JSON array terminator")
			}
		default:
			return fmt.Errorf("invalid JSON delimiter %q", delimiter)
		}
		return nil
	}
	if err := walkValue(); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values")
		}
		return err
	}
	return nil
}

func validCorpusLeafName(name string) bool {
	return name != "" && fs.ValidPath(name) && path.Base(name) == name &&
		name != "." && !strings.HasPrefix(name, ".")
}
