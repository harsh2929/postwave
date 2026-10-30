# frozen_string_literal: true

require "minitest/autorun"
require "socket"
require_relative "../lib/postwave"

class PostwaveTest < Minitest::Test
  # A tiny one-shot HTTP stub on a raw TCPServer. WEBrick was removed from the
  # Ruby stdlib in 3.0, so the test server is hand-rolled on TCPServer (which is
  # stdlib on every Ruby) to keep the test runnable on modern toolchains.
  # Accepts a single connection, captures the request, and writes back the
  # canned status + body. Returns [client, captured_hash, thread].
  def stub_server(status, body)
    server = TCPServer.new("127.0.0.1", 0)
    port = server.addr[1]
    captured = {}
    thread = Thread.new do
      conn = server.accept
      conn.gets # request line
      headers = {}
      while (line = conn.gets) && line != "\r\n"
        key, val = line.split(":", 2)
        headers[key.strip.downcase] = val.strip if val
      end
      len = headers["content-length"].to_i
      captured[:auth] = headers["authorization"]
      captured[:idem] = headers["idempotency-key"]
      captured[:body] = len.positive? ? conn.read(len) : ""
      conn.write("HTTP/1.1 #{status} STUB\r\nContent-Type: application/json\r\n" \
                 "Content-Length: #{body.bytesize}\r\nConnection: close\r\n\r\n#{body}")
      conn.close
      server.close
    end
    client = Moosewave::Client.new(api_key: "pw_test", base_url: "http://127.0.0.1:#{port}", max_retries: 0)
    [client, captured, thread]
  end

  def test_emails_send
    client, captured, thread = stub_server(202, JSON.generate({ "id" => "em_1", "status" => "sent" }))
    out = client.emails.send(to: "c@d.com", subject: "Hi", html: "<b>x</b>", from: "a@b.com")
    thread.join
    assert_equal "em_1", out["id"]
    assert_equal "Bearer pw_test", captured[:auth]
    refute_nil captured[:idem], "expected an Idempotency-Key on POST"
    assert captured[:body].start_with?("{")
  end

  def test_error_mapping
    body = JSON.generate({ "error" => { "code" => "invalid_request", "message" => "bad", "request_id" => "req_1" } })
    client, _captured, thread = stub_server(422, body)
    err = assert_raises(Moosewave::Error) { client.emails.send(to: "x@y.com", subject: "s", text: "t") }
    thread.join
    assert_equal 422, err.status
    assert_equal "invalid_request", err.code
    assert_equal "req_1", err.request_id
  end

  def test_verify_webhook
    secret = "owhsec_x"
    body = '{"event":"email.delivered"}'
    now = 1_784_764_800
    sig = Moosewave::Webhook.compute_header(secret, now, body)
    assert Moosewave::Webhook.verify(sig, secret, body, now: now)
    refute Moosewave::Webhook.verify(sig, "wrong", body, now: now)
    refute Moosewave::Webhook.verify("garbage", secret, body, now: now)
    refute Moosewave::Webhook.verify(sig, secret, body, now: now + 301)
    rotating = "t=#{now},v1=#{"0" * 64},v1=#{Moosewave::Webhook.compute(secret, now, body)}"
    assert Moosewave::Webhook.verify(rotating, secret, body, now: now)
    refute Moosewave::Webhook.verify("#{sig},t=#{now}", secret, body, now: now)
  end
end
