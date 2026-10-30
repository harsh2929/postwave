package seedlist

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

const (
	// DefaultMaxRawMIMEBytes bounds retained raw message bytes per seed result.
	// The IMAP reader also enforces this bound while streaming the literal.
	DefaultMaxRawMIMEBytes     int64 = 10 << 20
	maxConfiguredMIMEBytes     int64 = 50 << 20
	defaultMaxMIMEParts              = 128
	defaultMaxMIMEDepth              = 12
	maxManifestFilenameBytes         = 512
	maxManifestHeaders               = 512
	maxManifestHeaderNameBytes       = 128
	maxDecodedMIMEPartBytes    int64 = 50 << 20
)

const (
	rawMIMESourceIMAP   = "imap_body_peek"
	rawMIMESourceVendor = "vendor_api"
)

// CapabilityAvailability prevents a missing connector feature from being
// confused with a successful observation.
type CapabilityAvailability string

const (
	CapabilityAvailable   CapabilityAvailability = "available"
	CapabilityUnavailable CapabilityAvailability = "unavailable"
)

// ConnectorCapabilities is a frozen statement of what a connector can
// observe. Raw MIME is independent from headers and placement.
type ConnectorCapabilities struct {
	Headers         CapabilityAvailability `json:"headers"`
	RawMIME         CapabilityAvailability `json:"raw_mime"`
	BodyParts       CapabilityAvailability `json:"body_parts"`
	Placement       CapabilityAvailability `json:"placement"`
	ObservedSurface CapabilityAvailability `json:"observed_surface"`
}

// CapabilityReporter is optional so existing injected connectors remain
// source-compatible. Unknown capabilities fail closed to unavailable.
type CapabilityReporter interface {
	Capabilities() ConnectorCapabilities
}

// CapabilitiesOf returns an explicit, normalized capability snapshot.
func CapabilitiesOf(conn Connector) ConnectorCapabilities {
	if reporter, ok := conn.(CapabilityReporter); ok {
		return normalizeCapabilities(reporter.Capabilities())
	}
	return unavailableCapabilities()
}

func normalizeCapabilities(c ConnectorCapabilities) ConnectorCapabilities {
	c.Headers = normalizeCapability(c.Headers)
	c.RawMIME = normalizeCapability(c.RawMIME)
	c.BodyParts = normalizeCapability(c.BodyParts)
	c.Placement = normalizeCapability(c.Placement)
	c.ObservedSurface = normalizeCapability(c.ObservedSurface)
	return c
}

func normalizeCapability(c CapabilityAvailability) CapabilityAvailability {
	if c == CapabilityAvailable {
		return CapabilityAvailable
	}
	return CapabilityUnavailable
}

func unavailableCapabilities() ConnectorCapabilities {
	return ConnectorCapabilities{
		Headers:         CapabilityUnavailable,
		RawMIME:         CapabilityUnavailable,
		BodyParts:       CapabilityUnavailable,
		Placement:       CapabilityUnavailable,
		ObservedSurface: CapabilityUnavailable,
	}
}

func unavailableRawMIME(source, code string, maxBytes int64) *categorizers.RawMIMEAcquisition {
	return &categorizers.RawMIMEAcquisition{
		Status:    categorizers.RawMIMEUnavailable,
		Source:    source,
		ErrorCode: code,
		MaxBytes:  maxBytes,
		Manifest: categorizers.MIMEManifest{
			Status: categorizers.MIMEParseSkipped,
		},
	}
}

func failedRawMIME(code string, reportedBytes, maxBytes int64, uid, uidValidity uint32) *categorizers.RawMIMEAcquisition {
	return &categorizers.RawMIMEAcquisition{
		Status:        categorizers.RawMIMEFailed,
		Source:        rawMIMESourceIMAP,
		ErrorCode:     code,
		ReportedBytes: reportedBytes,
		MaxBytes:      maxBytes,
		UID:           uid,
		UIDValidity:   uidValidity,
		Manifest: categorizers.MIMEManifest{
			Status: categorizers.MIMEParseSkipped,
		},
	}
}

