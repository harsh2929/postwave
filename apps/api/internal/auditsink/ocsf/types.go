// SPDX-License-Identifier: AGPL-3.0-only
//
// Package ocsf implements OCSF 1.8 event mapping for audit_log rows.
//
// OCSF (Open Cybersecurity Schema Framework) v1.8 is the lingua franca
// for SIEM ingestion as of 2026. Splunk, Datadog Cloud SIEM, Microsoft
// Sentinel Data Lake, AWS Security Lake, Google SecOps, and SentinelOne
// all consume OCSF natively. Without this mapping our proprietary JSON
// envelope is shadow-banned by detection-engineering teams who refuse
// to maintain per-vendor parsers.
//
// This file declares the Go types that marshal to valid OCSF JSON.
// We hand-roll the structs rather than depend on the (very large)
// upstream `ocsf-schema` repo so the audit-sink path stays free of
// transitive dependencies.
//
// References:
//   - https://schema.ocsf.io/1.8.0/
//   - Event class catalog (numeric class_uid):
//     3001  Account Change            (iam category)
//     3002  Authentication            (iam category)
//     3004  Entity Management         (iam category)
//     6003  API Activity              (application activity)
//     7001  Operating System Patch    (not used; placeholder for future AI ops)
//
// We always emit `metadata.version="1.8.0"` and `metadata.product` set
// to Moosewave so downstream parsers can filter on origin.
package ocsf

// Event is the top-level OCSF envelope. All event classes share these
// fields. Class-specific fields are added via the embedded *Class
// pointer fields below — only one is set per row.
type Event struct {
	// Required: numeric class id (see header comment).
	ClassUID int `json:"class_uid"`
	// Human-readable class name (mirrors ClassUID).
	ClassName string `json:"class_name"`
	// Required: category UID (1=System Activity, 2=Findings,
	// 3=IAM, 4=Network, 5=Discovery, 6=Application Activity, 7=Detection).
	CategoryUID int `json:"category_uid"`
	// Human-readable category name.
	CategoryName string `json:"category_name"`
	// Required: numeric activity id within the class. Each class has
	// its own activity catalog.
	ActivityID int `json:"activity_id"`
	// Human-readable activity name.
	ActivityName string `json:"activity_name"`
	// Required: numeric type id = class_uid * 100 + activity_id.
	TypeUID int `json:"type_uid"`
	// Human-readable type id name.
	TypeName string `json:"type_name"`
	// Required: severity (0=Unknown,1=Informational,2=Low,3=Medium,
	// 4=High,5=Critical,6=Fatal).
	SeverityID int    `json:"severity_id"`
	Severity   string `json:"severity"`
	// Required: outcome status (0=Unknown,1=Success,2=Failure).
	StatusID int    `json:"status_id"`
	Status   string `json:"status"`
	// Required: event observation time (unix milliseconds).
	Time int64 `json:"time"`

	// OCSF metadata envelope. Schema version, product, originating
	// labels — used by SIEM routers to dispatch by source.
	Metadata Metadata `json:"metadata"`

	// Actor (the user / service / api-key that performed the action).
	Actor Actor `json:"actor"`

	// Source endpoint (IP, user agent).
	SrcEndpoint *Endpoint `json:"src_endpoint,omitempty"`

	// Pass-through bag for tenant-scoped attributes the SIEM may want
	// to pivot on but that aren't part of the formal OCSF schema.
	Unmapped map[string]any `json:"unmapped,omitempty"`

	// Free-form message, helpful for analyst eyeballing in raw views.
	Message string `json:"message,omitempty"`

	// --- class-specific extensions ---
	// At most one of these is non-nil per event.
	Authentication *Authentication `json:"-"`
	AccountChange  *AccountChange  `json:"-"`
	EntityManage   *EntityManage   `json:"-"`
	APIActivity    *APIActivity    `json:"-"`
}

// Metadata describes the OCSF envelope.
type Metadata struct {
	Version string  `json:"version"`
	Product Product `json:"product"`
	// Original native event for round-trip / debugging.
	OriginalTime int64 `json:"original_time,omitempty"`
	// Vendor-defined logging tier (e.g. "tenant_audit").
	LogName string `json:"log_name,omitempty"`
	// Required by OCSF for chain-of-custody.
	Profiles []string `json:"profiles,omitempty"`
}

// Product is the OCSF product object.
type Product struct {
	Name       string `json:"name"`
	Vendor     string `json:"vendor_name"`
	VersionRaw string `json:"version,omitempty"`
}

// Actor is the OCSF actor object — who initiated the action.
type Actor struct {
	User    *User    `json:"user,omitempty"`
	Session *Session `json:"session,omitempty"`
}

// User identifies the principal.
type User struct {
	UID       string `json:"uid,omitempty"`
	Name      string `json:"name,omitempty"`
	EmailAddr string `json:"email_addr,omitempty"`
	Type      string `json:"type,omitempty"`    // User | System | Admin | Service
	TypeID    int    `json:"type_id,omitempty"` // 1=User,2=Admin,3=System,4=Other
	Account   string `json:"account_uid,omitempty"`
}

// Session captures the auth context.
type Session struct {
	UID string `json:"uid,omitempty"`
}

// Endpoint describes a network source.
type Endpoint struct {
	IP        string `json:"ip,omitempty"`
	UserAgent string `json:"hostname,omitempty"` // OCSF uses hostname; we shove UA here for grep
}

// Authentication class (3002) — login / logout / api-key use.
type Authentication struct {
	AuthProtocol   string `json:"auth_protocol,omitempty"`
	AuthProtocolID int    `json:"auth_protocol_id,omitempty"`
	LogonType      string `json:"logon_type,omitempty"`
	LogonTypeID    int    `json:"logon_type_id,omitempty"`
	IsCleartext    bool   `json:"is_cleartext,omitempty"`
	IsMFA          bool   `json:"is_mfa,omitempty"`
}

// AccountChange class (3001) — user role/perm/status changes.
type AccountChange struct {
	ChangeType   string `json:"change_type,omitempty"`
	ChangeTypeID int    `json:"change_type_id,omitempty"`
}

// EntityManage class (3004) — list/segment/subscriber CRUD.
type EntityManage struct {
	EntityType  string         `json:"entity_type,omitempty"`
	EntityUID   string         `json:"entity_uid,omitempty"`
	EntityName  string         `json:"entity_name,omitempty"`
	OperationID int            `json:"operation_id,omitempty"`
	Operation   string         `json:"operation,omitempty"`
	Attributes  map[string]any `json:"attributes,omitempty"`
}

// APIActivity class (6003) — REST API request observed by the platform.
type APIActivity struct {
	Operation    string `json:"operation,omitempty"`
	OperationID  int    `json:"operation_id,omitempty"`
	ResourceType string `json:"resource_type,omitempty"`
	ResourceUID  string `json:"resource_uid,omitempty"`
}
