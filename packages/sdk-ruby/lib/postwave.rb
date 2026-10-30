# frozen_string_literal: true

require "net/http"
require "json"
require "uri"
require "openssl"
require "securerandom"

require_relative "postwave/emails"
require_relative "postwave/subscribers"
require_relative "postwave/webhook"

module Moosewave
  VERSION = "0.1.0"
  DEFAULT_BASE_URL = "https://api.moosewave.com"

  # Raised for any non-2xx API response. #status, #code, #request_id carry the
  # server's error envelope ({"error": {code, message, request_id}}).
  class Error < StandardError
    attr_reader :status, :code, :request_id

    def initialize(status:, code: nil, message: nil, request_id: nil)
      @status = status
      @code = code
      @request_id = request_id
      super(message || "postwave: http #{status}")
    end
  end

  # The Moosewave API client.
  #
  #   client = Moosewave::Client.new(api_key: "pw_live_…")
  #   client.emails.send(to: "user@example.com", subject: "Hi", html: "<b>Hi</b>", from: "you@you.com")
  class Client
    attr_reader :emails, :subscribers

    def initialize(api_key:, base_url: DEFAULT_BASE_URL, max_retries: 3, open_timeout: 10, read_timeout: 30)
      @api_key = api_key
      @base_url = base_url.sub(%r{/+\z}, "")
      @max_retries = max_retries
      @open_timeout = open_timeout
      @read_timeout = read_timeout
      @emails = Emails.new(self)
      @subscribers = Subscribers.new(self)
    end

    # request performs a JSON request with auth, idempotency (for writes), and
    # retry-on-429/5xx honoring Retry-After. Returns the parsed body (or nil).
    def request(method, path, body: nil, query: nil)
      uri = URI.parse(@base_url + path)
      uri.query = URI.encode_www_form(query) if query && !query.empty?

      idempotency_key = %w[POST PUT PATCH DELETE].include?(method) ? "rb_#{SecureRandom.hex(16)}" : nil
      attempt = 0
      loop do
        sleep(backoff(attempt)) if attempt.positive?
        resp = perform(method, uri, body, idempotency_key)

        if resp.is_a?(Net::HTTPSuccess)
          return resp.body.to_s.empty? ? nil : JSON.parse(resp.body)
        end

        err = build_error(resp)
        retriable = resp.code.to_i == 429 || (resp.code.to_i >= 500 && resp.code.to_i != 501)
        if retriable && attempt < @max_retries
          ra = resp["retry-after"].to_i
          sleep(ra) if ra.positive?
          attempt += 1
          next
        end
        raise err
      end
    rescue Net::OpenTimeout, Net::ReadTimeout, SocketError, Errno::ECONNREFUSED => e
      raise e if attempt >= @max_retries

      attempt += 1
      retry
    end

    private

    def perform(method, uri, body, idempotency_key)
      klass = {
        "GET" => Net::HTTP::Get, "POST" => Net::HTTP::Post,
        "PUT" => Net::HTTP::Put, "PATCH" => Net::HTTP::Patch,
        "DELETE" => Net::HTTP::Delete
      }.fetch(method)
      req = klass.new(uri)
      req["Authorization"] = "Bearer #{@api_key}"
      req["Accept"] = "application/json"
      req["User-Agent"] = "postwave-ruby/#{VERSION}"
      req["Idempotency-Key"] = idempotency_key if idempotency_key
      if body
        req["Content-Type"] = "application/json"
        req.body = JSON.generate(body)
      end
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.open_timeout = @open_timeout
      http.read_timeout = @read_timeout
      http.request(req)
    end

    def build_error(resp)
      env = begin
        JSON.parse(resp.body.to_s)
      rescue StandardError
        nil
      end
      e = env.is_a?(Hash) ? env["error"] : nil
      Error.new(
        status: resp.code.to_i,
        code: e && e["code"],
        message: e && e["message"],
        request_id: e && e["request_id"]
      )
    end

    def backoff(attempt)
      [0.2 * (2**(attempt - 1)), 5.0].min
    end
  end
end
