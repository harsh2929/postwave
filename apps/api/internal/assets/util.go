// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"encoding/base64"
)

// DecodeBase64 accepts both std and URL alphabets, padded or unpadded. It is
// the single base64 decoder shared by the HTTP upload handler and the native
// upload_asset tool, so both accept exactly the same encodings.
func DecodeBase64(s string) ([]byte, error) {
	if s == "" {
		return nil, errEmpty
	}
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.RawStdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawURLEncoding.DecodeString(s)
}
