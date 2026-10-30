// SPDX-License-Identifier: AGPL-3.0-only

package mimecomposer

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// FormatVersion identifies the canonical byte-composition algorithm.
	FormatVersion = "postwave.mime-composer.v1"

	// ContentHashVersion identifies the framing and fields included in
	// Hashes.Content. Persist it beside a content hash used outside this package.
	ContentHashVersion = "postwave.mime-content.v1"

	// Resource limits bound memory amplification during normalization,
	// quoted-printable encoding, and final artifact copying.
	MaxSubjectBytes               = 8 << 10
	MaxTextBodyBytes              = 2 << 20
	MaxHTMLBodyBytes              = 8 << 20
	MaxRawMessageBytes            = 32 << 20
	MaxRecipients                 = 1000
	MaxDisplayNameBytes           = 1 << 10
	MaxAddressBytes               = 254
	MaxMessageIDBytes             = 512
	MaxAdditionalHeaders          = 100
	MaxAdditionalHeaderNameBytes  = 128
	MaxAdditionalHeaderValueBytes = 64 << 10

	softHeaderLineLen = 78
	hardHeaderLineLen = 998
)

// Message is the semantic input to a multipart/alternative message. TextBody
// and HTMLBody are both required: RFC 2046 orders alternatives from the least
// to the most faithful representation, so Compose always writes text/plain
// first and text/html last.
//
// Headers is for additional ASCII headers such as List-Unsubscribe,
// List-Unsubscribe-Post, References, and X-Postwave-Test-ID. Compose rejects
// header names it owns, transport-owned authentication/routing headers,
// non-ASCII values, control characters, and any CR/LF injection attempt.
// Exported Max* constants define the accepted resource envelope.
type Message struct {
	From    mail.Address
	To      []mail.Address
	Cc      []mail.Address
	ReplyTo []mail.Address

	Subject  string
	TextBody string
	HTMLBody string

	Headers map[string]string
}

// Metadata contains the wire values that vary between message instances.
// Requiring these values keeps Compose free of implicit clocks and randomness.
// MessageID may be supplied with or without angle brackets; Compose emits the
// canonical bracketed form. Boundary must be a valid MIME boundary without
// whitespace; a cryptographically random ASCII token is recommended.
type Metadata struct {
	Date      time.Time
	MessageID string
	Boundary  string
}

// Hashes contains lowercase hexadecimal SHA-256 digests.
//
// MIME is the digest of the exact returned bytes. Content is a versioned,
// length-framed digest of the canonical subject, text, and HTML, independent
// of Date, Message-ID, boundary, recipients, and additional headers. Text and
// HTML hash their respective UTF-8 bodies after line endings are normalized to
// CRLF. Content deliberately excludes sender, recipients, Reply-To, and extra
// headers; it is not an approval or send-plan fingerprint.
type Hashes struct {
	MIME    string
	Content string
	Text    string
	HTML    string
}

// Result is one complete RFC message and the hashes calculated from it.
type Result struct {
	Raw    []byte
	Hashes Hashes
}

type header struct {
	name  string
	value string
}

var reservedHeaders = map[string]struct{}{
	"authentication-results":            {},
	"bcc":                               {},
	"cc":                                {},
	"content-length":                    {},
	"content-transfer-encoding":         {},
	"content-type":                      {},
	"date":                              {},
	"delivered-to":                      {},
	"dkim-signature":                    {},
	"envelope-to":                       {},
	"from":                              {},
	"message-id":                        {},
	"mime-version":                      {},
	"received":                          {},
	"reply-to":                          {},
	"return-path":                       {},
	"sender":                            {},
	"subject":                           {},
	"to":                                {},
	"x-original-authentication-results": {},
}

