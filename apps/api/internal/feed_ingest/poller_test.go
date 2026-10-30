// SPDX-License-Identifier: AGPL-3.0-only
package feed_ingest

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeStore is an in-memory store implementation for Poller tests.
type fakeStore struct {
	source *FeedSource

	begunRuns    int
	finished     []finishedRun
	polledGUIDs  []string
	markPolledN  int
	getSourceErr error
	finishErr    error
}

type finishedRun struct {
	status     string
	itemsSeen  int
	newItems   int
	campaignID string
	errMsg     string
}

func (f *fakeStore) GetSource(_ context.Context, _, _ string) (*FeedSource, error) {
	if f.getSourceErr != nil {
		return nil, f.getSourceErr
	}
	cp := *f.source
	return &cp, nil
}

func (f *fakeStore) beginRun(_ context.Context, _, _ string) (string, error) {
	f.begunRuns++
	return "run-1", nil
}

func (f *fakeStore) finishRun(_ context.Context, _, _, status string, itemsSeen, newItems int, campaignID, errMsg string) error {
	f.finished = append(f.finished, finishedRun{status, itemsSeen, newItems, campaignID, errMsg})
	return nil
}

func (f *fakeStore) markPolled(_ context.Context, _, _, newestGUID string) error {
	f.markPolledN++
	f.polledGUIDs = append(f.polledGUIDs, newestGUID)
	return nil
}

// finishRunAndMarkPolled records both effects, mirroring the production
// single-tx method (Finding 4). It feeds the same counters the existing
// assertions read (finished / markPolledN / polledGUIDs) so the happy-path
// tests keep working after the merge of finishRun + markPolled.
func (f *fakeStore) finishRunAndMarkPolled(_ context.Context, _, _, _, status string, itemsSeen, newItems int, campaignID, errMsg, newestGUID string) error {
	if f.finishErr != nil {
		return f.finishErr
	}
	f.finished = append(f.finished, finishedRun{status, itemsSeen, newItems, campaignID, errMsg})
	f.markPolledN++
	f.polledGUIDs = append(f.polledGUIDs, newestGUID)
	return nil
}

// fakeCreator records the drafts it was asked to create.
type fakeCreator struct {
	drafts []DraftCampaign
	err    error
}

func (f *fakeCreator) CreateDraft(_ context.Context, _ string, d DraftCampaign) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.drafts = append(f.drafts, d)
	return "campaign-123", nil
}

func strPtr(s string) *string { return &s }

func testSource() *FeedSource {
	return &FeedSource{
		ID:              "9f8b1c2d-0000-0000-0000-000000000001",
		Name:            "Blog",
		URL:             "https://blog.example.com/rss.xml",
		Schedule:        ScheduleDaily,
		SubjectTemplate: "{{title}}",
		ListID:          strPtr("42"),
		SegmentID:       nil,
		Enabled:         true,
	}
}

func TestPollCreatesDraftFromNewItems(t *testing.T) {
	store := &fakeStore{source: testSource()}
	creator := &fakeCreator{}
	p := &Poller{
		Store:     store,
		Campaigns: creator,
		Fetch: func(_ context.Context, _ string) ([]byte, error) {
			return []byte(rssFixture), nil
		},
	}

	res, err := p.Poll(context.Background(), "tenant-1", store.source.ID)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if res.Status != RunStatusSucceeded {
		t.Fatalf("status = %q (err %q)", res.Status, res.Error)
	}
	if res.ItemsSeen != 3 || res.NewItems != 3 {
		t.Errorf("items_seen=%d new_items=%d, want 3/3", res.ItemsSeen, res.NewItems)
	}
	if res.CampaignID != "campaign-123" {
		t.Errorf("campaign_id = %q", res.CampaignID)
	}
	if len(creator.drafts) != 1 {
		t.Fatalf("drafts created = %d, want 1", len(creator.drafts))
	}
	d := creator.drafts[0]
	if d.Subject != "Third post & thoughts" {
		t.Errorf("subject = %q (subject_template {{title}} → newest item title)", d.Subject)
	}
	if d.ListID != "42" || d.SegmentID != "" {
		t.Errorf("targeting list=%q segment=%q, want 42/empty", d.ListID, d.SegmentID)
	}
	if !strings.Contains(d.BodyHTML, "Second post") || !strings.Contains(d.BodyHTML, "https://blog.example.com/two") {
		t.Errorf("digest body missing items: %s", d.BodyHTML)
	}
	// Cursor advanced to the newest item's guid.
	if store.markPolledN != 1 || store.polledGUIDs[0] != "guid-3" {
		t.Errorf("markPolled guids = %v, want [guid-3]", store.polledGUIDs)
	}
	if len(store.finished) != 1 || store.finished[0].status != RunStatusSucceeded || store.finished[0].campaignID != "campaign-123" {
		t.Errorf("finished = %+v", store.finished)
	}
}

