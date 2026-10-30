// SPDX-License-Identifier: AGPL-3.0-only

package views

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
)

const campaignAssuranceSLOQuery = `SELECT
    queued_runs,
    running_runs,
    orphaned_queued_runs,
    expired_running_leases,
    ready_commands,
    oldest_ready_command_age_seconds,
    complete_runs_24h,
    incomplete_runs_24h,
    failed_runs_24h,
    blocked_runs_24h
FROM ops_campaign_assurance_slo_health()`

// CampaignAssuranceSLOHealth is a content-free fleet snapshot. It deliberately
// has no identity-bearing dimension: tenant/run drill-down belongs in the
// separately authorized ops view, never in metrics or alert details.
type CampaignAssuranceSLOHealth struct {
	QueuedRuns                  int64
	RunningRuns                 int64
	OrphanedQueuedRuns          int64
	ExpiredRunningLeases        int64
	ReadyCommands               int64
	OldestReadyCommandAgeSecond float64
	CompleteRuns24h             int64
	IncompleteRuns24h           int64
	FailedRuns24h               int64
	BlockedRuns24h              int64
}

type campaignAssuranceSLOQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func readCampaignAssuranceSLOHealth(
	ctx context.Context,
	queryer campaignAssuranceSLOQueryer,
) (CampaignAssuranceSLOHealth, error) {
	if queryer == nil {
		return CampaignAssuranceSLOHealth{}, errors.New("Campaign Assurance SLO queryer is required")
	}
	var result CampaignAssuranceSLOHealth
	err := queryer.QueryRow(ctx, campaignAssuranceSLOQuery).Scan(
		&result.QueuedRuns,
		&result.RunningRuns,
		&result.OrphanedQueuedRuns,
		&result.ExpiredRunningLeases,
		&result.ReadyCommands,
		&result.OldestReadyCommandAgeSecond,
		&result.CompleteRuns24h,
		&result.IncompleteRuns24h,
		&result.FailedRuns24h,
		&result.BlockedRuns24h,
	)
	return result, err
}

// CampaignAssuranceSLOHealth reads the reviewed aggregate through the ops
// pool. postwave_ops has EXECUTE on that function and no source-table access.
func (r *Reader) CampaignAssuranceSLOHealth(
	ctx context.Context,
) (CampaignAssuranceSLOHealth, error) {
	if r == nil || r.Pool == nil {
		return CampaignAssuranceSLOHealth{}, errors.New("Campaign Assurance ops reader is unavailable")
	}
	return readCampaignAssuranceSLOHealth(ctx, r.Pool)
}

// CampaignAssuranceSLOCollector exports bounded-label operational health. It
// reads through the same postwave_ops function as the board; it does not cache
// a successful result across scrapes, so a dead DB cannot freeze green values.
type CampaignAssuranceSLOCollector struct {
	queryer campaignAssuranceSLOQueryer
	timeout time.Duration

	scrapeSuccess  *prometheus.Desc
	runs           *prometheus.Desc
	orphaned       *prometheus.Desc
	expiredLeases  *prometheus.Desc
	readyCommands  *prometheus.Desc
	oldestReadyAge *prometheus.Desc
	terminal24h    *prometheus.Desc
	blocked24h     *prometheus.Desc
}

func NewCampaignAssuranceSLOCollector(
	queryer campaignAssuranceSLOQueryer,
) (*CampaignAssuranceSLOCollector, error) {
	if queryer == nil {
		return nil, errors.New("Campaign Assurance SLO collector queryer is required")
	}
	return &CampaignAssuranceSLOCollector{
		queryer: queryer,
		timeout: 2 * time.Second,
		scrapeSuccess: prometheus.NewDesc(
			"postwave_campaign_assurance_slo_scrape_success",
			"Whether the content-free Campaign Assurance SLO aggregate was read successfully (1=yes, 0=no).",
			nil, nil,
		),
		runs: prometheus.NewDesc(
			"postwave_campaign_assurance_runs",
			"Current Campaign Assurance runs by closed non-terminal state.",
			[]string{"state"}, nil,
		),
		orphaned: prometheus.NewDesc(
			"postwave_campaign_assurance_orphaned_queued_runs",
			"Queued Campaign Assurance runs eligible for at least five minutes with no unfinished command.",
			nil, nil,
		),
		expiredLeases: prometheus.NewDesc(
			"postwave_campaign_assurance_expired_running_leases",
			"Running Campaign Assurance runs whose worker lease is expired.",
			nil, nil,
		),
		readyCommands: prometheus.NewDesc(
			"postwave_campaign_assurance_ready_commands",
			"Campaign Assurance commands currently eligible for delivery.",
			nil, nil,
		),
		oldestReadyAge: prometheus.NewDesc(
			"postwave_campaign_assurance_oldest_ready_command_age_seconds",
			"Age in seconds of the oldest Campaign Assurance command eligible for delivery.",
			nil, nil,
		),
		terminal24h: prometheus.NewDesc(
			"postwave_campaign_assurance_terminal_runs_24h",
			"Campaign Assurance terminal runs in the trailing 24 hours by closed outcome.",
			[]string{"state"}, nil,
		),
		blocked24h: prometheus.NewDesc(
			"postwave_campaign_assurance_blocked_runs_24h",
			"Complete Campaign Assurance runs with a block decision in the trailing 24 hours.",
			nil, nil,
		),
	}, nil
}

func (c *CampaignAssuranceSLOCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, descriptor := range []*prometheus.Desc{
		c.scrapeSuccess, c.runs, c.orphaned, c.expiredLeases,
		c.readyCommands, c.oldestReadyAge, c.terminal24h, c.blocked24h,
	} {
		ch <- descriptor
	}
}

func (c *CampaignAssuranceSLOCollector) Collect(ch chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	defer cancel()
	health, err := readCampaignAssuranceSLOHealth(ctx, c.queryer)
	if err != nil {
		ch <- prometheus.MustNewConstMetric(c.scrapeSuccess, prometheus.GaugeValue, 0)
		return
	}
	ch <- prometheus.MustNewConstMetric(c.scrapeSuccess, prometheus.GaugeValue, 1)
	ch <- prometheus.MustNewConstMetric(c.runs, prometheus.GaugeValue, float64(health.QueuedRuns), "queued")
	ch <- prometheus.MustNewConstMetric(c.runs, prometheus.GaugeValue, float64(health.RunningRuns), "running")
	ch <- prometheus.MustNewConstMetric(c.orphaned, prometheus.GaugeValue, float64(health.OrphanedQueuedRuns))
	ch <- prometheus.MustNewConstMetric(c.expiredLeases, prometheus.GaugeValue, float64(health.ExpiredRunningLeases))
	ch <- prometheus.MustNewConstMetric(c.readyCommands, prometheus.GaugeValue, float64(health.ReadyCommands))
	ch <- prometheus.MustNewConstMetric(c.oldestReadyAge, prometheus.GaugeValue, health.OldestReadyCommandAgeSecond)
	ch <- prometheus.MustNewConstMetric(c.terminal24h, prometheus.GaugeValue, float64(health.CompleteRuns24h), "complete")
	ch <- prometheus.MustNewConstMetric(c.terminal24h, prometheus.GaugeValue, float64(health.IncompleteRuns24h), "incomplete")
	ch <- prometheus.MustNewConstMetric(c.terminal24h, prometheus.GaugeValue, float64(health.FailedRuns24h), "failed")
	ch <- prometheus.MustNewConstMetric(c.blocked24h, prometheus.GaugeValue, float64(health.BlockedRuns24h))
}
