// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Not t.Parallel: the trusted-proxy set middleware authenticates against is
// process-global.
func asnObservationRequest(remoteAddr string, headers ...string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/campaign/px.gif", nil)
	r.RemoteAddr = remoteAddr
	for _, value := range headers {
		r.Header.Add(middleware.ClientASNHeader, value)
	}
	return r
}

// The three answers a reader must be able to tell apart, and the fact that only
// one of them ever carries a number.
func TestObservedNetworkASNRecordsHowTheValueWasLearned(t *testing.T) {
	defer func() { _ = middleware.SetTrustedProxyCIDRs(nil) }()

	// 1. No authenticated edge in this deployment. The signal is switched OFF,
	// which must not look like "this client had no ASN".
	_ = middleware.SetTrustedProxyCIDRs(nil)
	asn, source := ObservedNetworkASN(asnObservationRequest("10.1.2.3:4444", "13335"), true)
	if asn != nil || source != NetworkASNEdgeUnconfigured {
		t.Fatalf("unconfigured deployment = %v/%q, want nil/edge_unconfigured", asn, source)
	}
	asn, source = ObservedNetworkASN(asnObservationRequest("10.1.2.3:4444", "13335"), false)
	if asn != nil || source != NetworkASNEdgeUnconfigured {
		t.Fatalf("trustHeaders=false = %v/%q, want nil/edge_unconfigured", asn, source)
	}

	if err := middleware.SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}

	// 2. Boundary exists, this request produced nothing usable. NULL, and the
	// provenance says the deployment is capable of measuring — a different fact
	// from case 1 and a different operator response.
	for _, test := range []struct {
		name    string
		request *http.Request
	}{
		{name: "untrusted peer with a header", request: asnObservationRequest("203.0.113.9:4444", "13335")},
		{name: "trusted peer, no header", request: asnObservationRequest("10.1.2.3:4444")},
		{name: "duplicate headers", request: asnObservationRequest("10.1.2.3:4444", "13335", "15169")},
		{name: "reserved AS 0", request: asnObservationRequest("10.1.2.3:4444", "0")},
		{name: "prefixed rendering", request: asnObservationRequest("10.1.2.3:4444", "AS13335")},
	} {
		t.Run(test.name, func(t *testing.T) {
			asn, source := ObservedNetworkASN(test.request, true)
			if asn != nil {
				t.Fatalf("%s produced a value %d — a guessed ASN is worse than none", test.name, *asn)
			}
			if source != NetworkASNUnmeasured {
				t.Fatalf("%s provenance = %q, want unmeasured", test.name, source)
			}
		})
	}

	// 3. A trusted edge measured it. Without this the assertions above would all
	// pass on a function that returns nil unconditionally.
	asn, source = ObservedNetworkASN(asnObservationRequest("10.1.2.3:4444", "13335"), true)
	if asn == nil || *asn != 13335 || source != NetworkASNEdgeMeasured {
		t.Fatalf("trusted edge = %v/%q, want 13335/edge_measured", asn, source)
	}
}

func TestNormalizeNetworkASNSourceRefusesAnUnattributedMeasurement(t *testing.T) {
	t.Parallel()
	value := uint32(13335)
	zero := uint32(0)

	for _, test := range []struct {
		name  string
		input ObservationInput
		want  NetworkASNSource
	}{
		{name: "unstated with no value", input: ObservationInput{}, want: NetworkASNUnmeasured},
		{
			name:  "measured",
			input: ObservationInput{NetworkASN: &value, NetworkASNSource: NetworkASNEdgeMeasured},
			want:  NetworkASNEdgeMeasured,
		},
		{
			name:  "unconfigured",
			input: ObservationInput{NetworkASNSource: NetworkASNEdgeUnconfigured},
			want:  NetworkASNEdgeUnconfigured,
		},
		{
			name:  "legacy backfill round-trips on read",
			input: ObservationInput{NetworkASN: &value, NetworkASNSource: NetworkASNLegacyUnattributed},
			want:  NetworkASNLegacyUnattributed,
		},
	} {
		got, err := normalizeNetworkASNSource(test.input)
		if err != nil || got != test.want {
			t.Fatalf("%s = %q/%v, want %q", test.name, got, err, test.want)
		}
	}

	for _, test := range []struct {
		name  string
		input ObservationInput
		want  string
	}{
		{
			name:  "a number with no stated origin",
			input: ObservationInput{NetworkASN: &value},
			want:  "without a provenance",
		},
		{
			name:  "measured provenance with no measurement",
			input: ObservationInput{NetworkASNSource: NetworkASNEdgeMeasured},
			want:  "contradicts its provenance",
		},
		{
			name:  "value carried under a NULL-implying provenance",
			input: ObservationInput{NetworkASN: &value, NetworkASNSource: NetworkASNUnmeasured},
			want:  "contradicts its provenance",
		},
		{
			name:  "reserved AS 0",
			input: ObservationInput{NetworkASN: &zero, NetworkASNSource: NetworkASNEdgeMeasured},
			want:  "reserved",
		},
		{
			name:  "invented vocabulary",
			input: ObservationInput{NetworkASNSource: NetworkASNSource("maxmind_lookup")},
			want:  "unknown network ASN source",
		},
	} {
		got, err := normalizeNetworkASNSource(test.input)
		if err == nil {
			t.Fatalf("%s was accepted as %q", test.name, got)
		}
		if !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("%s error = %v, want ErrInvalidInput mentioning %q", test.name, err, test.want)
		}
	}
}

