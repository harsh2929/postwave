// SPDX-License-Identifier: AGPL-3.0-only

// Package listmonkv6 is an in-process stand-in for the Listmonk v6.1.0 HTTP
// API that the deployment pins (listmonk/listmonk:v6.1.0@sha256:179d00d9…).
//
// It is test support only: _test.go files and other internal/testsupport
// packages may import it, and TestProductionCodeDoesNotImportTestSupport fails
// if shipped code does.
//
// # Why it exists
//
// Every Listmonk client test used to answer with bodies produced by encoding
// the client's own Go structs, so the tests could only ever agree with the
// client. Listmonk returns a subscriber's `lists` as an array of list objects,
// not ids; the struct said []int64, the fakes said []int64, and the first
// real signup to a list-targeted form failed after Listmonk had already
// committed it. This package answers with the bytes a real v6.1.0 container
// returned instead.
//
// # What is recorded and what is modelled
//
// The files under recorded/ are verbatim response bodies captured from the
// pinned image on an isolated network (the Recorded* names). Responses that
// carry data are rendered from those captures: the recorded JSON is decoded
// generically and only the values that depend on state (ids, email, name,
// status, attribs, memberships) are replaced, so every key, nesting level and
// type is the one Listmonk sends.
//
// The state transitions are modelled on the v6.1.0 source and were confirmed
// against the same container:
//   - POST /api/subscribers answers 409 for an existing address and never
//     adds lists to it.
//   - PUT /api/subscribers/:id replaces every subscription with the request's
//     `lists` (absent means none) and resets attribs to {} when they are
//     omitted.
//   - PATCH /api/subscribers/:id starts from the stored row, merges attribs,
//     and replaces subscriptions only when `lists` is present.
//   - PUT /api/subscribers/lists with action "add" and a status overwrites
//     any existing subscription status, including "unsubscribed".
//   - POST /api/tx answers 400 "template 0 not found" without a template id.
package listmonkv6

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

//go:embed recorded/*.json
var recordedFS embed.FS

// Recorded body names. Each is one response body captured from Listmonk v6.1.0.
const (
	RecordedCreateList                   = "create_list.json"
	RecordedCreateSubscriberWithList     = "create_subscriber_with_list.json"
	RecordedCreateSubscriberWithoutLists = "create_subscriber_without_lists.json"
	RecordedCreateSubscriberConflict     = "create_subscriber_conflict.json"
	RecordedQuerySubscribers             = "query_subscribers.json"
	RecordedManageSubscriberLists        = "manage_subscriber_lists.json"
	RecordedPatchSubscriber              = "patch_subscriber.json"
	RecordedPutSubscriber                = "put_subscriber.json"
	RecordedTxTemplateNotFound           = "tx_template_not_found.json"
	RecordedTxAccepted                   = "tx_accepted.json"
)

// Subscription statuses and subscriber statuses as Listmonk spells them.
const (
	SubscriptionUnconfirmed  = "unconfirmed"
	SubscriptionConfirmed    = "confirmed"
	SubscriptionUnsubscribed = "unsubscribed"

	StatusEnabled     = "enabled"
	StatusDisabled    = "disabled"
	StatusBlocklisted = "blocklisted"
)

// Recorded returns the verbatim bytes of one captured response body. It
// panics on an unknown name so a typo fails the test that made it.
func Recorded(name string) []byte {
	raw, err := recordedFS.ReadFile("recorded/" + name)
	if err != nil {
		panic(fmt.Sprintf("listmonkv6: no recorded body %q: %v", name, err))
	}
	return bytes.TrimRight(raw, "\n")
}

// List is a Listmonk list the server knows. Optin is "single" or "double".
type List struct {
	ID    int64
	Name  string
	Optin string
}

// Subscriber is a snapshot of one stored subscriber.
type Subscriber struct {
	ID      int64
	Email   string
	Name    string
	Status  string
	Attribs map[string]any
	// Lists maps a list id to the subscription status.
	Lists map[int64]string
}

