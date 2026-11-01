import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";

describe("loadConfig: OpenAI-compatible endpoint", () => {
  it("leaves the base URL unset and structured outputs off by default", () => {
    const config = loadConfig({ OPENAI_API_KEY: "k" });
    expect(config.llmBaseUrl).toBeUndefined();
    expect(config.llmStructuredOutputs).toBe(false);
  });

  it("reads LLM_BASE_URL and LLM_STRUCTURED_OUTPUTS", () => {
    const config = loadConfig({
      OPENAI_API_KEY: "k",
      LLM_BASE_URL: "http://localhost:11434/v1",
      LLM_STRUCTURED_OUTPUTS: "true",
    });
    expect(config.llmBaseUrl).toBe("http://localhost:11434/v1");
    expect(config.llmStructuredOutputs).toBe(true);
  });

  it("treats an empty base URL as unset and rejects an invalid one", () => {
    expect(loadConfig({ OPENAI_API_KEY: "k", LLM_BASE_URL: "" }).llmBaseUrl).toBeUndefined();
    expect(() => loadConfig({ OPENAI_API_KEY: "k", LLM_BASE_URL: "not a url" })).toThrow();
    expect(() => loadConfig({ OPENAI_API_KEY: "k", LLM_STRUCTURED_OUTPUTS: "yes" })).toThrow();
  });
});
