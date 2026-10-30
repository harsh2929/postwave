// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for the native write tools (1.3b). These exercise the
// argument validation, the nil-seam "not available" guards, the
// delegation contract (the right service method is called with the right
// args), and error mapping — all with fakes, so they run without a DB.
package mcp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/assets"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/tags"
)

// Fully decodable 1x1 PNG. Upload validation intentionally requires a complete
// image, not only a magic header and logical-screen dimensions.
var tinyPNG = func() []byte {
	b, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if err != nil {
		panic(err)
	}
	return b
}()

type fakeAssetUploader struct {
	gotTenant, gotFilename, gotMime string
	gotBody                         []byte
	ret                             *assets.Asset
	err                             error
}

func (f *fakeAssetUploader) UploadBytes(_ context.Context, tenantID, filename, mime string, body []byte) (*assets.Asset, error) {
	f.gotTenant, f.gotFilename, f.gotMime, f.gotBody = tenantID, filename, mime, body
	return f.ret, f.err
}

func dtCtx() context.Context {
	return middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "tenant-1"})
}

type fakeCampaignCreator struct {
	gotTenant string
	gotInput  campaigns.CreateInput
	ret       *campaigns.Campaign
	err       error
	calls     int
}

func (f *fakeCampaignCreator) Create(_ context.Context, tenantID string, in campaigns.CreateInput) (*campaigns.Campaign, error) {
	f.calls++
	f.gotTenant, f.gotInput = tenantID, in
	return f.ret, f.err
}

type fakeCampaignSender struct {
	gotCampaign string
	gotActor    string
	ret         campaigns.AgentQueueResult
	err         error
}

func (f *fakeCampaignSender) QueueCampaignForAgent(_ context.Context, _ string, campaignID, actorLabel string) (campaigns.AgentQueueResult, error) {
	f.gotCampaign, f.gotActor = campaignID, actorLabel
	return f.ret, f.err
}

type fakeTagCreator struct {
	gotInput tags.CreateInput
	ret      *tags.Tag
	err      error
}

func (f *fakeTagCreator) Create(_ context.Context, _ string, in tags.CreateInput) (*tags.Tag, error) {
	f.gotInput = in
	return f.ret, f.err
}

// --- create_campaign ---

func TestCreateCampaign_nilSeamUnavailable(t *testing.T) {
	_, err := handleCreateCampaign(dtCtx(), &Deps{}, json.RawMessage(`{"name":"a","subject":"b"}`))
	if err == nil {
		t.Fatal("expected unavailable error when CampaignCreate seam is nil")
	}
}

func TestCreateCampaign_requiresNameAndSubject(t *testing.T) {
	d := &Deps{CampaignCreate: &fakeCampaignCreator{}}
	for _, args := range []string{`{}`, `{"name":"x"}`, `{"subject":"y"}`, `{"name":"  ","subject":"y"}`} {
		if _, err := handleCreateCampaign(dtCtx(), d, json.RawMessage(args)); err == nil {
			t.Fatalf("expected validation error for args %s", args)
		}
	}
}

func TestCreateCampaign_rejectsLifecycleOwnedSchedule(t *testing.T) {
	fake := &fakeCampaignCreator{}
	d := &Deps{CampaignCreate: fake}
	for _, value := range []string{`null`, `"2030-01-01T12:00:00Z"`} {
		_, err := handleCreateCampaign(dtCtx(), d, json.RawMessage(
			`{"name":"Launch","subject":"Hi","scheduled_at":`+value+`}`,
		))
		if err == nil || !strings.Contains(err.Error(), "status and scheduled_at are controlled") {
			t.Fatalf("scheduled_at=%s error = %v, want lifecycle-owned rejection", value, err)
		}
	}
	for _, value := range []string{`null`, `"scheduled"`} {
		_, err := handleCreateCampaign(dtCtx(), d, json.RawMessage(
			`{"name":"Launch","subject":"Hi","status":`+value+`}`,
		))
		if err == nil || !strings.Contains(err.Error(), "status and scheduled_at are controlled") {
			t.Fatalf("status=%s error = %v, want lifecycle-owned rejection", value, err)
		}
	}
	if fake.calls != 0 {
		t.Fatalf("scheduled create reached repository %d times", fake.calls)
	}
}