func finalizeRawMIME(raw []byte, reportedBytes, maxBytes int64, uid, uidValidity uint32, readTruncated bool) *categorizers.RawMIMEAcquisition {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxRawMIMEBytes
	}
	tooLarge := readTruncated || int64(len(raw)) > maxBytes || reportedBytes > maxBytes
	if int64(len(raw)) > maxBytes {
		raw = raw[:maxBytes]
	}
	// If the server reported a larger message than it returned, the bytes are
	// not exact even when they happen to be under the configured bound.
	incomplete := reportedBytes > int64(len(raw))
	truncated := tooLarge || incomplete
	copyRaw := append([]byte(nil), raw...)
	sum := sha256.Sum256(copyRaw)
	result := &categorizers.RawMIMEAcquisition{
		Status:        categorizers.RawMIMEComplete,
		Source:        rawMIMESourceIMAP,
		SHA256:        hex.EncodeToString(sum[:]),
		CapturedBytes: int64(len(copyRaw)),
		ReportedBytes: reportedBytes,
		MaxBytes:      maxBytes,
		UID:           uid,
		UIDValidity:   uidValidity,
		Raw:           copyRaw,
	}
	if truncated {
		result.Status = categorizers.RawMIMETruncated
		result.Truncated = true
		result.ErrorCode = "message_incomplete"
		if tooLarge {
			result.ErrorCode = "message_too_large"
		}
		result.Manifest = categorizers.MIMEManifest{Status: categorizers.MIMEParseSkipped}
		return result
	}
	result.Manifest = parseMIMEManifest(copyRaw)
	return result
}

// parseMIMEManifest is intentionally offline: it only walks bytes already in
// memory and has no HTTP/DNS/browser dependency capable of loading images,
// stylesheets, fonts, links, or attachments.
func parseMIMEManifest(raw []byte) categorizers.MIMEManifest {
	headers, authentication, err := parseOrderedHeaderManifest(raw)
	if err != nil {
		return malformedMIMEManifest("invalid_headers")
	}
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return malformedMIMEManifest("invalid_message")
	}
	rootMediaType, _, err := parsePartMediaType(msg.Header.Get("Content-Type"))
	if err != nil {
		return malformedMIMEManifest("invalid_content_type")
	}
	parts := make([]categorizers.MIMEPart, 0, 4)
	if err := walkMIMEPart(msg.Header, msg.Body, "1", 0, &parts); err != nil {
		return malformedMIMEManifest(mimeParseErrorCode(err))
	}
	manifest := categorizers.MIMEManifest{
		Status:                categorizers.MIMEParseParsed,
		Headers:               headers,
		AuthenticationResults: authentication,
		Parts:                 parts,
	}
	manifest.StructureSHA256 = receivedStructureHash(rootMediaType, parts)
	manifest.TextBodySHA256, manifest.HTMLBodySHA256 = uniqueBodyHashes(parts)
	return manifest
}

