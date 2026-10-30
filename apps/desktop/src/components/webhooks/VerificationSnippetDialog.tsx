/**
 * VerificationSnippetDialog — copy-pasteable verification examples for the
 * exact signing algorithm configured on a canonical outbound webhook.
 *
 * All examples verify the timestamp and the exact raw request bytes. They
 * intentionally accept any matching same-version signature because key
 * rotation can temporarily emit primary and secondary signatures together.
 */

import { type ReactElement, useState } from "react";

import type { OutboundWebhookSigningAlgorithm } from "../../lib/api-client";
import { writeClipboardText } from "../../lib/clipboard";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";

type Lang = "node" | "python" | "go";

interface Props {
  open: boolean;
  onClose: () => void;
  signingAlgorithm?: OutboundWebhookSigningAlgorithm;
  /** Display-only — key material never appears inside copied snippets. */
  secretHint?: string;
}

const LANGS: ReadonlyArray<{ value: Lang; label: string }> = [
  { value: "node", label: "Node.js" },
  { value: "python", label: "Python" },
  { value: "go", label: "Go" },
];

const ALGORITHM_LABELS: Record<OutboundWebhookSigningAlgorithm, string> = {
  hmac_sha256: "HMAC-SHA256",
  ecdsa_p256: "ECDSA P-256 with SHA-256",
  ed25519: "Ed25519",
};

function hmacSnippet(lang: Lang): string {
  if (lang === "node") {
    return `// rawBody must be the exact request bytes, before JSON parsing.
const crypto = require('node:crypto');

function verifyPostwave(rawBody, header, secret, toleranceSec = 300) {
  const parts = (header || '').split(',').map(p => p.trim());
  const timestamps = parts.filter(p => p.startsWith('t=')).map(p => p.slice(2));
  const t = timestamps[0];
  const signatures = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (timestamps.length !== 1 || !t || signatures.length === 0 || !/^\\d+$/.test(t)) throw new Error('malformed signature');
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSec) throw new Error('stale signature');
  const expected = crypto.createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(t + '.', 'utf8'), rawBody]))
    .digest();
  const valid = signatures.some(hex => {
    if (!/^[0-9a-f]+$/i.test(hex)) return false;
    const actual = Buffer.from(hex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  });
  if (!valid) throw new Error('bad signature');
}`;
  }
  if (lang === "python") {
    return `# raw_body must be the exact request bytes, before JSON parsing.
import hashlib, hmac, time

def verify_postwave(raw_body: bytes, header: str, secret: str, tolerance_sec: int = 300) -> None:
    parts = [part.strip() for part in (header or '').split(',')]
    timestamps = [part[2:] for part in parts if part.startswith('t=')]
    timestamp = timestamps[0] if len(timestamps) == 1 else None
    signatures = [part[3:] for part in parts if part.startswith('v1=')]
    if not timestamp or not timestamp.isdigit() or not signatures:
        raise ValueError('malformed signature')
    if abs(int(time.time()) - int(timestamp)) > tolerance_sec:
        raise ValueError('stale signature')
    expected = hmac.new(secret.encode(), timestamp.encode() + b'.' + raw_body, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, signature) for signature in signatures):
        raise ValueError('bad signature')`;
  }
  return `// rawBody must be the exact request bytes, before JSON decoding.
package webhooks

import (
  "crypto/hmac"
  "crypto/sha256"
  "encoding/hex"
  "errors"
  "strconv"
  "strings"
  "time"
)

func VerifyPostwave(rawBody []byte, header, secret string, tolerance time.Duration) error {
  var timestamp string
  seenTimestamp := false
  var signatures []string
  for _, part := range strings.Split(header, ",") {
    part = strings.TrimSpace(part)
    if strings.HasPrefix(part, "t=") {
      if seenTimestamp { return errors.New("malformed signature") }
      seenTimestamp = true
      timestamp = strings.TrimPrefix(part, "t=")
    }
    if strings.HasPrefix(part, "v1=") { signatures = append(signatures, strings.TrimPrefix(part, "v1=")) }
  }
  unix, err := strconv.ParseInt(timestamp, 10, 64)
  if err != nil || len(signatures) == 0 { return errors.New("malformed signature") }
  skew := time.Since(time.Unix(unix, 0)); if skew < 0 { skew = -skew }
  if skew > tolerance { return errors.New("stale signature") }
  mac := hmac.New(sha256.New, []byte(secret))
  mac.Write([]byte(timestamp + ".")); mac.Write(rawBody)
  expected := mac.Sum(nil)
  for _, candidate := range signatures {
    actual, err := hex.DecodeString(candidate)
    if err == nil && hmac.Equal(expected, actual) { return nil }
  }
  return errors.New("bad signature")
}`;
}

