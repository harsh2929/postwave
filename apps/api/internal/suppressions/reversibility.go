// reversibility.go — GAP-LS-037. Per-reason policy for whether a
// suppression row can be removed via the admin/bulk delete path.
//
// The policy mirrors the Klaviyo + Postmark contract:
//
//   - Reversible — operator + API can remove freely (manual,
//     list_manual, global_unsubscribe, soft_bounce_threshold). These
//     come from a user action or a transient signal that the operator
//     is allowed to override.
//
//   - NeedsAdmin — hard_bounce and spam_complaint can only be released
//     by an admin who passes force=true on the bulk endpoint. The
//     friction is intentional: removing a hard-bounce row generally
//     means the operator believes the original signal was wrong; we
//     want that to be a deliberate action, not a click-through.
//
//   - Permanent — DSAR-deletion rows never delete. The presence of the
//     row is what stops the address from being re-imported during the
//     erasure-retention window, so even a force=true admin can't drop
//     it (they'd have to call the DSAR rescind endpoint, which is a
//     separate compliance flow that records its own audit reason).
//
// DSAR deletion is a first-class Reason and is permanently protected from
// administrative removal.

package suppressions

// Reversibility classifies how freely a suppression row can be removed
// from the admin/bulk surface.
type Reversibility int

const (
	// ReversibilityReversible — operator can remove without ceremony.
	ReversibilityReversible Reversibility = iota
	// ReversibilityNeedsAdmin — admin must pass force=true.
	ReversibilityNeedsAdmin
	// ReversibilityPermanent — row cannot be removed via this path.
	ReversibilityPermanent
)

// ReversibilityFor maps a Reason to its reversibility class. Unknown reasons
// fail closed as permanent: a newly-added legal or provider taxonomy must make
// an explicit removal-policy decision before older application binaries may
// delete it.
func ReversibilityFor(reason Reason) Reversibility {
	switch reason {
	case ReasonDSARDeletion:
		return ReversibilityPermanent
	case ReasonHardBounce, ReasonSpamComplaint, ReasonComplaint:
		return ReversibilityNeedsAdmin
	case ReasonManualUnsubscribe, ReasonListUnsubHeader, ReasonSpamtrap,
		ReasonRoleAccount, ReasonDNSFail, ReasonInvalidAddress,
		ReasonSoftBounceThreshold, ReasonGlobalUnsubscribe, ReasonListManual,
		ReasonSoftBounce, ReasonRoleAddress, ReasonInvalidEmail, ReasonBlocklistAuto:
		return ReversibilityReversible
	default:
		return ReversibilityPermanent
	}
}
