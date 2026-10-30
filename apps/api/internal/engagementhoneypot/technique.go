// SPDX-License-Identifier: AGPL-3.0-only

// Package engagementhoneypot produces the one kind of machine ground truth
// this platform can obtain from live traffic.
//
// The calibration harness in engagementclassification already distinguishes
// certifying evidence from diagnostic evidence, and it demotes seed-fleet
// machine labels to diagnostic on purpose: seed identity is an absolute input
// to the classifier, so measuring the classifier on seeds asks it to agree
// with something it was told. That leaves a hole. Before this package there
// was no source of machine ground truth that was NOT a seed, which means
// machine recall had no certifying evidence at all.
//
// A honeypot closes it. The decoy is a link that no human can reach, embedded
// in ordinary mail to ordinary recipients. Anything that fetches it is a
// machine, the recipient is real rather than seeded, and seed identity plays
// no part — so the label certifies without circularity.
//
// The asymmetry the whole design rests on: a rendering engine fetches IMAGES,
// but it does not follow HREFS. An unfetched link stays unfetched no matter
// how the message is displayed. Only something that deliberately walks the
// links — a scanner, a prefetcher, a summariser — issues that GET. This is
// why the decoy must be a link and never an image: an invisible image would
// be fetched by every image-loading human client and would label the entire
// engaged audience as machines.
//
// Everything here is the sending half plus the label rules. The classifier
// itself never reads honeypot state at request time; if it did, the evidence
// would be measuring its own input again.
package engagementhoneypot

// Technique names how a decoy is kept away from human hands. It is stored
// alongside every fetch because the validity of the label depends on it, and
// because a corpus built years later must be able to re-derive that validity
// from the row rather than from a build-time assumption.
type Technique string

const (
	// TechniqueDisplayNone removes the subtree from the render tree: no box is
	// generated, nothing enters the tab order, and the accessibility tree omits
	// it. No human affordance survives, which is what makes the label sound.
	TechniqueDisplayNone Technique = "display_none"

	// TechniqueHTMLComment puts the decoy URL inside an HTML comment, with no
	// element of any kind. It is the safest form available and the only one with
	// no dependency on CSS: a client that strips the style attribute turns a
	// display:none decoy into a plainly visible link, and the next human who
	// clicks it is certified as a machine. A comment has no such failure mode.
	// It yields less, because it is only fetched by scanners that harvest URLs
	// from source rather than walking the DOM — but yield is the cheap axis and
	// a false machine label is the expensive one.
	TechniqueHTMLComment Technique = "html_comment"

	// TechniqueOffScreen is the sr-only idiom — absolute positioning far outside
	// the viewport. It hides from a SIGHTED reader only. Screen readers announce
	// it and the keyboard tab order reaches it, so a blind recipient can
	// genuinely activate the decoy. Certifying that fetch as a machine would
	// write "assistive technology is a bot" into the corpus that calibrates the
	// shipped classifier. Recorded so historical rows can be read; never issued.
	TechniqueOffScreen Technique = "off_screen"

	// TechniqueZeroSize collapses the anchor to nothing. It paints no pixels but
	// still holds a place in the tab order and still activates on Enter.
	// Invisible is not unreachable.
	TechniqueZeroSize Technique = "zero_size"

	// TechniqueColorMatch paints the text in the background colour. The element
	// is entirely present — selectable, announced, focusable, clickable — and
	// hides from exactly one sense.
	TechniqueColorMatch Technique = "color_match"
)

// Certifies reports whether a fetch of a decoy hidden this way is admissible
// as machine ground truth.
//
// The question it answers is narrow and deliberately not "is this invisible":
// it is "could a human have caused this fetch". Anything focusable, anything
// an assistive technology announces, and anything this build does not
// recognise all answer no. The default is no, so evidence written by a future
// version whose techniques this build cannot evaluate degrades to diagnostic
// rather than being trusted by accident.
func (t Technique) Certifies() bool {
	return t == TechniqueDisplayNone || t == TechniqueHTMLComment
}

// CertifyingTechniques is the set a send may issue, safest first. Build emits
// one decoy per entry so that the yield of each can be compared against the
// other in live traffic — the measurement that eventually says whether the CSS
// decoy still earns the spam-filter cost of carrying hidden content.
func CertifyingTechniques() []Technique {
	return []Technique{TechniqueHTMLComment, TechniqueDisplayNone}
}
