// Package dmarc exposes tenant-scoped DMARC aggregate-report evidence from
// dmarc_aggregate_reports and dmarc_aggregate_records. It provides bounded
// report, insight, and source-detail read models; the XML parser and ingestion
// pipeline live in services/deliverability/internal/auth.
//
// Suggestion acknowledgement routes remain mounted for compatibility but are
// disabled by default and fail closed before database access. They must not be
// enabled until tenant-global dismissal state has actor and lifecycle
// governance.
package dmarc
