// SPDX-License-Identifier: AGPL-3.0-only

package inboxrealitycontract

import "fmt"

// ProductionSeedlistMinimum is the controlled-mailbox capacity required before
// Inbox Reality can be certified for production. It is an internal release
// gate, not a number the public site is allowed to present as live capacity.
//
// The checked-in development registry intentionally contains only a small
// credential-free fixture. A deployment must prove this many ACTIVE mailboxes
// through the signed live catalog; public copy must remain count-neutral and
// describe the deployment's configured active roster.
const ProductionSeedlistMinimum = 30

// VerifyProductionSeedlistCapacity reports whether a deployment meets the
// controlled-mailbox production release gate.
//
// SeedlistResponse.Seeds contains only ACTIVE mailboxes — a flagged or banned
// seed cannot produce a placement observation — so this counts capacity that
// can actually execute rather than rows that exist.
//
// The comparison is >=, not ==. Running more seeds than advertised is fine and
// is the normal state during provisioning; running fewer means the site is
// telling prospects something untrue, which is the direction that matters.
func VerifyProductionSeedlistCapacity(response SeedlistResponse) error {
	if active := len(response.Seeds); active < ProductionSeedlistMinimum {
		return fmt.Errorf(
			"inbox reality seedlist has %d active mailboxes; production requires at least %d",
			active, ProductionSeedlistMinimum)
	}
	return nil
}