function asymmetricSnippet(
  lang: Lang,
  algorithm: Exclude<OutboundWebhookSigningAlgorithm, "hmac_sha256">,
): string {
  const version = algorithm === "ecdsa_p256" ? "v2" : "v3";
  if (lang === "node") {
    const verify =
      algorithm === "ecdsa_p256"
        ? "crypto.verify('sha256', payload, publicKeyPem, signature)"
        : "crypto.verify(null, payload, publicKeyPem, signature)";
    return `// rawBody must be the exact request bytes, before JSON parsing.
const crypto = require('node:crypto');

function verifyPostwave(rawBody, header, publicKeyPem, toleranceSec = 300) {
  const parts = (header || '').split(',').map(p => p.trim());
  const timestamps = parts.filter(p => p.startsWith('t=')).map(p => p.slice(2));
  const t = timestamps[0];
  const signatures = parts.filter(p => p.startsWith('${version}=')).map(p => p.slice(3));
  if (timestamps.length !== 1 || !t || signatures.length === 0 || !/^\\d+$/.test(t)) throw new Error('malformed signature');
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSec) throw new Error('stale signature');
  const payload = Buffer.concat([Buffer.from(t + '.', 'utf8'), rawBody]);
  const valid = signatures.some(hex => /^[0-9a-f]+$/i.test(hex) &&
    ${verify.replace("signature", "Buffer.from(hex, 'hex')")});
  if (!valid) throw new Error('bad signature');
}`;
  }
  if (lang === "python") {
    const imports =
      algorithm === "ecdsa_p256"
        ? "from cryptography.hazmat.primitives import hashes, serialization\nfrom cryptography.hazmat.primitives.asymmetric import ec"
        : "from cryptography.hazmat.primitives import serialization";
    const verify =
      algorithm === "ecdsa_p256"
        ? "public_key.verify(signature, payload, ec.ECDSA(hashes.SHA256()))"
        : "public_key.verify(signature, payload)";
    return `# Requires cryptography. raw_body is the exact request bytes.
import time
from cryptography.exceptions import InvalidSignature
${imports}

def verify_postwave(raw_body: bytes, header: str, public_key_pem: bytes, tolerance_sec: int = 300) -> None:
    parts = [part.strip() for part in (header or '').split(',')]
    timestamps = [part[2:] for part in parts if part.startswith('t=')]
    timestamp = timestamps[0] if len(timestamps) == 1 else None
    signatures = [part[3:] for part in parts if part.startswith('${version}=')]
    if not timestamp or not timestamp.isdigit() or not signatures:
        raise ValueError('malformed signature')
    if abs(int(time.time()) - int(timestamp)) > tolerance_sec:
        raise ValueError('stale signature')
    payload = timestamp.encode() + b'.' + raw_body
    public_key = serialization.load_pem_public_key(public_key_pem)
    for candidate in signatures:
        try:
            signature = bytes.fromhex(candidate)
            ${verify}
            return
        except (InvalidSignature, ValueError, TypeError):
            pass
    raise ValueError('bad signature')`;
  }
  if (algorithm === "ecdsa_p256") {
    return `// rawBody must be the exact request bytes, before JSON decoding.
package webhooks

import (
  "crypto/ecdsa"
  "crypto/sha256"
  "crypto/x509"
  "encoding/hex"
  "encoding/pem"
  "errors"
  "strconv"
  "strings"
  "time"
)

func VerifyPostwave(rawBody []byte, header string, publicKeyPEM []byte, tolerance time.Duration) error {
  timestamp, signatures, malformed := signatureParts(header, "v2=")
  unix, err := strconv.ParseInt(timestamp, 10, 64)
  if malformed || err != nil || len(signatures) == 0 { return errors.New("malformed signature") }
  skew := time.Since(time.Unix(unix, 0)); if skew < 0 { skew = -skew }
  if skew > tolerance { return errors.New("stale signature") }
  block, _ := pem.Decode(publicKeyPEM); if block == nil { return errors.New("bad public key") }
  parsed, err := x509.ParsePKIXPublicKey(block.Bytes); if err != nil { return err }
  publicKey, ok := parsed.(*ecdsa.PublicKey); if !ok { return errors.New("wrong key type") }
  digest := sha256.Sum256(append([]byte(timestamp+"."), rawBody...))
  for _, candidate := range signatures {
    signature, err := hex.DecodeString(candidate)
    if err == nil && ecdsa.VerifyASN1(publicKey, digest[:], signature) { return nil }
  }
  return errors.New("bad signature")
}

func signatureParts(header, prefix string) (string, []string, bool) {
  var timestamp string; var signatures []string; seenTimestamp := false
  for _, part := range strings.Split(header, ",") {
    part = strings.TrimSpace(part)
    if strings.HasPrefix(part, "t=") {
      if seenTimestamp { return "", nil, true }
      seenTimestamp = true
      timestamp = strings.TrimPrefix(part, "t=")
    }
    if strings.HasPrefix(part, prefix) { signatures = append(signatures, strings.TrimPrefix(part, prefix)) }
  }
  return timestamp, signatures, false
}`;
  }
  return `// rawBody must be the exact request bytes, before JSON decoding.
package webhooks

import (
  "crypto/ed25519"
  "crypto/x509"
  "encoding/hex"
  "encoding/pem"
  "errors"
  "strconv"
  "strings"
  "time"
)

func VerifyPostwave(rawBody []byte, header string, publicKeyPEM []byte, tolerance time.Duration) error {
  var timestamp string; var signatures []string; seenTimestamp := false
  for _, part := range strings.Split(header, ",") {
    part = strings.TrimSpace(part)
    if strings.HasPrefix(part, "t=") {
      if seenTimestamp { return errors.New("malformed signature") }
      seenTimestamp = true
      timestamp = strings.TrimPrefix(part, "t=")
    }
    if strings.HasPrefix(part, "v3=") { signatures = append(signatures, strings.TrimPrefix(part, "v3=")) }
  }
  unix, err := strconv.ParseInt(timestamp, 10, 64)
  if err != nil || len(signatures) == 0 { return errors.New("malformed signature") }
  skew := time.Since(time.Unix(unix, 0)); if skew < 0 { skew = -skew }
  if skew > tolerance { return errors.New("stale signature") }
  block, _ := pem.Decode(publicKeyPEM); if block == nil { return errors.New("bad public key") }
  parsed, err := x509.ParsePKIXPublicKey(block.Bytes); if err != nil { return err }
  publicKey, ok := parsed.(ed25519.PublicKey); if !ok { return errors.New("wrong key type") }
  payload := append([]byte(timestamp+"."), rawBody...)
  for _, candidate := range signatures {
    signature, err := hex.DecodeString(candidate)
    if err == nil && ed25519.Verify(publicKey, payload, signature) { return nil }
  }
  return errors.New("bad signature")
}`;
}

