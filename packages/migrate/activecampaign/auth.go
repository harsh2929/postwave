// SPDX-License-Identifier: MIT

package activecampaign

import "net/url"

// BuildAPIKeyEntryURL returns the custom migration credential-entry URI
// consumed by desktop and web connection screens.
func BuildAPIKeyEntryURL(state string) string {
	v := url.Values{}
	v.Set("source", "activecampaign")
	v.Set("state", state)
	return "moosewave://migrations/api-key?" + v.Encode()
}
