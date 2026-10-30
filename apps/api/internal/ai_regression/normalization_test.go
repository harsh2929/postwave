// SPDX-License-Identifier: AGPL-3.0-only
package ai_regression

import (
	"strings"
	"testing"
)

func TestNormalizeGoldenOutputCanonicalizesVisibleText(t *testing.T) {
	t.Parallel()

	got := normalizeGoldenOutput(`
		<style>.private { display: none }</style>
		<p>Hello &amp; welcome</p>
		<script>providerSecret()</script>
		<p>World<br>again</p>
	`)

	if got != "Hello & welcome\n\nWorld\nagain" {
		t.Fatalf("normalizeGoldenOutput() = %q", got)
	}
	if strings.Contains(got, "private") || strings.Contains(got, "providerSecret") {
		t.Fatalf("non-content markup leaked into canonical output: %q", got)
	}
}

func TestNormalizeGoldenOutputIsIdempotentForPlainText(t *testing.T) {
	t.Parallel()

	const input = "Hello, team.\n\nA deliberate second paragraph."
	first := normalizeGoldenOutput(input)
	second := normalizeGoldenOutput(first)
	if first != input || second != first {
		t.Fatalf("normalization was not idempotent: first=%q second=%q", first, second)
	}
}
