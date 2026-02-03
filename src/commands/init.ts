import * as fs from "fs";
import * as path from "path";

const ZENTESTS_DIR = "zentests";

const DEFAULT_CONFIG = `export default {
  // Base URL for testing
  baseUrl: "https://example.com",

  // Environment-specific URLs
  environments: {
    production: { url: "https://example.com" },
    dev: { url: "https://dev.example.com" },
  },

  // AI provider: "anthropic", "openai", or "openrouter"
  provider: "anthropic",

  // Models for each component (can also be set via ZENTEST_*_MODEL env vars)
  models: {
    // Agentic tester - navigates pages (requires multimodal/vision)
    agenticModel: "claude-sonnet-4-20250514",
    // Test builder - generates Playwright code (no vision needed)
    builderModel: "claude-haiku-3-5-20241022",
    // Test healer - re-runs failed tests (requires multimodal/vision)
    healerModel: "claude-sonnet-4-20250514",
  },

  // Maximum steps per test before giving up
  maxSteps: 50,

  // Browser viewport dimensions
  viewport: { width: 1280, height: 720 },

  // Headless mode: "auto" (detects CI), true, or false
  headless: "auto",
}
`;

const EXAMPLE_TEST = `# Example Tests

## example-test
A user can visit the homepage and see a welcome message
`;

const ENV_EXAMPLE = `# Zentest Environment Variables
# Copy this file to .env and fill in your values

# =============================================================================
# API Keys - Set the key for your chosen provider
# =============================================================================

# Anthropic (Claude) - for provider: "anthropic"
ZENTEST_ANTHROPIC_API_KEY=

# OpenAI - for provider: "openai"
ZENTEST_OPENAI_API_KEY=

# OpenRouter (access multiple models) - for provider: "openrouter"
ZENTEST_OPENROUTER_API_KEY=

# =============================================================================
# Model Configuration - Override models for each component
# =============================================================================

# AI Provider: anthropic, openai, or openrouter
# ZENTEST_PROVIDER=anthropic

# Agentic Tester - navigates pages (requires multimodal/vision)
# ZENTEST_AGENTIC_MODEL=claude-sonnet-4-20250514

# Test Builder - generates Playwright code (no vision needed)
# ZENTEST_BUILDER_MODEL=claude-haiku-3-5-20241022

# Test Healer - re-runs failed tests (requires multimodal/vision)
# ZENTEST_HEALER_MODEL=claude-sonnet-4-20250514

# =============================================================================
# Browser Configuration
# =============================================================================

# Viewport dimensions
# ZENTEST_VIEWPORT_WIDTH=1280
# ZENTEST_VIEWPORT_HEIGHT=720

# Headless mode: auto, true, or false
# ZENTEST_HEADLESS=auto

# Maximum steps per test before giving up
# ZENTEST_MAX_STEPS=50
`;

export async function init() {
  const cwd = process.cwd();
  const zentestsPath = path.join(cwd, ZENTESTS_DIR);
  const configPath = path.join(cwd, "zentest.config.js");
  const envExamplePath = path.join(cwd, ".env.example");

  // Check if already initialized
  if (fs.existsSync(zentestsPath)) {
    console.log("zentests/ folder already exists");
    return;
  }

  // Create directories
  fs.mkdirSync(zentestsPath, { recursive: true });
  fs.mkdirSync(path.join(zentestsPath, "runs"), { recursive: true });
  fs.mkdirSync(path.join(zentestsPath, "static-tests"), { recursive: true });

  // Create example test file
  fs.writeFileSync(path.join(zentestsPath, "example-tests.md"), EXAMPLE_TEST);

  // Create config file (.js for easier import)
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, DEFAULT_CONFIG);
  }

  // Create env example file
  if (!fs.existsSync(envExamplePath)) {
    fs.writeFileSync(envExamplePath, ENV_EXAMPLE);
  }

  console.log("Initialized zentest:");
  console.log("  - Created zentests/ folder");
  console.log("  - Created zentests/example-tests.md");
  console.log("  - Created zentest.config.js");
  console.log("  - Created .env.example");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Copy .env.example to .env and add your API key");
  console.log("  2. Edit zentest.config.js with your app URL");
  console.log("  3. Write tests in zentests/*.md files");
  console.log("  4. Run: zentest run");
}
