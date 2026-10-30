// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/forms"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/pagination"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
	"github.com/postwave/postwave/apps/api/internal/testsupport/listmonkv6"
)

// formsSignupE2E composes the hosted-form lifecycle the way run() does — the
// public routes behind their rate limiters, the forms handlers, the
// production outbox, subscriber and list adapters, the outbox handlers
// registered by registerFormsSignupHandlers, and the canonical subscriber
// engine sync — against a migrated database as the RLS-bound application
// role, with the real Listmonk client talking to a Listmonk v6.1.0 stand-in
// that answers with recorded bodies.
type formsSignupE2E struct {
	t           *testing.T
	pool        *db.Pool
	tenantID    string
	listID      string
	soiFormID   string
	doiFormID   string
	engine      *listmonkv6.Server
	registry    *outbox.Registry
	subscribers *subscribers.Repo
	mailer      *e2eRecordingMailer
	router      chi.Router
	handled     map[string]string
}

const e2eEngineListID = 7

func newFormsSignupE2E(t *testing.T) *formsSignupE2E {
	t.Helper()
	return buildFormsSignupE2E(t, false)
}

// buildFormsSignupE2E composes the hosted-form plane. With sharedListmonk the
// form signup gets the production resolver over the process-global client,
// the way main wires it, instead of an engine owned by the test tenant.
func buildFormsSignupE2E(t *testing.T, sharedListmonk bool) *formsSignupE2E {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping the hosted-form composition proof")
	}
	pool, err := db.New(t.Context(), url) // refuses a role that bypasses RLS
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	e := &formsSignupE2E{
		t: t, pool: pool, tenantID: uuid.NewString(),
		soiFormID: uuid.NewString(), doiFormID: uuid.NewString(),
		engine:  listmonkv6.NewServer(t),
		mailer:  &e2eRecordingMailer{},
		handled: map[string]string{},
	}
	e.engine.AddList(e2eEngineListID, "Launch", "single")
	e.engine.AddList(5, "Customers", "single")
	e.seed()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	plane := buildOutboxPlane(pool)
	e.subscribers = &subscribers.Repo{
		Pool:             pool,
		EngineSyncOutbox: newSubscribersEngineSyncOutboxAdapter(plane.outboxRepo),
	}
	client := listmonk.New(listmonk.Config{BaseURL: e.engine.URL})
	e.registry = outbox.NewRegistry()
	var formEngines subscribers.EngineResolver = e2eEngineResolver{tenantID: e.tenantID, engine: client}
	if sharedListmonk {
		formEngines = &subscribers.SingleTenantGlobalEngineResolver{Pool: pool, Engine: client}
	}
	confirmations := registerFormsSignupHandlers(e.registry,
		newFormsSignupAudience(pool, e.subscribers, plane.webhooksDispatcher, formEngines, plane.outboxRepo, logger))
	if !sharedListmonk {
		// On a shared instance the canonical sync refuses too (proven in the
		// subscribers package); only the form signup's own writes are under
		// test there.
		e.registry.Register(subscribers.OutboxKindListmonkSync, (&subscribers.ListmonkSyncHandler{
			Repo:     e.subscribers,
			Resolver: e2eEngineResolver{tenantID: e.tenantID, engine: client},
		}).Handle)
	}
	if missing := e.registry.MustHave(forms.OutboxKindRecordSignup, forms.OutboxKindEnableListmonk, forms.OutboxKindSendConfirmation); len(missing) > 0 {
		t.Fatalf("form outbox kinds without a handler: %v", missing)
	}

	formsDeps := &forms.Deps{
		Repo:               &forms.Repo{Pool: pool},
		PublicHostBase:     "https://forms.example.test",
		ConfirmationMailer: e.mailer,
		ConfirmationFrom:   "Signups <signups@example.test>",
		RecipientGuard: formsConfirmationRecipientGuard{
			subscribers:  e.subscribers,
			suppressions: suppressions.NewConverger(&suppressions.Store{Pool: pool}, logger),
		},
		Outbox:   newFormsOutboxAdapter(plane.outboxRepo),
		Webhooks: newWebhookFanoutAppender(plane.outboxRepo),
		Logger:   logger,
	}
	confirmations.bind(formsDeps)
	limits := newPublicFormsRateLimits(middleware.RateLimitOptions{Store: &publicFormsMemoryWindowStore{}})
	router := chi.NewRouter()
	router.With(limits.submit.Middleware).
		Post("/api/public/forms/{slug}/submit", observability.RecordSurfaceFunc("forms", "ingest", formsDeps.PublicSubmit))
	router.With(limits.confirm.Middleware).
		Get("/api/public/forms/confirm/{token}", observability.RecordSurfaceFunc("forms", "public_confirm", formsDeps.PublicConfirm))
	e.router = router
	return e
}

