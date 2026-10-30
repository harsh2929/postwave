// SPDX-License-Identifier: AGPL-3.0-only

// Package pushsuppressions owns the private Route43 customer push-token
// suppression registry. The released push_token_suppressions table remains a
// mixed-version projection; push_suppression_authorities is the authoritative
// union gate. This package never calls APNs, FCM, Web Push, or a provider
// webhook and does not claim provider feedback is configured.
package pushsuppressions
