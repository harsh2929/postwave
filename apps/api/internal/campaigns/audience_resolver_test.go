package campaigns

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestResolveCampaignAudienceRejectsMixedSourcesBeforeLookup(t *testing.T) {
	repo := &Repo{}
	_, err := repo.ResolveCampaignAudience(context.Background(), "tenant-1", &Campaign{
		ListID:    "42",
		SegmentID: "00000000-0000-0000-0000-000000000001",
	})
	if !errors.Is(err, ErrAudienceMixedSources) {
		t.Fatalf("ResolveCampaignAudience mixed sources: want %v, got %v", ErrAudienceMixedSources, err)
	}
}

func TestQueueAudienceErrorMapsReferenceFailuresWithoutLeakingTenants(t *testing.T) {
	// The editor renders these messages verbatim (the audience status line,
	// save and send toasts), so each is the sentence a person reads, and none
	// names a table, a tenant, or an id.
	cases := []struct {
		name    string
		err     error
		code    string
		message string
	}{
		{name: "mixed", err: ErrAudienceMixedSources, code: "ambiguous_audience",
			message: "Choose either one list or one segment — a campaign can't send to both."},
		{name: "list missing or foreign", err: ErrAudienceListNotFound, code: "list_not_found",
			message: "The selected list isn't available as an audience in this workspace. Choose another list or segment."},
		{name: "segment missing or foreign", err: ErrSegmentNotFound, code: "segment_not_found",
			message: "The selected segment no longer exists. Choose another list or segment."},
		{name: "freeze missing or foreign", err: ErrFrozenAudienceNotFound, code: "frozen_audience_not_found",
			message: "This campaign's frozen audience snapshot is missing, so it can't be sent. Duplicate the campaign to choose its audience again."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := queueAudienceError(tc.err)
			if got.Status != http.StatusUnprocessableEntity || got.Code != tc.code || got.Err != nil {
				t.Fatalf("queueAudienceError(%v) = %+v", tc.err, got)
			}
			if got.Message != tc.message {
				t.Fatalf("queueAudienceError(%v).Message = %q, want %q", tc.err, got.Message, tc.message)
			}
		})
	}
}

func TestCountCampaignAudienceRejectsMixedSourcesBeforeCounter(t *testing.T) {
	counter := &fakeAudienceCounter{listCount: 7, segCount: 11}
	_, err := countCampaignAudience(context.Background(), counter, &Campaign{
		ListID:    "42",
		SegmentID: "segment-1",
	}, "tenant-1")
	if !errors.Is(err, ErrAudienceMixedSources) {
		t.Fatalf("countCampaignAudience mixed sources: want %v, got %v", ErrAudienceMixedSources, err)
	}
	if counter.listCalls != 0 || counter.segCalls != 0 {
		t.Fatalf("mixed audience consulted counters: list=%d segment=%d", counter.listCalls, counter.segCalls)
	}
}
