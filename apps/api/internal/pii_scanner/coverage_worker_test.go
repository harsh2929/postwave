// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRetryDelayExponentialCapAndJitter(t *testing.T) {
	if got := retryDelay(1, 0); got != 5*time.Second {
		t.Fatalf("attempt 1 delay=%s want 5s", got)
	}
	if got := retryDelay(2, 0); got != 10*time.Second {
		t.Fatalf("attempt 2 delay=%s want 10s", got)
	}
	base := retryDelay(4, 0)
	jittered := retryDelay(4, ^uint64(0))
	if jittered < base || jittered > base+base/4 {
		t.Fatalf("jittered delay=%s outside [%s,%s]", jittered, base, base+base/4)
	}
	if got := retryDelay(99, 0); got != time.Hour {
		t.Fatalf("capped delay=%s want 1h", got)
	}
}

func TestSafeCoverageFieldNameBoundedAndControlFree(t *testing.T) {
	input := "  notes\n" + string(make([]rune, 300))
	got := safeCoverageFieldName(input)
	if len([]rune(got)) > 256 {
		t.Fatalf("field name runes=%d want <=256", len([]rune(got)))
	}
	for _, r := range got {
		if r == '\n' || r == '\r' || r == '\t' {
			t.Fatalf("field name retained control character %q", r)
		}
	}
	if got := safeCoverageFieldName("\n\r"); got == "" {
		t.Fatal("control-only field name became empty")
	}
}

func TestCurrentCoverageScanContractIsVersionedAndSecretFree(t *testing.T) {
	pepper := []byte("coverage-contract-test-pepper-at-least-32-bytes")
	detector, err := NewDetector(pepper, "contract-test-v1")
	if err != nil {
		t.Fatal(err)
	}
	contract, ok := currentCoverageScanContract(detector)
	if !ok {
		t.Fatal("valid detector did not produce a coverage contract")
	}
	for _, fragment := range []string{
		ScannerName, ScannerVersion, DetectorName, DetectorVersion,
		PolicyName, PolicyVersion, FingerprintSchemeHMACSHA256V1, "contract-test-v1",
	} {
		if !strings.Contains(contract, fragment) {
			t.Errorf("coverage contract missing %q: %q", fragment, contract)
		}
	}
	if strings.Contains(contract, string(pepper)) || len(contract) > maxCoverageScanContractBytes {
		t.Fatalf("unsafe coverage contract %q", contract)
	}
	commitment := detector.FingerprintKeyCommitment()
	if !isFullFingerprint(commitment) || !strings.Contains(contract, commitment) {
		t.Fatalf("coverage contract missing key commitment: %q", contract)
	}
	otherDetector, err := NewDetector([]byte("different-contract-test-pepper-at-least-32-bytes"), "contract-test-v1")
	if err != nil {
		t.Fatal(err)
	}
	otherContract, ok := currentCoverageScanContract(otherDetector)
	if !ok || otherContract == contract {
		t.Fatal("replicas with different key material and the same key version were not fenced")
	}
	if contract2, ok := currentCoverageScanContract(&Detector{}); ok || contract2 != "" {
		t.Fatalf("zero detector contract=(%q,%v), want unavailable", contract2, ok)
	}
}

func TestCoverageScanContractParserRejectsAmbiguousOrIncompleteContracts(t *testing.T) {
	detector, err := NewDetector(
		[]byte("coverage-contract-parser-pepper-at-least-32-bytes"),
		"contract-parser-v1",
	)
	if err != nil {
		t.Fatal(err)
	}
	valid, ok := currentCoverageScanContract(detector)
	if !ok {
		t.Fatal("valid detector did not produce a coverage contract")
	}
	metadata, ok := parseCoverageScanContract(valid)
	if !ok || metadata.FingerprintKeyVersion != "contract-parser-v1" ||
		metadata.KeyCommitment != detector.FingerprintKeyCommitment() {
		t.Fatalf("valid contract metadata=%+v ok=%t", metadata, ok)
	}

	parts := strings.Split(valid, "|")
	invalid := []string{
		"",
		strings.Join(parts[:4], "|"),
		valid + "|unknown=value",
		parts[0] + "|" + parts[0] + "|" + strings.Join(parts[2:], "|"),
		strings.Replace(valid, parts[0], "scanner=missing-version-separator", 1),
		strings.Replace(valid, "fingerprint=hmac-sha256-v1@", "fingerprint=sha256@", 1),
		strings.Replace(valid, "key_commitment=hmac-sha256-v1:", "key_commitment=hmac-sha256-v1:xyz", 1),
		strings.Replace(valid, "contract-parser-v1", LegacyFingerprintKeyVersion, 1),
		valid + "\nscanner=forged@v1",
	}
	for _, contract := range invalid {
		if parsed, accepted := parseCoverageScanContract(contract); accepted {
			t.Errorf("invalid contract accepted metadata=%+v contract=%q", parsed, contract)
		}
		if _, err := requiredCoverageScanContract(contract); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("required contract %q error=%v, want ErrInvalidInput", contract, err)
		}
	}
	if _, err := optionalCoverageScanContract([]string{valid, valid}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("multiple contracts error=%v, want ErrInvalidInput", err)
	}
}

func TestCoverageClaimsRequireAnExactExecutableContract(t *testing.T) {
	repo := &Repo{}
	ownerID := "00000000-0000-4000-8000-000000000001"
	for _, contract := range []string{"", "scanner=incomplete@v1"} {
		if _, err := repo.ClaimScanIntents(context.Background(), ownerID, time.Minute, 1, contract); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("intent claim contract=%q error=%v, want ErrInvalidInput", contract, err)
		}
		if _, err := repo.ClaimReconciliations(context.Background(), ownerID, time.Minute, 1, contract); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("reconciliation claim contract=%q error=%v, want ErrInvalidInput", contract, err)
		}
	}
}

func TestValidateRepairInput(t *testing.T) {
	valid := []ScanRepairInput{
		{Action: "request_reconciliation", Confirmation: "REPAIR PII COVERAGE"},
		{Action: "requeue_dead_letters", SubscriberID: "00000000-0000-4000-8000-000000000001", Limit: 200, Confirmation: "REPAIR PII COVERAGE"},
	}
	for i := range valid {
		if err := validateRepairInput(&valid[i]); err != nil {
			t.Errorf("valid repair %+v: %v", valid[i], err)
		}
	}
	invalid := []ScanRepairInput{
		{Action: "requeue_dead_letters", Confirmation: "yes"},
		{Action: "unknown", Confirmation: "REPAIR PII COVERAGE"},
		{Action: "request_reconciliation", SubscriberID: "00000000-0000-4000-8000-000000000001", Confirmation: "REPAIR PII COVERAGE"},
		{Action: "requeue_dead_letters", SubscriberID: "not-a-uuid", Confirmation: "REPAIR PII COVERAGE"},
		{Action: "requeue_dead_letters", Limit: 201, Confirmation: "REPAIR PII COVERAGE"},
	}
	for i := range invalid {
		if err := validateRepairInput(&invalid[i]); err == nil {
			t.Errorf("invalid repair accepted: %+v", invalid[i])
		}
	}
}
