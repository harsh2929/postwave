// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancemodelsandbox

import (
	"context"
	"errors"
)

var ErrNetworkIsolation = errors.New("campaign assurance model sandbox: network isolation unavailable")

const networkIsolationSeal = "postwave.network-isolation.af-deny.v1"

// NetworkIsolationEnforcer applies and verifies a process-wide policy before
// the model-sandbox listener becomes reachable. The returned attestation has
// private fields, so callers outside this package cannot fabricate the value a
// Server accepts.
type NetworkIsolationEnforcer interface {
	Enforce(context.Context) (NetworkIsolationAttestation, error)
}

// NetworkIsolationAttestation is intentionally opaque. Only this package's
// platform enforcer can mint a production-valid value.
type NetworkIsolationAttestation struct {
	seal          string
	processWide   bool
	noNewPrivs    bool
	afINETDenied  bool
	afINET6Denied bool
	afUNIXAllowed bool
	noInternetFDs bool
}

func (attestation NetworkIsolationAttestation) valid() bool {
	return attestation.seal == networkIsolationSeal && attestation.processWide &&
		attestation.noNewPrivs && attestation.afINETDenied &&
		attestation.afINET6Denied && attestation.afUNIXAllowed && attestation.noInternetFDs
}

// NewProcessNetworkIsolationEnforcer returns the production implementation
// for the current platform. Unsupported platforms return ErrNetworkIsolation;
// the sandbox command therefore fails closed rather than advertising a claim
// it cannot enforce.
func NewProcessNetworkIsolationEnforcer() (NetworkIsolationEnforcer, error) {
	return newProcessNetworkIsolationEnforcer()
}