// legacy_unattributed exists only as migration 1968's backfill. A new row may
// never claim it: at write time the writer either measured the value or did not,
// and "unknowable origin" is never true of something being written now.
func TestNormalizeObservationRefusesToWriteTheLegacyProvenance(t *testing.T) {
	t.Parallel()
	value := uint32(13335)
	in := validObservation()
	in.NetworkASN = &value
	in.NetworkASNSource = NetworkASNLegacyUnattributed
	if _, err := normalizeObservation(in, in.IngestedAt); err == nil ||
		!strings.Contains(err.Error(), "read-only") {
		t.Fatalf("legacy provenance accepted on the write path: %v", err)
	}

	// Guard the guard: the same observation with a writable provenance IS
	// accepted, so the rejection above is about the value and not the fixture.
	in.NetworkASNSource = NetworkASNEdgeMeasured
	normalized, err := normalizeObservation(in, in.IngestedAt)
	if err != nil {
		t.Fatalf("measured provenance rejected: %v", err)
	}
	if normalized.NetworkASN == nil || *normalized.NetworkASN != value ||
		normalized.NetworkASNSource != NetworkASNEdgeMeasured {
		t.Fatalf("normalized ASN = %v/%q", normalized.NetworkASN, normalized.NetworkASNSource)
	}
}

func TestNormalizeObservationDefaultsAnAbsentASNToUnmeasuredRatherThanZero(t *testing.T) {
	t.Parallel()
	normalized, err := normalizeObservation(validObservation(), validObservation().IngestedAt)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.NetworkASN != nil {
		t.Fatalf("an observation with no ASN acquired one: %d", *normalized.NetworkASN)
	}
	if normalized.NetworkASNSource != NetworkASNUnmeasured {
		t.Fatalf("provenance = %q, want unmeasured", normalized.NetworkASNSource)
	}
}

// The vocabulary is exhaustive by construction, and the fingerprint omission
// documented in network_asn.go depends on it. A fifth value must break this
// test so whoever adds it revisits observationFingerprint.
func TestNetworkASNSourceVocabularyIsExhaustive(t *testing.T) {
	t.Parallel()
	want := map[NetworkASNSource]bool{
		NetworkASNEdgeMeasured:       true,
		NetworkASNEdgeUnconfigured:   true,
		NetworkASNUnmeasured:         true,
		NetworkASNLegacyUnattributed: true,
	}
	if !reflect.DeepEqual(networkASNSourceVocabulary, want) {
		t.Fatalf("vocabulary = %v, want %v — a new value must also revisit "+
			"observationFingerprint and migration 1968's CHECK", networkASNSourceVocabulary, want)
	}
	// Exactly the value-bearing ones imply a non-NULL ASN. Migration 1968's
	// pairing CHECK encodes the same split; a disagreement here surfaces as a
	// constraint violation at INSERT time instead of a Go error.
	for source := range want {
		carries := networkASNSourceCarriesValue(source)
		expect := source == NetworkASNEdgeMeasured || source == NetworkASNLegacyUnattributed
		if carries != expect {
			t.Fatalf("%q carries-value = %v, want %v", source, carries, expect)
		}
	}
}

// observationFingerprint deliberately does not hash the provenance. That is only
// sound while the EVIDENCE — the ASN itself — is hashed, so this pins both
// halves: provenance-only variation is a replay, ASN variation is not.
func TestObservationFingerprintCoversTheASNButNotItsProvenance(t *testing.T) {
	t.Parallel()
	base := validObservation()
	base.NetworkASNSource = NetworkASNUnmeasured
	unmeasured, err := observationFingerprint(base)
	if err != nil {
		t.Fatal(err)
	}
	base.NetworkASNSource = NetworkASNEdgeUnconfigured
	unconfigured, err := observationFingerprint(base)
	if err != nil {
		t.Fatal(err)
	}
	if unmeasured != unconfigured {
		t.Fatal("a trust-posture change re-fingerprints every in-flight provider retry " +
			"and invalidates every row written before migration 1968")
	}

	first := uint32(13335)
	second := uint32(15169)
	measured := validObservation()
	measured.NetworkASN = &first
	measured.NetworkASNSource = NetworkASNEdgeMeasured
	withASN, err := observationFingerprint(measured)
	if err != nil {
		t.Fatal(err)
	}
	measured.NetworkASN = &second
	changedASN, err := observationFingerprint(measured)
	if err != nil {
		t.Fatal(err)
	}
	if withASN == unmeasured || withASN == changedASN {
		t.Fatalf("the ASN itself is not fingerprinted: absent=%s first=%s second=%s",
			unmeasured[:12], withASN[:12], changedASN[:12])
	}
}