// Compose validates and builds a canonical multipart/alternative message.
// It returns no partial result on failure.
func Compose(message Message, metadata Metadata) (Result, error) {
	prepared, err := prepare(message, metadata)
	if err != nil {
		return Result{}, err
	}

	textEncoded, err := quotedPrintable(prepared.textBody)
	if err != nil {
		return Result{}, fmt.Errorf("encode text/plain: %w", err)
	}
	htmlEncoded, err := quotedPrintable(prepared.htmlBody)
	if err != nil {
		return Result{}, fmt.Errorf("encode text/html: %w", err)
	}
	if hasBoundaryCollision(textEncoded, prepared.boundary) {
		return Result{}, errors.New("text/plain body collides with MIME boundary")
	}
	if hasBoundaryCollision(htmlEncoded, prepared.boundary) {
		return Result{}, errors.New("text/html body collides with MIME boundary")
	}

	var raw bytes.Buffer
	for _, h := range prepared.headers {
		if err := writeHeader(&raw, h.name, h.value); err != nil {
			return Result{}, err
		}
	}
	raw.WriteString("\r\n")

	writePartStart(&raw, prepared.boundary, "text/plain; charset=UTF-8")
	raw.Write(textEncoded)
	raw.WriteString("\r\n")
	writePartStart(&raw, prepared.boundary, "text/html; charset=UTF-8")
	raw.Write(htmlEncoded)
	raw.WriteString("\r\n--")
	raw.WriteString(prepared.boundary)
	raw.WriteString("--\r\n")

	data := raw.Bytes()
	if len(data) > MaxRawMessageBytes {
		return Result{}, fmt.Errorf("composed MIME exceeds %d bytes", MaxRawMessageBytes)
	}
	if !usesOnlyCRLF(data) {
		return Result{}, errors.New("internal error: composed message contains a bare CR or LF")
	}

	result := Result{Raw: append([]byte(nil), data...)}
	result.Hashes.MIME = digestHex(data)
	result.Hashes.Text = digestHex([]byte(prepared.textBody))
	result.Hashes.HTML = digestHex([]byte(prepared.htmlBody))
	result.Hashes.Content = contentDigest(prepared.subject, prepared.textBody, prepared.htmlBody)
	return result, nil
}

type preparedMessage struct {
	subject  string
	textBody string
	htmlBody string
	boundary string
	headers  []header
}

func prepare(message Message, metadata Metadata) (preparedMessage, error) {
	if metadata.Date.IsZero() {
		return preparedMessage{}, errors.New("Date is required")
	}
	_, zoneOffset := metadata.Date.Zone()
	if zoneOffset%60 != 0 {
		return preparedMessage{}, errors.New("Date timezone offset must be a whole number of minutes")
	}
	if zoneOffset <= -24*60*60 || zoneOffset >= 24*60*60 {
		return preparedMessage{}, errors.New("Date timezone offset must be between -24:00 and +24:00")
	}

	messageID, err := canonicalMessageID(metadata.MessageID)
	if err != nil {
		return preparedMessage{}, err
	}
	if err := validateBoundary(metadata.Boundary); err != nil {
		return preparedMessage{}, err
	}
	if len(message.To)+len(message.Cc)+len(message.ReplyTo) > MaxRecipients {
		return preparedMessage{}, fmt.Errorf("message exceeds the %d-address limit", MaxRecipients)
	}

	from, err := formatAddress(message.From, "From")
	if err != nil {
		return preparedMessage{}, err
	}
	to, err := formatAddressList(message.To, "To", true)
	if err != nil {
		return preparedMessage{}, err
	}
	cc, err := formatAddressList(message.Cc, "Cc", false)
	if err != nil {
		return preparedMessage{}, err
	}
	replyTo, err := formatAddressList(message.ReplyTo, "Reply-To", false)
	if err != nil {
		return preparedMessage{}, err
	}

	if len(message.Subject) > MaxSubjectBytes {
		return preparedMessage{}, fmt.Errorf("Subject exceeds %d bytes", MaxSubjectBytes)
	}
	if err := validateDisplayText(message.Subject, "Subject"); err != nil {
		return preparedMessage{}, err
	}
	subject := strings.TrimSpace(message.Subject)
	if subject == "" {
		return preparedMessage{}, errors.New("Subject is required")
	}
	if containsEncodedWord(subject) {
		return preparedMessage{}, errors.New("Subject must contain decoded text, not an RFC 2047 encoded-word")
	}
	if message.TextBody == "" {
		return preparedMessage{}, errors.New("TextBody is required")
	}
	if len(message.TextBody) > MaxTextBodyBytes {
		return preparedMessage{}, fmt.Errorf("TextBody exceeds %d bytes", MaxTextBodyBytes)
	}
	if message.HTMLBody == "" {
		return preparedMessage{}, errors.New("HTMLBody is required")
	}
	if len(message.HTMLBody) > MaxHTMLBodyBytes {
		return preparedMessage{}, fmt.Errorf("HTMLBody exceeds %d bytes", MaxHTMLBodyBytes)
	}
	if !utf8.ValidString(message.TextBody) {
		return preparedMessage{}, errors.New("TextBody must be valid UTF-8")
	}
	if !utf8.ValidString(message.HTMLBody) {
		return preparedMessage{}, errors.New("HTMLBody must be valid UTF-8")
	}

	additional, err := prepareAdditionalHeaders(message.Headers)
	if err != nil {
		return preparedMessage{}, err
	}

	contentType := mime.FormatMediaType("multipart/alternative", map[string]string{"boundary": metadata.Boundary})
	if contentType == "" {
		return preparedMessage{}, errors.New("Boundary cannot be represented as a MIME parameter")
	}

	headers := []header{
		{name: "Date", value: metadata.Date.Format(time.RFC1123Z)},
		{name: "From", value: from},
		{name: "To", value: to},
	}
	if cc != "" {
		headers = append(headers, header{name: "Cc", value: cc})
	}
	if replyTo != "" {
		headers = append(headers, header{name: "Reply-To", value: replyTo})
	}
	headers = append(headers,
		header{name: "Subject", value: mime.QEncoding.Encode("UTF-8", subject)},
		header{name: "Message-ID", value: messageID},
		header{name: "MIME-Version", value: "1.0"},
	)
	headers = append(headers, additional...)
	headers = append(headers, header{name: "Content-Type", value: contentType})

	return preparedMessage{
		subject:  subject,
		textBody: normalizeCRLF(message.TextBody),
		htmlBody: normalizeCRLF(message.HTMLBody),
		boundary: metadata.Boundary,
		headers:  headers,
	}, nil
}

