defmodule Moosewave.WebhookTest do
  use ExUnit.Case, async: true

  test "verify round-trips a valid signature and rejects tampering" do
    secret = "owhsec_x"
    body = ~s({"event":"email.delivered"})
    now = 1_784_764_800
    sig = Moosewave.Webhook.compute_header(secret, now, body)

    assert Moosewave.Webhook.verify_at(sig, secret, body, now, 300)
    refute Moosewave.Webhook.verify_at(sig, "wrong", body, now, 300)
    refute Moosewave.Webhook.verify_at("garbage", secret, body, now, 300)
    refute Moosewave.Webhook.verify_at(nil, secret, body, now, 300)
    refute Moosewave.Webhook.verify_at(sig, secret, body, now + 301, 300)

    rotating =
      "t=#{now},v1=#{String.duplicate("0", 64)},v1=" <>
        (Moosewave.Webhook.compute(secret, now, body) |> Base.encode16(case: :lower))

    assert Moosewave.Webhook.verify_at(rotating, secret, body, now, 300)
    refute Moosewave.Webhook.verify_at("#{sig},t=#{now}", secret, body, now, 300)
  end

  test "new/2 applies defaults" do
    c = Moosewave.new("pw_test")
    assert c.base_url == "https://api.moosewave.com"
    assert c.max_retries == 3
  end
end
