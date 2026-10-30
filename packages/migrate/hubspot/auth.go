// SPDX-License-Identifier: MIT

package hubspot

import "net/url"

// BuildPrivateAppTokenEntryURL returns the custom migration URI consumed by
// desktop and web connection screens for HubSpot private-app-token auth.
func BuildPrivateAppTokenEntryURL(state string) string {
	v := url.Values{}
	v.Set("source", "hubspot")
	v.Set("state", state)
	return "moosewave://migrations/api-key?" + v.Encode()
}