func prepareAdditionalHeaders(input map[string]string) ([]header, error) {
	if len(input) == 0 {
		return nil, nil
	}
	if len(input) > MaxAdditionalHeaders {
		return nil, fmt.Errorf("message exceeds the %d-additional-header limit", MaxAdditionalHeaders)
	}

	seen := make(map[string]struct{}, len(input))
	out := make([]header, 0, len(input))
	for rawName, rawValue := range input {
		if len(rawName) > MaxAdditionalHeaderNameBytes {
			return nil, fmt.Errorf("additional header name exceeds %d bytes", MaxAdditionalHeaderNameBytes)
		}
		if !validHeaderName(rawName) {
			return nil, fmt.Errorf("invalid additional header name %q", rawName)
		}
		canonicalName := textproto.CanonicalMIMEHeaderKey(rawName)
		lowerName := strings.ToLower(canonicalName)
		if _, exists := seen[lowerName]; exists {
			return nil, fmt.Errorf("duplicate additional header %q", canonicalName)
		}
		seen[lowerName] = struct{}{}
		if isReservedHeader(lowerName) {
			return nil, fmt.Errorf("additional header %q is owned by the composer or transport", canonicalName)
		}

		if len(rawValue) > MaxAdditionalHeaderValueBytes {
			return nil, fmt.Errorf("additional header %q exceeds %d bytes", canonicalName, MaxAdditionalHeaderValueBytes)
		}
		if err := validateAdditionalHeaderValue(rawValue); err != nil {
			return nil, fmt.Errorf("invalid additional header %q: %w", canonicalName, err)
		}
		value := strings.TrimSpace(rawValue)
		if value == "" {
			return nil, fmt.Errorf("additional header %q must not be empty", canonicalName)
		}
		out = append(out, header{name: canonicalName, value: value})
	}

	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].name) < strings.ToLower(out[j].name)
	})
	return out, nil
}

func isReservedHeader(lowerName string) bool {
	if _, reserved := reservedHeaders[lowerName]; reserved {
		return true
	}
	return strings.HasPrefix(lowerName, "arc-") || strings.HasPrefix(lowerName, "resent-")
}

func validHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		// RFC 5322 ftext is printable US-ASCII except colon.
		if name[i] < 33 || name[i] > 126 || name[i] == ':' {
			return false
		}
	}
	return true
}