function snippet(
  lang: Lang,
  algorithm: OutboundWebhookSigningAlgorithm,
): string {
  return algorithm === "hmac_sha256"
    ? hmacSnippet(lang)
    : asymmetricSnippet(lang, algorithm);
}

export function VerificationSnippetDialog({
  open,
  onClose,
  signingAlgorithm = "hmac_sha256",
  secretHint,
}: Props): ReactElement {
  const [lang, setLang] = useState<Lang>("node");
  const tabs = useTabsInteraction({
    value: lang,
    items: LANGS.map((item) => ({ value: item.value })),
    onChange: setLang,
  });
  const code = snippet(lang, signingAlgorithm);
  const copy = async (): Promise<void> => {
    const result = await writeClipboardText(code, {
      contentClass: "public",
      label: `${lang} ${signingAlgorithm} verification snippet`,
    });
    if (result.ok) toast.success(`Copied ${lang} snippet`);
    else toast.error(result.message);
  };
  const keyLabel =
    signingAlgorithm === "hmac_sha256" ? "shared secret" : "public key PEM";
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Verify webhook signature"
      description={`Verify X-Postwave-Signature using ${ALGORITHM_LABELS[signingAlgorithm]} and the exact raw request body.`}
    >
      <div
        ref={tabs.listRef}
        className="lib-segmented wh-verification-tabs"
        {...tabs.listProps}
        aria-label="Verification language"
      >
        {LANGS.map((item) => (
          <button
            key={item.value}
            type="button"
            {...tabs.getTabProps(item.value)}
            className={lang === item.value ? "is-active" : ""}
          >
            {item.label}
          </button>
        ))}
      </div>
      {LANGS.map((item) => (
        <pre
          key={item.value}
          {...tabs.getPanelProps(item.value)}
          className="wh-verification-snippet"
          style={{ marginTop: 12 }}
        >
          <code>{snippet(item.value, signingAlgorithm)}</code>
        </pre>
      ))}
      <div className="wh-verification-identity-note" role="note">
        <strong>Only the exact body is authenticated.</strong>
        <span>
          Read freshness from the <code>t=</code> component of{" "}
          <code>X-Postwave-Signature</code>—outbound requests do not send a
          separate timestamp header. Auxiliary <code>X-Postwave-Event-Id</code>{" "}
          and <code>X-Postwave-Delivery</code> headers are not covered by that
          signature. Deduplicate only an identity present inside the verified
          signed body; if a transform removes it, do not trust a header as its
          replacement. <code>X-Postwave-Test: true</code> appears only on
          operator tests and Simulator fires.
        </span>
      </div>
      <p className="muted small">
        Replace the <code>{keyLabel}</code> argument with the material saved at
        create or rotation time{secretHint ? ` — ${secretHint}` : ""}. During a
        rotation grace window, accept any valid signature for an announced key
        ID, then retire the old key at the displayed expiry.
      </p>
      <ModalFooter>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void copy()}
        >
          Copy snippet
        </button>
      </ModalFooter>
    </Modal>
  );
}
