import json

from postwave import compute_signature_header, compute_signature_hex, verify_signature


SECRET = "owhsec_test_super_secret"
BODY = json.dumps(
    {
        "event": {
            "id": "11111111-1111-4111-8111-111111111111",
            "type": "campaign.sent",
            "occurred_at": "2026-07-23T00:00:00Z",
            "data": {"campaign_id": "cmp_1"},
        }
    }
).encode()
TIMESTAMP = 1_784_764_800


def test_round_trip_and_dual_key_rotation():
    header = compute_signature_header(BODY, SECRET, TIMESTAMP)
    assert verify_signature(BODY, header, SECRET, now=TIMESTAMP)
    good = compute_signature_hex(BODY, SECRET, TIMESTAMP)
    assert verify_signature(
        BODY,
        f"t={TIMESTAMP},v1={'0' * 64},v1={good}",
        SECRET,
        now=TIMESTAMP,
    )


def test_tampering_wrong_key_stale_and_legacy_scheme_fail():
    header = compute_signature_header(BODY, SECRET, TIMESTAMP)
    assert not verify_signature(BODY + b" ", header, SECRET, now=TIMESTAMP)
    assert not verify_signature(BODY, header, "wrong", now=TIMESTAMP)
    assert not verify_signature(BODY, header, SECRET, now=TIMESTAMP + 301)
    assert not verify_signature(
        BODY,
        f"sha256={compute_signature_hex(BODY, SECRET, TIMESTAMP)}",
        SECRET,
        now=TIMESTAMP,
    )


def test_malformed_headers_fail():
    assert not verify_signature(BODY, None, SECRET, now=TIMESTAMP)
    assert not verify_signature(BODY, f"t=nope,v1={'0' * 64}", SECRET, now=TIMESTAMP)
    assert not verify_signature(BODY, f"t={TIMESTAMP},v1=abc", SECRET, now=TIMESTAMP)
    assert not verify_signature(
        BODY,
        f"t={TIMESTAMP},t={TIMESTAMP},v1={'0' * 64}",
        SECRET,
        now=TIMESTAMP,
    )
    assert not verify_signature(
        BODY,
        compute_signature_header(BODY, SECRET, TIMESTAMP),
        SECRET,
        now=float("nan"),
    )
