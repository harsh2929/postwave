package reputation

import (
	"context"
	"testing"
)

func TestFetchMarksMissingSourcesUnavailableWithoutFabricatedScores(t *testing.T) {
	agg := NewAggregator()

	rep, err := agg.Fetch(context.Background(), "example.com", "")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}

	if rep.GoogleScore != "" {
		t.Fatalf("GoogleScore = %q, want unavailable", rep.GoogleScore)
	}
	if rep.MicrosoftScore != "" {
		t.Fatalf("MicrosoftScore = %q, want unavailable", rep.MicrosoftScore)
	}
	if rep.SenderScore != 0 || rep.DataAvailable {
		t.Fatalf("SenderScore/DataAvailable = %d/%v, want 0/false", rep.SenderScore, rep.DataAvailable)
	}
	if rep.BlacklistHits == nil {
		t.Fatal("BlacklistHits is nil, want empty slice")
	}
}
