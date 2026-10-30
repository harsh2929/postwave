# frozen_string_literal: true

module Moosewave
  # Canonical timestamped outbound-webhook HMAC verification.
  module Webhook
    module_function

    def verify(header, secret, raw_body, now: Time.now.to_i, tolerance: 300)
      return false if header.nil? || secret.nil? || secret.empty?
      return false if now.to_i.negative? || tolerance.negative?

      timestamp = nil
      signatures = []
      header.split(",").each do |raw_part|
        key, value = raw_part.strip.split("=", 2)
        return false if key == "t" && timestamp
        timestamp = value if key == "t"
        signatures << value if key == "v1" && value
      end
      return false unless timestamp&.match?(/\A\d+\z/) && signatures.any?
      return false unless timestamp.to_i.positive?
      return false if tolerance.positive? && (now.to_i - timestamp.to_i).abs > tolerance

      expected = compute(secret, timestamp, raw_body)
      signatures.any? { |supplied| secure_compare(supplied.downcase, expected) }
    rescue StandardError
      false
    end

    # Lowercase v1 HMAC of timestamp + "." + exact raw body.
    def compute(secret, timestamp, raw_body)
      OpenSSL::HMAC.hexdigest("SHA256", secret, "#{timestamp}.#{raw_body}")
    end

    def compute_header(secret, timestamp, raw_body)
      "t=#{timestamp},v1=#{compute(secret, timestamp.to_s, raw_body)}"
    end

    def secure_compare(a, b)
      return false unless a.bytesize == b.bytesize

      bytes = a.unpack("C*")
      result = 0
      b.each_byte.with_index { |byte, index| result |= byte ^ bytes[index] }
      result.zero?
    end
  end
end
