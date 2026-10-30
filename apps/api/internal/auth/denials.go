// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// The auth surface's refusals, in the shared vocabulary.
//
// Four sites, four different things to do about them, and one affordance
// between them: prose. "Ask an admin", "verify your email", "you already lost
// access" and "that isn't a downgrade" are not the same screen — and two of
// them are not problems the caller can solve by asking anybody.
//
// The CODES are unchanged; they are an existing client contract.

// writeViewerModeRoleDenial refuses a caller whose role cannot preview viewer
// mode.
//
// The one refusal here that IS a person to go and ask, so it names the role.
func writeViewerModeRoleDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject:      "viewer_mode",
		Reason:       entitlement.ReasonRole,
		Code:         "viewer_mode_forbidden",
		Message:      "only admins and owners can preview viewer mode",
		RequiredRole: "admin",
	})
}

// writeViewerModeNotDowngradeDenial refuses previewing a role at or above the
// caller's own.
//
// ReasonPolicy: an owner asking to preview as an owner is asking for something
// the feature does not mean. No role change makes it valid, so presenting it as
// a permission problem would send them looking for a permission that does not
// exist.
func writeViewerModeNotDowngradeDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "viewer_mode",
		Reason:  entitlement.ReasonPolicy,
		Code:    "viewer_mode_not_downgrade",
		Message: "preview role must be lower-privilege than your own role",
	})
}

// writeEmailNotVerifiedDenial refuses a workspace switch before verification.
//
// ReasonPolicy, and the one refusal on this surface the caller resolves
// themselves. Calling it a role problem would send them to an admin who cannot
// verify their email for them.
func writeEmailNotVerifiedDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "workspace_switch",
		Reason:  entitlement.ReasonPolicy,
		Code:    "email_not_verified",
		Message: "verify your email address before switching workspaces",
	})
}

// writeWorkspaceAccessRevokedDenial refuses a switch into a workspace the
// caller no longer belongs to.
//
// The original site sent an EMPTY message, which renders as a blank refusal —
// the user sees a dialog with nothing in it and has to guess. Conversion is the
// moment to give it one. No remedy: nobody the caller can reach restores
// access, and offering an action that cannot work is worse than offering none.
func writeWorkspaceAccessRevokedDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "workspace_switch",
		Reason:  entitlement.ReasonPolicy,
		Code:    "workspace_access_revoked",
		Message: "your access to that workspace has been removed",
	})
}

// writeMFAChallengeDenial refuses a sensitive action until the caller completes
// a TOTP challenge.
//
// ReasonPolicy: a step to take, not a role to acquire. The message is a
// parameter because the two sites guard different actions ("before rotating the
// existing factor" / "before disabling MFA") and the wording is the whole
// instruction.
func writeMFAChallengeDenial(w http.ResponseWriter, message string) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "mfa",
		Reason:  entitlement.ReasonPolicy,
		Code:    "mfa_required",
		Message: message,
	})
}

// writeMFAPolicyDenial refuses disabling MFA when the workspace requires it.
//
// Nearly the same words as the challenge denial above and a different
// situation: there is no challenge to complete, because the policy demands an
// enrolled factor at all times. The distinct code is what lets a client tell
// "do this now" from "your workspace does not allow this".
func writeMFAPolicyDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "mfa",
		Reason:  entitlement.ReasonPolicy,
		Code:    "mfa_policy_required",
		Message: "tenant policy requires an enrolled two-factor method",
	})
}

// writeProviderUnverifiedEmailDenial refuses a sign-in whose identity provider
// asserted no verified email.
//
// ReasonPolicy with no remedy: nothing in Moosewave grants this. No role, no
// plan, no admin — the user has to verify the address with their provider. A
// remedy pointing anywhere in this product would be a dead end.
func writeProviderUnverifiedEmailDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "oauth_identity",
		Reason:  entitlement.ReasonPolicy,
		Code:    "unverified_email",
		Message: "the identity provider did not assert a verified email address",
	})
}

// writeProviderEmailMismatchDenial refuses linking a provider identity whose
// verified email is not the signed-in account's.
func writeProviderEmailMismatchDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "oauth_identity",
		Reason:  entitlement.ReasonPolicy,
		Code:    "link_email_mismatch",
		Message: "the provider's verified email must match the signed-in account",
	})
}

// writeCLIMFARequiredDenial refuses a write-capable CLI credential before MFA.
//
// Its own helper rather than reusing writeMFAChallengeDenial: the CLI's message
// names what the credential is FOR, and a caller reading it is at a terminal
// rather than in a UI that can pop a challenge. Same code, because it is the
// same fact and clients switch on the code.
func writeCLIMFARequiredDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "cli_credential",
		Reason:  entitlement.ReasonPolicy,
		Code:    "mfa_required",
		Message: "complete MFA before granting a write-capable CLI credential",
	})
}

// writeCLIInsufficientRoleDenial refuses a caller whose role cannot authorize a
// CLI credential.
//
// A genuine role refusal, and the one on this path where "ask someone" is real
// advice — so it carries the role rather than leaving a terminal user to guess
// which of their colleagues to find.
func writeCLIInsufficientRoleDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject:      "cli_credential",
		Reason:       entitlement.ReasonRole,
		Code:         "insufficient_role",
		Message:      "your role cannot authorize a CLI credential",
		RequiredRole: "admin",
	})
}

// writeDeviceApprovalMFADenial refuses approving a device request before MFA.
//
// Its own helper rather than reusing the credential one: approving a DEVICE is
// the higher-stakes action of the two — it grants a new machine standing access
// — and the message says so.
func writeDeviceApprovalMFADenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "device_approval",
		Reason:  entitlement.ReasonPolicy,
		Code:    "mfa_required",
		Message: "complete MFA before approving this device request",
	})
}

// writeDeviceTrustDisabledDenial refuses remembering a device when the
// workspace has the feature off.
//
// ReasonFlag: workspace configuration. An admin CAN turn it on, so unlike most
// flag denials this one has a real remedy.
func writeDeviceTrustDisabledDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "device_trust",
		Reason:  entitlement.ReasonFlag,
		Code:    "device_trust_disabled",
		Message: "this workspace does not allow remembering devices",
		Remedy:  entitlement.RemedyContactWorkspaceAdmin,
	})
}
