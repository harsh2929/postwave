// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"fmt"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// network_asn was accepted end to end and was always NULL.
//
// Every layer carried the field — ProviderEventInput, ObservationInput, the
// fingerprint, the INSERT, the reclassification read-back, the retention
// degradation exemption that deliberately RETAINS ASN so a degraded row is
// still re-derivable — and no writer ever set it. The registry rule that
// matches on ASN (classifier.go's R_MACHINE_SOURCE ASN arm) could therefore
// never fire in production. Scaffolding without wiring, in the exact shape this
// codebase keeps producing.
//
// The gap was never geoip. The value is available at the edge for free
// (Cloudflare exposes ip.src.asnum to transform rules) and needs only a
// trustworthy way to carry it inward. What was missing was the trust boundary
// and — more important — a way for a READER to tell a measured ASN from an
// absent one after the fact.
//
// THAT SECOND HALF IS WHY THIS FILE EXISTS RATHER THAN A ONE-LINE HEADER READ.
// A NULL ASN is ambiguous in three different ways that call for three different
// operator responses: the deployment has no authenticated edge (fix the
// configuration), the edge is configured but this request produced nothing (fix
// the transform rule, or accept it), or the value simply is not knowable for
// this request. Persisting only NULL collapses all three, and the first one is
// a silent total outage of the ASN signal that looks identical to "no bots this
// week". So the provenance is stored beside the value and constrained in the
// database, and the vocabulary below is exhaustive by test.
//
// WHAT THIS FILE WILL NEVER DO is synthesise a value. internal/audit/ueba's
// impossible-travel detector hashes an unknown /16 into a pseudo-coordinate
// instead of taking a MaxMind dependency, and that is correct THERE: a wrong
// coordinate degrades to a missed flag. Here the same move produces a confident
// wrong classification, because a fabricated ASN that collides with a registry
// entry marks a real person's open as machine traffic — and the resulting
// number is indistinguishable from a measured one. For this field NULL is
// strictly better than a plausible guess.

// NetworkASNSource records HOW the ASN on an observation was learned.
type NetworkASNSource string

const (
	// NetworkASNEdgeMeasured — an authenticated edge inside the configured
	// trusted-proxy set reported the client's ASN for this request. This is the
	// only value that may accompany a non-NULL ASN.
	NetworkASNEdgeMeasured NetworkASNSource = "edge_measured"

	// NetworkASNEdgeUnconfigured — this deployment has no authenticated edge
	// boundary, so no ASN header could be honoured for ANY request. Recorded
	// distinctly because it is a deployment fact, not a property of the client:
	// it tells an operator staring at an empty machine-source breakdown that
	// the signal is switched off rather than quiet.
	NetworkASNEdgeUnconfigured NetworkASNSource = "edge_unconfigured"

	// NetworkASNUnmeasured — an edge boundary exists, and this request produced
	// no usable ASN: no header, an untrusted peer, duplicate headers, or a value
	// outside the valid range. The observation is written with a NULL ASN.
	NetworkASNUnmeasured NetworkASNSource = "unmeasured"

	// NetworkASNLegacyUnattributed — READ ONLY. Migration 1968's backfill for a
	// row that already carried an ASN before provenance was recorded. Nobody can
	// now say how those values were learned, and inventing "edge_measured" for
	// them would be precisely the fabricated provenance this design exists to
	// prevent — so they get a value that says "unknown origin" out loud.
	// normalizeObservation refuses it on the write path: no new row may claim it.
	NetworkASNLegacyUnattributed NetworkASNSource = "legacy_unattributed"
)

// networkASNSourceVocabulary is the complete set of values the column accepts,
// on read as well as on write. Exhaustive on purpose, and there is a test that
// says so — because observationFingerprint deliberately does NOT hash this
// field.
//
// The fingerprint omission is sound for two reasons that a fourth measured
// source would break, which is why the vocabulary test exists to force the
// visit:
//
//   - Every value that implies a NON-NULL ASN also puts that ASN in the
//     fingerprint, so no provenance change can smuggle a different measurement
//     past an idempotency check.
//   - The two NULL-ASN values (unmeasured / edge_unconfigured) differ only by
//     the deployment's trust posture, which no caller controls. Hashing them
//     would turn an operator flipping POSTWAVE_TRUST_FORWARDED_IP_HEADERS into
//     an ErrIdempotencyConflict on every in-flight provider retry, and would
//     additionally invalidate the stored fingerprint of every row written
//     before this column existed.
var networkASNSourceVocabulary = map[NetworkASNSource]bool{
	NetworkASNEdgeMeasured:       true,
	NetworkASNEdgeUnconfigured:   true,
	NetworkASNUnmeasured:         true,
	NetworkASNLegacyUnattributed: true,
}

