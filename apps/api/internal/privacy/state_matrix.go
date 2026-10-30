// SPDX-License-Identifier: AGPL-3.0-only
//
// state_matrix.go — jurisdiction selection metadata and a fail-closed
// resolution projection.
//
// Earlier revisions exposed a static obligation matrix as if it could decide
// deadlines, recipients, thresholds, and notice content. Those rules lack the
// facts, effective dates, citations, and durable counsel approval needed for a
// legal determination, and several rows are known to be stale. Keep only
// code/name metadata for operator data capture. Any obligation-shaped output
// remains release-held until a versioned policy service is qualified.

package privacy

import (
	"sort"
	"strings"
	"time"
)

const (
	jurisdictionResolutionStatus = "release_held"
	jurisdictionRulesReleaseHold = "jurisdiction_rules_release_hold"
)

// JurisdictionReference is non-actionable selection metadata. It deliberately
// contains no deadline, threshold, recipient, or notice-content fields.
type JurisdictionReference struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

// jurisdictionCatalog is a selector catalog, not a statement of applicable
// law or a claim that the catalog is complete.
//
// It exists so an operator can RECORD which jurisdiction an incident or a data
// subject belongs to. A code that is absent forces the operator to either
// mis-file the record under a neighbouring state or leave it in
// UnknownJurisdictions — both of which degrade the audit trail that the
// release-held resolution below is meant to protect.
//
// The 2026-09-05 compliance audit (F-08) found nine US states here against
// roughly twenty with comprehensive privacy statutes in force. Every US state
// with such a statute in force as of 2026-09-05 is now listed, with the
// effective date recorded next to it. Three of these took effect after the
// previous compliance review: Indiana, Kentucky, and Rhode Island.
//
// Adding a code CHANGES NOTHING about obligations. ResolveJurisdictions still
// returns release_held for every input; these are labels for a dropdown.
var jurisdictionCatalog = map[string]string{
	// Non-US regimes.
	"GDPR": "European Union / EEA",
	"UK":   "United Kingdom",
	"LGPD": "Brazil",

	// US states with a comprehensive consumer privacy statute in force.
	"CA": "California",    // CCPA/CPRA — 2020-01-01
	"CO": "Colorado",      // CPA — 2023-07-01
	"CT": "Connecticut",   // CTDPA — 2023-07-01
	"DE": "Delaware",      // DPDPA — 2025-01-01
	"IA": "Iowa",          // ICDPA — 2025-01-01
	"IN": "Indiana",       // INCDPA — 2026-01-01
	"KY": "Kentucky",      // KCDPA — 2026-01-01
	"MD": "Maryland",      // MODPA — 2025-10-01
	"MN": "Minnesota",     // MCDPA — 2025-07-31
	"MT": "Montana",       // MTCDPA — 2024-10-01
	"NE": "Nebraska",      // NDPA — 2025-01-01
	"NH": "New Hampshire", // NHPA — 2025-01-01
	"NJ": "New Jersey",    // NJDPA — 2025-01-15
	"OR": "Oregon",        // OCPA — 2024-07-01
	"RI": "Rhode Island",  // RIDTPPA — 2026-01-01
	"TN": "Tennessee",     // TIPA — 2025-07-01
	"TX": "Texas",         // TDPSA — 2024-07-01
	"UT": "Utah",          // UCPA — 2023-12-31
	"VA": "Virginia",      // VCDPA — 2023-01-01

	// US states carried for sector-specific or breach-notification relevance
	// rather than a comprehensive privacy statute. Kept because incidents are
	// filed against them: Illinois for BIPA, Massachusetts for 201 CMR 17.00,
	// New York for the SHIELD Act, Florida and Washington for their breach and
	// health-data regimes (Washington's My Health My Data included).
	"FL": "Florida",
	"IL": "Illinois",
	"MA": "Massachusetts",
	"NY": "New York",
	"WA": "Washington",
}

// JurisdictionResolution is an explicit release-hold response. Recognized
// echoes non-actionable catalog entries; it must not be interpreted as a
// finding that a notification obligation applies.
type JurisdictionResolution struct {
	Status               string                  `json:"status"`
	ReleaseHoldCode      string                  `json:"release_hold_code"`
	Recognized           []JurisdictionReference `json:"recognized"`
	UnknownJurisdictions []string                `json:"unknown_jurisdictions,omitempty"`
}

// ResolveJurisdictions preserves the existing call signature while refusing
// to manufacture obligation conclusions from incomplete incident facts. The
// categories, count, and legacy clock inputs intentionally do not affect the
// release-held response.
func ResolveJurisdictions(jurisdictionCodes []string, _ []string, _ int, _ time.Time) JurisdictionResolution {
	res := JurisdictionResolution{
		Status:          jurisdictionResolutionStatus,
		ReleaseHoldCode: jurisdictionRulesReleaseHold,
		Recognized:      make([]JurisdictionReference, 0),
	}
	seen := make(map[string]struct{}, len(jurisdictionCodes))
	for _, raw := range jurisdictionCodes {
		code := strings.ToUpper(strings.TrimSpace(raw))
		if code == "" {
			continue
		}
		if _, duplicate := seen[code]; duplicate {
			continue
		}
		seen[code] = struct{}{}
		name, known := jurisdictionCatalog[code]
		if !known {
			res.UnknownJurisdictions = append(res.UnknownJurisdictions, code)
			continue
		}
		res.Recognized = append(res.Recognized, JurisdictionReference{Code: code, Name: name})
	}
	sort.Slice(res.Recognized, func(i, j int) bool {
		return res.Recognized[i].Code < res.Recognized[j].Code
	})
	sort.Strings(res.UnknownJurisdictions)
	return res
}

// KnownJurisdictions returns sorted selection metadata. The result is always
// a non-nil array so strict clients do not have to reinterpret JSON null.
func KnownJurisdictions() []JurisdictionReference {
	out := make([]JurisdictionReference, 0, len(jurisdictionCatalog))
	for code, name := range jurisdictionCatalog {
		out = append(out, JurisdictionReference{Code: code, Name: name})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Code < out[j].Code })
	return out
}
