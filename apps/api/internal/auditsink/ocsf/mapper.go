// SPDX-License-Identifier: AGPL-3.0-only

package ocsf

import (
	"encoding/json"
	"strings"
	"time"
)

// AuditRow mirrors auditsink.AuditRow without importing the package
// (avoids an import cycle when callers want to map and then re-serialize
// independently of the sink wiring).
type AuditRow struct {
	ID           int64
	TenantID     string
	UserID       string
	Action       string
	ResourceType string
	ResourceID   string
	Metadata     map[string]any
	IP           string
	UserAgent    string
	ActorType    string
	ActorLabel   string
	At           time.Time
	RowHash      string
	PrevHash     string
}

// Map translates a single audit row to a fully populated OCSF Event.
// Never returns nil; for unknown actions it falls back to APIActivity
// (class 6003) so downstream consumers always receive a parseable
// envelope.
func Map(r AuditRow) Event {
	action := strings.ToLower(strings.TrimSpace(r.Action))
	evt := baseEvent(r)

	switch {
	case isAuthAction(action):
		mapAuthentication(action, r, &evt)
	case isAccountChange(action):
		mapAccountChange(action, r, &evt)
	case isEntityManage(action):
		mapEntityManagement(action, r, &evt)
	default:
		mapAPIActivity(action, r, &evt)
	}

	return evt
}

// MapBatch converts a slice of rows. Convenience wrapper; preserves
// input order so downstream sinks can keep their cursor semantics.
func MapBatch(rows []AuditRow) []Event {
	out := make([]Event, len(rows))
	for i, r := range rows {
		out[i] = Map(r)
	}
	return out
}

// MarshalNDJSON renders the batch as newline-delimited JSON — the
// format Splunk HEC and many SIEM intake endpoints expect for OCSF
// event streams.
func MarshalNDJSON(events []Event) ([]byte, error) {
	var buf strings.Builder
	enc := json.NewEncoder(jsonWriter{&buf})
	enc.SetEscapeHTML(false)
	for _, e := range events {
		if err := enc.Encode(flatten(e)); err != nil {
			return nil, err
		}
	}
	return []byte(buf.String()), nil
}

// jsonWriter adapts a strings.Builder to io.Writer for json.NewEncoder.
type jsonWriter struct{ b *strings.Builder }

func (w jsonWriter) Write(p []byte) (int, error) {
	return w.b.Write(p)
}

// flatten lifts the class-specific extension struct into the OCSF
// envelope per the schema (e.g. authentication fields live as siblings
// of class_uid, not nested under "authentication"). Returns a
// map[string]any so we can splice in the active class without breaking
// JSON ordering.
func flatten(e Event) map[string]any {
	raw, _ := json.Marshal(e)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)

	if e.Authentication != nil {
		spliceClass(m, e.Authentication)
	}
	if e.AccountChange != nil {
		spliceClass(m, e.AccountChange)
	}
	if e.EntityManage != nil {
		spliceClass(m, e.EntityManage)
	}
	if e.APIActivity != nil {
		spliceClass(m, e.APIActivity)
	}
	return m
}

func spliceClass(m map[string]any, v any) {
	raw, _ := json.Marshal(v)
	var sub map[string]any
	if err := json.Unmarshal(raw, &sub); err != nil {
		return
	}
	for k, val := range sub {
		// Don't overwrite envelope keys.
		if _, exists := m[k]; exists {
			continue
		}
		m[k] = val
	}
}

// baseEvent builds the OCSF envelope minus the class-specific extension.
// The caller (mapAuthentication / mapEntityManagement / …) fills in
// ClassUID + activity + extension pointer.
func baseEvent(r AuditRow) Event {
	sev, sevID := severityFor(r.Action, r.Metadata)
	status, statusID := statusFor(r.Action, r.Metadata)
	evt := Event{
		Severity:   sev,
		SeverityID: sevID,
		Status:     status,
		StatusID:   statusID,
		Time:       r.At.UnixMilli(),
		Metadata: Metadata{
			Version: "1.8.0",
			Product: Product{
				Name:       "Moosewave",
				Vendor:     "Moosewave Inc.",
				VersionRaw: "audit-1",
			},
			OriginalTime: r.At.UnixMilli(),
			LogName:      "postwave.audit_log",
			Profiles:     []string{"cloud", "datetime"},
		},
		Actor: Actor{
			User: actorUser(r),
		},
		Unmapped: map[string]any{
			"postwave_tenant_id":     r.TenantID,
			"postwave_audit_id":      r.ID,
			"postwave_action":        r.Action,
			"postwave_resource_type": r.ResourceType,
			"postwave_resource_id":   r.ResourceID,
			"postwave_row_hash":      r.RowHash,
			"postwave_prev_hash":     r.PrevHash,
			"postwave_actor_type":    r.ActorType,
		},
		Message: humanMessage(r),
	}
	if r.IP != "" || r.UserAgent != "" {
		evt.SrcEndpoint = &Endpoint{IP: r.IP, UserAgent: r.UserAgent}
	}
	if len(r.Metadata) > 0 {
		// Mirror metadata under unmapped["metadata"] so downstream
		// detection logic doesn't have to chase two locations.
		evt.Unmapped["postwave_metadata"] = r.Metadata
	}
	return evt
}