// networkASNSourceCarriesValue reports whether a provenance implies a non-NULL
// ASN. It is the Go half of migration 1968's pairing CHECK; the two must agree
// or a write that passes here fails as a constraint violation three layers down.
func networkASNSourceCarriesValue(source NetworkASNSource) bool {
	return source == NetworkASNEdgeMeasured || source == NetworkASNLegacyUnattributed
}

// writableNetworkASNSource reports whether a WRITER may state this provenance.
func writableNetworkASNSource(source NetworkASNSource) bool {
	return source != NetworkASNLegacyUnattributed
}

// ObservedNetworkASN reads the client's ASN for an HTTP-boundary ingest path.
//
// It is the ONLY sanctioned way to populate ObservationInput.NetworkASN from a
// request. The trust decision is delegated wholesale to middleware — the
// package that owns SetTrustedProxyCIDRs and therefore owns what "trusted peer"
// means — so this can never drift from ResolveClientIP's boundary.
//
// trustHeaders is the deployment's POSTWAVE_TRUST_FORWARDED_IP_HEADERS posture,
// exactly as it is passed to ResolveClientIP at the same call sites.
//
// Note which requests this is CORRECT for. It measures the peer that made THIS
// request, so it is meaningful only where that peer is the engaging client —
// a tracking pixel fetch, a click redirect, a first-party browser beacon. On an
// ESP webhook the peer is the ESP, and calling this there would record the
// provider's ASN as if it were the recipient's. Those call sites must keep
// passing an absent ASN.
func ObservedNetworkASN(r *http.Request, trustHeaders bool) (*uint32, NetworkASNSource) {
	if !trustHeaders || !middleware.TrustedProxyCIDRsConfigured() {
		return nil, NetworkASNEdgeUnconfigured
	}
	if asn, measured := middleware.ResolveClientASN(r, trustHeaders); measured {
		value := asn
		return &value, NetworkASNEdgeMeasured
	}
	return nil, NetworkASNUnmeasured
}

// normalizeNetworkASNSource resolves the provenance actually persisted.
//
// An unset source is normalised to "unmeasured" only when there is no ASN — a
// writer that supplies a value must also state how it learned it, because
// deriving "edge_measured" from the mere presence of a number would be this
// file inventing a provenance claim on the writer's behalf. That is the same
// fabrication the package header refuses, one level up.
func normalizeNetworkASNSource(in ObservationInput) (NetworkASNSource, error) {
	source := in.NetworkASNSource
	if source == "" {
		if in.NetworkASN != nil {
			return "", fmt.Errorf(
				"%w: network ASN supplied without a provenance; set NetworkASNSource "+
					"(use ObservedNetworkASN) rather than letting the reader assume how it was learned",
				ErrInvalidInput)
		}
		return NetworkASNUnmeasured, nil
	}
	if !networkASNSourceVocabulary[source] {
		return "", fmt.Errorf("%w: unknown network ASN source %q", ErrInvalidInput, source)
	}
	if (in.NetworkASN != nil) != networkASNSourceCarriesValue(source) {
		return "", fmt.Errorf(
			"%w: network ASN presence contradicts its provenance %q", ErrInvalidInput, source)
	}
	if in.NetworkASN != nil && *in.NetworkASN == 0 {
		// AS 0 is reserved and is never an origin. Rejected in Go as well as by
		// the column CHECK so the failure names the field instead of surfacing
		// as a constraint violation three layers down.
		return "", fmt.Errorf("%w: network ASN 0 is reserved and is not a measurement", ErrInvalidInput)
	}
	return source, nil
}
