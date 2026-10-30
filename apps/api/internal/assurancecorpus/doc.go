// SPDX-License-Identifier: AGPL-3.0-only

// Package assurancecorpus loads and validates the bounded, synthetic RFC 5322
// benchmark corpus for Campaign Assurance. Raw corpus messages are untrusted
// test data: the loader never fetches URLs, executes markup, or invents the
// compiler receipts required by campaignchecks.Analyze.
package assurancecorpus
