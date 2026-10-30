// SPDX-License-Identifier: AGPL-3.0-only

// Package mimecomposer builds canonical multipart/alternative email messages.
//
// Compose is deliberately transport-independent and deterministic: callers
// provide the Date, Message-ID, and MIME boundary that appear on the wire. The
// returned bytes are therefore suitable for hashing, persistence as an
// immutable send artifact, and byte-for-byte comparison before transport or
// through a transport that has been certified not to rewrite the MIME entity.
//
// The package only composes message headers and the MIME body. SMTP envelope
// recipients (including Bcc), DKIM signing, Return-Path, Received, and
// provider-specific headers remain the responsibility of the transport.
//
// Hashes.MIME identifies the exact locally composed artifact. DKIM signing and
// normal SMTP transit prepend headers, so hashing a received .eml will not
// normally reproduce it. Some providers also replace Date or Message-ID, and
// structured "send email" APIs commonly rebuild the entire MIME entity with a
// new boundary and transfer encoding. Integrations that require byte identity
// must use a raw-message transport whose rewrite behavior has been certified.
// Otherwise compare the decoded semantic alternatives with Hashes.Text and
// Hashes.HTML and retain both the authored Message-ID and provider message ID.
package mimecomposer
