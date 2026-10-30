defmodule Moosewave do
  @moduledoc """
  Official Elixir client for the Moosewave API.

      client = Moosewave.new("pw_live_…")
      {:ok, res} = Moosewave.Emails.send(client, to: "user@example.com", subject: "Hi",
                                        html: "<b>Hello</b>", from: "you@you.com")

  The HTTP layer is built on Erlang's stdlib `:httpc` (`:inets`/`:ssl`), so the
  only third-party dependency is `:jason` for JSON. TLS peer verification uses
  the system CA store (`:public_key.cacerts_get/0`, OTP 25+).
  """

  @default_base_url "https://api.moosewave.com"
  @retry_statuses_extra MapSet.new([429])
  @version "0.1.0"

  defstruct api_key: nil, base_url: @default_base_url, max_retries: 3

  @type t :: %__MODULE__{api_key: String.t(), base_url: String.t(), max_retries: non_neg_integer()}

  @doc "Build a client. Options: `:base_url`, `:max_retries`."
  @spec new(String.t(), keyword()) :: t()
  def new(api_key, opts \\ []) do
    %__MODULE__{
      api_key: api_key,
      base_url: Keyword.get(opts, :base_url, @default_base_url) |> String.trim_trailing("/"),
      max_retries: Keyword.get(opts, :max_retries, 3)
    }
  end

  @doc """
  Perform a request. Returns `{:ok, body}` on 2xx, or
  `{:error, %{status: s, code: c, message: m, request_id: id}}`.
  """
  @spec request(t(), atom(), String.t(), map() | nil, keyword()) ::
          {:ok, any()} | {:error, map()}
  def request(%__MODULE__{} = client, method, path, body \\ nil, query \\ []) do
    _ = Application.ensure_all_started(:inets)
    _ = Application.ensure_all_started(:ssl)

    url = build_url(client.base_url, path, query)

    headers = [
      {~c"authorization", String.to_charlist("Bearer " <> client.api_key)},
      {~c"user-agent", String.to_charlist("postwave-elixir/" <> @version)},
      {~c"accept", ~c"application/json"}
    ]

    # An Idempotency-Key minted once and reused across this call's retries, so a
    # retried write can't be double-applied server-side.
    headers =
      if method in [:post, :put, :patch, :delete] do
        key = "ex_" <> (:crypto.strong_rand_bytes(16) |> Base.encode16(case: :lower))
        [{~c"idempotency-key", String.to_charlist(key)} | headers]
      else
        headers
      end

    encoded = if body, do: Jason.encode!(body), else: nil
    do_request(method, url, headers, encoded, client.max_retries, 0)
  end

  # ---- HTTP via :httpc, with transient-retry (429 + 5xx except 501) ----------

  defp do_request(method, url, headers, body, max_retries, attempt) do
    request_spec =
      if body do
        {String.to_charlist(url), headers, ~c"application/json", body}
      else
        {String.to_charlist(url), headers}
      end

    http_opts = [timeout: 30_000, connect_timeout: 30_000, ssl: ssl_opts(url)]
    opts = [body_format: :binary]

    case :httpc.request(method, request_spec, http_opts, opts) do
      {:ok, {{_proto, status, _reason}, resp_headers, resp_body}} ->
        if retryable?(status) and attempt < max_retries do
          Process.sleep(backoff_ms(resp_headers, attempt))
          do_request(method, url, headers, body, max_retries, attempt + 1)
        else
          decoded = decode_body(resp_body)

          if status in 200..299 do
            {:ok, decoded}
          else
            {:error, parse_error(status, decoded)}
          end
        end

      {:error, reason} ->
        if attempt < max_retries do
          Process.sleep(backoff_ms([], attempt))
          do_request(method, url, headers, body, max_retries, attempt + 1)
        else
          {:error, %{status: 0, code: "transport", message: inspect(reason), request_id: nil}}
        end
    end
  end

  # 501 Not Implemented is permanent — never retry it; retry the rest of 5xx + 429.
  defp retryable?(status), do: (status >= 500 and status != 501) or MapSet.member?(@retry_statuses_extra, status)

  defp backoff_ms(resp_headers, attempt) do
    case retry_after_ms(resp_headers) do
      ms when is_integer(ms) -> ms
      _ -> min(trunc(:math.pow(2, attempt) * 500), 8_000)
    end
  end

  defp retry_after_ms(resp_headers) do
    resp_headers
    |> Enum.find_value(fn {k, v} ->
      if to_string(k) |> String.downcase() == "retry-after", do: v, else: nil
    end)
    |> case do
      nil -> nil
      v -> case Integer.parse(to_string(v)) do
             {secs, _} when secs >= 0 -> secs * 1000
             _ -> nil
           end
    end
  end

  defp build_url(base, path, query) do
    pairs = (query || []) |> Enum.map(fn {k, v} -> {to_string(k), to_string(v)} end)
    qs = if pairs == [], do: "", else: "?" <> URI.encode_query(pairs)
    base <> path <> qs
  end

  defp ssl_opts(url) do
    host = URI.parse(url).host || ""

    base = [
      verify: :verify_peer,
      depth: 100,
      server_name_indication: String.to_charlist(host),
      customize_hostname_check: [match_fun: :public_key.pkix_verify_hostname_match_fun(:https)]
    ]

    # System CA store landed in OTP 25; on older runtimes there is no built-in
    # trust store to verify against.
    if function_exported?(:public_key, :cacerts_get, 0) do
      [{:cacerts, apply(:public_key, :cacerts_get, [])} | base]
    else
      [verify: :verify_none]
    end
  end

  defp decode_body(""), do: nil
  defp decode_body(body) when is_binary(body) do
    case Jason.decode(body) do
      {:ok, decoded} -> decoded
      _ -> body
    end
  end

  defp decode_body(body), do: body

  defp parse_error(status, body) do
    err = if is_map(body), do: Map.get(body, "error"), else: nil

    %{
      status: status,
      code: err && Map.get(err, "code"),
      message: (err && Map.get(err, "message")) || "request failed",
      request_id: err && Map.get(err, "request_id")
    }
  end
end
