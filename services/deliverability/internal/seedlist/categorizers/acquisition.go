package categorizers

// RawMIMEStatus describes whether exact RFC-822 bytes were acquired for a
// controlled seed message. A connector must never claim complete unless Raw
// contains the whole message and SHA256 hashes those exact bytes.
type RawMIMEStatus string

const (
	RawMIMEComplete    RawMIMEStatus = "complete"
	RawMIMETruncated   RawMIMEStatus = "truncated"
	RawMIMEFailed      RawMIMEStatus = "failed"
	RawMIMEUnavailable RawMIMEStatus = "unavailable"
)

// MIMEParseStatus is deliberately separate from acquisition status. A
// message can be captured exactly while still containing malformed MIME.
type MIMEParseStatus string

const (
	MIMEParseParsed    MIMEParseStatus = "parsed"
	MIMEParseMalformed MIMEParseStatus = "malformed"
	MIMEParseSkipped   MIMEParseStatus = "skipped"
)

// MIMEPart is a bounded structural description of a raw MIME leaf. Hashes are
// calculated over the encoded bytes as received; parsing never dereferences a
// URL or executes an attachment.
type MIMEPart struct {
	Path        string `json:"path"`
	MediaType   string `json:"media_type"`
	Charset     string `json:"charset,omitempty"`
	Disposition string `json:"disposition,omitempty"`
	// Attachment filenames can contain customer PII. The durable manifest
	// therefore records only whether one was present and its digest. Raw MIME
	// remains the short-lived, encrypted source of truth.
	HasFilename      bool   `json:"has_filename,omitempty"`
	FilenameSHA256   string `json:"filename_sha256,omitempty"`
	TransferEncoding string `json:"transfer_encoding,omitempty"`
	EncodedBytes     int64  `json:"encoded_bytes"`
	SHA256           string `json:"sha256"`
	DecodedBytes     int64  `json:"decoded_bytes,omitempty"`
	DecodedSHA256    string `json:"decoded_sha256,omitempty"`
}

// MIMEHeader is an ordered, privacy-safe header receipt. Values are never
// retained in the manifest: even apparently harmless fields such as To,
// Message-ID, and filenames can identify a seed account or recipient. Unknown
// extension header names are represented as other-sha256:<digest>, because an
// attacker can encode private data in the header name itself.
type MIMEHeader struct {
	Position    int    `json:"position"`
	Name        string `json:"name"`
	ValueSHA256 string `json:"value_sha256"`
}

// AuthenticationResult retains only the standardized mechanism and verdict
// from Authentication-Results/ARC-Authentication-Results/Received-SPF. It
// deliberately omits authserv-id, domains, selectors, identities, and comments.
type AuthenticationResult struct {
	Header   string `json:"header"`
	Position int    `json:"position"`
	Method   string `json:"method"`
	Result   string `json:"result"`
}

// MIMEManifest is safe structural metadata derived locally from a complete
// capture. ErrorCode is intentionally machine-readable; parser errors are not
// copied verbatim because they may contain hostile message content.
type MIMEManifest struct {
	Status                MIMEParseStatus        `json:"status"`
	ErrorCode             string                 `json:"error_code,omitempty"`
	Headers               []MIMEHeader           `json:"headers,omitempty"`
	AuthenticationResults []AuthenticationResult `json:"authentication_results,omitempty"`
	Parts                 []MIMEPart             `json:"parts,omitempty"`
	StructureSHA256       string                 `json:"structure_sha256,omitempty"`
	TextBodySHA256        string                 `json:"text_body_sha256,omitempty"`
	HTMLBodySHA256        string                 `json:"html_body_sha256,omitempty"`
}

// RawMIMEAcquisition carries bounded received bytes and their provenance.
// Raw is excluded from JSON to prevent accidental API/log exposure. It is
// intended for the encrypted, short-retention observation writer that will be
// wired by Inbox Reality consolidation.
type RawMIMEAcquisition struct {
	Status        RawMIMEStatus `json:"status"`
	Source        string        `json:"source"`
	ErrorCode     string        `json:"error_code,omitempty"`
	SHA256        string        `json:"sha256,omitempty"`
	CapturedBytes int64         `json:"captured_bytes"`
	ReportedBytes int64         `json:"reported_bytes,omitempty"`
	MaxBytes      int64         `json:"max_bytes"`
	Truncated     bool          `json:"truncated"`
	UID           uint32        `json:"uid,omitempty"`
	UIDValidity   uint32        `json:"uid_validity,omitempty"`
	Raw           []byte        `json:"-"`
	Manifest      MIMEManifest  `json:"manifest"`
}