func TestCreateCampaign_delegatesAndMapsHTMLEditor(t *testing.T) {
	fake := &fakeCampaignCreator{ret: &campaigns.Campaign{ID: "c1", Name: "Launch", Subject: "Hi", Status: "draft", CampaignType: "regular"}}
	d := &Deps{CampaignCreate: fake}
	out, err := handleCreateCampaign(dtCtx(), d, json.RawMessage(`{"name":"Launch","subject":"Hi","body_html":"<p>x</p>"}`))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if fake.gotTenant != "tenant-1" {
		t.Fatalf("tenant not threaded: %q", fake.gotTenant)
	}
	if fake.gotInput.EditorMode != "html" {
		t.Fatalf("body_html present should set editor mode html, got %q", fake.gotInput.EditorMode)
	}
	m := out.(map[string]any)
	if m["id"] != "c1" || m["status"] != "draft" {
		t.Fatalf("unexpected result payload: %+v", m)
	}
}

func TestCreateCampaign_noHTMLLeavesEditorDefault(t *testing.T) {
	fake := &fakeCampaignCreator{ret: &campaigns.Campaign{ID: "c2"}}
	d := &Deps{CampaignCreate: fake}
	if _, err := handleCreateCampaign(dtCtx(), d, json.RawMessage(`{"name":"n","subject":"s"}`)); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if fake.gotInput.EditorMode != "" {
		t.Fatalf("no body_html should leave editor mode empty (repo default), got %q", fake.gotInput.EditorMode)
	}
}

// --- send_campaign ---

func TestSendCampaign_nilSeamUnavailable(t *testing.T) {
	if _, err := handleSendCampaign(dtCtx(), &Deps{}, json.RawMessage(`{"campaign_id":"c1"}`)); err == nil {
		t.Fatal("expected unavailable error when CampaignSend seam is nil")
	}
}

func TestSendCampaign_requiresCampaignID(t *testing.T) {
	d := &Deps{CampaignSend: &fakeCampaignSender{}}
	if _, err := handleSendCampaign(dtCtx(), d, json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected error when campaign_id is missing")
	}
}

func TestSendCampaign_delegatesAndSurfacesApproval(t *testing.T) {
	fake := &fakeCampaignSender{ret: campaigns.AgentQueueResult{CampaignID: "c1", Status: "pending_approval", ApprovalRequired: true, ApprovalID: "ap1"}}
	d := &Deps{CampaignSend: fake}
	out, err := handleSendCampaign(dtCtx(), d, json.RawMessage(`{"campaign_id":"  c1  "}`))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if fake.gotCampaign != "c1" {
		t.Fatalf("campaign_id should be trimmed before delegation, got %q", fake.gotCampaign)
	}
	res, ok := out.(campaigns.AgentQueueResult)
	if !ok || !res.ApprovalRequired || res.ApprovalID != "ap1" {
		t.Fatalf("approval outcome not surfaced: %+v", out)
	}
}

func TestSendCampaign_propagatesServiceError(t *testing.T) {
	d := &Deps{CampaignSend: &fakeCampaignSender{err: errors.New("campaign needs a subject and body_html before queueing")}}
	if _, err := handleSendCampaign(dtCtx(), d, json.RawMessage(`{"campaign_id":"c1"}`)); err == nil {
		t.Fatal("expected the service error to propagate")
	}
}

// --- create_tag ---

func TestCreateTag_nilSeamUnavailable(t *testing.T) {
	if _, err := handleCreateTag(dtCtx(), &Deps{}, json.RawMessage(`{"name":"vip"}`)); err == nil {
		t.Fatal("expected unavailable error when TagCreate seam is nil")
	}
}

func TestCreateTag_requiresName(t *testing.T) {
	d := &Deps{TagCreate: &fakeTagCreator{}}
	if _, err := handleCreateTag(dtCtx(), d, json.RawMessage(`{"name":"   "}`)); err == nil {
		t.Fatal("expected validation error for blank name")
	}
}

