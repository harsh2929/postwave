// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/abtests"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// A list is a first-class campaign audience: it can be attached, changed and
// cleared after create, it is stored as the tenant-owned engine id whichever
// spelling the caller used, and every surface that describes the audience
// names it rather than printing an id.
//
// These drive the real handlers through the production route mounts
// (MountWrite, MountRead, MountChecklist, MountSendPreview) as an editor
// session, against a database the RLS-bound application role can see.

const everyoneWithAnEmailAST = `{"op":"not","children":[{"op":"condition","field":"email","comparator":"is_null"}]}`

// fakeListNamer stands in for the engine: list names live in Listmonk.
type fakeListNamer struct {
	names map[string]string
	calls int
}

func (f *fakeListNamer) ListName(_ context.Context, _ string, listID string) (string, error) {
	f.calls++
	name, ok := f.names[listID]
	if !ok {
		return "", errors.New("engine: list not found")
	}
	return name, nil
}

type audienceFixture struct {
	pool      *db.Pool
	ctx       context.Context
	tenantID  string
	repo      *Repo
	router    chi.Router
	listUUID  string
	segmentID string
}

const fixtureEngineListID int64 = 16

// newAudienceFixture seeds a tenant with two eligible subscribers, a list
// (engine id 16) holding one of them, and a segment named "Spring VIPs" that matches
// both.
func newAudienceFixture(t *testing.T, namer ListNamer) audienceFixture {
	t.Helper()
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	tenantID := setupTenantQ(t, pool, ctx, "aud-author")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "list-member@example.com", status: "enabled"},
		{email: "not-on-the-list@example.com", status: "enabled"},
	})
	listUUID := insertListIdentityQ(t, pool, ctx, tenantID, fixtureEngineListID)
	addListMemberQ(t, pool, ctx, tenantID, listUUID, fixtureEngineListID, "list-member@example.com")
	segmentID := insertSegmentQ(t, pool, ctx, tenantID, "Spring VIPs", everyoneWithAnEmailAST)

	repo := &Repo{Pool: pool, ListNamer: namer}
	return audienceFixture{
		pool: pool, ctx: ctx, tenantID: tenantID, repo: repo,
		router:   audienceRouter(repo, tenantID),
		listUUID: listUUID, segmentID: segmentID,
	}
}

