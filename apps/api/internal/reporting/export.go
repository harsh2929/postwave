package reporting

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
)

// RunResultToJSON renders a completed report run as a JSON document: the run
// header plus the row array. Mirrors RunResultToCSV so the report-builder can
// offer both download formats from the same completed run.
func RunResultToJSON(run *ReportRun) ([]byte, error) {
	if run == nil {
		return nil, errors.New("run is nil")
	}
	if run.Status != "completed" {
		return nil, fmt.Errorf("run status is %q; only completed runs can be exported", run.Status)
	}
	rows := []any{}
	if rowsAny, ok := run.Result["rows"]; ok {
		if arr, ok := rowsAny.([]any); ok {
			rows = arr
		}
	}
	doc := map[string]any{
		"run_id":        run.ID,
		"definition_id": run.DefinitionID,
		"completed_at":  run.CompletedAt,
		"rows_total":    len(rows),
		"rows":          rows,
	}
	return json.MarshalIndent(doc, "", "  ")
}

// RunResultToCSV renders a completed report run as CSV. Columns are the
// union of keys found across all rows (metric/product_area/value first,
// then dimensions like day in stable order, then any extras). Rate-type
// rows preserve their numerator/denominator alongside the rate value so
// downstream pivots can re-aggregate without losing precision.
func RunResultToCSV(run *ReportRun) ([]byte, error) {
	if run == nil {
		return nil, errors.New("run is nil")
	}
	if run.Status != "completed" {
		return nil, fmt.Errorf("run status is %q; only completed runs can be exported", run.Status)
	}
	rowsAny, ok := run.Result["rows"]
	if !ok {
		return nil, errors.New("run result has no rows")
	}
	rows, ok := rowsAny.([]any)
	if !ok {
		return nil, errors.New("run result rows are not an array")
	}
	mapped := make([]map[string]any, 0, len(rows))
	for _, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		mapped = append(mapped, row)
	}
	headers := csvHeaders(mapped)
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	if err := w.Write(headers); err != nil {
		return nil, err
	}
	for _, row := range mapped {
		record := make([]string, len(headers))
		for i, key := range headers {
			record[i] = csvCellString(row[key])
		}
		if err := w.Write(record); err != nil {
			return nil, err
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// csvHeaders builds a stable column ordering across heterogeneous rows.
// The leading slots are the always-present fields; the rest are sorted
// alphabetically so the output stays deterministic for snapshot tests.
func csvHeaders(rows []map[string]any) []string {
	priority := []string{"metric", "product_area", "day", "value", "value_type", "numerator", "denominator", "denominator_zero"}
	seen := map[string]bool{}
	headers := []string{}
	for _, key := range priority {
		seen[key] = true
	}
	extra := map[string]struct{}{}
	for _, row := range rows {
		for k := range row {
			if !seen[k] {
				extra[k] = struct{}{}
			}
		}
	}
	for _, key := range priority {
		used := false
		for _, row := range rows {
			if _, ok := row[key]; ok {
				used = true
				break
			}
		}
		if used {
			headers = append(headers, key)
		}
	}
	sortedExtra := make([]string, 0, len(extra))
	for k := range extra {
		sortedExtra = append(sortedExtra, k)
	}
	sort.Strings(sortedExtra)
	headers = append(headers, sortedExtra...)
	return headers
}

func csvCellString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return spreadsheetSafeString(v)
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		// JSON-decoded numbers come back as float64; format integers without
		// a trailing ".0" so totals look natural in spreadsheet apps.
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	default:
		return spreadsheetSafeString(fmt.Sprintf("%v", v))
	}
}

func spreadsheetSafeString(value string) string {
	if value == "" {
		return value
	}
	switch value[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + value
	default:
		return value
	}
}

// BlockedProduct describes which Klaviyo-parity product a not-yet-shipped
// metric depends on. The /api/v1/reporting/blocked-products surface uses
// this so report-builder dashboards show "Reviews report requires the
// Reviews product to ship" instead of empty result panes.
type BlockedProduct struct {
	ProductArea string   `json:"product_area"`
	Initiative  string   `json:"initiative"`
	BlockedNote string   `json:"blocked_note"`
	Metrics     []string `json:"metrics"`
	Statuses    []string `json:"statuses"`
}

// productInitiativeMap pairs each report metric's product_area with the
// Klaviyo-alleviation register initiative that gates it. Strings are kept
// in sync with docs/klaviyo-gap-alleviation-register.json; if you ship a
// product you also flip the matching metric's runtime_status to
// "supported" and the entry drops off this list automatically.
var productInitiativeMap = map[string]struct {
	initiative string
	note       string
}{
	"flow":           {"KLV-03-flow-builder-and-runtime-parity", "Flow execution metrics require the flow runtime analytics pipeline."},
	"deliverability": {"KLV-14-deliverability-routing-and-entitlements", "Provider / domain / country / client breakdowns require deliverability routing reporting."},
	"sms":            {"KLV-01-omnichannel-control-plane", "SMS conversation metrics require the omnichannel control plane SMS surface."},
	"push":           {"KLV-01-omnichannel-control-plane", "Push metrics require the customer-push channel adapter."},
	"reviews":        {"KLV-11-reviews-product", "Review metrics require the reviews product."},
	"helpdesk":       {"KLV-10-customer-hub-helpdesk-and-agent", "Helpdesk metrics require the customer-hub service suite."},
}

// BlockedProductSummary groups planned/partial metrics by the gating
// initiative so the UI can show one blocker card per product, not one
// per metric. Pure function so it's trivially unit-testable.
func BlockedProductSummary(registry []MetricDefinition) []BlockedProduct {
	byArea := map[string]*BlockedProduct{}
	for _, def := range registry {
		if def.RuntimeStatus == "supported" {
			continue
		}
		meta, ok := productInitiativeMap[def.ProductArea]
		if !ok {
			continue
		}
		entry, exists := byArea[def.ProductArea]
		if !exists {
			entry = &BlockedProduct{
				ProductArea: def.ProductArea,
				Initiative:  meta.initiative,
				BlockedNote: meta.note,
			}
			byArea[def.ProductArea] = entry
		}
		entry.Metrics = append(entry.Metrics, def.Key)
		entry.Statuses = append(entry.Statuses, def.RuntimeStatus)
	}
	out := make([]BlockedProduct, 0, len(byArea))
	for _, area := range sortedKeys(byArea) {
		out = append(out, *byArea[area])
	}
	return out
}

func sortedKeys(m map[string]*BlockedProduct) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
