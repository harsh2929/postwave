defmodule Moosewave.Subscribers do
  @moduledoc "Subscriber CRUD."

  def list(client, query \\ []), do: Moosewave.request(client, :get, "/api/v1/subscribers", nil, query)
  def get(client, id), do: Moosewave.request(client, :get, "/api/v1/subscribers/" <> URI.encode(id))
  def create(client, attrs), do: Moosewave.request(client, :post, "/api/v1/subscribers", attrs)
  def update(client, id, attrs), do: Moosewave.request(client, :patch, "/api/v1/subscribers/" <> URI.encode(id), attrs)
  def delete(client, id), do: Moosewave.request(client, :delete, "/api/v1/subscribers/" <> URI.encode(id))
end