// audienceRouter mounts the production campaign routes behind an editor's
// dashboard session for the tenant.
func audienceRouter(repo *Repo, tenantID string) chi.Router {
	d := &Deps{Repo: repo, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	r := chi.NewRouter()
	audienceFixture{tenantID: tenantID}.editorSession(r)
	MountRead(r, d)
	MountWrite(r, d)
	MountChecklist(r, d)
	MountSendPreview(r, d, &SendPreviewDeps{Repo: repo})
	return r
}

func (f audienceFixture) do(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequestWithContext(f.ctx, method, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req)
	return rec
}

func (f audienceFixture) create(t *testing.T, body string) Campaign {
	t.Helper()
	rec := f.do(t, http.MethodPost, "/api/v1/campaigns", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var c Campaign
	if err := json.Unmarshal(rec.Body.Bytes(), &c); err != nil {
		t.Fatalf("decode created campaign: %v", err)
	}
	return c
}

func (f audienceFixture) storedAudience(t *testing.T, campaignID string) (listID, segmentID string) {
	t.Helper()
	tx, err := db.WithTenant(f.ctx, f.pool, f.tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	if err := tx.QueryRow(f.ctx, `
SELECT COALESCE(audience_list_id::text, ''), COALESCE(segment_id::text, '')
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, f.tenantID, campaignID).Scan(&listID, &segmentID); err != nil {
		t.Fatalf("read stored audience: %v", err)
	}
	return listID, segmentID
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("response is not the error envelope: %s", rec.Body.String())
	}
	return env.Error.Code
}

func errorMessage(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var env struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("response is not the error envelope: %s", rec.Body.String())
	}
	return env.Error.Message
}

const audienceCampaignBody = `"subject":"Launch","body_html":"<p>Hi <a href=\"{{ unsubscribe_url }}\">unsubscribe</a></p>"`

// Every client holds the engine id, but an API caller may hold the Moosewave
// uuid the members endpoints echo. Both must name the same list, and the row
// must store the engine id: audience_list_id is a bigint, so the uuid used to
// pass validation and then fail the INSERT's cast with a 500.
func TestCreatingACampaignWithTheListUUIDStoresTheEngineID(t *testing.T) {
	f := newAudienceFixture(t, nil)

	c := f.create(t, `{"name":"By uuid",`+audienceCampaignBody+`,"list_id":"`+f.listUUID+`"}`)

	if c.ListID != "16" {
		t.Fatalf("response list_id = %q, want the engine id 16", c.ListID)
	}
	if listID, _ := f.storedAudience(t, c.ID); listID != "16" {
		t.Fatalf("stored audience_list_id = %q, want 16", listID)
	}
}

// The web editor switches a campaign from a segment to a list by sending both
// fields, the unused one as "". PATCH rejected list_id as an unknown field.
func TestPatchingAListOntoASegmentCampaignSendsToTheList(t *testing.T) {
	f := newAudienceFixture(t, nil)
	c := f.create(t, `{"name":"Switch",`+audienceCampaignBody+`,"segment_id":"`+f.segmentID+`"}`)

	rec := f.do(t, http.MethodPatch, "/api/v1/campaigns/"+c.ID, `{"list_id":"16","segment_id":""}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH list_id: status=%d body=%s", rec.Code, rec.Body.String())
	}
	listID, segmentID := f.storedAudience(t, c.ID)
	if listID != "16" || segmentID != "" {
		t.Fatalf("stored audience = list %q segment %q, want list 16 and no segment", listID, segmentID)
	}

	got, err := f.repo.Get(f.ctx, f.tenantID, c.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	resolved, err := f.repo.ResolveCampaignAudience(f.ctx, f.tenantID, got)
	if err != nil {
		t.Fatalf("ResolveCampaignAudience: %v", err)
	}
	if resolved.Kind != CampaignAudienceList || len(resolved.Emails) != 1 ||
		resolved.Emails[0] != "list-member@example.com" {
		t.Fatalf("resolved audience = %+v, want the one list member", resolved)
	}
}

// The uuid spelling of the list the campaign already targets is not a change.
func TestPatchingTheSameListByUUIDKeepsTheEngineID(t *testing.T) {
	f := newAudienceFixture(t, nil)
	c := f.create(t, `{"name":"Same list",`+audienceCampaignBody+`,"list_id":"16"}`)

	rec := f.do(t, http.MethodPatch, "/api/v1/campaigns/"+c.ID, `{"list_id":"`+f.listUUID+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH list uuid: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if listID, _ := f.storedAudience(t, c.ID); listID != "16" {
		t.Fatalf("stored audience_list_id = %q, want 16", listID)
	}
}

func TestPatchingAnEmptyListIDClearsTheList(t *testing.T) {
	f := newAudienceFixture(t, nil)
	c := f.create(t, `{"name":"Clear",`+audienceCampaignBody+`,"list_id":"16"}`)

	rec := f.do(t, http.MethodPatch, "/api/v1/campaigns/"+c.ID, `{"list_id":""}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH empty list_id: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if listID, segmentID := f.storedAudience(t, c.ID); listID != "" || segmentID != "" {
		t.Fatalf("stored audience = list %q segment %q, want both cleared", listID, segmentID)
	}
}

// An update that does not carry list_id leaves the stored list alone. Update
// reads the row, then writes it; when it also wrote audience_list_id back from
// that read, a rename that raced a list change silently reverted the list.
//
// The race is made deterministic with a row lock: the list change is written
// but not committed, so the rename reads the committed list (16) and its
// UPDATE waits behind the lock. The list change then commits and the rename's
// UPDATE proceeds against the new row.
func TestAnUpdateWithoutAListLeavesAConcurrentListChangeInPlace(t *testing.T) {
	f := newAudienceFixture(t, nil)
	insertListIdentityQ(t, f.pool, f.ctx, f.tenantID, 21)
	c := f.create(t, `{"name":"Race",`+audienceCampaignBody+`,"list_id":"16"}`)

	listChange, txErr := db.WithTenant(f.ctx, f.pool, f.tenantID)
	if txErr != nil {
		t.Fatalf("WithTenant: %v", txErr)
	}
	defer func() { _ = listChange.Rollback(f.ctx) }()
	if _, execErr := listChange.Exec(f.ctx, `
UPDATE campaigns SET audience_list_id = 21, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, f.tenantID, c.ID); execErr != nil {
		t.Fatalf("hold a list change: %v", execErr)
	}

	renamed := "Race, renamed"
	done := make(chan error, 1)
	go func() {
		_, updateErr := f.repo.Update(f.ctx, f.tenantID, c.ID, UpdateInput{Name: &renamed})
		done <- updateErr
	}()
	waitForBlockedCampaignUpdate(t, f)
	if commitErr := listChange.Commit(f.ctx); commitErr != nil {
		t.Fatalf("commit the list change: %v", commitErr)
	}
	select {
	case updateErr := <-done:
		if updateErr != nil {
			t.Fatalf("rename: %v", updateErr)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("rename never finished after the list change committed")
	}

	if listID, _ := f.storedAudience(t, c.ID); listID != "21" {
		t.Fatalf("stored audience_list_id = %q after a rename, want the concurrently chosen list 21", listID)
	}
	got, err := f.repo.Get(f.ctx, f.tenantID, c.ID)
	if err != nil || got.Name != renamed {
		t.Fatalf("Get = %+v, %v; want the rename applied", got, err)
	}
}

// waitForBlockedCampaignUpdate waits until another session of this role is
// waiting on a lock while updating a campaign — the rename, parked behind the
// uncommitted list change.
func waitForBlockedCampaignUpdate(t *testing.T, f audienceFixture) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		tx, err := db.WithTenant(f.ctx, f.pool, f.tenantID)
		if err != nil {
			t.Fatalf("WithTenant: %v", err)
		}
		var waiting int
		err = tx.QueryRow(f.ctx, `
SELECT count(*)
  FROM pg_stat_activity
 WHERE datname = current_database()
   AND pid <> pg_backend_pid()
   AND wait_event_type = 'Lock'
   AND query LIKE '%UPDATE campaigns SET%'`).Scan(&waiting)
		_ = tx.Rollback(f.ctx)
		if err != nil {
			t.Fatalf("read pg_stat_activity: %v", err)
		}
		if waiting > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the rename never reached its UPDATE")
}

// An engine id this tenant has no mapping for — never created here, or owned by
// another tenant on the shared engine — is refused with the stable
// list_not_found code, not stored.
func TestPatchingAListThisWorkspaceDoesNotOwnIsListNotFound(t *testing.T) {
	f := newAudienceFixture(t, nil)
	other := setupTenantQ(t, f.pool, f.ctx, "aud-author-other")
	insertListIdentityQ(t, f.pool, f.ctx, other, 77)
	c := f.create(t, `{"name":"Foreign",`+audienceCampaignBody+`}`)

	for _, listID := range []string{"999", "77"} {
		rec := f.do(t, http.MethodPatch, "/api/v1/campaigns/"+c.ID, `{"list_id":"`+listID+`"}`)
		if rec.Code != http.StatusUnprocessableEntity || errorCode(t, rec) != "list_not_found" {
			t.Fatalf("PATCH list_id %s: status=%d body=%s, want 422 list_not_found", listID, rec.Code, rec.Body.String())
		}
	}
	if listID, _ := f.storedAudience(t, c.ID); listID != "" {
		t.Fatalf("a refused list was stored: audience_list_id = %q", listID)
	}
}

func TestPatchingAListWhileASegmentRemainsIsAmbiguous(t *testing.T) {
	f := newAudienceFixture(t, nil)
	c := f.create(t, `{"name":"Both",`+audienceCampaignBody+`,"segment_id":"`+f.segmentID+`"}`)

	rec := f.do(t, http.MethodPatch, "/api/v1/campaigns/"+c.ID, `{"list_id":"16"}`)
	if rec.Code != http.StatusUnprocessableEntity || errorCode(t, rec) != "ambiguous_audience" {
		t.Fatalf("status=%d body=%s, want 422 ambiguous_audience", rec.Code, rec.Body.String())
	}
	if got, want := errorMessage(t, rec), "Choose either one list or one segment — a campaign can't send to both."; got != want {
		t.Fatalf("message = %q, want the editor's sentence %q", got, want)
	}
}

// Who receives the message is frozen once sending starts, the list included.
func TestPatchingTheListOfADispatchedCampaignIsRefused(t *testing.T) {
	f := newAudienceFixture(t, nil)
	c := f.create(t, `{"name":"Sending",`+audienceCampaignBody+`}`)
	setStatusDirect(t, f.pool, f.ctx, f.tenantID, c.ID, StatusSending, true)

	rec := f.do(t, http.MethodPatch, "/api/v1/campaigns/"+c.ID, `{"list_id":"16"}`)
	if rec.Code != http.StatusConflict || errorCode(t, rec) != "campaign_dispatching" {
		t.Fatalf("status=%d body=%s, want 409 campaign_dispatching", rec.Code, rec.Body.String())
	}
	if listID, _ := f.storedAudience(t, c.ID); listID != "" {
		t.Fatalf("list was attached to a dispatching campaign: %q", listID)
	}
}

// A frozen campaign sends to its snapshot. Re-pointing its list or segment
// would leave it naming one audience while delivering to another, so the
// change is refused — while a save that repeats the current audience, which
// is what the editor sends on every save, still goes through.
func TestChangingTheAudienceOfAFrozenCampaignIsRefused(t *testing.T) {
	f := newAudienceFixture(t, nil)
	c := f.create(t, `{"name":"Frozen",`+audienceCampaignBody+`,"segment_id":"`+f.segmentID+`"}`)
	if _, err := f.repo.FreezeCampaignAudience(f.ctx, f.tenantID, c.ID); err != nil {
		t.Fatalf("freeze: %v", err)
	}

	rec := f.do(t, http.MethodPatch, "/api/v1/campaigns/"+c.ID, `{"list_id":"16","segment_id":""}`)
	if rec.Code != http.StatusConflict || errorCode(t, rec) != "audience_frozen" {
		t.Fatalf("status=%d body=%s, want 409 audience_frozen", rec.Code, rec.Body.String())
	}
	if listID, segmentID := f.storedAudience(t, c.ID); listID != "" || segmentID != f.segmentID {
		t.Fatalf("frozen audience changed: list %q segment %q", listID, segmentID)
	}

	same := `{"subject":"Launch, revised","list_id":"","segment_id":"` + f.segmentID + `"}`
	if rec := f.do(t, http.MethodPatch, "/api/v1/campaigns/"+c.ID, same); rec.Code != http.StatusOK {
		t.Fatalf("unchanged audience save: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
}

func checklistItem(t *testing.T, f audienceFixture, campaignID, key string) CheckItem {
	t.Helper()
	rec := f.do(t, http.MethodGet, "/api/v1/campaigns/"+campaignID+"/checklist", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("checklist: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var resp ChecklistResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode checklist: %v", err)
	}
	for _, item := range resp.Checks {
		if item.Key == key {
			return item
		}
	}
	t.Fatalf("checklist has no %q row: %s", key, rec.Body.String())
	return CheckItem{}
}

func sendPreview(t *testing.T, f audienceFixture, campaignID string) SendPreviewResponse {
	t.Helper()
	rec := f.do(t, http.MethodGet, "/api/v1/campaigns/"+campaignID+"/send-preview", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("send-preview: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var resp SendPreviewResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode send-preview: %v", err)
	}
	return resp
}

// The send review used to read "Audience: Selected segment" and "Segment
// 00a94619-… selected." — the segment's name was only reachable through a
// send-preview hook nothing wired.
func TestTheSendReviewNamesTheSegment(t *testing.T) {
	f := newAudienceFixture(t, nil)
	c := f.create(t, `{"name":"Segment review",`+audienceCampaignBody+`,"segment_id":"`+f.segmentID+`"}`)

	item := checklistItem(t, f, c.ID, "list_selected")
	if item.Status != CheckPass || !strings.Contains(item.Detail, "“Spring VIPs”") {
		t.Fatalf("list_selected = %q %q, want a pass naming “Spring VIPs”", item.Status, item.Detail)
	}
	if strings.Contains(item.Detail, f.segmentID) {
		t.Fatalf("list_selected prints the segment id: %q", item.Detail)
	}

	preview := sendPreview(t, f, c.ID)
	if preview.AudienceKind != "segment" || preview.AudienceLabel != "Spring VIPs" || preview.SegmentLabel != "Spring VIPs" {
		t.Fatalf("send-preview = kind %q audience_label %q segment_label %q, want segment Spring VIPs",
			preview.AudienceKind, preview.AudienceLabel, preview.SegmentLabel)
	}
}

func TestTheSendReviewNamesTheList(t *testing.T) {
	namer := &fakeListNamer{names: map[string]string{"16": "Newsletter"}}
	f := newAudienceFixture(t, namer)
	c := f.create(t, `{"name":"List review",`+audienceCampaignBody+`,"list_id":"16"}`)

	item := checklistItem(t, f, c.ID, "list_selected")
	if item.Status != CheckPass || !strings.Contains(item.Detail, "“Newsletter”") {
		t.Fatalf("list_selected = %q %q, want a pass naming “Newsletter”", item.Status, item.Detail)
	}
	preview := sendPreview(t, f, c.ID)
	if preview.AudienceKind != "list" || preview.AudienceLabel != "Newsletter" || preview.SegmentLabel != "" {
		t.Fatalf("send-preview = kind %q audience_label %q segment_label %q, want list Newsletter",
			preview.AudienceKind, preview.AudienceLabel, preview.SegmentLabel)
	}
	if preview.Recipients != 1 {
		t.Fatalf("send-preview recipients = %d, want the one list member", preview.Recipients)
	}
}

// When the engine cannot name the list, the copy says so. It never falls back
// to printing the engine id.
func TestAListWhoseNameCannotBeReadIsNotShownAsAnID(t *testing.T) {
	for name, namer := range map[string]ListNamer{
		"no namer wired":      nil,
		"engine lookup fails": &fakeListNamer{names: map[string]string{}},
	} {
		t.Run(name, func(t *testing.T) {
			f := newAudienceFixture(t, namer)
			c := f.create(t, `{"name":"Unnamed list",`+audienceCampaignBody+`,"list_id":"16"}`)

			item := checklistItem(t, f, c.ID, "list_selected")
			if item.Status != CheckPass || strings.Contains(item.Detail, "16") ||
				!strings.Contains(item.Detail, "list") {
				t.Fatalf("list_selected = %q %q, want a pass that names neither an id nor a guess",
					item.Status, item.Detail)
			}
			if preview := sendPreview(t, f, c.ID); preview.AudienceLabel != "" {
				t.Fatalf("audience_label = %q, want empty so the client says \"Selected list\"", preview.AudienceLabel)
			}
		})
	}
}

// "Entire audience" is the editor's default and a real target: queue-fill and
// send-preview both send to it. The checklist hard-failed it ("No audience
// selected") while the editor promised it, so a fresh campaign could never
// be sent from the product.
func TestAWholeWorkspaceCampaignPassesTheRecipientsGate(t *testing.T) {
	f := newAudienceFixture(t, nil)
	c := f.create(t, `{"name":"Everyone",`+audienceCampaignBody+`}`)

	recipients := checklistItem(t, f, c.ID, "recipient_count_above_zero")
	if recipients.Status != CheckPass || !strings.Contains(recipients.Detail, "2 eligible recipients") {
		t.Fatalf("recipient_count_above_zero = %q %q, want a pass for the 2 eligible subscribers",
			recipients.Status, recipients.Detail)
	}
	selected := checklistItem(t, f, c.ID, "list_selected")
	if selected.Status != CheckWarn || !strings.Contains(selected.Detail, "every eligible contact") {
		t.Fatalf("list_selected = %q %q, want a warning that confirms the whole-workspace send",
			selected.Status, selected.Detail)
	}
	if preview := sendPreview(t, f, c.ID); preview.AudienceKind != "workspace" || preview.Recipients != 2 {
		t.Fatalf("send-preview = kind %q recipients %d, want workspace 2", preview.AudienceKind, preview.Recipients)
	}
}

// The editor counts a picked list the way the send review will: members who
// can actually be sent to, not every row in the list.
func TestCountingAListAudienceCountsOnlyEligibleMembers(t *testing.T) {
	f := newAudienceFixture(t, nil)
	insertSubscribersQ(t, f.pool, f.ctx, f.tenantID, []subQ{
		{email: "no-consent@example.com", status: "enabled", noEmailConsent: true},
	})
	addListMemberQ(t, f.pool, f.ctx, f.tenantID, f.listUUID, fixtureEngineListID, "no-consent@example.com")

	n, err := f.repo.CountEligibleListAudience(f.ctx, f.tenantID, "16")
	if err != nil {
		t.Fatalf("CountEligibleListAudience: %v", err)
	}
	if n != 1 {
		t.Fatalf("eligible list count = %d, want 1 (the member without email consent is not sendable)", n)
	}
	if _, err := f.repo.CountEligibleListAudience(f.ctx, f.tenantID, "999"); !errors.Is(err, ErrAudienceListNotFound) {
		t.Fatalf("unmapped list count err = %v, want ErrAudienceListNotFound", err)
	}
}

// editorSession wraps a handler in an editor's dashboard session for the
// fixture's tenant, the identity every route above is exercised as.
func (f audienceFixture) editorSession(r chi.Router) {
	userID := uuid.NewString()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID})
			ctx = middleware.WithUser(ctx, &middleware.User{ID: userID, TenantID: f.tenantID, Role: "editor"})
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
}

func (f audienceFixture) postTo(t *testing.T, r chi.Router, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(f.ctx, http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func (f audienceFixture) abRouter() chi.Router {
	d := &Deps{Repo: f.repo, ABRepo: &abtests.Repo{Pool: f.pool}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	r := chi.NewRouter()
	f.editorSession(r)
	// The production mount (internal/server MountCampaignABCreateRoutes).
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/ab-test", d.CreateABTest)
	return r
}

func (f audienceFixture) campaignAudiences(t *testing.T) map[string]string {
	t.Helper()
	tx, err := db.WithTenant(f.ctx, f.pool, f.tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	rows, err := tx.Query(f.ctx, `
SELECT id::text, COALESCE(audience_list_id::text, '')
  FROM campaigns
 WHERE tenant_id = $1::uuid`, f.tenantID)
	if err != nil {
		t.Fatalf("read campaigns: %v", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, listID string
		if err := rows.Scan(&id, &listID); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[id] = listID
	}
	return out
}

const abUnsubscribeBody = `"body_html":"<p>Hi <a href=\"{{ unsubscribe_url }}\">unsubscribe</a></p>"`

// The A/B create path cast audience_list_id straight from the request to
// bigint and never validated it: a uuid was a 500 after the parent already
// existed, and an engine id this tenant does not own was stored. It now goes
// through the same resolution as every other write.
func TestAnABTestOnAListStoresTheEngineIDOnEveryRow(t *testing.T) {
	f := newAudienceFixture(t, nil)
	rec := f.postTo(t, f.abRouter(), "/api/v1/campaigns/ab-test",
		`{"name":"AB on list","subject_variants":["One","Two"],"audience_list_id":"`+f.listUUID+`",`+abUnsubscribeBody+`}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("A/B create: status=%d body=%s", rec.Code, rec.Body.String())
	}
	stored := f.campaignAudiences(t)
	if len(stored) != 3 {
		t.Fatalf("A/B create made %d campaigns, want a parent and two variants", len(stored))
	}
	for id, listID := range stored {
		if listID != "16" {
			t.Fatalf("campaign %s stored audience_list_id %q, want the engine id 16", id, listID)
		}
	}
}

func TestAnABTestOnAListThisWorkspaceDoesNotOwnCreatesNothing(t *testing.T) {
	f := newAudienceFixture(t, nil)
	rec := f.postTo(t, f.abRouter(), "/api/v1/campaigns/ab-test",
		`{"name":"AB foreign","subject_variants":["One","Two"],"audience_list_id":"999",`+abUnsubscribeBody+`}`)
	if rec.Code != http.StatusUnprocessableEntity || errorCode(t, rec) != "list_not_found" {
		t.Fatalf("status=%d body=%s, want 422 list_not_found", rec.Code, rec.Body.String())
	}
	if stored := f.campaignAudiences(t); len(stored) != 0 {
		t.Fatalf("a refused A/B test left %d campaigns behind", len(stored))
	}
}

// eligibleCounter has the production AudienceCounter's shape
// (composition_adapters.go newAudienceCounter): lists through the campaign
// repository's eligible count, segments through the segments repository.
type eligibleCounter struct {
	repo     *Repo
	segments *segments.Repo
}

func (c eligibleCounter) CountListAudience(ctx context.Context, tenantID, listID string) (int64, error) {
	return c.repo.CountEligibleListAudience(ctx, tenantID, listID)
}

func (c eligibleCounter) CountSegmentAudience(ctx context.Context, tenantID, segmentID string) (int64, error) {
	return c.segments.CountSegmentAudience(ctx, tenantID, segmentID)
}

func (f audienceFixture) countRouter() chi.Router {
	r := chi.NewRouter()
	f.editorSession(r)
	MountAudienceCount(r, &AudienceCountDeps{
		Audience: eligibleCounter{repo: f.repo, segments: &segments.Repo{Pool: f.pool}},
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	return r
}

// Picking a list in the editor sizes it. A list this workspace does not have
// answered 500 "internal error"; it is the same 422 list_not_found a save or a
// send gets, so the editor can say what is wrong.
func TestCountingAnAudienceThisWorkspaceDoesNotHaveIsNotFound(t *testing.T) {
	f := newAudienceFixture(t, nil)
	router := f.countRouter()

	if rec := f.postTo(t, router, "/api/v1/audiences/count", `{"list_id":"999"}`); rec.Code != http.StatusUnprocessableEntity || errorCode(t, rec) != "list_not_found" {
		t.Fatalf("unknown list: status=%d body=%s, want 422 list_not_found", rec.Code, rec.Body.String())
	}
	if rec := f.postTo(t, router, "/api/v1/audiences/count", `{"segment_id":"`+uuid.NewString()+`"}`); rec.Code != http.StatusUnprocessableEntity || errorCode(t, rec) != "segment_not_found" {
		t.Fatalf("unknown segment: status=%d body=%s, want 422 segment_not_found", rec.Code, rec.Body.String())
	} else if got, want := errorMessage(t, rec), "The selected segment no longer exists. Choose another list or segment."; got != want {
		t.Fatalf("unknown segment message = %q, want the editor's sentence %q", got, want)
	}
	rec := f.postTo(t, router, "/api/v1/audiences/count", `{"list_id":"16"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("known list: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got AudienceCountResult
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got.Deliverable != 1 || got.Kind != "list" {
		t.Fatalf("known list count = %+v (%v), want 1 deliverable list member", got, err)
	}
}