func walkMIMEPart(header mail.Header, body io.Reader, path string, depth int, parts *[]categorizers.MIMEPart) error {
	if depth > defaultMaxMIMEDepth {
		return errMIMEDepth
	}
	mediaType, params, err := parsePartMediaType(header.Get("Content-Type"))
	if err != nil {
		return errMIMEContentType
	}
	if strings.HasPrefix(mediaType, "multipart/") {
		boundary := strings.TrimSpace(params["boundary"])
		if boundary == "" {
			return errMIMEBoundary
		}
		reader := multipart.NewReader(body, boundary)
		for index := 1; ; index++ {
			part, nextErr := reader.NextRawPart()
			if nextErr == io.EOF {
				break
			}
			if nextErr != nil {
				return errMIMEBoundary
			}
			if len(*parts) >= defaultMaxMIMEParts {
				_ = part.Close()
				return errMIMEParts
			}
			childPath := fmt.Sprintf("%s.%d", path, index)
			if err := walkMIMEPart(mail.Header(part.Header), part, childPath, depth+1, parts); err != nil {
				_ = part.Close()
				return err
			}
			if err := part.Close(); err != nil {
				return errMIMERead
			}
		}
		return nil
	}

	content, err := io.ReadAll(io.LimitReader(body, maxDecodedMIMEPartBytes+1))
	if err != nil {
		return errMIMERead
	}
	if int64(len(content)) > maxDecodedMIMEPartBytes {
		return errMIMERead
	}
	disposition, dispositionParams, _ := mime.ParseMediaType(header.Get("Content-Disposition"))
	filename := strings.TrimSpace(dispositionParams["filename"])
	if filename == "" {
		filename = strings.TrimSpace(params["name"])
	}
	if len(filename) > maxManifestFilenameBytes {
		filename = filename[:maxManifestFilenameBytes]
	}
	sum := sha256.Sum256(content)
	filenameHash := ""
	if filename != "" {
		filenameHash = digestHexBytes([]byte(filename))
	}
	transferEncoding := strings.ToLower(strings.TrimSpace(header.Get("Content-Transfer-Encoding")))
	decoded, decodeErr := decodeMIMEPart(content, transferEncoding)
	if decodeErr != nil {
		return errMIMERead
	}
	decodedSum := sha256.Sum256(decoded)
	*parts = append(*parts, categorizers.MIMEPart{
		Path:             path,
		MediaType:        mediaType,
		Charset:          strings.TrimSpace(params["charset"]),
		Disposition:      strings.ToLower(strings.TrimSpace(disposition)),
		HasFilename:      filename != "",
		FilenameSHA256:   filenameHash,
		TransferEncoding: transferEncoding,
		EncodedBytes:     int64(len(content)),
		SHA256:           hex.EncodeToString(sum[:]),
		DecodedBytes:     int64(len(decoded)),
		DecodedSHA256:    hex.EncodeToString(decodedSum[:]),
	})
	return nil
}

func decodeMIMEPart(content []byte, transferEncoding string) ([]byte, error) {
	var reader io.Reader = bytes.NewReader(content)
	switch strings.ToLower(strings.TrimSpace(transferEncoding)) {
	case "", "7bit", "8bit", "binary":
	case "quoted-printable":
		reader = quotedprintable.NewReader(reader)
	case "base64":
		reader = base64.NewDecoder(base64.StdEncoding, reader)
	default:
		// An unknown transfer encoding is not safe to compare with an outbound
		// body hash. Preserve the encoded receipt but fail the parsed manifest.
		return nil, fmt.Errorf("unsupported transfer encoding")
	}
	decoded, err := io.ReadAll(io.LimitReader(reader, maxDecodedMIMEPartBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(decoded)) > maxDecodedMIMEPartBytes {
		return nil, fmt.Errorf("decoded MIME part too large")
	}
	return decoded, nil
}

func parseOrderedHeaderManifest(raw []byte) ([]categorizers.MIMEHeader, []categorizers.AuthenticationResult, error) {
	var headerBlock []byte
	if index := bytes.Index(raw, []byte("\r\n\r\n")); index >= 0 {
		headerBlock = raw[:index]
	} else if index := bytes.Index(raw, []byte("\n\n")); index >= 0 {
		headerBlock = raw[:index]
	} else {
		return nil, nil, fmt.Errorf("missing header terminator")
	}
	headerBlock = bytes.ReplaceAll(headerBlock, []byte("\r\n"), []byte("\n"))
	lines := bytes.Split(headerBlock, []byte("\n"))

	type rawHeader struct {
		name  string
		value string
	}
	parsed := make([]rawHeader, 0, len(lines))
	for _, lineBytes := range lines {
		line := string(bytes.TrimSuffix(lineBytes, []byte("\r")))
		if line == "" {
			continue
		}
		if line[0] == ' ' || line[0] == '\t' {
			if len(parsed) == 0 {
				return nil, nil, fmt.Errorf("orphan header continuation")
			}
			parsed[len(parsed)-1].value += " " + strings.TrimSpace(line)
			continue
		}
		if len(parsed) >= maxManifestHeaders {
			return nil, nil, fmt.Errorf("too many headers")
		}
		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			return nil, nil, fmt.Errorf("malformed header")
		}
		rawName := strings.TrimSpace(line[:colon])
		if len(rawName) == 0 || len(rawName) > maxManifestHeaderNameBytes {
			return nil, nil, fmt.Errorf("invalid header name length")
		}
		canonical := textproto.CanonicalMIMEHeaderKey(rawName)
		if canonical == "" {
			return nil, nil, fmt.Errorf("invalid header name")
		}
		parsed = append(parsed, rawHeader{
			name:  strings.ToLower(canonical),
			value: strings.TrimSpace(line[colon+1:]),
		})
	}

	headers := make([]categorizers.MIMEHeader, 0, len(parsed))
	authentication := make([]categorizers.AuthenticationResult, 0, 8)
	for index, header := range parsed {
		position := index + 1
		headers = append(headers, categorizers.MIMEHeader{
			Position:    position,
			Name:        privacySafeManifestHeaderName(header.name),
			ValueSHA256: digestHexBytes([]byte(header.value)),
		})
		authentication = append(authentication, authenticationResults(header.name, header.value, position)...)
	}
	return headers, authentication, nil
}

