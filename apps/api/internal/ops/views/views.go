// Package views serves the ops console's read-only, cross-tenant data views.
// Every query runs platform-scoped (raw ops pool, no per-tenant RLS) — the same
// way the existing check probes read cross-tenant — and returns tenant_id on
// each row. Nothing here mutates: operator actions go through the audited action
// path in internal/ops, never through a view.
package views

// TenantHealth is the at-a-glance status shown in the directory.
type TenantHealth string

const (
	HealthOK        TenantHealth = "ok"
	HealthDunning   TenantHealth = "dunning"   // a payment is failing
	HealthSuspended TenantHealth = "suspended" // sending is paused
)

// DeriveTenantHealth reduces a tenant's operational flags to one badge.
// Suspended (sending paused) is the most severe and wins over dunning.
func DeriveTenantHealth(sendingPaused, dunning bool) TenantHealth {
	switch {
	case sendingPaused:
		return HealthSuspended
	case dunning:
		return HealthDunning
	default:
		return HealthOK
	}
}
