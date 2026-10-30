// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"strings"
)

type decodedMIMEPart struct {
	mediaType string
	body      []byte
}

func analyzeMIME(a *analysis) {
	raw := a.input.Compilation.RFC822
	if len(raw) == 0 {
		a.mimeFailure("MIME_MESSAGE_MISSING", "The canonical outbound RFC 822 message is missing.", nil, nil)
		return
	}
	if len(raw) > MaxMIMEBytes {
		return
	}
	if !onlyCRLF(raw) {
		a.mimeFailure("MIME_LINE_ENDINGS_INVALID", "The outbound message contains a bare carriage return or line feed.",
			map[string]any{"line_endings": "CRLF only"}, map[string]any{"line_endings": "mixed_or_bare"})
	}
	message, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		a.mimeFailure("MIME_MESSAGE_INVALID", "The outbound bytes are not a parseable RFC 5322 message.",
			nil, map[string]any{"error_class": "mail_parse_failed"})
		return
	}
	if strings.TrimSpace(message.Header.Get("MIME-Version")) != "1.0" {
		a.mimeFailure("MIME_VERSION_INVALID", "The outbound message must declare MIME-Version: 1.0.",
			map[string]any{"mime_version": "1.0"}, map[string]any{"mime_version": message.Header.Get("MIME-Version")})
	}
	decodedSubject, err := new(mime.WordDecoder).DecodeHeader(message.Header.Get("Subject"))
	if err != nil || decodedSubject != a.input.Compilation.Subject || decodedSubject != a.input.Revision.Subject {
		a.add(findingSpec{
			code: "MIME_SUBJECT_MISMATCH", severity: SeverityCritical, blocking: true,
			dimension:   DimensionParity,
			evidence:    []EvidenceReference{{Representation: RepresentationMIME, Location: "/headers/subject"}},
			expected:    map[string]any{"subject": a.input.Revision.Subject},
			observed:    map[string]any{"subject": decodedSubject, "decode_valid": err == nil},
			explanation: "The final MIME subject does not exactly match the frozen revision and compiler result.",
			remediation: Remediation{Kind: RemediationRecompileMIME, Representation: RepresentationMIME},
		})
	}

	mediaType, parameters, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if err != nil || !strings.EqualFold(mediaType, "multipart/alternative") || parameters["boundary"] == "" {
		a.mimeFailure("MIME_ALTERNATIVE_INVALID", "Semantic delivery requires one valid multipart/alternative container.",
			map[string]any{"media_type": "multipart/alternative", "boundary_present": true},
			map[string]any{"media_type": mediaType, "boundary_present": parameters["boundary"] != "", "parse_valid": err == nil})
		return
	}

	reader := multipart.NewReader(message.Body, parameters["boundary"])
	parts := make([]decodedMIMEPart, 0, 3)
	for index := 0; index < 3; index++ {
		part, nextErr := reader.NextRawPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			a.mimeFailure("MIME_PART_INVALID", "A MIME alternative could not be parsed safely.", nil,
				map[string]any{"part_index": index, "error_class": "multipart_parse_failed"})
			return
		}
		partType, partParameters, parseErr := mime.ParseMediaType(part.Header.Get("Content-Type"))
		transferEncoding := strings.ToLower(strings.TrimSpace(part.Header.Get("Content-Transfer-Encoding")))
		if parseErr != nil || (partType != "text/plain" && partType != "text/html") ||
			!strings.EqualFold(partParameters["charset"], "UTF-8") || transferEncoding != "quoted-printable" ||
			strings.TrimSpace(part.Header.Get("Content-Disposition")) != "" {
			a.mimeFailure("MIME_PART_HEADERS_INVALID", "Each certified alternative must be UTF-8 quoted-printable text without an attachment disposition.",
				map[string]any{"charset": "UTF-8", "transfer_encoding": "quoted-printable", "content_disposition": ""},
				map[string]any{
					"part_index": index, "media_type": partType, "charset": partParameters["charset"],
					"transfer_encoding": transferEncoding, "content_disposition": part.Header.Get("Content-Disposition"),
					"content_type_valid": parseErr == nil,
				})
		}
		maximum := MaxHTMLBytes
		if partType == "text/plain" {
			maximum = MaxTextBytes
		}
		decoded, readErr := io.ReadAll(io.LimitReader(quotedprintable.NewReader(part), int64(maximum)+1))
		if readErr != nil || len(decoded) > maximum {
			a.mimeFailure("MIME_PART_BODY_INVALID", "A MIME alternative failed bounded quoted-printable decoding.",
				map[string]any{"maximum_bytes": maximum},
				map[string]any{"part_index": index, "bytes": len(decoded), "decode_valid": readErr == nil})
			return
		}
		parts = append(parts, decodedMIMEPart{mediaType: strings.ToLower(partType), body: decoded})
	}
	if len(parts) != 2 {
		a.mimeFailure("MIME_PART_COUNT_INVALID", "The certified message must contain exactly two alternatives.",
			map[string]any{"part_count": 2}, map[string]any{"part_count": len(parts)})
		return
	}
	if parts[0].mediaType != "text/plain" || parts[1].mediaType != "text/html" {
		a.mimeFailure("MIME_ALTERNATIVE_ORDER_INVALID", "multipart/alternative must put text/plain first and text/html last.",
			map[string]any{"order": []string{"text/plain", "text/html"}},
			map[string]any{"order": []string{parts[0].mediaType, parts[1].mediaType}})
	}
	compareMIMEPart(a, 0, parts[0], "text/plain", []byte(a.input.Compilation.Text), RepresentationPlainText)
	compareMIMEPart(a, 1, parts[1], "text/html", []byte(a.input.Compilation.HTML), RepresentationHTMLSource)
}

func compareMIMEPart(a *analysis, index int, part decodedMIMEPart, mediaType string, expected []byte, representation Representation) {
	if part.mediaType != mediaType || bytes.Equal(part.body, expected) {
		return
	}
	a.add(findingSpec{
		code: "MIME_PART_CONTENT_MISMATCH", severity: SeverityCritical, blocking: true,
		dimension: DimensionParity,
		evidence: []EvidenceReference{
			{Representation: RepresentationMIME, Location: fmt.Sprintf("/parts/%d", index), SHA256: digestBytes(part.body)},
			{Representation: representation, Location: "/", SHA256: digestBytes(expected)},
		},
		expected:    map[string]any{"media_type": mediaType, "sha256": digestBytes(expected), "bytes": len(expected)},
		observed:    map[string]any{"media_type": part.mediaType, "sha256": digestBytes(part.body), "bytes": len(part.body)},
		explanation: "The decoded MIME part is not byte-for-byte identical to the certified compiler projection.",
		remediation: Remediation{Kind: RemediationRecompileMIME, Representation: RepresentationMIME},
	})
}

func (a *analysis) mimeFailure(code, explanation string, expected, observed any) {
	a.add(findingSpec{
		code: code, severity: SeverityCritical, blocking: true,
		dimension: DimensionMIME,
		evidence:  []EvidenceReference{{Representation: RepresentationMIME, Location: "/"}},
		expected:  expected, observed: observed, explanation: explanation,
		remediation: Remediation{Kind: RemediationRecompileMIME, Representation: RepresentationMIME},
	})
}

func onlyCRLF(value []byte) bool {
	for index, character := range value {
		switch character {
		case '\r':
			if index+1 >= len(value) || value[index+1] != '\n' {
				return false
			}
		case '\n':
			if index == 0 || value[index-1] != '\r' {
				return false
			}
		}
	}
	return true
}