func (e *formsSignupE2E) seed() {
	e.t.Helper()
	ctx := e.t.Context()
	tx, err := db.WithTenant(ctx, e.pool, e.tenantID)
	if err != nil {
		e.t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'hosted forms', 'studio')`,
		e.tenantID, "hosted-forms-"+e.tenantID[:8]); err != nil {
		e.t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
VALUES (gen_random_uuid(), $1, $2::uuid) RETURNING postwave_uuid::text`, e2eEngineListID, e.tenantID).Scan(&e.listID); err != nil {
		e.t.Fatalf("map list: %v", err)
	}
	structure := `{"fields":[{"id":"f_email","kind":"email","label":"Email","required":true},` +
		`{"id":"f_name","kind":"name","label":"Name","required":false},` +
		`{"id":"f_consent","kind":"checkbox","label":"I agree to receive emails.","required":true}]}`
	for id, mode := range map[string]string{e.soiFormID: "single", e.doiFormID: "double"} {
		if _, err := tx.Exec(ctx, `
INSERT INTO forms (id, tenant_id, name, slug, status, opt_in_mode, structure, settings)
VALUES ($1::uuid, $2::uuid, 'Launch list', $3, 'published', $4, $5::jsonb,
        '{"targetListId":"7","successMessage":"Thanks for signing up"}'::jsonb)`,
			id, e.tenantID, "launch-"+id[:8], mode, structure); err != nil {
			e.t.Fatalf("seed form: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		e.t.Fatalf("commit seed: %v", err)
	}
	e.t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), e.pool, e.tenantID)
		if err != nil {
			e.t.Errorf("cleanup tx: %v", err)
			return
		}
		defer func() { _ = cleanup.Rollback(context.Background()) }()
		if _, err := cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, e.tenantID); err != nil {
			e.t.Errorf("cleanup tenant: %v", err)
			return
		}
		_ = cleanup.Commit(context.Background())
	})
}

func (e *formsSignupE2E) submit(formID, email string) *httptest.ResponseRecorder {
	e.t.Helper()
	body := `{"email":"` + email + `","name":"Ada Lovelace","consent":"yes"}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/forms/launch-"+formID[:8]+"/submit", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "203.0.113.20:5000"
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func (e *formsSignupE2E) confirm(token string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/public/forms/confirm/"+token, nil)
	req.RemoteAddr = "203.0.113.20:5001"
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

// drain dispatches every outbox event the tenant's writes appended to the
// handler registered for its kind, until nothing new appears, as the worker
// would. Kinds this composition does not register (webhook deliveries) are
// out of scope and skipped.
func (e *formsSignupE2E) drain() {
	e.t.Helper()
	for round := 0; round < 20; round++ {
		progressed := false
		for _, ev := range e.pendingEvents() {
			handler, ok := e.registry.Lookup(ev.Kind)
			e.handled[ev.ID] = ev.Kind
			if !ok {
				continue
			}
			if err := handler(e.t.Context(), ev); err != nil {
				e.t.Fatalf("%s handler: %v", ev.Kind, err)
			}
			progressed = true
		}
		if !progressed {
			return
		}
	}
	e.t.Fatal("the outbox never settled")
}

func (e *formsSignupE2E) pendingEvents() []outbox.Event {
	e.t.Helper()
	ctx := e.t.Context()
	tx, err := db.WithTenant(ctx, e.pool, e.tenantID)
	if err != nil {
		e.t.Fatalf("outbox read tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, kind, payload
  FROM outbox_events
 WHERE tenant_id = $1::uuid
 ORDER BY created_at, id`, e.tenantID)
	if err != nil {
		e.t.Fatalf("read outbox: %v", err)
	}
	defer rows.Close()
	var out []outbox.Event
	for rows.Next() {
		var ev outbox.Event
		var payload []byte
		if err := rows.Scan(&ev.ID, &ev.TenantID, &ev.Kind, &payload); err != nil {
			e.t.Fatalf("scan outbox: %v", err)
		}
		if _, done := e.handled[ev.ID]; done {
			continue
		}
		ev.Payload = json.RawMessage(payload)
		out = append(out, ev)
	}
	return out
}

