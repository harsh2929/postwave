defmodule Moosewave.Emails do
  @moduledoc "Transactional email — fire a single message (or a batch) from your app."

  @doc """
  Send one transactional email. `:to`/`:cc`/`:bcc`/`:reply_to` accept a string or
  a list; one of `:html`/`:text` is required.
  """
  @spec send(Moosewave.t(), keyword()) :: {:ok, any()} | {:error, map()}
  def send(client, opts) do
    to = Keyword.fetch!(opts, :to)
    subject = Keyword.fetch!(opts, :subject)

    if is_nil(opts[:html]) and is_nil(opts[:text]) do
      raise ArgumentError, "send requires :html or :text"
    end

    body =
      %{"to" => to, "subject" => subject}
      |> put_opt(opts, :from, "from")
      |> put_opt(opts, :html, "html")
      |> put_opt(opts, :text, "text")
      |> put_opt(opts, :cc, "cc")
      |> put_opt(opts, :bcc, "bcc")
      |> put_opt(opts, :reply_to, "reply_to")
      |> put_opt(opts, :headers, "headers")
      |> put_opt(opts, :tags, "tags")
      |> put_opt(opts, :attachments, "attachments")
      |> put_opt(opts, :scheduled_at, "scheduled_at")

    Moosewave.request(client, :post, "/api/v1/emails", body)
  end

  @doc "Send up to 100 distinct emails in one call."
  @spec send_batch(Moosewave.t(), [map()]) :: {:ok, any()} | {:error, map()}
  def send_batch(client, emails) when is_list(emails) do
    Moosewave.request(client, :post, "/api/v1/emails/batch", %{"emails" => emails})
  end

  @doc "Fetch one email's status."
  @spec get(Moosewave.t(), String.t()) :: {:ok, any()} | {:error, map()}
  def get(client, id), do: Moosewave.request(client, :get, "/api/v1/emails/" <> URI.encode(id))

  @doc "List recent transactional sends."
  @spec list(Moosewave.t(), keyword()) :: {:ok, any()} | {:error, map()}
  def list(client, opts \\ []) do
    query = if opts[:limit], do: [limit: opts[:limit]], else: []
    Moosewave.request(client, :get, "/api/v1/emails", nil, query)
  end

  defp put_opt(map, opts, key, wire_key) do
    case Keyword.get(opts, key) do
      nil -> map
      v -> Map.put(map, wire_key, v)
    end
  end
end
