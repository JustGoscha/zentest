import { ComputerUseProvider, ProviderConfig, ProviderType } from "./base.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";

export {
  ComputerUseProvider,
  ProviderConfig,
  ProviderType,
  GetNextActionParams,
  GetNextActionResult,
  TokenUsage,
} from "./base.js";

/**
 * Create a provider based on configuration
 */
export function createProvider(config: ProviderConfig): ComputerUseProvider {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(config.apiKey, config.model);

    case "openai":
      return new OpenAIProvider(config.apiKey, config.model);

    case "openrouter":
      return new OpenRouterProvider(config.apiKey, config.model);

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Get the default model for a provider
 */
export function getDefaultModel(provider: ProviderType): string {
  switch (provider) {
    case "anthropic":
      return "claude-sonnet-4-20250514";
    case "openai":
      return "gpt-4o";
    case "openrouter":
      return "anthropic/claude-sonnet-4";
  }
}

/**
 * Check if provider API key is available
 */
export function hasApiKey(provider: ProviderType): boolean {
  switch (provider) {
    case "anthropic":
      return !!process.env.ZENTEST_ANTHROPIC_API_KEY;
    case "openai":
      return !!process.env.ZENTEST_OPENAI_API_KEY;
    case "openrouter":
      return !!process.env.ZENTEST_OPENROUTER_API_KEY;
  }
}