func (e *formsSignupE2E) handledKinds() map[string]int {
	out := map[string]int{}
	for _, kind := range e.handled {
		out[kind]++
	}
	return out
}

type e2eAudience struct {
	status, consentSource, signupSource string
	marketingConsented                  bool
	members                             []string
	audience                            []string
	submissions                         []forms.SubmissionStatus
}

// audienceOf reads what each surface shows for email: Subscribers, the
// list's Members, the forms' Submissions, and the campaign audience for the
// list — every one of them through the repository that serves it.
func (e *formsSignupE2E) audienceOf(email string) e2eAudience {
	e.t.Helper()
	ctx := e.t.Context()
	var got e2eAudience
	page, err := e.subscribers.Search(ctx, e.tenantID, email, 1, 10, false)
	if err != nil {
		e.t.Fatalf("subscriber search: %v", err)
	}
	if page.Total == 1 {
		got.status, got.consentSource = page.Items[0].Status, page.Items[0].ConsentSource
		got.marketingConsented = page.Items[0].ConsentEmailMarketingAt != nil
		got.signupSource = e.signupSourceOf(page.Items[0].ID)
	}
	members, _, err := (&lists.Repo{Pool: e.pool}).ListMembers(ctx, e.tenantID, e.listID, "", "", 1, 50)
	if err != nil {
		e.t.Fatalf("list members: %v", err)
	}
	for _, member := range members {
		got.members = append(got.members, member.Email+"/"+member.Source)
	}
	for _, formID := range []string{e.soiFormID, e.doiFormID} {
		subs, _, listErr := (&forms.Repo{Pool: e.pool}).ListSubmissions(ctx, e.tenantID, formID, 50, pagination.Cursor{})
		if listErr != nil {
			e.t.Fatalf("list submissions: %v", listErr)
		}
		for _, sub := range subs {
			if sub.Email == email {
				got.submissions = append(got.submissions, sub.Status)
			}
		}
	}
	got.audience, err = (&campaigns.Repo{Pool: e.pool}).ListAudienceEmails(ctx, e.tenantID, "7")
	if err != nil {
		e.t.Fatalf("campaign audience: %v", err)
	}
	return got
}

// A single opt-in signup to a list-targeted form: the visitor is told they
// are subscribed and appears in Subscribers (enabled, with single opt-in
// consent), in the list's Members, in the form's Submissions and in a
// campaign audience for the list — and Listmonk holds the list subscription
// after the canonical engine sync has run over it.
func TestAHostedFormSignupReachesEveryAudienceSurface(t *testing.T) {
	e := newFormsSignupE2E(t)
	email := "soi-" + uuid.NewString()[:8] + "@example.test"

	rec := e.submit(e.soiFormID, email)
	if want := `{"ok":true,"state":"subscribed","message":"Thanks for signing up"}` + "\n"; rec.Code != http.StatusOK || rec.Body.String() != want {
		t.Fatalf("submit = %d %q, want 200 %q", rec.Code, rec.Body.String(), want)
	}
	e.drain()

	got := e.audienceOf(email)
	want := e2eAudience{
		status: subscribers.StatusEnabled, consentSource: subscribers.ConsentSingleOptIn,
		signupSource: subscribers.SignupSourceHostedPage, marketingConsented: true,
		members: []string{email + "/form"}, audience: []string{email},
		submissions: []forms.SubmissionStatus{forms.SubmissionConfirmed},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("after a single opt-in signup:\n got %+v\nwant %+v", got, want)
	}
	engineSub, ok := e.engine.Subscriber(email)
	if !ok || engineSub.Status != listmonkv6.StatusEnabled ||
		!reflect.DeepEqual(engineSub.Lists, map[int64]string{e2eEngineListID: listmonkv6.SubscriptionConfirmed}) {
		t.Fatalf("Listmonk = %+v, want enabled with list 7 confirmed", engineSub)
	}
	if e.handledKinds()[subscribers.OutboxKindListmonkSync] == 0 {
		t.Fatal("the canonical engine sync never ran, so this proves nothing about it keeping the subscription")
	}
}