var retainedManifestHeaderNames = map[string]struct{}{
	"arc-authentication-results": {}, "arc-message-signature": {}, "arc-seal": {},
	"authentication-results": {}, "bcc": {}, "cc": {}, "content-disposition": {},
	"content-transfer-encoding": {}, "content-type": {}, "date": {},
	"dkim-signature": {}, "feedback-id": {}, "from": {}, "list-id": {},
	"list-unsubscribe": {}, "list-unsubscribe-post": {}, "message-id": {},
	"mime-version": {}, "precedence": {}, "received": {}, "received-spf": {},
	"reply-to": {}, "return-path": {}, "sender": {}, "subject": {}, "to": {},
}

func privacySafeManifestHeaderName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	if _, retained := retainedManifestHeaderNames[name]; retained {
		return name
	}
	// Extension header names are attacker-controlled and can themselves carry
	// a seed identifier or other low-volume private data. Preserve order and
	// equality without retaining that name verbatim.
	return "other-sha256:" + digestHexBytes([]byte(name))
}

var allowedAuthenticationMethods = map[string]struct{}{
	"arc": {}, "bimi": {}, "compauth": {}, "dkim": {}, "dmarc": {},
	"iprev": {}, "sender-id": {}, "spf": {},
}

var allowedAuthenticationVerdicts = map[string]struct{}{
	"bestguesspass": {}, "fail": {}, "neutral": {}, "none": {}, "pass": {},
	"permerror": {}, "policy": {}, "softfail": {}, "temperror": {},
}

func authenticationResults(headerName, value string, position int) []categorizers.AuthenticationResult {
	headerName = strings.ToLower(strings.TrimSpace(headerName))
	if headerName == "received-spf" {
		fields := strings.Fields(value)
		if len(fields) == 0 {
			return nil
		}
		verdict := strings.ToLower(strings.Trim(fields[0], ";,()"))
		if _, ok := allowedAuthenticationVerdicts[verdict]; !ok {
			return nil
		}
		return []categorizers.AuthenticationResult{{
			Header: headerName, Position: position, Method: "spf", Result: verdict,
		}}
	}
	if headerName != "authentication-results" && headerName != "arc-authentication-results" {
		return nil
	}
	var out []categorizers.AuthenticationResult
	for _, segment := range strings.Split(value, ";") {
		for _, field := range strings.Fields(segment) {
			method, verdict, ok := strings.Cut(strings.Trim(field, ";,()"), "=")
			if !ok {
				continue
			}
			method = strings.ToLower(strings.TrimSpace(method))
			verdict = strings.ToLower(strings.Trim(strings.TrimSpace(verdict), ";,()"))
			if _, ok := allowedAuthenticationMethods[method]; !ok {
				continue
			}
			if _, ok := allowedAuthenticationVerdicts[verdict]; !ok {
				continue
			}
			out = append(out, categorizers.AuthenticationResult{
				Header: headerName, Position: position, Method: method, Result: verdict,
			})
		}
	}
	return out
}

