import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const ZENTESTS_DIR = "zentests";

const DEFAULT_CONFIG = `export default {
  // Base URL for testing
  // Configure all AI + browser settings via environment variables only.
  baseUrl: "https://example.com",

  // Optional: environment-specific URLs
  environments: {
    production: { url: "https://example.com" },
    dev: { url: "https://dev.example.com" },
  },
}
`;

const EXAMPLE_TEST = `# Example Tests

## example-test
A user can visit the homepage and it says Example Domain somewhere
`;

const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './zentests/static-tests',
  timeout: 120_000,
  use: {
    // Base URL set via ZENTEST_BASE_URL env variable at runtime
  },
});
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

# Agentic Tester - the model that navigates and interacts with the page
# Requires multimodal (vision) capabilities
# Anthropic: claude-sonnet-4-20250514, claude-opus-4-20250514
# OpenAI: gpt-4o, gpt-4-turbo
# OpenRouter: anthropic/claude-sonnet-4, openai/gpt-4o
ZENTEST_AGENTIC_MODEL=anthropic/claude-haiku-4.5

# Test Builder - generates Playwright test code from recorded actions
# Can use a smaller/cheaper model (no vision needed)
# Anthropic: claude-haiku-3-5-20241022, claude-sonnet-4-20250514
# OpenAI: gpt-4o-mini, gpt-4o
# OpenRouter: anthropic/claude-haiku-3.5, openai/gpt-4o-mini
ZENTEST_BUILDER_MODEL=anthropic/claude-haiku-4.5

# Test Healer - re-runs failed tests to figure out what changed
# Requires multimodal (vision) capabilities
ZENTEST_HEALER_MODEL=anthropic/claude-haiku-4.5

# =============================================================================
# Browser Configuration
# =============================================================================

# Viewport dimensions
ZENTEST_VIEWPORT_WIDTH=1280
ZENTEST_VIEWPORT_HEIGHT=720

# Headless mode: auto, true, or false
ZENTEST_HEADLESS=auto

# Maximum steps per test before giving up
ZENTEST_MAX_STEPS=50
`;

const DEFAULT_DEPENDENCIES: Record<string, string> = {
  "@playwright/test": "^1.58.1",
  "playwright": "^1.58.1",
};

const DEFAULT_DEV_DEPENDENCIES: Record<string, string> = {
  "typescript": "^5.9.3",
};

export async function init() {
  const cwd = process.cwd();
  const zentestsPath = path.join(cwd, ZENTESTS_DIR);
  const configPath = path.join(cwd, "zentest.config.js");
  const envExamplePath = path.join(cwd, ".env.example");
  const envPath = path.join(cwd, ".env");
  const packageJsonPath = path.join(cwd, "package.json");

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

  // Create playwright config
  const playwrightConfigPath = path.join(cwd, "playwright.config.ts");
  if (!fs.existsSync(playwrightConfigPath)) {
    fs.writeFileSync(playwrightConfigPath, PLAYWRIGHT_CONFIG);
  }

  // Create env example file
  if (!fs.existsSync(envExamplePath)) {
    fs.writeFileSync(envExamplePath, ENV_EXAMPLE);
  }

  // Create .env from .env.example if it doesn't exist
  const envCreated = !fs.existsSync(envPath);
  if (envCreated) {
    fs.copyFileSync(envExamplePath, envPath);
  }

  // Create package.json if it doesn't exist
  const packageJsonCreated = !fs.existsSync(packageJsonPath);
  if (packageJsonCreated) {
    const projectName = path.basename(cwd) || "zentest-project";
    const packageJson = {
      name: projectName,
      type: "module",
      private: true,
      scripts: {
        zentest: "zentest run",
      },
      dependencies: DEFAULT_DEPENDENCIES,
      devDependencies: DEFAULT_DEV_DEPENDENCIES,
    };
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }

  // Install dependencies when we create package.json
  if (packageJsonCreated) {
    const bunResult = spawnSync("bun", ["install"], { stdio: "inherit" });
    if (bunResult.error || bunResult.status !== 0) {
      const npmResult = spawnSync("npm", ["install"], { stdio: "inherit" });
      if (npmResult.error || npmResult.status !== 0) {
        console.warn("Dependency install failed. Run 'bun install' or 'npm install'.");
      }
    }
  }

  console.log("Initialized zentest:");
  console.log("  - Created zentests/ folder");
  console.log("  - Created zentests/example-tests.md");
  console.log("  - Created zentest.config.js");
  console.log("  - Created playwright.config.ts");
  console.log("  - Created .env.example");
  if (envCreated) {
    console.log("  - Created .env");
  }
  if (packageJsonCreated) {
    console.log("  - Created package.json");
  }
  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit .env and add your API key");
  console.log("  2. Edit zentest.config.js with your app URL");
  console.log("  3. Write tests in zentests/*.md files");
  console.log("  4. Run: zentest run");
}
