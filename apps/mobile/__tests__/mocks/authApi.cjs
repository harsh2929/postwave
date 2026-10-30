const result = async () => ({ data: {}, error: null });
const client = new Proxy(
  { baseUrl: "https://api.moosewave.com" },
  { get: (target, property) => property in target ? target[property] : result },
);

module.exports = {
  createAuthClient: () => client,
  isValidWorkspaceSlug: () => true,
  redactAuthError: () => "Authentication failed",
  scorePassword: () => ({ label: "Strong", score: 4 }),
  suggestWorkspaceSlug: () => "test-workspace",
};