// Request is one request the server received.
type Request struct {
	Method   string
	Path     string
	RawQuery string
	Body     []byte
}

// Server is a stateful Listmonk v6.1.0 stand-in. Construct it with NewServer.
type Server struct {
	*httptest.Server

	mu          sync.Mutex
	nextID      int64
	subscribers map[int64]*Subscriber
	lists       map[int64]List
	requests    []Request
	optinMails  int
	failures    map[string][]int
}

// NewServer starts a server that is closed when the test ends. Lists 1 and 2
// exist from the start, as they do on a fresh v6.1.0 install ("Default list"
// and the double opt-in "Opt-in list").
func NewServer(t testing.TB) *Server {
	t.Helper()
	s := &Server{
		nextID:      100,
		subscribers: map[int64]*Subscriber{},
		lists: map[int64]List{
			1: {ID: 1, Name: "Default list", Optin: "single"},
			2: {ID: 2, Name: "Opt-in list", Optin: "double"},
		},
		failures: map[string][]int{},
	}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.Close)
	return s
}

// AddList registers a list. optin is "single" or "double".
func (s *Server) AddList(id int64, name, optin string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lists[id] = List{ID: id, Name: name, Optin: optin}
}

// SeedSubscriber stores a subscriber as if it had been created earlier and
// returns its id.
func (s *Server) SeedSubscriber(email, name, status string, attribs map[string]any, lists map[int64]string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	sub := &Subscriber{
		ID:      s.nextID,
		Email:   strings.ToLower(strings.TrimSpace(email)),
		Name:    name,
		Status:  status,
		Attribs: copyMap(attribs),
		Lists:   map[int64]string{},
	}
	for id, st := range lists {
		sub.Lists[id] = st
	}
	s.subscribers[sub.ID] = sub
	return sub.ID
}

// Subscriber returns a copy of the stored subscriber with this address.
func (s *Server) Subscriber(email string) (Subscriber, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sub := s.byEmailLocked(email)
	if sub == nil {
		return Subscriber{}, false
	}
	return cloneSubscriber(sub), true
}

// Requests returns every request received so far, in order.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.requests...)
}

// RequestsTo returns the requests received for one method and path.
func (s *Server) RequestsTo(method, path string) []Request {
	var out []Request
	for _, req := range s.Requests() {
		if req.Method == method && req.Path == path {
			out = append(out, req)
		}
	}
	return out
}

// OptinMailsSent counts the double opt-in emails Listmonk itself would have
// sent: a create without preconfirmed subscriptions that names a double
// opt-in list.
func (s *Server) OptinMailsSent() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.optinMails
}

// FailNext makes the next request for method and path answer with status and
// an empty JSON error instead of being handled. Repeated calls queue.
func (s *Server) FailNext(method, path string, status int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := method + " " + path
	s.failures[key] = append(s.failures[key], status)
}

var subscriberIDPath = regexp.MustCompile(`^/api/subscribers/([0-9]+)$`)

// maxRequestBytes bounds what the fake accepts. Real client requests are a
// few hundred bytes; anything past this is a test bug worth failing loudly.
const maxRequestBytes = 1 << 20

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, maxRequestBytes)
	if err != nil {
		writeRaw(w, http.StatusRequestEntityTooLarge, []byte(`{"message":"request body too large"}`))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, Request{
		Method: r.Method, Path: r.URL.Path, RawQuery: r.URL.RawQuery, Body: body,
	})
	if queued := s.failures[r.Method+" "+r.URL.Path]; len(queued) > 0 {
		s.failures[r.Method+" "+r.URL.Path] = queued[1:]
		writeRaw(w, queued[0], []byte(`{"message":"injected failure"}`))
		return
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/subscribers":
		s.createSubscriber(w, body)
	case r.Method == http.MethodGet && r.URL.Path == "/api/subscribers":
		s.querySubscribers(w, r.URL.Query().Get("query"))
	case r.Method == http.MethodPut && r.URL.Path == "/api/subscribers/lists":
		s.manageSubscriberLists(w, body)
	case r.Method == http.MethodPost && r.URL.Path == "/api/tx":
		s.transactional(w, body)
	case subscriberIDPath.MatchString(r.URL.Path):
		id, _ := strconv.ParseInt(subscriberIDPath.FindStringSubmatch(r.URL.Path)[1], 10, 64)
		s.subscriberByID(w, r.Method, id, body)
	default:
		writeRaw(w, http.StatusNotFound, []byte(`{"message":"Not found."}`))
	}
}

