// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import "testing"

// A honeypot label is only worth as much as the claim "no human could have
// done this". These tests pin that claim to the concrete rendering behaviour
// of each hiding technique, because getting it wrong is not a missed
// detection — it is a HUMAN certified as a machine, in the corpus that
// certifies the shipped classifier.

func TestOffScreenTextDoesNotCertify(t *testing.T) {
	// The trap. Off-screen positioning (the sr-only idiom) is invisible to a
	// sighted reader and therefore looks like a honeypot, but a screen reader
	// announces it and the keyboard tab order reaches it. A blind recipient
	// activating that link is a human, and labelling them machine would teach
	// the classifier that assistive technology is a bot.
	if TechniqueOffScreen.Certifies() {
		t.Error("off-screen text certified a machine label; a screen-reader user can reach and activate it")
	}
}

func TestZeroSizeDoesNotCertify(t *testing.T) {
	// A zero-size anchor still occupies a position in the tab order and is
	// activated by Enter. Invisible is not the same as unreachable.
	if TechniqueZeroSize.Certifies() {
		t.Error("zero-size anchor certified a machine label; it remains keyboard-focusable")
	}
}

func TestColorMatchDoesNotCertify(t *testing.T) {
	// Text painted the same colour as its background is fully present: it is
	// selectable, announced, focusable and clickable. It hides from one sense
	// only.
	if TechniqueColorMatch.Certifies() {
		t.Error("colour-matched text certified a machine label; it is fully present and clickable")
	}
}

func TestUnknownTechniqueDoesNotCertify(t *testing.T) {
	// Rows outlive the generator that wrote them. A technique this build does
	// not recognise must decay to "cannot certify" rather than be assumed
	// safe, so that reading old evidence with new code is conservative.
	if Technique("something_invented_later").Certifies() {
		t.Error("an unrecognised technique certified a machine label")
	}
	if Technique("").Certifies() {
		t.Error("the zero-value technique certified a machine label")
	}
}

func TestDisplayNoneCertifiesAMachineLabel(t *testing.T) {
	// display:none removes the subtree from the render tree entirely: no box,
	// no tab stop, and the accessibility tree omits it. There is no human
	// affordance left to activate.
	if !TechniqueDisplayNone.Certifies() {
		t.Error("display:none did not certify; it is the one technique with no human affordance")
	}
}
