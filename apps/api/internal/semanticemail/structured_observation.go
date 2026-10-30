// SPDX-License-Identifier: AGPL-3.0-only

// structured_observation.go — joining a frozen compiler status to a later
// display observation (F08).
//
// The compiler receipt records what the COMPILER did: whether markup was
// valid, whether the sender was eligible, whether bytes were emitted. Every
// compile-time status says ObservedDisplay "unknown", and campaignchecks
// enforces that — a receipt claiming a display at compile time is an overclaim,
// because nothing has been observed yet.
//
// An observation happens later, in a controlled mailbox. So it is JOINED at
// read time rather than written back: the receipt stays frozen evidence of one
// moment, the observation stays evidence of another, and the assessment is the
// only place they meet.

package semanticemail

import "github.com/postwave/postwave/apps/api/internal/structuredregistry"

// AssessStructuredStatus combines a frozen compiler status with a display
// observation, if one exists.
//
// It takes the status BY VALUE and returns a new assessment; nothing here
// mutates the receipt.
func AssessStructuredStatus(
	status StructuredDataStatus,
	observed structuredregistry.DisplayObservation,
) structuredregistry.Assessment {
	assessment := structuredregistry.Assessment{
		MarkupValid: status.Valid,
	}

	switch status.Eligibility {
	case EligibilityEligible:
		assessment.SenderEligibility = structuredregistry.EligibilityRegistered
	case EligibilityDisabled, EligibilityUnverified:
		assessment.SenderEligibility = structuredregistry.EligibilityIneligible
	default:
		// Zero value: unknown. Not asserted as ineligible, because "we did not
		// establish eligibility" is a different fact from "this sender may not".
		assessment.SenderEligibility = structuredregistry.EligibilityUnknown
	}

	if status.Emitted {
		if surface, ok := structuredregistry.SurfaceForType(
			structuredregistry.ProviderGmail, schemaTypeForKind[status.Kind]); ok {
			assessment.Support = structuredregistry.Lookup(
				structuredregistry.ProviderGmail, surface, schemaTypeForKind[status.Kind])
		}
	}

	// Markup the compiler never emitted cannot have been seen rendering. An
	// observation claiming otherwise is incoherent evidence — a capture
	// attributed to the wrong message, or a mailbox still holding a previous
	// send — and accepting it would let a display claim outlive the markup it
	// describes. The observation is discarded rather than downgraded, because
	// there is nothing here it could truthfully describe.
	if !status.Emitted {
		return assessment
	}
	assessment.Display = observed
	return assessment
}