// Forms write Listmonk by email address. On a deployment whose one Listmonk
// serves more than one workspace, workspace B's form must not touch the
// subscriber workspace A synced for the same address: no request reaches
// Listmonk, and B's own audience still records the signup.
func TestAFormSignupNeverWritesAListmonkSharedWithAnotherWorkspace(t *testing.T) {
	e := buildFormsSignupE2E(t, true)
	otherTenant := uuid.NewString()
	seedE2ETenant(t, e.pool, otherTenant)
	email := "shared-" + uuid.NewString()[:8] + "@example.test"
	e.engine.SeedSubscriber(email, "Workspace A's customer", listmonkv6.StatusDisabled,
		map[string]any{"plan": "gold"}, map[int64]string{5: listmonkv6.SubscriptionUnsubscribed})
	before, _ := e.engine.Subscriber(email)
	seeded := len(e.engine.Requests())

	if rec := e.submit(e.soiFormID, email); rec.Code != http.StatusOK {
		t.Fatalf("submit = %d %s", rec.Code, rec.Body.String())
	}
	e.drain()

	if got := e.engine.Requests()[seeded:]; len(got) != 0 {
		t.Fatalf("a shared Listmonk received %d request(s) from another workspace's form, first %s %s",
			len(got), got[0].Method, got[0].Path)
	}
	if after, _ := e.engine.Subscriber(email); !reflect.DeepEqual(after, before) {
		t.Fatalf("workspace A's Listmonk subscriber changed:\n got %+v\nwant %+v", after, before)
	}
	if got := e.audienceOf(email); got.status != subscribers.StatusEnabled || !reflect.DeepEqual(got.members, []string{email + "/form"}) {
		t.Fatalf("workspace B's audience = %+v, want the signup enabled and in the form's list", got)
	}
}

// The production recipient guard: a double opt-in confirmation is never sent
// to an address that hard-bounced or was erased, and is sent to one that
// unsubscribed, because confirming is how that person comes back.
func TestAConfirmationEmailSkipsBouncedAndErasedAddresses(t *testing.T) {
	e := newFormsSignupE2E(t)
	suffix := uuid.NewString()[:8]
	bounced, erased, unsubscribed := "bounced-"+suffix+"@example.test", "erased-"+suffix+"@example.test", "left-"+suffix+"@example.test"
	e.suppress(bounced, "hard_bounce", `{}`)
	// Erased after unsubscribing: the opt-out row alone would let the
	// confirmation through, the erasure tombstone (as a privacy deletion
	// writes it) must not.
	e.suppress(erased, "global_unsubscribe", `{}`)
	e.suppress(erased, "manual", `{"gdpr_erasure": true}`)
	e.suppress(unsubscribed, "global_unsubscribe", `{}`)

	for _, email := range []string{bounced, erased, unsubscribed} {
		if rec := e.submit(e.doiFormID, email); rec.Code != http.StatusOK {
			t.Fatalf("submit %s = %d %s", email, rec.Code, rec.Body.String())
		}
	}
	e.drain()

	messages := e.mailer.messages()
	if len(messages) != 1 || messages[0].To != unsubscribed {
		t.Fatalf("confirmation emails = %+v, want exactly one, to the unsubscribed address", messages)
	}
	for email, want := range map[string]forms.ConfirmationEmailState{
		bounced: forms.ConfirmationEmailRecipientSuppressed, erased: forms.ConfirmationEmailRecipientSuppressed,
		unsubscribed: forms.ConfirmationEmailSent,
	} {
		if got := e.confirmationEmailState(email); got != want {
			t.Errorf("%s confirmation email state = %q, want %q", email, got, want)
		}
	}
}

func (e *formsSignupE2E) suppress(email, reason, metadata string) {
	e.t.Helper()
	tx, err := db.WithTenant(e.t.Context(), e.pool, e.tenantID)
	if err != nil {
		e.t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(e.t.Context()) }()
	if _, err := tx.Exec(e.t.Context(), `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, $3, 'test', $4::jsonb)`, e.tenantID, email, reason, metadata); err != nil {
		e.t.Fatalf("suppress %s: %v", email, err)
	}
	if err := tx.Commit(e.t.Context()); err != nil {
		e.t.Fatalf("commit suppression: %v", err)
	}
}

