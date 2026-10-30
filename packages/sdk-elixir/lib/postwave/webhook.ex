defmodule Moosewave.Webhook do
  @moduledoc """
  Canonical timestamped outbound-webhook HMAC verification.
  """

  import Bitwise

  @doc "Verify with the recommended five-minute replay window."
  @spec verify(String.t() | nil, String.t(), binary()) :: boolean()
  def verify(header, secret, raw_body) do
    verify_at(header, secret, raw_body, System.system_time(:second), 300)
  end

  @doc "Deterministic verifier for tests or a custom replay tolerance."
  @spec verify_at(String.t() | nil, String.t(), binary(), integer(), non_neg_integer()) ::
          boolean()
  def verify_at(header, secret, raw_body, now, tolerance)
      when is_binary(header) and is_binary(secret) and is_binary(raw_body) and
             is_integer(now) and now >= 0 and is_integer(tolerance) and tolerance >= 0 do
    {timestamp, signatures} =
      header
      |> String.split(",")
      |> Enum.reduce({nil, []}, fn raw_part, {timestamp, signatures} ->
        case String.split(String.trim(raw_part), "=", parts: 2) do
          ["t", _value] when not is_nil(timestamp) -> {:duplicate, signatures}
          ["t", value] -> {value, signatures}
          ["v1", value] -> {timestamp, [value | signatures]}
          _ -> {timestamp, signatures}
        end
      end)

    with {signed_at, ""} when signed_at > 0 <- Integer.parse(timestamp || ""),
         true <- tolerance == 0 or abs(now - signed_at) <= tolerance do
      expected = compute(secret, signed_at, raw_body)

      Enum.any?(signatures, fn value ->
        case Base.decode16(String.downcase(value), case: :lower) do
          {:ok, supplied} -> secure_compare(supplied, expected)
          :error -> false
        end
      end)
    else
      _ -> false
    end
  rescue
    _ -> false
  end

  def verify_at(_, _, _, _, _), do: false

  @doc "Raw HMAC-SHA256 bytes for timestamp + dot + exact body."
  @spec compute(String.t(), integer(), binary()) :: binary()
  def compute(secret, timestamp, raw_body) do
    :crypto.mac(:hmac, :sha256, secret, "#{timestamp}.#{raw_body}")
  end

  @doc "Complete canonical signature header."
  @spec compute_header(String.t(), integer(), binary()) :: String.t()
  def compute_header(secret, timestamp, raw_body) do
    signature = compute(secret, timestamp, raw_body) |> Base.encode16(case: :lower)
    "t=#{timestamp},v1=#{signature}"
  end

  defp secure_compare(a, b) when byte_size(a) == byte_size(b) do
    :crypto.exor(a, b)
    |> :binary.bin_to_list()
    |> Enum.reduce(0, fn byte, acc -> bor(byte, acc) end)
    |> Kernel.==(0)
  end

  defp secure_compare(_, _), do: false
end
