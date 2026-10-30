"""Internal HTTP wrapper used by the sync + async clients.

Both clients share this module so retry/backoff/error-mapping logic stays
in one place. Sync uses :class:`httpx.Client`; async uses
:class:`httpx.AsyncClient`. Both are passed in by the public client.
"""

from __future__ import annotations

import random
import re
import time
import uuid
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from urllib.parse import unquote

import httpx

from .errors import ParseError, PostwaveError, RateLimitError, ServerError, map_error

MAX_RESPONSE_BODY_BYTES = 5 * 1024 * 1024
MAX_ERROR_BODY_BYTES = 64 * 1024
_ABSOLUTE_URL_RE = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)
_DOT_SEGMENTS = frozenset({".", "..", "%2e", "%2e.", ".%2e", "%2e%2e"})
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

# Sentinel used to distinguish "caller passed None to opt out" from
# "caller didn't pass anything; auto-mint when appropriate". Compared by
# identity, so it's safe to import this constant elsewhere.
AUTO = object()

# Methods that may safely auto-mint an idempotency key. GET/HEAD/OPTIONS
# are safe by definition; PUT is idempotent semantically, so retries
# don't need server-side dedup.
_NON_IDEMPOTENT_METHODS = frozenset({"POST", "PATCH", "DELETE"})


def normalize_base_url(base_url: str) -> str:
    """Return a safe, canonical API base URL.

    We allow http:// for local development, but reject credentials, query
    strings, and fragments. Those components are almost always copy/paste
    mistakes and can leak secrets through logs or construct surprising
    request targets.
    """
    value = str(base_url or "").strip().rstrip("/")
    if _contains_control(value):
        raise ValueError(
            "base_url must be a valid http(s) URL without credentials, query, or fragment",
        )
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise ValueError(
            "base_url must be a valid http(s) URL without credentials, query, or fragment",
        ) from exc

    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(
            "base_url must be a valid http(s) URL without credentials, query, or fragment",
        )
    if parsed.scheme == "http" and not _is_local_http_host(parsed.hostname or ""):
        raise ValueError(
            "base_url must be a valid http(s) URL without credentials, query, or fragment",
        )
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(
            "base_url must be a valid http(s) URL without credentials, query, or fragment",
        )
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def build_url(base_url: str, path: str) -> str:
    base = normalize_base_url(base_url)
    base_parts = urlsplit(base)
    raw_path = str(path or "")
    if raw_path.strip() != raw_path or _contains_control(raw_path):
        raise ValueError("unsafe request path")
    if _ABSOLUTE_URL_RE.match(raw_path) or raw_path.startswith("//") or "\\" in raw_path:
        raise ValueError("unsafe request path")

    relative = raw_path.lstrip("/")
    if "#" in relative:
        raise ValueError("unsafe request path")

    path_part, sep, query = relative.partition("?")
    if any(_unsafe_path_segment(segment) for segment in path_part.split("/")):
        raise ValueError("unsafe request path")

    base_path = base_parts.path.rstrip("/")
    if base_path:
        full_path = f"{base_path}/{path_part}"
    else:
        full_path = f"/{path_part}"
    return urlunsplit((base_parts.scheme, base_parts.netloc, full_path, query if sep else "", ""))


def _contains_control(value: str) -> bool:
    return any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value)


def _is_local_http_host(hostname: str) -> bool:
    return hostname in {"localhost", "127.0.0.1", "::1"}


def _unsafe_path_segment(segment: str) -> bool:
    if not segment:
        return False
    decoded = segment
    for _ in range(2):
        try:
            decoded = unquote(decoded)
        except Exception:
            break
    for value in (segment, decoded):
        if value in {".", ".."} or value.lower() in _DOT_SEGMENTS:
            return True
        if "\\" in value or _contains_control(value):
            return True
    return False


def resolve_idempotency_key(
    *,
    method: str,
    headers: dict[str, str],
    idempotency_key: Any = AUTO,
) -> str | None:
    """Return the Idempotency-Key value (or None for opt-out / N/A).

    Resolution order:
      1. Explicit ``idempotency_key=None`` → opt out (returns None).
      2. Explicit string → that string.
      3. Already in ``headers["Idempotency-Key"]`` → that value.
      4. Non-idempotent method (POST/PATCH/DELETE) → fresh ``uuid.uuid4()``.
      5. Otherwise → None.

    The returned value (when non-None) should be installed into the
    headers BEFORE the retry loop so every attempt sees the same key —
    that's the whole point of idempotency keys.
    """
    if idempotency_key is None:
        return None
    if isinstance(idempotency_key, str) and idempotency_key:
        return idempotency_key
    if "Idempotency-Key" in headers and headers["Idempotency-Key"]:
        return headers["Idempotency-Key"]
    if method.upper() in _NON_IDEMPOTENT_METHODS:
        return str(uuid.uuid4())
    return None


