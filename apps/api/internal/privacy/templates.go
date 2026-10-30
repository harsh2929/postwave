// SPDX-License-Identifier: AGPL-3.0-only
//
// templates.go — fail-closed boundary around legacy incident-notification
// drafts. The repository still contains the historical draft assets for legal
// review, but production code does not embed or render them: their assertions
// are not backed by a sourced, effective-dated rule set or verified incident
// evidence.

package privacy

import (
	"errors"
	"fmt"
	"strings"
)

// templateVersion is a legacy draft identifier retained for stored-row and
// wire compatibility. It is not a legal approval or currency marker.
const templateVersion = "2026-06"

// ErrIncidentPacketReleaseHeld is returned for every recognized audience until
// the template and evidence pipeline meets the release acceptance criteria.
var ErrIncidentPacketReleaseHeld = errors.New("privacy: incident packet rendering is release-held")

// IncidentSnapshot is the legacy input shape retained for stored evidence and
// compatibility tests. No production renderer currently consumes it.
type IncidentSnapshot struct {
	IncidentID           string
	ControllerName       string
	Summary              string
	DetectedAt           string
	ClockStartedAt       string
	ContainmentAt        string
	DeadlineAt           string
	AffectedCategories   string
	AffectedRegions      string
	AffectedSubjectCount string
	Jurisdictions        []string
	ContentRequirements  []string
	DPOName              string
	DPOEmail             string
	SignoffBy            string
	SignoffAt            string
	TemplateVersion      string
	GeneratedAt          string
}

// PacketAudience is the legacy wire enum used by the held endpoint.
type PacketAudience string

const (
	PacketAudienceAuthority   PacketAudience = "authority"
	PacketAudienceCustomer    PacketAudience = "customer"
	PacketAudienceDataSubject PacketAudience = "data_subject"
)

// ValidAudience reports whether a is one of the three recognized legacy
// audience names. Recognition does not establish a notification duty.
func ValidAudience(a string) bool {
	switch PacketAudience(a) {
	case PacketAudienceAuthority, PacketAudienceCustomer, PacketAudienceDataSubject:
		return true
	}
	return false
}

// RenderPacket fails closed for every recognized audience. Keeping this guard
// below the HTTP handler prevents a future internal caller from bypassing the
// route-level release hold and generating an unsupported legal artifact.
func RenderPacket(audience PacketAudience, _ IncidentSnapshot) (string, string, error) {
	if !ValidAudience(string(audience)) {
		return "", "", fmt.Errorf("privacy: unknown packet audience %q", string(audience))
	}
	return "", "", ErrIncidentPacketReleaseHeld
}

// PacketFilename returns a stable legacy filename. No file is generated while
// RenderPacket and the HTTP endpoint remain release-held.
func PacketFilename(audience PacketAudience, incidentID string) string {
	safe := strings.ToLower(strings.TrimSpace(incidentID))
	safe = strings.ReplaceAll(safe, " ", "-")
	if safe == "" {
		safe = "incident"
	}
	return fmt.Sprintf("postwave-incident-%s-%s.md", safe, string(audience))
}

// TemplateVersion exposes the legacy stored-row identifier.
func TemplateVersion() string { return templateVersion }
