import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { ProviderType } from "../providers/index.js";

/**
 * Model configuration for each component
 */
export interface ModelConfig {
  /** Model for the agentic tester (requires vision + computer use) */
  agenticModel: string;
  /** Model for the test builder (generates Playwright code) */
  builderModel: string;
  /** Model for the test healer (re-runs failed tests) */
  healerModel: string;
}

export type AutomationMode = "vision" | "mcp";

export interface ZentestConfig {
  baseUrl: string;
  environments: Record<string, { url: string }>;
  /** AI provider: anthropic, openai, or openrouter */
  provider: ProviderType;
  /** Models for each component */
  models: ModelConfig;
  /** Legacy: single model (maps to agenticModel for backward compatibility) */
  model?: string;
  /** API key (optional, can use ZENTEST_*_API_KEY env vars) */
  apiKey?: string;
  /** Maximum steps before stopping (default 50) */
  maxSteps: number;
  /** Viewport dimensions */
  viewport: { width: number; height: number };
  /** Headless mode: "auto" detects CI vs dev, true/false override */
  headless: "auto" | boolean;
  /**
   * Automation mode for action execution:
   * - "vision": Original mode — BrowserExecutor with custom code generation
   * - "mcp": Uses Playwright MCP tools for execution + auto-generated Playwright code
   */
  automationMode: AutomationMode;
}

const DEFAULT_MODELS: ModelConfig = {
  agenticModel: "claude-sonnet-4-20250514",
  builderModel: "claude-haiku-3-5-20241022",
  healerModel: "claude-sonnet-4-20250514",
};

const DEFAULT_CONFIG: ZentestConfig = {
  baseUrl: "http://localhost:3000",
  environments: {},
  provider: "anthropic",
  models: DEFAULT_MODELS,
  maxSteps: 50,
  viewport: { width: 1280, height: 720 },
  headless: "auto",
  automationMode: "vision",
};

/**
 * Load zentest configuration from project root
 */
export async function loadConfig(cwd: string): Promise<ZentestConfig> {
  const configPath = path.join(cwd, "zentest.config.ts");
  const configPathJs = path.join(cwd, "zentest.config.js");

  let fileConfig: Partial<ZentestConfig> = {};

  // Try .js first (already compiled or plain JS)
  if (fs.existsSync(configPathJs)) {
    try {
      const configUrl = pathToFileURL(configPathJs).href;
      const module = await import(configUrl);
      fileConfig = module.default;
    } catch (e) {
      console.warn("Warning: Could not load zentest.config.js", e);
    }
  } else if (fs.existsSync(configPath)) {
    // For .ts, we'd need tsx or ts-node - for now just warn
    console.warn(
      "Warning: TypeScript config found but not yet supported. Use zentest.config.js instead."
    );
  }

  // Merge file config with defaults, then apply env overrides
  const merged = mergeConfig(fileConfig);
  return applyEnvOverrides(merged);
}

/**
 * Merge user config with defaults
 */
function mergeConfig(userConfig: Partial<ZentestConfig>): ZentestConfig {
  // Handle legacy 'model' field - map to agenticModel
  const models: ModelConfig = {
    ...DEFAULT_MODELS,
    ...userConfig.models,
  };

  // If legacy 'model' is set, use it for agenticModel
  if (userConfig.model && !userConfig.models?.agenticModel) {
    models.agenticModel = userConfig.model;
  }

  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    models,
    viewport: {
      ...DEFAULT_CONFIG.viewport,
      ...userConfig.viewport,
    },
  };
}

/**
 * Apply environment variable overrides
 */
function applyEnvOverrides(config: ZentestConfig): ZentestConfig {
  const env = process.env;

  // Provider
  if (env.ZENTEST_PROVIDER) {
    const provider = env.ZENTEST_PROVIDER as ProviderType;
    if (["anthropic", "openai", "openrouter"].includes(provider)) {
      config.provider = provider;
    }
  }

  // Models
  if (env.ZENTEST_AGENTIC_MODEL) {
    config.models.agenticModel = env.ZENTEST_AGENTIC_MODEL;
  }
  if (env.ZENTEST_BUILDER_MODEL) {
    config.models.builderModel = env.ZENTEST_BUILDER_MODEL;
  }
  if (env.ZENTEST_HEALER_MODEL) {
    config.models.healerModel = env.ZENTEST_HEALER_MODEL;
  }

  // Viewport
  if (env.ZENTEST_VIEWPORT_WIDTH) {
    const width = parseInt(env.ZENTEST_VIEWPORT_WIDTH, 10);
    if (!isNaN(width)) config.viewport.width = width;
  }
  if (env.ZENTEST_VIEWPORT_HEIGHT) {
    const height = parseInt(env.ZENTEST_VIEWPORT_HEIGHT, 10);
    if (!isNaN(height)) config.viewport.height = height;
  }

  // Max steps
  if (env.ZENTEST_MAX_STEPS) {
    const maxSteps = parseInt(env.ZENTEST_MAX_STEPS, 10);
    if (!isNaN(maxSteps)) config.maxSteps = maxSteps;
  }

  // Headless
  if (env.ZENTEST_HEADLESS) {
    const headless = env.ZENTEST_HEADLESS.toLowerCase();
    if (headless === "auto") {
      config.headless = "auto";
    } else if (headless === "true" || headless === "1") {
      config.headless = true;
    } else if (headless === "false" || headless === "0") {
      config.headless = false;
    }
  }

  return config;
}

/**
 * Determine if browser should run headless
 */
export function shouldRunHeadless(config: ZentestConfig): boolean {
  if (config.headless === "auto") {
    // Auto-detect: headless in CI, headed in interactive terminal
    return !process.stdout.isTTY || !!process.env.CI;
  }
  return config.headless;
}

/**
 * Get the appropriate API key for the configured provider
 */
export function getApiKey(config: ZentestConfig): string | undefined {
  if (config.apiKey) return config.apiKey;

  switch (config.provider) {
    case "anthropic":
      return process.env.ZENTEST_ANTHROPIC_API_KEY;
    case "openai":
      return process.env.ZENTEST_OPENAI_API_KEY;
    case "openrouter":
      return process.env.ZENTEST_OPENROUTER_API_KEY;
  }
}
