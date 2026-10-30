// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	ec "github.com/postwave/postwave/apps/api/internal/engagementclassification"
)

// Fetch is one observed GET of a decoy: the verified claim the URL carried,
// plus what the network showed at the moment of the request.
//
// There is no Classification field and there is nowhere to put one. The label
// is not a judgement anybody records — it follows from the fetch having
// happened at all, which is the entire reason this evidence can certify.
type Fetch struct {
	Claim       Claim
	Provider    string
	FetchedAt   time.Time
	DeliveredAt *time.Time
	UserAgent   string
	IP          string
	NetworkASN  *uint32
	// NetworkASNSource must be stated whenever NetworkASN is present; the
	// calibration loader refuses an ASN whose origin nobody can name.
	NetworkASNSource ec.NetworkASNSource
	NetworkRegion    string
	ReverseDNS       string
	TLSJA4           string
}

// CorpusOptions names the exported evidence. Provider is optional and acts as
// the default for fetches that do not carry their own.
type CorpusOptions struct {
	Name     string
	Version  string
	Provider string
}

const (
	// corpusSamplingUnit is one recipient of one campaign. It is the unit the
	// Wilson intervals are computed over, so it has to be the unit that
	// independent evidence actually arrives in.
	corpusSamplingUnit = "recipient_campaign"

	examplesFilename = "examples.jsonl"
	manifestFilename = "manifest.json"
)

var corpusNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,95}$`)

// ExportCorpus writes a controlled-machine calibration corpus for the supplied
// fetches.
//
// Every example is written with ground truth machine and IsSeed false, which
// is precisely what makes it certifying rather than diagnostic: the recipient
// is real, so seed identity — an absolute classifier input — plays no part in
// the label, and the circularity that demotes seed evidence does not arise.
func ExportCorpus(directory string, options CorpusOptions, fetches []Fetch) error {
	if !corpusNamePattern.MatchString(options.Name) {
		return fmt.Errorf("%w: honeypot corpus name %q is invalid", ErrInvalidInput, options.Name)
	}
	if !corpusNamePattern.MatchString(options.Version) {
		return fmt.Errorf("%w: honeypot corpus version %q is invalid", ErrInvalidInput, options.Version)
	}
	if len(fetches) == 0 {
		// An empty corpus loads and evaluates perfectly happily, and reports a
		// machine recall computed from nothing. Refusing here keeps a run that
		// collected no evidence from looking like a run that passed.
		return fmt.Errorf("%w: honeypot corpus requires at least one fetch", ErrInvalidInput)
	}

	examples, err := collapseToObservations(fetches, options.Provider)
	if err != nil {
		return err
	}

	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	for _, example := range examples {
		if err := encoder.Encode(example); err != nil {
			return fmt.Errorf("encode honeypot calibration example: %w", err)
		}
	}
	digest := sha256.Sum256(body.Bytes())

	manifest, err := json.MarshalIndent(ec.CalibrationCorpusManifestV2{
		ContractVersion: ec.CalibrationCorpusContractV2,
		Name:            options.Name,
		Kind:            ec.ControlledMachineCorpus,
		Version:         options.Version,
		Provider:        strings.ToLower(strings.TrimSpace(options.Provider)),
		SamplingUnit:    corpusSamplingUnit,
		SampleCount:     len(examples),
		ExamplesFile:    examplesFilename,
		ExamplesSHA256:  hex.EncodeToString(digest[:]),
	}, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal honeypot corpus manifest: %w", err)
	}

	// Examples first: the manifest names a digest, so a crash between the two
	// writes must not leave a manifest pointing at a file that is not there.
	if err := os.WriteFile(filepath.Join(directory, examplesFilename), body.Bytes(), 0o600); err != nil {
		return fmt.Errorf("write honeypot examples: %w", err)
	}
	if err := os.WriteFile(filepath.Join(directory, manifestFilename), append(manifest, '\n'), 0o600); err != nil {
		return fmt.Errorf("write honeypot manifest: %w", err)
	}
	return nil
}

// collapseToObservations reduces every fetch of every decoy to at most one
// example per recipient per campaign.
//
// A scanner typically fetches both decoys and often retries, and a security
// gateway may re-scan the same message days later. Those are all the same
// underlying fact — this message was machine-processed — and counting them
// separately would tighten the confidence interval on evidence that is not
// independent, claiming precision that was never earned.
func collapseToObservations(fetches []Fetch, defaultProvider string) ([]ec.CalibrationExampleV2, error) {
	earliest := make(map[string]Fetch, len(fetches))
	for _, fetch := range fetches {
		if !fetch.Claim.Technique.Certifies() {
			// The last gate before evidence becomes certification. An
			// off-screen decoy may have been activated by a screen-reader user,
			// and a human in the machine corpus does not merely add noise — it
			// certifies the classifier against its own worst failure.
			return nil, fmt.Errorf(
				"%w: fetch of a %q decoy cannot certify a machine label",
				ErrInvalidInput, fetch.Claim.Technique)
		}
		if fetch.FetchedAt.IsZero() {
			return nil, fmt.Errorf("%w: honeypot fetch has no observation time", ErrInvalidInput)
		}
		key := samplingUnitHash(fetch.Claim)
		previous, seen := earliest[key]
		if !seen || fetch.FetchedAt.Before(previous.FetchedAt) {
			// The earliest fetch is the one whose latency relative to delivery
			// still means something; a later retry would smear that signal.
			earliest[key] = fetch
		}
	}

	keys := make([]string, 0, len(earliest))
	for key := range earliest {
		keys = append(keys, key)
	}
	// Deterministic output so a re-export of the same evidence is byte-for-byte
	// the same file, and therefore the same manifest digest.
	sort.Strings(keys)

	examples := make([]ec.CalibrationExampleV2, 0, len(keys))
	for index, key := range keys {
		fetch := earliest[key]
		provider := strings.ToLower(strings.TrimSpace(fetch.Provider))
		if provider == "" {
			provider = strings.ToLower(strings.TrimSpace(defaultProvider))
		}
		examples = append(examples, ec.CalibrationExampleV2{
			ID:               fmt.Sprintf("hp-%06d-%s", index, key[:16]),
			Provider:         provider,
			SamplingUnitHash: key,
			GroundTruth:      ec.Machine,
			Source:           "honeypot",
			EventType:        "clicked",
			OccurredAt:       fetch.FetchedAt.UTC(),
			DeliveredAt:      fetch.DeliveredAt,
			// Never a seed. This single field is the difference between
			// evidence that certifies machine recall and evidence that is
			// filed as diagnostic.
			IsSeed:           false,
			UserAgent:        fetch.UserAgent,
			IP:               fetch.IP,
			NetworkASN:       fetch.NetworkASN,
			NetworkASNSource: fetch.NetworkASNSource,
			NetworkRegion:    fetch.NetworkRegion,
			ReverseDNS:       fetch.ReverseDNS,
			TLSJA4:           fetch.TLSJA4,
		})
	}
	return examples, nil
}

// samplingUnitHash identifies one recipient of one campaign without carrying
// either. The claim already holds an HMAC rather than an address, so the
// corpus can be handed to an analyst who has no right to the mailing list.
func samplingUnitHash(claim Claim) string {
	digest := sha256.Sum256([]byte(strings.Join([]string{
		corpusSamplingUnit,
		claim.TenantID,
		claim.CampaignID,
		claim.RecipientIdentityHMAC,
	}, "\x1f")))
	return hex.EncodeToString(digest[:])
}
