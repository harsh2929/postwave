package orchestrator

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/postwave/migrate/canonical"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

const (
	mailchimpCustomFieldPlanCursorKey = "__postwave_mailchimp_custom_field_plan"
	mailchimpCustomFieldPlanDoneKey   = "__postwave_mailchimp_custom_field_plan_complete"
)

func loadMailchimpCustomFieldPlan(job *canonical.MigrationJob) map[string]string {
	out := map[string]string{}
	if job == nil || job.Cursor == nil || job.Cursor[mailchimpCustomFieldPlanCursorKey] == nil {
		return out
	}
	_ = json.Unmarshal([]byte(*job.Cursor[mailchimpCustomFieldPlanCursorKey]), &out)
	return out
}

func persistMailchimpCustomFieldPlan(job *canonical.MigrationJob, plan map[string]string, complete bool) error {
	if job == nil {
		return nil
	}
	raw, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	value := string(raw)
	job.Cursor[mailchimpCustomFieldPlanCursorKey] = &value
	done := "false"
	if complete {
		done = "true"
	}
	job.Cursor[mailchimpCustomFieldPlanDoneKey] = &done
	return nil
}

func mailchimpCustomFieldPlanComplete(job *canonical.MigrationJob) bool {
	if job == nil || job.Cursor == nil || job.Cursor[mailchimpCustomFieldPlanDoneKey] == nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(*job.Cursor[mailchimpCustomFieldPlanDoneKey]), "true")
}

// ResetMailchimpCustomFieldPlan starts a new review epoch. Fresh dry-runs call
// this; commit and recovery paths deliberately retain the completed plan they
// are bound to.
func ResetMailchimpCustomFieldPlan(job *canonical.MigrationJob) {
	if job == nil || job.Cursor == nil {
		return
	}
	delete(job.Cursor, mailchimpCustomFieldPlanCursorKey)
	delete(job.Cursor, mailchimpCustomFieldPlanDoneKey)
}

func mergeSubscriberCustomFieldPlan(plan map[string]string, subscriber canonical.Subscriber) error {
	return mergeImportedCustomFieldPlan(plan, subscriber, "Mailchimp merge/custom field", "cross-audience")
}

func mergeImportedCustomFieldPlan(plan map[string]string, subscriber canonical.Subscriber, label, conflictScope string) error {
	for key, observedType := range listmonkx.ImportedCustomFieldTypes(subscriber) {
		plannedType, exists := plan[key]
		if !exists || plannedType == "unknown" {
			plan[key] = observedType
			continue
		}
		if observedType == "unknown" || observedType == plannedType {
			continue
		}
		return fmt.Errorf("%s %q has incompatible %s types %s and %s; resolve or namespace the source schema before commit", label, key, conflictScope, plannedType, observedType)
	}
	return nil
}

func validateSubscriberAgainstCustomFieldPlan(plan map[string]string, subscriber canonical.Subscriber) error {
	return validateImportedSubscriberAgainstCustomFieldPlan(plan, subscriber, "Mailchimp merge/custom field")
}

func validateImportedSubscriberAgainstCustomFieldPlan(plan map[string]string, subscriber canonical.Subscriber, label string) error {
	for key, observedType := range listmonkx.ImportedCustomFieldTypes(subscriber) {
		plannedType, exists := plan[key]
		if !exists {
			return fmt.Errorf("%s %q appeared after the completed source-schema preflight; restart the migration from a frozen source snapshot", label, key)
		}
		if observedType == "unknown" {
			continue
		}
		if plannedType == "unknown" {
			plannedType = "string"
		}
		if observedType != plannedType {
			return fmt.Errorf("%s %q changed type after the completed source-schema preflight: planned %s, commit observed %s; restart the migration from a frozen source snapshot", label, key, plannedType, observedType)
		}
	}
	return nil
}
