import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { chromium, Browser } from "playwright";
import { parseTestFile } from "../runner/testParser.js";
import {
  loadConfig,
  shouldRunHeadless,
  ZentestConfig,
  getApiKey,
} from "../config/loader.js";
import { createProvider, ComputerUseProvider } from "../providers/index.js";
import { AgenticTester } from "../agents/agenticTester.js";
import { TestBuilder } from "../agents/testBuilder.js";
import {
  INDENT_LEVELS,
  color,
  formatSuiteHeader,
  formatTestHeader,
  logLine,
  statusLabel,
} from "../ui/cliOutput.js";
import { init } from "./init.js";

interface RunOptions {
  agentic?: boolean;
  env?: string;
  headless?: boolean;
  headed?: boolean;
  verbose?: boolean;
}

export async function run(suite: string | undefined, options: RunOptions) {
  const cwd = process.cwd();
  const zentestsPath = path.join(cwd, "zentests");
  const configPath = path.join(cwd, "zentest.config.js");

  // Auto-initialize if needed
  if (!fs.existsSync(zentestsPath) || !fs.existsSync(configPath)) {
    await init();
  }

  // Load config
  const config = await loadConfig(cwd);
  const envUrl = options.env
    ? config.environments[options.env]?.url
    : config.baseUrl;

  if (!envUrl) {
    console.error(`Error: Environment '${options.env}' not found in config`);
    process.exit(1);
  }

  logLine(INDENT_LEVELS.suite, color.bold("Zentest Runner"));
  logLine(INDENT_LEVELS.suite, `${statusLabel("info")} Target: ${envUrl}`);
  logLine(INDENT_LEVELS.suite, `${statusLabel("info")} Provider: ${config.provider}`);
  logLine(INDENT_LEVELS.suite, `${statusLabel("info")} Models:`);
  logLine(INDENT_LEVELS.suite, `  - Agentic: ${config.models.agenticModel}`);
  logLine(INDENT_LEVELS.suite, `  - Builder: ${config.models.builderModel}`);
  logLine(INDENT_LEVELS.suite, `  - Healer:  ${config.models.healerModel}`);
  if (options.agentic) {
    logLine(INDENT_LEVELS.suite, `${statusLabel("warn")} Mode: Agentic (forced)`);
  }
  if (options.verbose) {
    logLine(INDENT_LEVELS.suite, `${statusLabel("info")} Verbose: on`);
  }
  console.log("");

  // Determine headless mode
  let headless: boolean;
  if (options.headless) {
    headless = true;
  } else if (options.headed) {
    headless = false;
  } else {
    headless = shouldRunHeadless(config);
  }

  logLine(
    INDENT_LEVELS.suite,
    `${statusLabel("info")} Browser: ${headless ? "headless" : "visible"}`
  );

  // Check if any API key is available
  const hasAnthropicKey = !!process.env.ZENTEST_ANTHROPIC_API_KEY;
  const hasOpenAIKey = !!process.env.ZENTEST_OPENAI_API_KEY;
  const hasOpenRouterKey = !!process.env.ZENTEST_OPENROUTER_API_KEY;
  
  if (!hasAnthropicKey && !hasOpenAIKey && !hasOpenRouterKey && !config.apiKey) {
    console.error("Error: API key required. Set ONE of the following:");
    console.error("  - ZENTEST_ANTHROPIC_API_KEY (for Anthropic/Claude)");
    console.error("  - ZENTEST_OPENAI_API_KEY (for OpenAI)");
    console.error("  - ZENTEST_OPENROUTER_API_KEY (for OpenRouter)");
    console.error("");
    console.error("Or set 'apiKey' in your zentest.config.js");
    process.exit(1);
  }

  // Create provider for agentic tester
  const apiKey = getApiKey(config);
  let agenticProvider: ComputerUseProvider;
  try {
    agenticProvider = createProvider({
      provider: config.provider,
      model: config.models.agenticModel,
      apiKey,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("API key required")) {
      console.error("Error: API key required. Set ONE of the following:");
      console.error("  - ZENTEST_ANTHROPIC_API_KEY (for Anthropic/Claude)");
      console.error("  - ZENTEST_OPENAI_API_KEY (for OpenAI)");
      console.error("  - ZENTEST_OPENROUTER_API_KEY (for OpenRouter)");
      console.error("");
      console.error(`Current provider: ${config.provider}`);
      console.error(`Set ZENTEST_${config.provider.toUpperCase()}_API_KEY or change provider in config`);
      process.exit(1);
    }
    throw error;
  }

  // Launch browser
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: config.viewport,
  });

  try {
    // Find test files
    const testFiles = fs
      .readdirSync(zentestsPath)
      .filter((f) => f.endsWith(".md"));

    if (suite) {
      const suiteFile = `${suite}.md`;
      if (!testFiles.includes(suiteFile)) {
        console.error(`Error: Test suite '${suite}' not found`);
        process.exit(1);
      }
      await runTestFile(
        path.join(zentestsPath, suiteFile),
        envUrl,
        config,
        context,
        agenticProvider,
        options,
        headless
      );
    } else {
      // Run all test files
      for (const file of testFiles) {
        await runTestFile(
          path.join(zentestsPath, file),
          envUrl,
          config,
          context,
          agenticProvider,
          options,
          headless
        );
      }
    }
  } finally {
    await browser.close();
  }
}