func TestCreateTag_conflictMapsToFriendlyError(t *testing.T) {
	d := &Deps{TagCreate: &fakeTagCreator{err: tags.ErrConflict}}
	_, err := handleCreateTag(dtCtx(), d, json.RawMessage(`{"name":"vip"}`))
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("conflict should map to an 'already exists' message, got %v", err)
	}
}

func TestCreateTag_delegatesTrimmed(t *testing.T) {
	fake := &fakeTagCreator{ret: &tags.Tag{ID: "t1", Name: "vip", Color: "#fff"}}
	d := &Deps{TagCreate: fake}
	out, err := handleCreateTag(dtCtx(), d, json.RawMessage(`{"name":"  vip  ","color":"#fff"}`))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if fake.gotInput.Name != "vip" {
		t.Fatalf("name should be trimmed before delegation, got %q", fake.gotInput.Name)
	}
	if out.(map[string]any)["id"] != "t1" {
		t.Fatalf("unexpected result: %+v", out)
	}
}

// --- apply_subscriber_tag (guards only; happy path is the DB test) ---

func TestApplySubscriberTag_nilSeamUnavailable(t *testing.T) {
	if _, err := handleApplySubscriberTag(dtCtx(), &Deps{}, json.RawMessage(`{"subscriber_id":"a@x","tag":"vip"}`)); err == nil {
		t.Fatal("expected unavailable error when SubTagApply seam is nil")
	}
}

type noopSubTagApplier struct{}

func (noopSubTagApplier) ApplyByName(context.Context, string, string, string, string, string) (string, error) {
	return "", nil
}

func TestApplySubscriberTag_requiresBothArgs(t *testing.T) {
	d := &Deps{SubTagApply: noopSubTagApplier{}}
	for _, args := range []string{`{}`, `{"subscriber_id":"a@x"}`, `{"tag":"vip"}`, `{"subscriber_id":" ","tag":"vip"}`} {
		if _, err := handleApplySubscriberTag(dtCtx(), d, json.RawMessage(args)); err == nil {
			t.Fatalf("expected validation error for args %s", args)
		}
	}
}

// --- upload_asset ---

func TestUploadAsset_nilSeamUnavailable(t *testing.T) {
	b64 := base64.StdEncoding.EncodeToString(tinyPNG)
	if _, err := handleUploadAsset(dtCtx(), &Deps{}, json.RawMessage(`{"content_base64":"`+b64+`"}`)); err == nil {
		t.Fatal("expected unavailable error when AssetUpload seam is nil")
	}
}

func TestUploadAsset_requiresContent(t *testing.T) {
	d := &Deps{AssetUpload: &fakeAssetUploader{}}
	if _, err := handleUploadAsset(dtCtx(), d, json.RawMessage(`{"filename":"x.png"}`)); err == nil {
		t.Fatal("expected error when content_base64 is missing")
	}
}

func TestUploadAsset_rejectsBadBase64(t *testing.T) {
	d := &Deps{AssetUpload: &fakeAssetUploader{}}
	if _, err := handleUploadAsset(dtCtx(), d, json.RawMessage(`{"content_base64":"!!!not base64!!!"}`)); err == nil {
		t.Fatal("expected error for invalid base64")
	}
}

func TestUploadAsset_rejectsNonImage(t *testing.T) {
	// Valid base64, but the bytes aren't a recognised image → ValidateUpload
	// fails BEFORE the seam is called.
	fake := &fakeAssetUploader{}
	d := &Deps{AssetUpload: fake}
	b64 := base64.StdEncoding.EncodeToString([]byte("this is definitely not an image file"))
	if _, err := handleUploadAsset(dtCtx(), d, json.RawMessage(`{"content_base64":"`+b64+`"}`)); err == nil {
		t.Fatal("expected validation error for non-image bytes")
	}
	if fake.gotBody != nil {
		t.Fatal("seam must NOT be called when validation fails")
	}
}