func (e *formsSignupE2E) confirmationEmailState(email string) forms.ConfirmationEmailState {
	e.t.Helper()
	tx, err := db.WithTenant(e.t.Context(), e.pool, e.tenantID)
	if err != nil {
		e.t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(e.t.Context()) }()
	var state string
	if err := tx.QueryRow(e.t.Context(), `
SELECT COALESCE(confirmation_email_state, '') FROM form_submissions
 WHERE tenant_id = $1::uuid AND email = $2`, e.tenantID, email).Scan(&state); err != nil {
		e.t.Fatalf("read confirmation state for %s: %v", email, err)
	}
	return forms.ConfirmationEmailState(state)
}

// seedE2ETenant adds a workspace for the duration of the test.
func seedE2ETenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	tx, err := db.WithTenant(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if _, err := tx.Exec(t.Context(), `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'other workspace', 'studio')`,
		tenantID, "other-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			t.Errorf("cleanup tx: %v", err)
			return
		}
		defer func() { _ = cleanup.Rollback(context.Background()) }()
		if _, err := cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err == nil {
			_ = cleanup.Commit(context.Background())
		}
	})
}

// Double opt-in: until the emailed link is clicked the visitor is an
// unconfirmed subscriber with a pending submission and is in no list and no
// audience; the click enables them with double opt-in consent and joins them
// to the list, in Moosewave and in Listmonk.
func TestADoubleOptInSignupJoinsTheListWhenTheEmailedLinkIsClicked(t *testing.T) {
	e := newFormsSignupE2E(t)
	email := "doi-" + uuid.NewString()[:8] + "@example.test"

	rec := e.submit(e.doiFormID, email)
	if want := `{"ok":true,"state":"pending-confirmation","message":"Thanks for signing up"}` + "\n"; rec.Code != http.StatusOK || rec.Body.String() != want {
		t.Fatalf("submit = %d %q, want 200 %q", rec.Code, rec.Body.String(), want)
	}
	e.drain()
	pending := e.audienceOf(email)
	if pending.status != subscribers.StatusUnconfirmed || pending.marketingConsented ||
		len(pending.members) != 0 || len(pending.audience) != 0 ||
		!reflect.DeepEqual(pending.submissions, []forms.SubmissionStatus{forms.SubmissionPending}) {
		t.Fatalf("before confirmation: %+v", pending)
	}
	messages := e.mailer.messages()
	if len(messages) != 1 || messages[0].To != email {
		t.Fatalf("confirmation emails = %+v, want one to %s", messages, email)
	}
	token := e.tokenFor(email)
	if link := "https://forms.example.test/forms/launch-" + e.doiFormID[:8] + "/confirm/" + token; !strings.Contains(messages[0].HTMLBody, `href="`+link+`"`) {
		t.Fatalf("the email does not link to %s:\n%s", link, messages[0].HTMLBody)
	}

	if confirmed := e.confirm(token); confirmed.Code != http.StatusOK || !strings.Contains(confirmed.Body.String(), `"state":"confirmed"`) {
		t.Fatalf("confirm = %d %s", confirmed.Code, confirmed.Body.String())
	}
	e.drain()
	got := e.audienceOf(email)
	want := e2eAudience{
		status: subscribers.StatusEnabled, consentSource: subscribers.ConsentDoubleOptIn,
		signupSource: subscribers.SignupSourceHostedPage, marketingConsented: true,
		members: []string{email + "/form"}, audience: []string{email},
		submissions: []forms.SubmissionStatus{forms.SubmissionConfirmed},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("after confirmation:\n got %+v\nwant %+v", got, want)
	}
	engineSub, _ := e.engine.Subscriber(email)
	if engineSub.Status != listmonkv6.StatusEnabled ||
		!reflect.DeepEqual(engineSub.Lists, map[int64]string{e2eEngineListID: listmonkv6.SubscriptionConfirmed}) {
		t.Fatalf("Listmonk = %+v, want enabled with list 7 confirmed", engineSub)
	}
	if n := e.engine.OptinMailsSent(); n != 0 {
		t.Fatalf("Listmonk would have mailed %d opt-in requests of its own", n)
	}
}

