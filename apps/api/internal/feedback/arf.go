// SPDX-License-Identifier: AGPL-3.0-only
package feedback

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/textproto"
	"strings"
	"time"
)

// ParseARFReport parses an RFC 5965 Abuse Reporting Format (ARF) message
// out of a multipart/report body and returns a ComplaintEvent with
// complaint_type="fbl".
//
// The wire shape is a multipart/report with three parts (per RFC 5965):
//
//  1. text/plain — human-readable description (ignored).
//  2. message/feedback-report — the structured key:value report we mine.
//  3. message/rfc822 — a copy of the original message (ignored here, kept
//     in raw for support).
//
// `contentType` should be the value of the request's Content-Type header
// (it carries the multipart boundary parameter). When empty, we attempt
// to detect a boundary by parsing the body as a full message; that
// covers operators forwarding ARF reports as-is to our endpoint.
//
// The fields we read out of the message/feedback-report part are:
//
//	Original-Rcpt-To      — recipient address that complained (preferred)
//	Original-Mail-From    — fallback when Original-Rcpt-To is absent
//	Feedback-Type         — "abuse" | "fraud" | "virus" | … (informational)
//	Arrival-Date          — RFC5322 timestamp of arrival
func ParseARFReport(body []byte, contentType string) (*ComplaintEvent, error) {
	boundary, err := arfBoundary(body, contentType)
	if err != nil {
		return nil, err
	}
	mr := multipart.NewReader(bytes.NewReader(body), boundary)

	var (
		recipient    string
		mailFrom     string
		feedbackType string
		arrivalDate  string
	)

	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("arf: read part: %w", err)
		}
		ct, _, _ := mime.ParseMediaType(part.Header.Get("Content-Type"))
		if !strings.EqualFold(strings.TrimSpace(ct), "message/feedback-report") {
			_, _ = io.Copy(io.Discard, part)
			_ = part.Close()
			continue
		}
		// The feedback-report part is itself a sequence of header-style
		// key:value lines. textproto.Reader.ReadMIMEHeader handles folding
		// and the blank-line terminator the same way email clients do.
		tp := textproto.NewReader(bufio.NewReader(part))
		hdr, err := tp.ReadMIMEHeader()
		// EOF without a blank line is acceptable: ARF reports often end
		// the part with the last header and no trailing newline.
		if err != nil && err != io.EOF {
			_ = part.Close()
			return nil, fmt.Errorf("arf: parse feedback-report headers: %w", err)
		}
		recipient = strings.TrimSpace(hdr.Get("Original-Rcpt-To"))
		mailFrom = strings.TrimSpace(hdr.Get("Original-Mail-From"))
		feedbackType = strings.TrimSpace(hdr.Get("Feedback-Type"))
		arrivalDate = strings.TrimSpace(hdr.Get("Arrival-Date"))
		_ = part.Close()
		break
	}

	email := stripAngleBrackets(recipient)
	if email == "" {
		email = stripAngleBrackets(mailFrom)
	}
	if email == "" {
		return nil, fmt.Errorf("arf: no Original-Rcpt-To or Original-Mail-From found")
	}

	rawJSON, err := json.Marshal(map[string]any{
		"feedback_type":      feedbackType,
		"original_rcpt_to":   recipient,
		"original_mail_from": mailFrom,
		"arrival_date":       arrivalDate,
		"body":               string(body),
	})
	if err != nil {
		return nil, fmt.Errorf("arf: marshal raw: %w", err)
	}

	return &ComplaintEvent{
		SubscriberEmail: email,
		ComplaintType:   "fbl",
		ESP:             "arf",
		Raw:             json.RawMessage(rawJSON),
		ReceivedAt:      parseARFTime(arrivalDate),
	}, nil
}

// arfBoundary extracts the multipart boundary from the request
// Content-Type. When the caller couldn't capture the header (e.g. a CLI
// forwarding a saved .eml file), we fall through to scanning the body
// for a top-level Content-Type line.
func arfBoundary(body []byte, contentType string) (string, error) {
	if contentType != "" {
		mt, params, err := mime.ParseMediaType(contentType)
		if err == nil && strings.HasPrefix(strings.ToLower(mt), "multipart/") {
			if b := strings.TrimSpace(params["boundary"]); b != "" {
				return b, nil
			}
		}
	}
	// Fall back: parse leading message headers out of the body itself.
	tp := textproto.NewReader(bufio.NewReader(bytes.NewReader(body)))
	hdr, err := tp.ReadMIMEHeader()
	if err != nil && err != io.EOF {
		return "", fmt.Errorf("arf: detect boundary: %w", err)
	}
	if ct := hdr.Get("Content-Type"); ct != "" {
		if _, params, err := mime.ParseMediaType(ct); err == nil {
			if b := strings.TrimSpace(params["boundary"]); b != "" {
				return b, nil
			}
		}
	}
	return "", fmt.Errorf("arf: missing multipart boundary")
}

func stripAngleBrackets(in string) string {
	in = strings.TrimSpace(in)
	in = strings.TrimPrefix(in, "<")
	in = strings.TrimSuffix(in, ">")
	// ARF Original-Rcpt-To often uses the form `rfc822; user@example.com`.
	if idx := strings.Index(in, ";"); idx >= 0 {
		in = in[idx+1:]
	}
	return strings.TrimSpace(in)
}

func parseARFTime(in string) time.Time {
	in = strings.TrimSpace(in)
	if in == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC1123Z, time.RFC1123, time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, in); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}