def build_request(
    *,
    method: str,
    base_url: str,
    path: str,
    api_key: str | None,
    tenant_id: str | None,
    body: Any | None,
    query: dict[str, Any] | None,
    extra_headers: dict[str, str] | None,
) -> tuple[str, dict[str, str], dict[str, Any] | None, Any | None]:
    """Pure helper that returns the URL + headers + params + body to send.

    Pulled out as a free function so the two client classes share it without
    inheritance acrobatics.
    """
    url = build_url(base_url, path)
    headers: dict[str, str] = {
        "Accept": "application/json",
        "User-Agent": "postwave-python/0.1.0",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if tenant_id:
        headers["X-Tenant-Slug"] = tenant_id
    if body is not None:
        headers["Content-Type"] = "application/json"
    if extra_headers:
        headers.update(extra_headers)
    validate_headers(headers)

    params = {k: v for k, v in (query or {}).items() if v is not None}
    return url, headers, params or None, body


def validate_header_value(name: str, value: str) -> None:
    if not isinstance(value, str) or any(
        (ord(ch) < 0x20 and ch != "\t") or ord(ch) == 0x7F for ch in value
    ):
        raise ValueError(f"{name} contains unsafe characters")


def validate_headers(headers: dict[str, str]) -> None:
    for name, value in headers.items():
        if not _HEADER_NAME_RE.match(name):
            raise ValueError(f"unsafe request header name: {name}")
        validate_header_value(f"header {name}", value)


def parse_response(resp: httpx.Response) -> Any:
    """Parse a successful response body. Returns ``None`` for 204."""
    if resp.status_code == 204:
        return None
    ct = resp.headers.get("content-type", "")
    if not resp.content:
        return None
    _ensure_body_under_cap(resp, MAX_RESPONSE_BODY_BYTES)
    if _is_json_media_type(ct):
        try:
            return resp.json()
        except ValueError as exc:
            raise ParseError(
                "Invalid JSON response from Moosewave",
                status=resp.status_code,
                request_id=resp.headers.get("x-request-id"),
            ) from exc
    return resp.text


def raise_for_response(resp: httpx.Response) -> None:
    """Translate a non-2xx response into a typed PostwaveError."""
    if resp.is_success:
        return
    request_id = resp.headers.get("x-request-id")
    body: Any
    try:
        _ensure_body_under_cap(resp, MAX_ERROR_BODY_BYTES)
        body = (
            resp.json()
            if _is_json_media_type(resp.headers.get("content-type", ""))
            else resp.text
        )
    except Exception:
        body = None
    raise map_error(resp.status_code, body, request_id, dict(resp.headers))


def _is_json_media_type(content_type: str) -> bool:
    media_type = content_type.partition(";")[0].strip().lower()
    return media_type == "application/json" or media_type.endswith("+json")


def _ensure_body_under_cap(resp: httpx.Response, max_bytes: int) -> None:
    declared = resp.headers.get("content-length")
    if declared:
        try:
            if int(declared) > max_bytes:
                raise PostwaveError(
                    f"Moosewave response body exceeded {max_bytes} bytes",
                    status=resp.status_code,
                    code="response_too_large",
                    request_id=resp.headers.get("x-request-id"),
                )
        except ValueError:
            pass
    content = resp.content
    if len(content) <= max_bytes:
        return
    raise PostwaveError(
        f"Moosewave response body exceeded {max_bytes} bytes",
        status=resp.status_code,
        code="response_too_large",
        request_id=resp.headers.get("x-request-id"),
    )


def compute_backoff(
    attempt: int,
    *,
    retry_after_header: str | None = None,
    retry_after_body: float | None = None,
) -> float:
    """Decide how long to sleep before the next retry, in seconds."""
    if retry_after_body and retry_after_body > 0:
        return min(retry_after_body, 30.0)
    if retry_after_header:
        try:
            secs = float(retry_after_header)
            if secs >= 0:
                return min(secs, 30.0)
        except ValueError:
            try:
                dt = parsedate_to_datetime(retry_after_header)
                delta = dt.timestamp() - time.time()
                if delta > 0:
                    return min(delta, 30.0)
            except (TypeError, ValueError):
                pass
    base = 0.25 * (2**attempt)
    return min(base + random.random() * base, 30.0)


def retry_is_safe(method: str, headers: dict) -> bool:
    """Whether a failed attempt may be repeated.

    Retrying is only safe when the server can recognise the repeat: a
    semantically idempotent verb, or any request carrying an Idempotency-Key.
    A keyless POST/PATCH/DELETE is neither.

    That combination was reachable. ``idempotency_key=None`` is documented as
    opting out of the key, and the retry loops in client.py gated only on
    ``should_retry(err)`` -- which receives the ERROR and therefore cannot know
    the method or whether a key was sent. A caller who disabled dedup on a
    campaign send still got the full retry budget, and the transport path is
    worse than the status path: a timeout says nothing about whether the server
    processed the request, so the write may have committed and only the
    response been lost.

    Mirrors the same rule in @postwave/sdk-ts (src/client.ts `retryIsSafe`).
    sdk-go needs no equivalent -- it has no opt-out and always mints for writes.
    """
    if method.upper() not in _NON_IDEMPOTENT_METHODS:
        return True
    return bool(headers.get("Idempotency-Key"))


def should_retry(err: PostwaveError) -> bool:
    if isinstance(err, RateLimitError):
        return True
    if isinstance(err, ServerError) and err.status != 501:
        return True
    return False