func TestUploadAsset_delegatesValidImage(t *testing.T) {
	fake := &fakeAssetUploader{ret: &assets.Asset{ID: "a1", URL: "https://cdn/x.png", Filename: "x.png", Mime: "image/png", Width: 1, Height: 1, Bytes: int64(len(tinyPNG))}}
	d := &Deps{AssetUpload: fake}
	// data: URI prefix should be stripped.
	b64 := "data:image/png;base64," + base64.StdEncoding.EncodeToString(tinyPNG)
	out, err := handleUploadAsset(dtCtx(), d, json.RawMessage(`{"content_base64":"`+b64+`","filename":"x.png","mime":"image/png"}`))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if string(fake.gotBody) != string(tinyPNG) {
		t.Fatalf("decoded body mismatch (data: prefix not stripped?): %q", fake.gotBody)
	}
	if fake.gotTenant != "tenant-1" {
		t.Fatalf("tenant not threaded: %q", fake.gotTenant)
	}
	m := out.(map[string]any)
	if m["id"] != "a1" || m["url"] != "https://cdn/x.png" {
		t.Fatalf("unexpected result payload: %+v", m)
	}
}

func TestUploadAsset_infraErrorIsGeneric(t *testing.T) {
	// A valid image but the seam fails with a raw infra error — the model must
	// see a generic message, not the leaked internal detail.
	fake := &fakeAssetUploader{err: errors.New("s3: secret bucket acl denied for arn:...")}
	d := &Deps{AssetUpload: fake}
	b64 := base64.StdEncoding.EncodeToString(tinyPNG)
	_, err := handleUploadAsset(dtCtx(), d, json.RawMessage(`{"content_base64":"`+b64+`"}`))
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "s3") || strings.Contains(err.Error(), "bucket") {
		t.Fatalf("infra detail leaked to model: %v", err)
	}
}

// --- create_list ---

type fakeListCreator struct {
	gotTenant string
	gotIn     lists.CreateListInput
	ret       *lists.List
	err       error
}

func (f *fakeListCreator) CreateForAgent(_ context.Context, tenantID string, in lists.CreateListInput) (*lists.List, error) {
	f.gotTenant, f.gotIn = tenantID, in
	return f.ret, f.err
}

func TestCreateList_nilSeamUnavailable(t *testing.T) {
	if _, err := handleCreateList(dtCtx(), &Deps{}, json.RawMessage(`{"name":"VIP"}`)); err == nil {
		t.Fatal("expected unavailable error when ListCreate seam is nil")
	}
}

func TestCreateList_requiresName(t *testing.T) {
	d := &Deps{ListCreate: &fakeListCreator{}}
	if _, err := handleCreateList(dtCtx(), d, json.RawMessage(`{"name":"   "}`)); err == nil {
		t.Fatal("expected validation error for blank name")
	}
}

func TestCreateList_delegatesAndMaps(t *testing.T) {
	fake := &fakeListCreator{ret: &lists.List{ID: 7, Name: "Newsletter", Type: "public", Optin: "double"}}
	d := &Deps{ListCreate: fake}
	out, err := handleCreateList(dtCtx(), d, json.RawMessage(`{"name":"Newsletter","type":"public","optin":"double","tags":["a"]}`))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if fake.gotTenant != "tenant-1" {
		t.Fatalf("tenant not threaded: %q", fake.gotTenant)
	}
	if fake.gotIn.Type != "public" || len(fake.gotIn.Tags) != 1 {
		t.Fatalf("input not forwarded: %+v", fake.gotIn)
	}
	m := out.(map[string]any)
	if m["id"] != int64(7) || m["name"] != "Newsletter" {
		t.Fatalf("unexpected result: %+v", m)
	}
}

func TestCreateList_propagatesServiceError(t *testing.T) {
	d := &Deps{ListCreate: &fakeListCreator{err: errors.New("could not create list: The list already exists.")}}
	if _, err := handleCreateList(dtCtx(), d, json.RawMessage(`{"name":"dup"}`)); err == nil {
		t.Fatal("expected the service error to propagate")
	}
}
