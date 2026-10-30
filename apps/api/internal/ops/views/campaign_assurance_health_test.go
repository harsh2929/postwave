// SPDX-License-Identifier: AGPL-3.0-only

package views

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

type campaignAssuranceHealthRow struct {
	values CampaignAssuranceSLOHealth
	err    error
}

func (r campaignAssuranceHealthRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	values := []any{
		r.values.QueuedRuns, r.values.RunningRuns,
		r.values.OrphanedQueuedRuns, r.values.ExpiredRunningLeases,
		r.values.ReadyCommands, r.values.OldestReadyCommandAgeSecond,
		r.values.CompleteRuns24h, r.values.IncompleteRuns24h,
		r.values.FailedRuns24h, r.values.BlockedRuns24h,
	}
	if len(dest) != len(values) {
		return errors.New("unexpected Campaign Assurance health destination count")
	}
	for index := range dest {
		switch value := dest[index].(type) {
		case *int64:
			*value = values[index].(int64)
		case *float64:
			*value = values[index].(float64)
		default:
			return errors.New("unexpected Campaign Assurance health destination type")
		}
	}
	return nil
}

type campaignAssuranceHealthQueryer struct {
	row   pgx.Row
	query string
}

func (q *campaignAssuranceHealthQueryer) QueryRow(
	_ context.Context,
	query string,
	_ ...any,
) pgx.Row {
	q.query = query
	return q.row
}

func TestCampaignAssuranceSLOCollectorHasClosedLabelsAndNoIdentity(t *testing.T) {
	queryer := &campaignAssuranceHealthQueryer{row: campaignAssuranceHealthRow{
		values: CampaignAssuranceSLOHealth{
			QueuedRuns: 2, RunningRuns: 3, OrphanedQueuedRuns: 1,
			ExpiredRunningLeases: 4, ReadyCommands: 5,
			OldestReadyCommandAgeSecond: 67,
			CompleteRuns24h:             8, IncompleteRuns24h: 9,
			FailedRuns24h: 10, BlockedRuns24h: 11,
		},
	}}
	collector, err := NewCampaignAssuranceSLOCollector(queryer)
	if err != nil {
		t.Fatal(err)
	}
	registry := prometheus.NewPedanticRegistry()
	if err := registry.Register(collector); err != nil {
		t.Fatal(err)
	}
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(queryer.query, "ops_campaign_assurance_slo_health()") {
		t.Fatalf("collector bypassed reviewed aggregate: %q", queryer.query)
	}
	want := map[string]float64{
		"postwave_campaign_assurance_slo_scrape_success":               1,
		"postwave_campaign_assurance_orphaned_queued_runs":             1,
		"postwave_campaign_assurance_expired_running_leases":           4,
		"postwave_campaign_assurance_ready_commands":                   5,
		"postwave_campaign_assurance_oldest_ready_command_age_seconds": 67,
		"postwave_campaign_assurance_blocked_runs_24h":                 11,
	}
	for name, value := range want {
		family := metricFamily(families, name)
		if family == nil || len(family.Metric) != 1 || family.Metric[0].GetGauge().GetValue() != value {
			t.Errorf("metric %s = %#v, want %v", name, family, value)
		}
	}
	for _, family := range families {
		for _, metric := range family.Metric {
			for _, label := range metric.Label {
				if label.GetName() != "state" {
					t.Errorf("metric %s exposes non-closed label %q", family.GetName(), label.GetName())
				}
				if value := label.GetValue(); value != "queued" && value != "running" &&
					value != "complete" && value != "incomplete" && value != "failed" {
					t.Errorf("metric %s exposes unknown state %q", family.GetName(), value)
				}
			}
		}
		for _, forbidden := range []string{"tenant", "campaign_id", "run_id", "mailbox", "recipient", "model_output"} {
			if strings.Contains(strings.ToLower(family.GetName()), forbidden) {
				t.Errorf("metric name contains identity/content fragment %q: %s", forbidden, family.GetName())
			}
		}
	}
}

func TestCampaignAssuranceSLOCollectorFailsLoudWithoutStaleValues(t *testing.T) {
	collector, err := NewCampaignAssuranceSLOCollector(&campaignAssuranceHealthQueryer{
		row: campaignAssuranceHealthRow{err: errors.New("ops database unavailable")},
	})
	if err != nil {
		t.Fatal(err)
	}
	registry := prometheus.NewPedanticRegistry()
	if err := registry.Register(collector); err != nil {
		t.Fatal(err)
	}
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	if len(families) != 1 || families[0].GetName() != "postwave_campaign_assurance_slo_scrape_success" ||
		families[0].Metric[0].GetGauge().GetValue() != 0 {
		t.Fatalf("failed scrape exported stale health: %#v", families)
	}
}

func metricFamily(families []*dto.MetricFamily, name string) *dto.MetricFamily {
	for _, family := range families {
		if family.GetName() == name {
			return family
		}
	}
	return nil
}
