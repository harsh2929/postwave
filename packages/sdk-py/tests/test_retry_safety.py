"""A request the server cannot deduplicate must not be retried.

Retrying is only safe when the server can recognise the repeat: a semantically
idempotent verb, or any request carrying an Idempotency-Key. A keyless
POST/PATCH/DELETE is neither.

That combination was reachable. ``idempotency_key=None`` is documented as
opting out of the key, while the retry loops in client.py gated only on
``should_retry(err)`` — which receives the ERROR and therefore cannot know the
method or whether a key was sent. A caller who disabled dedup on a campaign
send still got the full retry budget.

The transport path is the worse of the two: a timeout says nothing about
whether the server processed the request, so the write may have committed and
only the response been lost.
"""

import httpx
import pytest

from postwave import _http


class TestRetryIsSafe:
    @pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS", "PUT"])
    def test_idempotent_verbs_retry_without_a_key(self, method):
        # PUT is excluded from _NON_IDEMPOTENT_METHODS on purpose: it is
        # idempotent by definition, so a repeat is safe with or without a key.
        assert _http.retry_is_safe(method, {}) is True

    @pytest.mark.parametrize("method", ["POST", "PATCH", "DELETE"])
    def test_keyless_writes_are_not_retryable(self, method):
        assert _http.retry_is_safe(method, {}) is False

    @pytest.mark.parametrize("method", ["POST", "PATCH", "DELETE"])
    def test_keyed_writes_are_retryable(self, method):
        # Guard the guard: a predicate returning False for every write would
        # satisfy the assertions above while breaking normal retries.
        assert _http.retry_is_safe(method, {"Idempotency-Key": "k"}) is True

    def test_an_empty_key_is_no_key(self):
        assert _http.retry_is_safe("POST", {"Idempotency-Key": ""}) is False

    def test_method_case_does_not_matter(self):
        assert _http.retry_is_safe("post", {}) is False
        assert _http.retry_is_safe("get", {}) is True


class TestClientHonoursIt:
    def _client(self, handler, retries=2):
        from postwave.client import Moosewave

        http = httpx.Client(
            transport=httpx.MockTransport(handler), base_url="http://localhost:8080"
        )
        return Moosewave(
            api_key="sk_test",
            tenant_id="acme",
            http_client=http,
            retries=retries,
            base_url="http://localhost:8080",
        )

    def test_keyless_post_makes_one_transport_attempt(self):
        attempts = {"n": 0}

        def handler(request):  # noqa: ARG001
            attempts["n"] += 1
            raise httpx.ConnectError("network down")

        client = self._client(handler)
        with pytest.raises(Exception):
            client.request("POST", "/api/v1/campaigns", body={}, idempotency_key=None)
        assert attempts["n"] == 1

    def test_auto_minted_post_still_retries(self):
        # Guard the guard: a change that stopped retrying writes entirely would
        # satisfy the assertion above.
        attempts = {"n": 0}

        def handler(request):  # noqa: ARG001
            attempts["n"] += 1
            raise httpx.ConnectError("network down")

        client = self._client(handler)
        with pytest.raises(Exception):
            client.request("POST", "/api/v1/campaigns", body={})
        assert attempts["n"] == 3

    def test_keyless_post_does_not_retry_a_503(self):
        # A 503 can arrive after the write committed, so the status path needs
        # the same rule as the transport path.
        attempts = {"n": 0}

        def handler(request):  # noqa: ARG001
            attempts["n"] += 1
            return httpx.Response(503, json={"error": {"message": "boom"}})

        client = self._client(handler)
        with pytest.raises(Exception):
            client.request("POST", "/api/v1/campaigns", body={}, idempotency_key=None)
        assert attempts["n"] == 1

    def test_get_still_retries_without_a_key(self):
        attempts = {"n": 0}

        def handler(request):  # noqa: ARG001
            attempts["n"] += 1
            raise httpx.ConnectError("network down")

        client = self._client(handler)
        with pytest.raises(Exception):
            client.request("GET", "/api/v1/campaigns")
        assert attempts["n"] == 3
