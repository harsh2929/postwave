// SPDX-License-Identifier: AGPL-3.0-only

// Package factcontract defines the versioned semantic contract used to decide
// whether a rendered campaign preserved the sender's intended meaning.
//
// A Fact Contract is an expected-output oracle. It is not embedded in the
// outbound message and must never be presented as an observation of how an
// inbox provider understood a message. Callers should freeze the normalized
// contract alongside the exact campaign content revision and send plan that it
// describes.
//
// ContractV1 is deliberately independent of HTTP, persistence, campaigns, and
// model-scoring packages. That keeps validation identical at authoring,
// assurance, and dispatch boundaries without creating an import cycle.
package factcontract
