// SPDX-License-Identifier: AGPL-3.0-only
package ai_regression

import (
	"strings"

	"github.com/postwave/postwave/apps/api/internal/html2text"
)

// normalizeGoldenOutput produces the canonical, reviewable plain-text form
// persisted in the golden set. The shared HTML parser decodes entities,
// preserves useful block/list boundaries, and discards non-content elements
// such as script, style, and head. It is safe for both already-plain text and
// untrusted HTML and never follows links or executes markup.
func normalizeGoldenOutput(input string) string {
	output := strings.TrimSpace(html2text.Convert(input))
	// The email-oriented converter intentionally leaves generous separation
	// around neighboring blocks. A stored regression reference uses one blank
	// line as its canonical paragraph boundary so repeated normalization is
	// byte-stable and presentation does not accumulate vertical whitespace.
	for strings.Contains(output, "\n\n\n") {
		output = strings.ReplaceAll(output, "\n\n\n", "\n\n")
	}
	return output
}