func TestPollDedupesAgainstLastItemGUID(t *testing.T) {
	src := testSource()
	src.LastItemGUID = "guid-2" // only guid-3 is newer
	store := &fakeStore{source: src}
	creator := &fakeCreator{}
	p := &Poller{
		Store:     store,
		Campaigns: creator,
		Fetch: func(_ context.Context, _ string) ([]byte, error) {
			return []byte(rssFixture), nil
		},
	}

	res, err := p.Poll(context.Background(), "tenant-1", src.ID)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if res.NewItems != 1 {
		t.Fatalf("new_items = %d, want 1", res.NewItems)
	}
	d := creator.drafts[0]
	if strings.Contains(d.BodyHTML, "Second post") || strings.Contains(d.BodyHTML, "First post") {
		t.Errorf("digest includes already-seen items: %s", d.BodyHTML)
	}
	if !strings.Contains(d.BodyHTML, "Third post") {
		t.Errorf("digest missing the new item: %s", d.BodyHTML)
	}
	if store.polledGUIDs[0] != "guid-3" {
		t.Errorf("cursor = %q, want guid-3", store.polledGUIDs[0])
	}
}

func TestPollNoNewItemsSkipsDraft(t *testing.T) {
	src := testSource()
	src.LastItemGUID = "guid-3" // newest already seen
	store := &fakeStore{source: src}
	creator := &fakeCreator{}
	p := &Poller{
		Store:     store,
		Campaigns: creator,
		Fetch: func(_ context.Context, _ string) ([]byte, error) {
			return []byte(rssFixture), nil
		},
	}

	res, err := p.Poll(context.Background(), "tenant-1", src.ID)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if res.Status != RunStatusSucceeded || res.NewItems != 0 || res.CampaignID != "" {
		t.Errorf("res = %+v, want succeeded/0 new/no campaign", res)
	}
	if len(creator.drafts) != 0 {
		t.Errorf("draft created with no new items")
	}
	// last_polled_at stamped, cursor untouched (empty guid arg).
	if store.markPolledN != 1 || store.polledGUIDs[0] != "" {
		t.Errorf("markPolled guids = %v, want [\"\"]", store.polledGUIDs)
	}
}

func TestPollFetchFailureRecordsFailedRun(t *testing.T) {
	store := &fakeStore{source: testSource()}
	creator := &fakeCreator{}
	p := &Poller{
		Store:     store,
		Campaigns: creator,
		Fetch: func(_ context.Context, _ string) ([]byte, error) {
			return nil, errors.New("connection refused")
		},
	}

	res, err := p.Poll(context.Background(), "tenant-1", store.source.ID)
	if err != nil {
		t.Fatalf("Poll should not error on fetch failure (recorded on run): %v", err)
	}
	if res.Status != RunStatusFailed || !strings.Contains(res.Error, "connection refused") {
		t.Errorf("res = %+v", res)
	}
	if len(creator.drafts) != 0 {
		t.Errorf("draft created on failed fetch")
	}
	if store.markPolledN != 0 {
		t.Errorf("cursor advanced on failed fetch")
	}
	if len(store.finished) != 1 || store.finished[0].status != RunStatusFailed {
		t.Errorf("finished = %+v", store.finished)
	}
}

func TestPollParseFailureRecordsFailedRun(t *testing.T) {
	store := &fakeStore{source: testSource()}
	p := &Poller{
		Store:     store,
		Campaigns: &fakeCreator{},
		Fetch: func(_ context.Context, _ string) ([]byte, error) {
			return []byte("<html>not a feed</html>"), nil
		},
	}
	res, err := p.Poll(context.Background(), "tenant-1", store.source.ID)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if res.Status != RunStatusFailed || !strings.Contains(res.Error, "parse") {
		t.Errorf("res = %+v", res)
	}
}

func TestPollDraftFailureRecordsFailedRun(t *testing.T) {
	store := &fakeStore{source: testSource()}
	p := &Poller{
		Store:     store,
		Campaigns: &fakeCreator{err: errors.New("segment not found for tenant")},
		Fetch: func(_ context.Context, _ string) ([]byte, error) {
			return []byte(rssFixture), nil
		},
	}
	res, err := p.Poll(context.Background(), "tenant-1", store.source.ID)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if res.Status != RunStatusFailed || !strings.Contains(res.Error, "draft") {
		t.Errorf("res = %+v", res)
	}
	// Cursor must NOT advance when the draft failed — the items are
	// still un-drafted and the next poll must retry them.
	if store.markPolledN != 0 {
		t.Errorf("cursor advanced despite draft failure")
	}
}