type subscriberBody struct {
	Email          *string         `json:"email"`
	Name           *string         `json:"name"`
	Status         *string         `json:"status"`
	Attribs        map[string]any  `json:"attribs"`
	Lists          json.RawMessage `json:"lists"`
	PreconfirmSubs bool            `json:"preconfirm_subscriptions"`
}

func (b subscriberBody) listIDs() ([]int64, bool, error) {
	if len(b.Lists) == 0 || string(b.Lists) == "null" {
		return nil, false, nil
	}
	var ids []int64
	if err := json.Unmarshal(b.Lists, &ids); err != nil {
		return nil, true, err
	}
	return ids, true, nil
}

func (s *Server) createSubscriber(w http.ResponseWriter, raw []byte) {
	var in subscriberBody
	if err := json.Unmarshal(raw, &in); err != nil || in.Email == nil || !plausibleEmail(*in.Email) {
		writeRaw(w, http.StatusBadRequest, []byte(`{"message":"Invalid email."}`))
		return
	}
	if s.byEmailLocked(*in.Email) != nil {
		writeRaw(w, http.StatusConflict, Recorded(RecordedCreateSubscriberConflict))
		return
	}
	ids, _, err := in.listIDs()
	if err != nil {
		writeRaw(w, http.StatusBadRequest, []byte(`{"message":"Invalid lists."}`))
		return
	}
	s.nextID++
	sub := &Subscriber{
		ID:      s.nextID,
		Email:   strings.ToLower(strings.TrimSpace(*in.Email)),
		Name:    deref(in.Name),
		Status:  deref(in.Status),
		Attribs: copyMap(in.Attribs),
		Lists:   map[int64]string{},
	}
	if sub.Status == "" {
		sub.Status = StatusEnabled
	}
	subscription := SubscriptionUnconfirmed
	if in.PreconfirmSubs {
		subscription = SubscriptionConfirmed
	}
	doubleOptin := false
	for _, id := range ids {
		if _, ok := s.lists[id]; !ok {
			continue
		}
		sub.Lists[id] = subscription
		if s.lists[id].Optin == "double" {
			doubleOptin = true
		}
	}
	if !in.PreconfirmSubs && doubleOptin {
		s.optinMails++
	}
	s.subscribers[sub.ID] = sub
	writeJSON(w, http.StatusOK, map[string]any{"data": s.renderSubscriberLocked(sub)})
}

func (s *Server) subscriberByID(w http.ResponseWriter, method string, id int64, raw []byte) {
	sub, ok := s.subscribers[id]
	if !ok {
		writeRaw(w, http.StatusNotFound, []byte(`{"message":"Subscriber not found."}`))
		return
	}
	switch method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"data": s.renderSubscriberLocked(sub)})
	case http.MethodDelete:
		delete(s.subscribers, id)
		writeRaw(w, http.StatusOK, Recorded(RecordedManageSubscriberLists))
	case http.MethodPut:
		s.updateSubscriber(w, sub, raw, true)
	case http.MethodPatch:
		s.updateSubscriber(w, sub, raw, false)
	default:
		writeRaw(w, http.StatusMethodNotAllowed, []byte(`{"message":"Method not allowed."}`))
	}
}