async function runTestFile(
  filePath: string,
  baseUrl: string,
  config: ZentestConfig,
  context: Awaited<ReturnType<Browser["newContext"]>>,
  agenticProvider: ComputerUseProvider,
  options: RunOptions,
  headless: boolean
) {
  const testSuite = parseTestFile(filePath);
  const suiteName = path.basename(filePath, ".md");

  console.log("");
  logLine(INDENT_LEVELS.suite, formatSuiteHeader(testSuite.name));

  let passed = 0;
  let failed = 0;

  for (const test of testSuite.tests) {
    console.log("");
    logLine(INDENT_LEVELS.test, formatTestHeader(test.name));
    logLine(INDENT_LEVELS.step, color.dim(`"${test.description}"`));

    // Check if static test exists
    const staticTestPath = path.join(
      path.dirname(filePath),
      "static-tests",
      `${suiteName}.${test.name}.spec.js`
    );
    const hasStaticTest = fs.existsSync(staticTestPath);

    // Decide whether to run agentic
    const runAgentic = options.agentic || !hasStaticTest;

    if (runAgentic) {
      // Run agentic test
      const page = await context.newPage();

      try {
        const tester = new AgenticTester(page, baseUrl, agenticProvider, {
          maxSteps: config.maxSteps,
          viewport: config.viewport,
          verbose: options.verbose,
        });

        const result = await tester.run(test);

        if (result.success) {
          passed++;

          // Generate static test on success
          const legacySteps = AgenticTester.toLegacySteps(result.steps);
          const builder = new TestBuilder(suiteName, test.name);
          const testCode = builder.generate(legacySteps, test);

          // Ensure static-tests directory exists
          const staticTestsDir = path.join(path.dirname(filePath), "static-tests");
          if (!fs.existsSync(staticTestsDir)) {
            fs.mkdirSync(staticTestsDir, { recursive: true });
          }

          // Write static test
          fs.writeFileSync(staticTestPath, testCode);
        logLine(
          INDENT_LEVELS.step,
          `${statusLabel("check")} Generated static test: ${staticTestPath}`
        );
        } else {
          failed++;
        }
      } finally {
        await page.close();
      }
    } else {
      const ranStatic = await runStaticTest(staticTestPath, baseUrl, headless);
      if (ranStatic) {
        passed++;
      } else {
        failed++;
      }
    }
  }

  const passedText = color.green(String(passed));
  const failedText = failed > 0 ? color.red(String(failed)) : color.gray(String(failed));
  console.log("");
  logLine(
    INDENT_LEVELS.test,
    `${statusLabel(failed > 0 ? "fail" : "check")} Summary: ${passedText} passed, ${failedText} failed`
  );
}

async function runStaticTest(
  staticTestPath: string,
  baseUrl: string,
  headless: boolean
): Promise<boolean> {
  const cwd = process.cwd();
  const cliPath = path.join(
    cwd,
    "node_modules",
    "@playwright",
    "test",
    "cli.js"
  );

  if (!fs.existsSync(cliPath)) {
    logLine(
      INDENT_LEVELS.step,
      `${statusLabel("fail")} Playwright Test not found at ${cliPath}`
    );
    return false;
  }

  logLine(
    INDENT_LEVELS.step,
    `${statusLabel("info")} Running static test: ${staticTestPath}`
  );

  const args = [cliPath, "test", staticTestPath];

  // Point Playwright at the config so its TS transformer registers properly
  const configPath = path.join(cwd, "playwright.config.ts");
  if (fs.existsSync(configPath)) {
    args.push("--config", configPath);
  }

  if (!headless) {
    args.push("--headed");
  }

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        ZENTEST_BASE_URL: baseUrl,
      },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode === 0) {
    logLine(
      INDENT_LEVELS.step,
      `${statusLabel("check")} Static test passed`
    );
    return true;
  }

  logLine(INDENT_LEVELS.step, `${statusLabel("fail")} Static test failed`);
  return false;
}