func validateAdditionalHeaderValue(value string) error {
	for i := 0; i < len(value); i++ {
		b := value[i]
		switch {
		case b == '\r' || b == '\n':
			return errors.New("CR and LF are forbidden")
		case b == '\t':
			continue
		case b < 32 || b == 127:
			return errors.New("control characters are forbidden")
		case b > 126:
			return errors.New("value must be ASCII; use a typed encoded field for internationalized text")
		}
	}
	return nil
}

func formatAddressList(addresses []mail.Address, field string, required bool) (string, error) {
	if len(addresses) == 0 {
		if required {
			return "", fmt.Errorf("%s is required", field)
		}
		return "", nil
	}
	formatted := make([]string, 0, len(addresses))
	for i, address := range addresses {
		value, err := formatAddress(address, fmt.Sprintf("%s[%d]", field, i))
		if err != nil {
			return "", err
		}
		formatted = append(formatted, value)
	}
	return strings.Join(formatted, ", "), nil
}

func formatAddress(address mail.Address, field string) (string, error) {
	if len(address.Name) > MaxDisplayNameBytes {
		return "", fmt.Errorf("%s display name exceeds %d bytes", field, MaxDisplayNameBytes)
	}
	if err := validateDisplayText(address.Name, field+" display name"); err != nil {
		return "", err
	}
	if containsEncodedWord(address.Name) {
		return "", fmt.Errorf("%s display name must contain decoded text, not an RFC 2047 encoded-word", field)
	}
	if address.Address == "" {
		return "", fmt.Errorf("%s address is required", field)
	}
	if len(address.Address) > MaxAddressBytes {
		return "", fmt.Errorf("%s address exceeds %d bytes", field, MaxAddressBytes)
	}
	if !isASCII(address.Address) || strings.ContainsAny(address.Address, "\r\n\x00") {
		return "", fmt.Errorf("%s address must be a safe ASCII addr-spec", field)
	}
	parsed, err := mail.ParseAddress(address.Address)
	if err != nil || parsed.Name != "" || parsed.Address != address.Address {
		return "", fmt.Errorf("%s address must be an addr-spec: %q", field, address.Address)
	}
	return (&mail.Address{Name: address.Name, Address: address.Address}).String(), nil
}

func validateDisplayText(value, field string) error {
	if !utf8.ValidString(value) {
		return fmt.Errorf("%s must be valid UTF-8", field)
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return fmt.Errorf("%s contains a control character", field)
		}
	}
	return nil
}

func isASCII(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] > 127 {
			return false
		}
	}
	return true
}

func canonicalMessageID(value string) (string, error) {
	if len(value) > MaxMessageIDBytes {
		return "", fmt.Errorf("MessageID exceeds %d bytes", MaxMessageIDBytes)
	}
	if !utf8.ValidString(value) {
		return "", errors.New("MessageID must be valid UTF-8")
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return "", errors.New("MessageID contains a control character")
		}
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("MessageID is required")
	}
	if strings.HasPrefix(value, "<") || strings.HasSuffix(value, ">") {
		if !strings.HasPrefix(value, "<") || !strings.HasSuffix(value, ">") || len(value) < 3 {
			return "", errors.New("MessageID has mismatched angle brackets")
		}
		value = value[1 : len(value)-1]
	}
	if strings.Count(value, "@") != 1 {
		return "", errors.New("MessageID must contain one @")
	}
	left, right, _ := strings.Cut(value, "@")
	if !validDotAtom(left) {
		return "", errors.New("MessageID local part must be a dot-atom")
	}
	if !validDomain(right) {
		return "", errors.New("MessageID domain is invalid")
	}
	return "<" + value + ">", nil
}

func validDotAtom(value string) bool {
	if value == "" || strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") || strings.Contains(value, "..") {
		return false
	}
	for i := 0; i < len(value); i++ {
		b := value[i]
		if (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') {
			continue
		}
		if strings.ContainsRune("!#$%&'*+-/=?^_`{|}~.", rune(b)) {
			continue
		}
		return false
	}
	return true
}

func validDomain(value string) bool {
	if value == "" || len(value) > 255 || strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") {
		return false
	}
	labels := strings.Split(value, ".")
	for _, label := range labels {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for i := 0; i < len(label); i++ {
			b := label[i]
			if (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '-' {
				continue
			}
			return false
		}
	}
	return true
}

