"""Canonical outbound-webhook HMAC verification.

``X-Postwave-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256>``
signs ``timestamp + b"." + exact_raw_body``.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import time


def compute_signature_hex(
    raw_body: bytes | str,
    secret: str,
    timestamp: int | str | None = None,
) -> str:
    if isinstance(raw_body, str):
        raw_body = raw_body.encode("utf-8")
    timestamp_text = str(int(time.time()) if timestamp is None else timestamp)
    if not timestamp_text.isdigit():
        raise ValueError("timestamp must be Unix seconds")
    signed = timestamp_text.encode("ascii") + b"." + raw_body
    return hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()


def compute_signature_header(
    raw_body: bytes | str,
    secret: str,
    timestamp: int | str | None = None,
) -> str:
    timestamp_text = str(int(time.time()) if timestamp is None else timestamp)
    return f"t={timestamp_text},v1={compute_signature_hex(raw_body, secret, timestamp_text)}"


def verify_signature(
    raw_body: bytes | str,
    header: str | None,
    secret: str,
    *,
    now: float | None = None,
    tolerance_seconds: int = 300,
) -> bool:
    if not header or not secret:
        return False
    timestamp: str | None = None
    signatures: list[str] = []
    for raw_part in header.split(","):
        key, separator, value = raw_part.strip().partition("=")
        if not separator:
            continue
        if key == "t":
            if timestamp is not None:
                return False
            timestamp = value
        elif key == "v1" and len(value) == 64:
            try:
                bytes.fromhex(value)
            except ValueError:
                continue
            signatures.append(value.lower())
    if timestamp is None or not timestamp.isdigit() or not signatures:
        return False
    current = time.time() if now is None else now
    if tolerance_seconds < 0 or not math.isfinite(float(current)):
        return False
    if tolerance_seconds > 0 and abs(int(current) - int(timestamp)) > tolerance_seconds:
        return False
    expected = compute_signature_hex(raw_body, secret, timestamp)
    return any(hmac.compare_digest(candidate, expected) for candidate in signatures)
