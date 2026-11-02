import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import type { Config } from "../config/schema.js";
import { traced } from "../observability/aegis.js";

/**
 * Creates a language model instance for the configured provider.
 *
 * Single switch point for provider selection (OCP): adding a provider
 * means adding one case here and one enum value in the config schema.
 * The agent depends only on the LanguageModel interface (DIP).
 *
 * Note: when using Anthropic, add "@ai-sdk/anthropic" to dependencies;
 * it is imported lazily-safe here because the case is unreachable
 * unless LLM_PROVIDER=anthropic is set.
 *
 * @param config - Validated application config.
 * @returns Provider-bound language model.
 */
export function createLanguageModel(config: Config): LanguageModel {
  switch (config.llmProvider) {
    case "openai": {
      const openai = createOpenAI({
        apiKey: config.llmApiKey,
        ...(config.llmBaseUrl === undefined ? {} : { baseURL: config.llmBaseUrl }),
      });
      return traced(
        openai(config.llmModel, { structuredOutputs: config.llmStructuredOutputs })
      );
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: config.llmApiKey });
      return traced(anthropic(config.llmModel));
    }
  }
}