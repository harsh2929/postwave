package handlers

import (
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// writeOwnerRoleRequiredDenial refuses an action only a workspace owner may
// take.
//
// Two sites wrote this by hand as prose. Both are genuine role refusals with a
// specific answer — go and ask an owner — and rendered generically the best a
// client can say is "ask an administrator", which is wrong here: an admin
// cannot grant the owner role either.
//
// The message is a parameter because the two sites refuse different things
// ("grant the owner role" vs "modify another owner") and the wording is what
// tells them apart.
func writeOwnerRoleRequiredDenial(w http.ResponseWriter, message string) {
	entitlement.Write(w, entitlement.Denial{
		Subject:      "workspace_member",
		Reason:       entitlement.ReasonRole,
		Code:         "owner_role_required",
		Message:      message,
		RequiredRole: "owner",
	})
}

// writeDirectProvisionDisabledDenial refuses direct provisioning in production.
//
// ReasonFlag: an operator switch, not a plan or a role. The route exists for ops
// emergencies and is off by default because bypassing billing must be a
// deliberate decision — so neither an upgrade nor an admin resolves it, and a
// remedy pointing at either would be a dead end.
//
// The env-var instruction stays in the message: the reader of this refusal is
// the ops engineer who needs to know how to override it.
func writeDirectProvisionDisabledDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "sending_provision",
		Reason:  entitlement.ReasonFlag,
		Code:    "direct_provision_disabled",
		Message: "Direct /sending/provision calls are disabled in production. " +
			"Provisioning is triggered by the Stripe billing webhook. Set " +
			"POSTWAVE_ALLOW_DIRECT_PROVISION=1 to override for ops emergencies.",
	})
}

// writeBuiltInRoleDenial refuses deleting a role the product defines.
//
// ReasonPolicy: a fact about the RESOURCE, not the caller. No permission makes
// a built-in role deletable, so classifying it as a role problem produces
// advice — "ask an admin" — that cannot work for anyone.
func writeBuiltInRoleDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "rbac_role",
		Reason:  entitlement.ReasonPolicy,
		Code:    "builtin_role",
		Message: "built-in roles cannot be deleted",
	})
}

// writeAuditPIIScopeDenial refuses decrypting redacted audit metadata without
// the audit:read_pii scope.
//
// Same class as the API-key scope refusals: a credential narrowing only its
// owner can widen. The scope NAME stays in the message because it is the whole
// answer — without it the reader cannot know what to add.
func writeAuditPIIScopeDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "audit_pii",
		Reason:  entitlement.ReasonPolicy,
		Code:    "missing_scope",
		Message: "audit:read_pii scope required to decrypt redacted metadata",
	})
}