// An address already known to Moosewave and Listmonk joins the form's list;
// its other Listmonk subscription survives the form and the engine sync.
func TestAKnownAddressJoinsTheFormsListAndKeepsItsOtherSubscriptions(t *testing.T) {
	e := newFormsSignupE2E(t)
	email := "known-" + uuid.NewString()[:8] + "@example.test"
	if _, err := e.subscribers.Upsert(e.t.Context(), e.tenantID, subscribers.CreateInput{Email: email}); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	e.engine.SeedSubscriber(email, "Known", listmonkv6.StatusDisabled, map[string]any{"plan": "pro"},
		map[int64]string{5: listmonkv6.SubscriptionConfirmed})

	if rec := e.submit(e.soiFormID, email); rec.Code != http.StatusOK {
		t.Fatalf("submit = %d %s", rec.Code, rec.Body.String())
	}
	e.drain()
	got := e.audienceOf(email)
	if got.status != subscribers.StatusEnabled || !reflect.DeepEqual(got.members, []string{email + "/form"}) ||
		!reflect.DeepEqual(got.audience, []string{email}) {
		t.Fatalf("known address after signup: %+v", got)
	}
	engineSub, _ := e.engine.Subscriber(email)
	wantLists := map[int64]string{5: listmonkv6.SubscriptionConfirmed, e2eEngineListID: listmonkv6.SubscriptionConfirmed}
	if engineSub.Status != listmonkv6.StatusEnabled || !reflect.DeepEqual(engineSub.Lists, wantLists) || engineSub.Attribs["plan"] != "pro" {
		t.Fatalf("Listmonk = %+v, want enabled on %v with attribs kept", engineSub, wantLists)
	}
}

func (e *formsSignupE2E) signupSourceOf(subscriberID string) string {
	e.t.Helper()
	ctx := e.t.Context()
	tx, err := db.WithTenant(ctx, e.pool, e.tenantID)
	if err != nil {
		e.t.Fatalf("tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var source string
	if err := tx.QueryRow(ctx, `SELECT signup_source FROM subscribers WHERE id = $1::uuid`, subscriberID).Scan(&source); err != nil {
		e.t.Fatalf("signup_source: %v", err)
	}
	return source
}

func (e *formsSignupE2E) tokenFor(email string) string {
	e.t.Helper()
	ctx := e.t.Context()
	tx, err := db.WithTenant(ctx, e.pool, e.tenantID)
	if err != nil {
		e.t.Fatalf("tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var token string
	if err := tx.QueryRow(ctx, `SELECT confirmation_token FROM form_submissions WHERE email = $1 AND status = 'pending'`, email).Scan(&token); err != nil {
		e.t.Fatalf("read token: %v", err)
	}
	return token
}

type e2eEngineResolver struct {
	tenantID string
	engine   subscribers.Engine
}

func (r e2eEngineResolver) Acquire(_ context.Context, tenantID string) (subscribers.EngineLease, error) {
	if tenantID != r.tenantID {
		return nil, subscribers.ErrGlobalEngineRequiresSingleTenant
	}
	return e2eEngineLease{engine: r.engine}, nil
}

type e2eEngineLease struct{ engine subscribers.Engine }

func (l e2eEngineLease) Engine() subscribers.Engine { return l.engine }
func (e2eEngineLease) Close() error                 { return nil }

type e2eRecordingMailer struct {
	mu   sync.Mutex
	sent []mailer.Message
}

func (m *e2eRecordingMailer) Send(_ context.Context, msg mailer.Message) error {
	if err := msg.Validate(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, msg)
	return nil
}

func (m *e2eRecordingMailer) messages() []mailer.Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]mailer.Message(nil), m.sent...)
}

// The outbox worker starts before main has built the form handlers'
// dependencies. A confirmation email that arrives in between fails and is
// retried; it is never acknowledged unsent.
func TestAConfirmationEmailBeforeTheFormsAreWiredIsRetried(t *testing.T) {
	delivery := &formsConfirmationDelivery{}
	if err := delivery.handle(context.Background(), outbox.Event{Kind: forms.OutboxKindSendConfirmation, TenantID: uuid.NewString(), Payload: []byte(`{}`)}); err == nil {
		t.Fatal("an unbound confirmation delivery acknowledged the event")
	}
}