func actorUser(r AuditRow) *User {
	u := &User{UID: r.UserID, Name: r.ActorLabel}
	if strings.Contains(r.ActorLabel, "@") {
		u.EmailAddr = r.ActorLabel
	}
	switch strings.ToLower(r.ActorType) {
	case "system", "worker":
		u.Type = "System"
		u.TypeID = 3
	case "service", "api_key", "apikey", "machine":
		u.Type = "Service"
		u.TypeID = 4
	case "admin":
		u.Type = "Admin"
		u.TypeID = 2
	default:
		u.Type = "User"
		u.TypeID = 1
	}
	u.Account = r.TenantID
	return u
}

func humanMessage(r AuditRow) string {
	actor := r.ActorLabel
	if actor == "" {
		actor = r.UserID
	}
	if actor == "" {
		actor = "system"
	}
	if r.ResourceID != "" {
		return r.Action + " by " + actor + " on " + r.ResourceType + ":" + r.ResourceID
	}
	return r.Action + " by " + actor
}

// --- Action → class routing helpers. Moosewave actions are dotted
// names like `subscriber.create`, `api_key.rotate`, `auth.login`. We
// route by prefix where possible to make adding new actions painless.

func isAuthAction(a string) bool {
	return strings.HasPrefix(a, "auth.") ||
		strings.HasPrefix(a, "session.") ||
		a == "login" || a == "logout" || a == "mfa.verify" ||
		strings.HasPrefix(a, "api_key.use")
}

func isAccountChange(a string) bool {
	return strings.HasPrefix(a, "user.") ||
		strings.HasPrefix(a, "role.") ||
		strings.HasPrefix(a, "team.") ||
		strings.HasPrefix(a, "scim.") ||
		strings.HasPrefix(a, "api_key.")
}

// Entity management covers tenant data CRUD operations that an admin
// or operator performs (lists, segments, subscribers, etc).
func isEntityManage(a string) bool {
	knownPrefixes := []string{
		"subscriber.", "list.", "segment.", "tag.",
		"template.", "campaign.", "sequence.", "automation.",
		"export.", "import.", "audit_sink.", "webhook.",
	}
	for _, p := range knownPrefixes {
		if strings.HasPrefix(a, p) {
			return true
		}
	}
	return false
}

// --- per-class population.

func mapAuthentication(action string, r AuditRow, evt *Event) {
	evt.ClassUID = 3002
	evt.ClassName = "Authentication"
	evt.CategoryUID = 3
	evt.CategoryName = "Identity & Access Management"

	activityID, activityName := authActivity(action, r.Metadata)
	evt.ActivityID = activityID
	evt.ActivityName = activityName
	evt.TypeUID = evt.ClassUID*100 + activityID
	evt.TypeName = "Authentication: " + activityName

	auth := &Authentication{}
	if v, ok := r.Metadata["mfa"].(bool); ok {
		auth.IsMFA = v
	}
	if v, ok := r.Metadata["protocol"].(string); ok {
		auth.AuthProtocol = v
		auth.AuthProtocolID = authProtocolID(v)
	}
	// Default: assume not cleartext (we never serve over HTTP).
	auth.IsCleartext = false
	if strings.Contains(action, "api_key") {
		auth.LogonType = "Network"
		auth.LogonTypeID = 3
	} else {
		auth.LogonType = "Interactive"
		auth.LogonTypeID = 2
	}
	evt.Authentication = auth
}

func authActivity(action string, _ map[string]any) (int, string) {
	switch {
	case strings.HasSuffix(action, "login") || action == "auth.login":
		return 1, "Logon"
	case strings.HasSuffix(action, "logout") || action == "auth.logout":
		return 2, "Logoff"
	case strings.Contains(action, "failed"):
		return 99, "Other"
	case strings.HasPrefix(action, "api_key."):
		return 4, "Authentication Ticket"
	case strings.HasPrefix(action, "mfa."):
		return 1, "Logon"
	}
	return 99, "Other"
}

func authProtocolID(name string) int {
	switch strings.ToLower(name) {
	case "oauth2", "oauth":
		return 6
	case "saml":
		return 4
	case "oidc":
		return 6
	case "scim":
		return 99
	case "password":
		return 1
	case "api_key":
		return 99
	}
	return 0
}

func mapAccountChange(action string, r AuditRow, evt *Event) {
	evt.ClassUID = 3001
	evt.ClassName = "Account Change"
	evt.CategoryUID = 3
	evt.CategoryName = "Identity & Access Management"

	activityID, activityName := accountChangeActivity(action)
	evt.ActivityID = activityID
	evt.ActivityName = activityName
	evt.TypeUID = evt.ClassUID*100 + activityID
	evt.TypeName = "Account Change: " + activityName

	ac := &AccountChange{
		ChangeType:   activityName,
		ChangeTypeID: activityID,
	}
	evt.AccountChange = ac
}