type receivedMIMEStructure struct {
	Version   string   `json:"version"`
	MediaType string   `json:"media_type"`
	Parts     []string `json:"parts"`
	Encoding  string   `json:"transfer_encoding"`
}

func receivedStructureHash(rootMediaType string, parts []categorizers.MIMEPart) string {
	partTypes := make([]string, 0, len(parts))
	encoding := ""
	for _, part := range parts {
		partType := strings.ToLower(strings.TrimSpace(part.MediaType))
		if charset := canonicalCharset(part.Charset); charset != "" {
			partType += "; charset=" + charset
		}
		partTypes = append(partTypes, partType)
		partEncoding := strings.ToLower(strings.TrimSpace(part.TransferEncoding))
		if encoding == "" {
			encoding = partEncoding
		} else if encoding != partEncoding {
			encoding = "mixed"
		}
	}
	payload, err := json.Marshal(receivedMIMEStructure{
		Version:   "postwave.mime-composer.v1",
		MediaType: strings.ToLower(strings.TrimSpace(rootMediaType)),
		Parts:     partTypes,
		Encoding:  encoding,
	})
	if err != nil {
		return ""
	}
	return digestHexBytes(payload)
}

func canonicalCharset(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "utf-8", "utf8":
		return "UTF-8"
	default:
		return strings.TrimSpace(raw)
	}
}

func uniqueBodyHashes(parts []categorizers.MIMEPart) (textHash, htmlHash string) {
	textCount, htmlCount := 0, 0
	for _, part := range parts {
		switch strings.ToLower(strings.TrimSpace(part.MediaType)) {
		case "text/plain":
			textCount++
			textHash = part.DecodedSHA256
		case "text/html":
			htmlCount++
			htmlHash = part.DecodedSHA256
		}
	}
	if textCount != 1 {
		textHash = ""
	}
	if htmlCount != 1 {
		htmlHash = ""
	}
	return textHash, htmlHash
}

func digestHexBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func parsePartMediaType(raw string) (string, map[string]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "text/plain", map[string]string{}, nil
	}
	mediaType, params, err := mime.ParseMediaType(raw)
	if err != nil {
		return "", nil, err
	}
	return strings.ToLower(mediaType), params, nil
}

type mimeParseSentinel string

func (e mimeParseSentinel) Error() string { return string(e) }

const (
	errMIMEContentType mimeParseSentinel = "content_type"
	errMIMEBoundary    mimeParseSentinel = "boundary"
	errMIMEDepth       mimeParseSentinel = "depth"
	errMIMEParts       mimeParseSentinel = "parts"
	errMIMERead        mimeParseSentinel = "read"
)

func mimeParseErrorCode(err error) string {
	switch err {
	case errMIMEContentType:
		return "invalid_content_type"
	case errMIMEBoundary:
		return "invalid_multipart_boundary"
	case errMIMEDepth:
		return "mime_depth_exceeded"
	case errMIMEParts:
		return "mime_part_limit_exceeded"
	default:
		return "mime_read_failed"
	}
}

func malformedMIMEManifest(code string) categorizers.MIMEManifest {
	return categorizers.MIMEManifest{
		Status:    categorizers.MIMEParseMalformed,
		ErrorCode: code,
	}
}
