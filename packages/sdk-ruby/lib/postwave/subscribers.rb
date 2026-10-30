# frozen_string_literal: true

module Moosewave
  # Subscriber CRUD.
  class Subscribers
    def initialize(client)
      @client = client
    end

    def list(query = {})
      @client.request("GET", "/api/v1/subscribers", query: query)
    end

    def get(id)
      @client.request("GET", "/api/v1/subscribers/#{URI.encode_www_form_component(id)}")
    end

    def create(attributes)
      @client.request("POST", "/api/v1/subscribers", body: attributes)
    end

    def update(id, attributes)
      @client.request("PATCH", "/api/v1/subscribers/#{URI.encode_www_form_component(id)}", body: attributes)
    end

    def delete(id)
      @client.request("DELETE", "/api/v1/subscribers/#{URI.encode_www_form_component(id)}")
    end
  end
end
