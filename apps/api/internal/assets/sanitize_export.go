// SPDX-License-Identifier: AGPL-3.0-only
package assets

import "context"

// SanitizedImage is the persistence-safe result of the asset library's full
// image validation pipeline. Body has been completely decoded and stripped of
// unsupported metadata by the same boundary used for ordinary asset uploads.
type SanitizedImage struct {
	MIME   string
	Width  int
	Height int
	Body   []byte
}

// ValidateAndSanitizeUpload exposes the existing upload hardening boundary to
// trusted internal workers that persist images outside the tenant asset table.
// It deliberately delegates to validateAndSanitizeUpload so supported formats,
// byte/dimension limits, metadata removal, and cancellation behaviour cannot
// drift from normal asset uploads.
func ValidateAndSanitizeUpload(ctx context.Context, body []byte) (SanitizedImage, error) {
	validated, err := validateAndSanitizeUpload(ctx, body)
	if err != nil {
		return SanitizedImage{}, err
	}
	return SanitizedImage{
		MIME:   validated.mime,
		Width:  validated.width,
		Height: validated.height,
		Body:   validated.body,
	}, nil
}