// updateSubscriber applies v6.1.0's UpdateSubscriber (put=true) or
// PatchSubscriber (put=false) followed by UpdateSubscriberWithLists.
func (s *Server) updateSubscriber(w http.ResponseWriter, sub *Subscriber, raw []byte, put bool) {
	var in subscriberBody
	if err := json.Unmarshal(raw, &in); err != nil {
		writeRaw(w, http.StatusBadRequest, []byte(`{"message":"Invalid request."}`))
		return
	}
	email := sub.Email
	if put || in.Email != nil {
		// PUT binds onto an empty struct, so a missing email is "". PATCH binds
		// onto the stored row, so only a present email replaces it.
		email = deref(in.Email)
	}
	if !plausibleEmail(email) {
		writeRaw(w, http.StatusBadRequest, []byte(`{"message":"Invalid email."}`))
		return
	}
	ids, listsPresent, err := in.listIDs()
	if err != nil {
		writeRaw(w, http.StatusBadRequest, []byte(`{"message":"Invalid lists."}`))
		return
	}
	var attribs map[string]any
	if put {
		// PUT: attribs are exactly the request's, and {} when omitted.
		attribs = copyMap(in.Attribs)
	} else {
		// PATCH: the request is decoded onto the stored row, and decoding a JSON
		// object into a non-nil map keeps the keys it does not mention.
		attribs = copyMap(sub.Attribs)
		for k, v := range in.Attribs {
			attribs[k] = v
		}
	}
	sub.Email = strings.ToLower(strings.TrimSpace(email))
	if name := strings.TrimSpace(deref(in.Name)); name != "" {
		sub.Name = name
	}
	if status := deref(in.Status); status != "" {
		sub.Status = status
	}
	sub.Attribs = attribs
	if put || listsPresent {
		subscription := SubscriptionUnconfirmed
		if in.PreconfirmSubs {
			subscription = SubscriptionConfirmed
		}
		next := map[int64]string{}
		for _, id := range ids {
			if _, ok := s.lists[id]; !ok {
				continue
			}
			switch current, had := sub.Lists[id]; {
			case sub.Status == StatusBlocklisted:
				next[id] = SubscriptionUnsubscribed
			case had && (current == SubscriptionConfirmed || current == SubscriptionUnsubscribed):
				next[id] = current
			default:
				next[id] = subscription
			}
		}
		sub.Lists = next
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": s.renderSubscriberLocked(sub)})
}

func (s *Server) querySubscribers(w http.ResponseWriter, query string) {
	results := []any{}
	if email, ok := emailFromQuery(query); ok {
		if sub := s.byEmailLocked(email); sub != nil {
			results = append(results, s.renderSubscriberLocked(sub))
		}
	}
	envelope := decodeRecorded(RecordedQuerySubscribers)
	data := envelope["data"].(map[string]any)
	data["results"] = results
	data["query"] = query
	data["total"] = len(results)
	writeJSON(w, http.StatusOK, envelope)
}

func (s *Server) manageSubscriberLists(w http.ResponseWriter, raw []byte) {
	var in struct {
		IDs           []int64 `json:"ids"`
		Action        string  `json:"action"`
		TargetListIDs []int64 `json:"target_list_ids"`
		Status        string  `json:"status"`
	}
	if err := json.Unmarshal(raw, &in); err != nil || len(in.IDs) == 0 {
		writeRaw(w, http.StatusBadRequest, []byte(`{"message":"No IDs given."}`))
		return
	}
	if len(in.TargetListIDs) == 0 {
		writeRaw(w, http.StatusBadRequest, []byte(`{"message":"No lists given."}`))
		return
	}
	for _, id := range in.IDs {
		sub, ok := s.subscribers[id]
		if !ok {
			continue
		}
		for _, listID := range in.TargetListIDs {
			if _, ok := s.lists[listID]; !ok {
				continue
			}
			switch in.Action {
			case "add":
				// add-subscribers-to-lists: insert with the status (default
				// unconfirmed); on conflict a given status overwrites whatever
				// the subscription was, "unsubscribed" included.
				current, had := sub.Lists[listID]
				switch {
				case in.Status != "":
					sub.Lists[listID] = in.Status
				case !had:
					sub.Lists[listID] = SubscriptionUnconfirmed
				default:
					sub.Lists[listID] = current
				}
			case "remove":
				delete(sub.Lists, listID)
			case "unsubscribe":
				if _, had := sub.Lists[listID]; had {
					sub.Lists[listID] = SubscriptionUnsubscribed
				}
			default:
				writeRaw(w, http.StatusBadRequest, []byte(`{"message":"Invalid action."}`))
				return
			}
		}
	}
	writeRaw(w, http.StatusOK, Recorded(RecordedManageSubscriberLists))
}

func (s *Server) transactional(w http.ResponseWriter, raw []byte) {
	var in struct {
		TemplateID int64 `json:"template_id"`
	}
	_ = json.Unmarshal(raw, &in)
	if in.TemplateID == 0 {
		writeRaw(w, http.StatusBadRequest, Recorded(RecordedTxTemplateNotFound))
		return
	}
	writeRaw(w, http.StatusOK, Recorded(RecordedTxAccepted))
}

// renderSubscriberLocked renders sub as the subscriber object inside the
// recorded create response: the recorded object supplies every key, and only
// state-dependent values are replaced.
func (s *Server) renderSubscriberLocked(sub *Subscriber) map[string]any {
	recorded := decodeRecorded(RecordedCreateSubscriberWithList)["data"].(map[string]any)
	listTemplate := recorded["lists"].([]any)[0].(map[string]any)
	recorded["id"] = sub.ID
	recorded["uuid"] = fmt.Sprintf("00000000-0000-4000-8000-%012d", sub.ID)
	recorded["email"] = sub.Email
	recorded["name"] = sub.Name
	recorded["status"] = sub.Status
	recorded["attribs"] = copyMap(sub.Attribs)
	ids := make([]int64, 0, len(sub.Lists))
	for id := range sub.Lists {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	lists := make([]any, 0, len(ids))
	for _, id := range ids {
		entry := make(map[string]any, len(listTemplate))
		for k, v := range listTemplate {
			entry[k] = v
		}
		list := s.lists[id]
		entry["id"] = id
		entry["uuid"] = fmt.Sprintf("00000000-0000-4000-9000-%012d", id)
		entry["name"] = list.Name
		entry["optin"] = list.Optin
		entry["subscription_status"] = sub.Lists[id]
		lists = append(lists, entry)
	}
	recorded["lists"] = lists
	return recorded
}

func (s *Server) byEmailLocked(email string) *Subscriber {
	email = strings.ToLower(strings.TrimSpace(email))
	for _, sub := range s.subscribers {
		if sub.Email == email {
			return sub
		}
	}
	return nil
}

// emailFromQuery extracts the address from the SQL-ish expression the API
// accepts, subscribers.email = 'a@example.com', in which a quote inside the
// address is written twice.
func emailFromQuery(query string) (string, bool) {
	const prefix = "subscribers.email = '"
	if !strings.HasPrefix(query, prefix) || !strings.HasSuffix(query, "'") {
		return "", false
	}
	return strings.ReplaceAll(query[len(prefix):len(query)-1], "''", "'"), true
}

func decodeRecorded(name string) map[string]any {
	var out map[string]any
	if err := json.Unmarshal(Recorded(name), &out); err != nil {
		panic(fmt.Sprintf("listmonkv6: recorded body %q is not a JSON object: %v", name, err))
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	raw, err := json.Marshal(body)
	if err != nil {
		writeRaw(w, http.StatusInternalServerError, []byte(`{"message":"encode"}`))
		return
	}
	writeRaw(w, status, raw)
}

func writeRaw(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func plausibleEmail(email string) bool {
	email = strings.TrimSpace(email)
	at := strings.IndexByte(email, '@')
	return at > 0 && at < len(email)-1
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func copyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func cloneSubscriber(sub *Subscriber) Subscriber {
	out := *sub
	out.Attribs = copyMap(sub.Attribs)
	out.Lists = make(map[int64]string, len(sub.Lists))
	for id, st := range sub.Lists {
		out.Lists[id] = st
	}
	return out
}