func validateBoundary(boundary string) error {
	if boundary == "" {
		return errors.New("Boundary is required")
	}
	if strings.ContainsAny(boundary, " \t") {
		return errors.New("Boundary must not contain whitespace")
	}
	w := multipart.NewWriter(io.Discard)
	defer func() { _ = w.Close() }()
	if err := w.SetBoundary(boundary); err != nil {
		return fmt.Errorf("invalid Boundary: %w", err)
	}
	return nil
}

func containsEncodedWord(value string) bool {
	if !strings.Contains(value, "=?") {
		return false
	}
	decoded, err := new(mime.WordDecoder).DecodeHeader(value)
	return err == nil && decoded != value
}

func quotedPrintable(body string) ([]byte, error) {
	var encoded bytes.Buffer
	w := quotedprintable.NewWriter(&encoded)
	if _, err := io.WriteString(w, body); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return encoded.Bytes(), nil
}

func hasBoundaryCollision(encoded []byte, boundary string) bool {
	marker := []byte("--" + boundary)
	return bytes.HasPrefix(encoded, marker) || bytes.Contains(encoded, append([]byte("\r\n"), marker...))
}

func writePartStart(raw *bytes.Buffer, boundary, contentType string) {
	raw.WriteString("--")
	raw.WriteString(boundary)
	raw.WriteString("\r\nContent-Type: ")
	raw.WriteString(contentType)
	raw.WriteString("\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n")
}

func writeHeader(raw *bytes.Buffer, name, value string) error {
	if value == "" {
		raw.WriteString(name)
		raw.WriteString(":\r\n")
		return nil
	}

	prefix := name + ": "
	remaining := value
	for {
		if len(prefix)+len(remaining) <= softHeaderLineLen {
			if len(prefix)+len(remaining) > hardHeaderLineLen {
				return fmt.Errorf("header %q exceeds the RFC 5322 hard line limit", name)
			}
			raw.WriteString(prefix)
			raw.WriteString(remaining)
			raw.WriteString("\r\n")
			return nil
		}

		capacity := softHeaderLineLen - len(prefix)
		splitAt := lastWhitespaceAtOrBefore(remaining, capacity)
		if splitAt <= 0 {
			capacity = hardHeaderLineLen - len(prefix)
			if len(remaining) <= capacity {
				raw.WriteString(prefix)
				raw.WriteString(remaining)
				raw.WriteString("\r\n")
				return nil
			}
			splitAt = lastWhitespaceAtOrBefore(remaining, capacity)
			if splitAt <= 0 {
				return fmt.Errorf("header %q contains an unfolded token exceeding the RFC 5322 hard line limit", name)
			}
		}

		raw.WriteString(prefix)
		raw.WriteString(remaining[:splitAt])
		raw.WriteString("\r\n")
		for splitAt < len(remaining) && (remaining[splitAt] == ' ' || remaining[splitAt] == '\t') {
			splitAt++
		}
		remaining = remaining[splitAt:]
		prefix = "\t"
	}
}

func lastWhitespaceAtOrBefore(value string, capacity int) int {
	if capacity <= 0 || value == "" {
		return -1
	}
	if capacity >= len(value) {
		capacity = len(value) - 1
	}
	for i := capacity; i >= 0; i-- {
		if value[i] == ' ' || value[i] == '\t' {
			return i
		}
	}
	return -1
}

func normalizeCRLF(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	return strings.ReplaceAll(value, "\n", "\r\n")
}

func usesOnlyCRLF(value []byte) bool {
	for i, b := range value {
		switch b {
		case '\r':
			if i+1 >= len(value) || value[i+1] != '\n' {
				return false
			}
		case '\n':
			if i == 0 || value[i-1] != '\r' {
				return false
			}
		}
	}
	return true
}

func digestHex(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func contentDigest(subject, textBody, htmlBody string) string {
	h := sha256.New()
	writeHashFrame(h, ContentHashVersion)
	writeHashFrame(h, subject)
	writeHashFrame(h, textBody)
	writeHashFrame(h, htmlBody)
	return hex.EncodeToString(h.Sum(nil))
}

func writeHashFrame(w io.Writer, value string) {
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(value)))
	_, _ = w.Write(size[:])
	_, _ = io.WriteString(w, value)
}