// TestPollReachesTerminalStatusOnHappyPath is the Finding 4 regression:
// after merging markPolled + finishRun into one transaction, the
// happy-path poll must still drive the run to a TERMINAL status
// (succeeded), with exactly one cursor-advance + run-finish pair. A
// poll that drafted but never finished its run would leave the run row
// stuck 'running' forever (no sweeper), which is exactly the bug the
// single-tx merge closes.
func TestPollReachesTerminalStatusOnHappyPath(t *testing.T) {
	store := &fakeStore{source: testSource()}
	creator := &fakeCreator{}
	p := &Poller{
		Store:     store,
		Campaigns: creator,
		Fetch: func(_ context.Context, _ string) ([]byte, error) {
			return []byte(rssFixture), nil
		},
	}

	res, err := p.Poll(context.Background(), "tenant-1", store.source.ID)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	// Run must reach a terminal status — never left 'running'.
	if res.Status != RunStatusSucceeded {
		t.Fatalf("run status = %q, want terminal %q (a non-terminal status means the run is stuck)", res.Status, RunStatusSucceeded)
	}
	if len(store.finished) != 1 {
		t.Fatalf("finished runs = %d, want exactly 1 (run never finished → stuck 'running')", len(store.finished))
	}
	if store.finished[0].status != RunStatusSucceeded {
		t.Errorf("recorded run status = %q, want %q", store.finished[0].status, RunStatusSucceeded)
	}
	// Cursor advance + run finish happen together (single tx): exactly
	// one cursor write, to the newest item's guid.
	if store.markPolledN != 1 || len(store.polledGUIDs) != 1 || store.polledGUIDs[0] != "guid-3" {
		t.Errorf("cursor writes = %v (markPolledN=%d), want exactly [guid-3]", store.polledGUIDs, store.markPolledN)
	}
}

// TestPollNoNewItemsReachesTerminalStatus pins the same atomic
// finish-and-stamp guarantee on the nothing-new branch: the run still
// reaches 'succeeded' (cursor untouched) in one transaction.
func TestPollNoNewItemsReachesTerminalStatus(t *testing.T) {
	src := testSource()
	src.LastItemGUID = "guid-3" // newest already seen → no new items
	store := &fakeStore{source: src}
	p := &Poller{
		Store:     store,
		Campaigns: &fakeCreator{},
		Fetch: func(_ context.Context, _ string) ([]byte, error) {
			return []byte(rssFixture), nil
		},
	}
	res, err := p.Poll(context.Background(), "tenant-1", src.ID)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if res.Status != RunStatusSucceeded {
		t.Fatalf("run status = %q, want terminal %q", res.Status, RunStatusSucceeded)
	}
	if len(store.finished) != 1 || store.finished[0].status != RunStatusSucceeded {
		t.Fatalf("finished = %+v, want one succeeded run", store.finished)
	}
	// Cursor stamped (markPolled effect) but not advanced (empty guid).
	if store.markPolledN != 1 || store.polledGUIDs[0] != "" {
		t.Errorf("cursor = %v, want one stamp with empty guid", store.polledGUIDs)
	}
}

func TestPollCapsDigestSize(t *testing.T) {
	var sb strings.Builder
	sb.WriteString(`<?xml version="1.0"?><rss version="2.0"><channel><title>Big</title>`)
	for i := 0; i < 50; i++ {
		sb.WriteString(`<item><guid>g-` + string(rune('0'+i%10)) + strings.Repeat("x", i) + `</guid><title>t</title></item>`)
	}
	sb.WriteString(`</channel></rss>`)

	store := &fakeStore{source: testSource()}
	creator := &fakeCreator{}
	p := &Poller{
		Store:     store,
		Campaigns: creator,
		Fetch: func(_ context.Context, _ string) ([]byte, error) {
			return []byte(sb.String()), nil
		},
	}
	res, err := p.Poll(context.Background(), "tenant-1", store.source.ID)
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if res.ItemsSeen != 50 {
		t.Errorf("items_seen = %d, want 50", res.ItemsSeen)
	}
	if res.NewItems != maxDigestItems {
		t.Errorf("new_items = %d, want capped at %d", res.NewItems, maxDigestItems)
	}
}
