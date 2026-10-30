// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/audit"
)

func TestSegmentsNLQAdapterExposesConcreteAnthropicMetadata(t *testing.T) {
	adapter := segmentsNLQAdapter{c: audit.NewAnthropicNLQClient(
		"test-key",
		"claude-segment-test",
		"https://api.anthropic.com",
	)}

	metadata := adapter.AIProcessingMetadata()
	if metadata.Provider != "anthropic" || metadata.Model != "claude-segment-test" {
		t.Fatalf("metadata = %+v", metadata)
	}
}

func TestSegmentsNLQAdapterDoesNotMislabelCustomGateway(t *testing.T) {
	adapter := segmentsNLQAdapter{c: audit.NewAnthropicNLQClient(
		"test-key",
		"gateway-model",
		"https://ai-gateway.example.test",
	)}

	metadata := adapter.AIProcessingMetadata()
	if metadata.Provider != "" || metadata.Model != "gateway-model" {
		t.Fatalf("custom gateway metadata = %+v", metadata)
	}
}
