package auth

import (
	"encoding/xml"
	"io"
	"time"
)

// DMARC aggregate ("rua") reports are XML documents that ESPs send daily to
// the rua= mailbox. This file is the XML parser; the persistence side
// lives in dmarc_storage.go (table: dmarc_aggregate_reports +
// dmarc_aggregate_records), the IMAP fetcher in dmarc_imap.go.
// This comment is historical — both halves of the pipeline are wired.

// AggregateReport mirrors the RFC 7489 Appendix A schema (subset we use).
type AggregateReport struct {
	XMLName    xml.Name        `xml:"feedback"`
	ReportMeta ReportMetadata  `xml:"report_metadata"`
	PolicyPub  PolicyPublished `xml:"policy_published"`
	Records    []DMARCRecord   `xml:"record"`
}

// ReportMetadata is the report header (org, email, date range).
type ReportMetadata struct {
	OrgName   string    `xml:"org_name"`
	Email     string    `xml:"email"`
	ReportID  string    `xml:"report_id"`
	DateBegin int64     `xml:"date_range>begin"`
	DateEnd   int64     `xml:"date_range>end"`
	BeginAt   time.Time `xml:"-"`
	EndAt     time.Time `xml:"-"`
}

// PolicyPublished is the policy that was active at the time of the report.
type PolicyPublished struct {
	Domain string `xml:"domain"`
	ADKIM  string `xml:"adkim"`
	ASPF   string `xml:"aspf"`
	P      string `xml:"p"`
	SP     string `xml:"sp"`
	Pct    string `xml:"pct"`
}

// DMARCRecord is one source-IP slice of activity within a report.
type DMARCRecord struct {
	Row struct {
		SourceIP string `xml:"source_ip"`
		Count    int    `xml:"count"`
		Policy   struct {
			Disposition string `xml:"disposition"`
			DKIM        string `xml:"dkim"`
			SPF         string `xml:"spf"`
		} `xml:"policy_evaluated"`
	} `xml:"row"`
	Identifiers struct {
		HeaderFrom string `xml:"header_from"`
	} `xml:"identifiers"`
	AuthResults struct {
		DKIM []struct {
			Domain   string `xml:"domain"`
			Result   string `xml:"result"`
			Selector string `xml:"selector"`
		} `xml:"dkim"`
		SPF []struct {
			Domain string `xml:"domain"`
			Result string `xml:"result"`
		} `xml:"spf"`
	} `xml:"auth_results"`
}

// ParseAggregate decodes an XML aggregate report and resolves epoch timestamps.
func ParseAggregate(r io.Reader) (*AggregateReport, error) {
	var rep AggregateReport
	dec := xml.NewDecoder(r)
	if err := dec.Decode(&rep); err != nil {
		return nil, err
	}
	rep.ReportMeta.BeginAt = time.Unix(rep.ReportMeta.DateBegin, 0).UTC()
	rep.ReportMeta.EndAt = time.Unix(rep.ReportMeta.DateEnd, 0).UTC()
	return &rep, nil
}

// Report is the canonical alias the storage layer & IMAP poller pass around.
// Kept as a type alias of AggregateReport so the existing parser surface
// (ParseAggregate, the AggregateReport fields) stays untouched while the
// new ingestion pipeline can reference auth.Report consistently.
type Report = AggregateReport

// ParseXML is a thin alias around ParseAggregate so callers in the IMAP
// poller can spell the parser entry-point as ParseXML(r) — matches the
// shape of the spec ("ParseXML(io.Reader)") and keeps backwards compat.
func ParseXML(r io.Reader) (*Report, error) { return ParseAggregate(r) }
