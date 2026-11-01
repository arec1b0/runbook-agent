import { ConfigSchema, type Config, type LlmProvider } from "./schema.js";

/**
 * Maps a provider to the environment variable holding its API key.
 * Kept explicit so a missing key produces a precise error message.
 */
const API_KEY_ENV_BY_PROVIDER: Record<LlmProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/**
 * Loads and validates configuration from process.env.
 *
 * Fails fast: throws a single aggregated error listing every invalid
 * field, so misconfiguration is caught at startup, not mid-incident.
 *
 * @param env - Environment source, injectable for testing (DIP).
 * @returns Validated, immutable configuration object.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): Readonly<Config> {
  const provider = (env["LLM_PROVIDER"] ?? "openai") as string;

  const apiKeyEnvName =
    API_KEY_ENV_BY_PROVIDER[provider as LlmProvider] ?? "OPENAI_API_KEY";

  const result = ConfigSchema.safeParse({
    llmProvider: env["LLM_PROVIDER"],
    llmModel: env["LLM_MODEL"],
    llmApiKey: env[apiKeyEnvName],
    llmBaseUrl: env["LLM_BASE_URL"] || undefined,
    llmStructuredOutputs: env["LLM_STRUCTURED_OUTPUTS"],
    port: env["PORT"],
    executionMode: env["EXECUTION_MODE"],
    logLevel: env["LOG_LEVEL"],
    approvalTimeoutMs: env["APPROVAL_TIMEOUT_MS"],
    incidentFilePath: env["INCIDENT_FILE_PATH"],
  });

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid configuration (check your .env against .env.example):\n${details}\n` +
        `Note: for provider "${provider}" the API key is read from ${apiKeyEnvName}.`
    );
  }

  return Object.freeze(result.data);
}