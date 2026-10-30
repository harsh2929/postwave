defmodule Moosewave.MixProject do
  use Mix.Project

  def project do
    [
      app: :postwave,
      version: "0.1.0",
      elixir: "~> 1.14",
      description: "Official Elixir client for the Moosewave API (transactional email, subscribers, webhooks).",
      package: package(),
      deps: deps()
    ]
  end

  def application, do: [extra_applications: [:logger, :crypto, :inets, :ssl, :public_key]]

  defp deps do
    # HTTP is stdlib :httpc (:inets/:ssl); jason is the only third-party dep.
    [
      {:jason, "~> 1.4"}
    ]
  end

  defp package do
    [
      licenses: ["MIT"],
      links: %{"Moosewave" => "https://moosewave.com"}
    ]
  end
end
