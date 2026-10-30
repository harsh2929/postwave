# frozen_string_literal: true

require_relative "lib/postwave"

Gem::Specification.new do |spec|
  spec.name = "postwave"
  spec.version = Moosewave::VERSION
  spec.authors = ["Moosewave"]
  spec.summary = "Official Ruby client for the Moosewave API"
  spec.description = "Transactional email, subscribers, and webhook verification for Moosewave."
  spec.homepage = "https://moosewave.com"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.0"
  spec.files = Dir["lib/**/*.rb", "README.md", "LICENSE"]
  spec.require_paths = ["lib"]
end
