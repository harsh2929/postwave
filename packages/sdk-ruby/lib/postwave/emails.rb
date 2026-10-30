# frozen_string_literal: true

module Moosewave
  # Transactional email: fire a single message (or a batch) from your app.
  class Emails
    def initialize(client)
      @client = client
    end

    # Send one transactional email. `to`/`cc`/`bcc`/`reply_to` accept a String
    # or an Array; one of `html`/`text` is required.
    def send(to:, subject:, from: nil, html: nil, text: nil, cc: nil, bcc: nil,
             reply_to: nil, headers: nil, tags: nil, attachments: nil, scheduled_at: nil)
      raise ArgumentError, "send requires html or text" if html.nil? && text.nil?

      body = { to: to, subject: subject }
      body[:from] = from if from
      { html: html, text: text, cc: cc, bcc: bcc, reply_to: reply_to,
        headers: headers, tags: tags, attachments: attachments, scheduled_at: scheduled_at }.each do |k, v|
        body[k] = v unless v.nil?
      end
      @client.request("POST", "/api/v1/emails", body: body)
    end

    # Send up to 100 distinct emails in one call.
    def send_batch(emails)
      @client.request("POST", "/api/v1/emails/batch", body: { emails: emails })
    end

    # Fetch one email's status.
    def get(id)
      @client.request("GET", "/api/v1/emails/#{URI.encode_www_form_component(id)}")
    end

    # List recent transactional sends.
    def list(limit: nil)
      @client.request("GET", "/api/v1/emails", query: limit ? { limit: limit } : nil)
    end
  end
end
