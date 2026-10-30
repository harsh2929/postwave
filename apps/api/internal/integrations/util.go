// SPDX-License-Identifier: AGPL-3.0-only
package integrations

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