func accountChangeActivity(action string) (int, string) {
	switch {
	case strings.HasSuffix(action, ".create") || strings.HasSuffix(action, ".invite"):
		return 1, "Create"
	case strings.HasSuffix(action, ".enable") || strings.HasSuffix(action, ".unlock"):
		return 2, "Enable"
	case strings.HasSuffix(action, ".disable") || strings.HasSuffix(action, ".lock"):
		return 3, "Disable"
	case strings.HasSuffix(action, ".delete") || strings.HasSuffix(action, ".remove"):
		return 6, "Delete"
	case strings.HasSuffix(action, ".update") ||
		strings.HasSuffix(action, ".rename") ||
		strings.HasSuffix(action, ".rotate"):
		return 7, "Change"
	case strings.HasSuffix(action, ".assign") || strings.Contains(action, "role"):
		return 8, "Attach Policy"
	}
	return 99, "Other"
}

func mapEntityManagement(action string, r AuditRow, evt *Event) {
	evt.ClassUID = 3004
	evt.ClassName = "Entity Management"
	evt.CategoryUID = 3
	evt.CategoryName = "Identity & Access Management"

	activityID, activityName := entityActivity(action)
	evt.ActivityID = activityID
	evt.ActivityName = activityName
	evt.TypeUID = evt.ClassUID*100 + activityID
	evt.TypeName = "Entity Management: " + activityName

	em := &EntityManage{
		EntityType:  r.ResourceType,
		EntityUID:   r.ResourceID,
		OperationID: activityID,
		Operation:   activityName,
		Attributes:  r.Metadata,
	}
	if name, ok := r.Metadata["name"].(string); ok {
		em.EntityName = name
	}
	evt.EntityManage = em
}

func entityActivity(action string) (int, string) {
	switch {
	case strings.HasSuffix(action, ".create") || strings.HasSuffix(action, ".add"):
		return 1, "Create"
	case strings.HasSuffix(action, ".update") ||
		strings.HasSuffix(action, ".rename") ||
		strings.HasSuffix(action, ".patch"):
		return 3, "Update"
	case strings.HasSuffix(action, ".delete") || strings.HasSuffix(action, ".remove"):
		return 4, "Delete"
	case strings.HasSuffix(action, ".export"):
		return 5, "Export"
	case strings.HasSuffix(action, ".import"):
		return 6, "Import"
	}
	return 99, "Other"
}

func mapAPIActivity(action string, r AuditRow, evt *Event) {
	evt.ClassUID = 6003
	evt.ClassName = "API Activity"
	evt.CategoryUID = 6
	evt.CategoryName = "Application Activity"

	activityID, activityName := apiActivity(action)
	evt.ActivityID = activityID
	evt.ActivityName = activityName
	evt.TypeUID = evt.ClassUID*100 + activityID
	evt.TypeName = "API Activity: " + activityName

	evt.APIActivity = &APIActivity{
		Operation:    action,
		OperationID:  activityID,
		ResourceType: r.ResourceType,
		ResourceUID:  r.ResourceID,
	}
}

func apiActivity(action string) (int, string) {
	switch {
	case strings.Contains(action, "read") || strings.Contains(action, "list") || strings.Contains(action, "get"):
		return 1, "Read"
	case strings.Contains(action, "create") || strings.Contains(action, "add"):
		return 2, "Create"
	case strings.Contains(action, "update") || strings.Contains(action, "rotate") || strings.Contains(action, "patch"):
		return 3, "Update"
	case strings.Contains(action, "delete") || strings.Contains(action, "remove"):
		return 4, "Delete"
	}
	return 99, "Other"
}

// severityFor encodes operational judgement: destructive operations
// and security-sensitive flips are Medium-or-higher, reads are
// Informational. This drives the SIEM's noise-filter logic.
func severityFor(action string, meta map[string]any) (string, int) {
	a := strings.ToLower(action)
	switch {
	case strings.Contains(a, "delete") || strings.Contains(a, "remove"):
		return "High", 4
	case strings.Contains(a, "export"):
		return "Medium", 3
	case strings.Contains(a, "failed") || strings.Contains(a, "denied"):
		return "Medium", 3
	case strings.Contains(a, "rotate") || strings.Contains(a, "lock") || strings.Contains(a, "disable"):
		return "Medium", 3
	case strings.Contains(a, "login") || strings.Contains(a, "logout"):
		if _, ok := meta["failed"]; ok {
			return "Medium", 3
		}
		return "Informational", 1
	}
	return "Informational", 1
}

func statusFor(action string, meta map[string]any) (string, int) {
	a := strings.ToLower(action)
	if strings.Contains(a, "failed") || strings.Contains(a, "denied") {
		return "Failure", 2
	}
	if v, ok := meta["success"].(bool); ok {
		if v {
			return "Success", 1
		}
		return "Failure", 2
	}
	return "Success", 1
}
