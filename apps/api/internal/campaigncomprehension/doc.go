// SPDX-License-Identifier: AGPL-3.0-only

// Package campaigncomprehension defines the closed, model-independent wire
// contract and deterministic score used by Predicted Agent Comprehension.
//
// The package parses analyzer output; it does not invoke an analyzer or claim
// to reproduce a recipient inbox's summary. Callers retain the analyzer,
// prompt, model, representation, and controlled-observation provenance in the
// enclosing Campaign Assurance receipt.
package campaigncomprehension
