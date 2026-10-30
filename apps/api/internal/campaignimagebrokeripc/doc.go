// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignimagebrokeripc places campaign image acquisition behind an
// authenticated, bounded Unix-domain IPC boundary.
//
// A Client implements campaignimagebroker.Inspector without owning a resolver,
// HTTP client, storage credential, source-fetch primitive, or arbitrary file
// reader. A Server owns the real campaignimagebroker.Inspector and returns only
// its closed report: OCR text, immutable hashes and provenance, and an opaque
// raster-evidence reference. Source URLs cross only from the frozen artifact to
// the broker request; no URL or network primitive exists in the response schema.
//
// Unix-domain IPC authenticates the local peer and constrains the protocol. It
// does not enforce process or network isolation. Production deployment MUST run
// Server in a distinct image-fetch-broker workload with allowlisted HTTPS egress
// and MUST deny egress, credentials, browsers, tools, and shells to the caller
// and model workloads. Co-locating Server with an API or model worker does not
// satisfy that deployment requirement.
package campaignimagebrokeripc
