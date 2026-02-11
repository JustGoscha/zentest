import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { tmpdir } from "os";
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
import { TestBuilder, TestResult } from "../agents/testBuilder.js";
import { TestHealer } from "../agents/testHealer.js";
import {
  INDENT_LEVELS,
  color,
  formatSuiteHeader,
  formatTestHeader,
  logLine,
  statusLabel,
} from "../ui/cliOutput.js";
import { init } from "./init.js";

interface StaticTestResult {
  passed: boolean;
  failedTestName?: string;
}

interface RunOptions {
  agentic?: boolean;
  heal?: boolean;
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
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("zentest is not initialized in this directory. Initialize now? (y/N) ", resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      process.exit(0);
    }
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

  // Static test path is now a single file for the entire suite
  const staticTestsDir = path.join(path.dirname(filePath), "static-tests");
  const staticTestPath = path.join(staticTestsDir, `${suiteName}.spec.js`);
  const hasStaticTest = fs.existsSync(staticTestPath);

  // Decide whether to run agentic for the whole suite
  const runAgentic = options.agentic || !hasStaticTest;

  let passed = 0;
  let failed = 0;

  if (runAgentic) {
    // Run agentic tests - share one page across all tests in the suite
    const page = await context.newPage();
    const testResults: TestResult[] = [];
    let isFirstTest = true;

    try {
      for (const test of testSuite.tests) {
        console.log("");
        logLine(INDENT_LEVELS.test, formatTestHeader(test.name));
        logLine(INDENT_LEVELS.step, color.dim(`"${test.description}"`));

        // Only navigate to baseUrl on the first test
        const tester = new AgenticTester(page, baseUrl, agenticProvider, {
          maxSteps: config.maxSteps,
          viewport: config.viewport,
          verbose: options.verbose,
        });

        const result = await tester.run(test, { skipNavigation: !isFirstTest });
        isFirstTest = false;

        if (result.success) {
          passed++;
          testResults.push({ test, steps: result.steps });
        } else {
          failed++;
          // Stop on first failure - subsequent tests likely depend on previous state
          logLine(
            INDENT_LEVELS.step,
            `${statusLabel("warn")} Stopping suite - subsequent tests depend on previous state`
          );
          break;
        }
      }

      // Generate single static test file + steps sidecar if we have any successful results
      if (testResults.length > 0) {
        if (!fs.existsSync(staticTestsDir)) {
          fs.mkdirSync(staticTestsDir, { recursive: true });
        }

        const builder = new TestBuilder(suiteName, "");
        const testCode = builder.generateSuite(testResults, testSuite);
        fs.writeFileSync(staticTestPath, testCode);

        const stepsPath = staticTestPath.replace(/\.spec\.js$/, ".steps.json");
        TestBuilder.saveSuiteSteps(stepsPath, testResults);

        logLine(
          INDENT_LEVELS.step,
          `${statusLabel("check")} Generated static test: ${staticTestPath}`
        );
      }
    } finally {
      await page.close();
    }
  } else {
    // Run the single combined static test file
    const staticResult = await runStaticTest(staticTestPath, baseUrl, headless);
    if (staticResult.passed) {
      passed = testSuite.tests.length;
    } else {
      // --- Self-healing: replay passing tests then go agentic from failure (unless --no-heal) ---
      if (options.heal === false) {
        failed = testSuite.tests.length;
        logLine(
          INDENT_LEVELS.step,
          `${statusLabel("info")} Self-healing disabled (--no-heal)`
        );
      } else {
        // Load saved steps sidecar for partial replay
        const stepsPath = staticTestPath.replace(/\.spec\.js$/, ".steps.json");
        const savedSteps = TestBuilder.loadSuiteSteps(stepsPath);

        // Find the index of the failed test
        let failedTestIndex = 0;
        if (staticResult.failedTestName && savedSteps) {
          const idx = testSuite.tests.findIndex(
            (t) => t.name === staticResult.failedTestName
          );
          if (idx >= 0) failedTestIndex = idx;
        }

        const canPartialReplay =
          savedSteps && failedTestIndex > 0;

        if (canPartialReplay) {
          logLine(
            INDENT_LEVELS.step,
            `${statusLabel("info")} Healing: replaying ${failedTestIndex} passing test(s), then agentic from '${staticResult.failedTestName}'...`
          );
        } else {
          logLine(
            INDENT_LEVELS.step,
            `${statusLabel("info")} Healing: re-running suite agentically...`
          );
        }

        const healPage = await context.newPage();
        try {
          const healer = new TestHealer(healPage, baseUrl, agenticProvider, {
            maxSteps: config.maxSteps,
            viewport: config.viewport,
            verbose: options.verbose,
          });

          const healResult = await healer.healSuite(testSuite, {
            savedSteps: canPartialReplay ? savedSteps : undefined,
            failedTestIndex: canPartialReplay ? failedTestIndex : undefined,
          });

          if (healResult.testResults.length > 0) {
            // Regenerate suite-level static test file + steps sidecar
            if (!fs.existsSync(staticTestsDir)) {
              fs.mkdirSync(staticTestsDir, { recursive: true });
            }
            const builder = new TestBuilder(suiteName, "");
            const testCode = builder.generateSuite(
              healResult.testResults,
              testSuite
            );
            fs.writeFileSync(staticTestPath, testCode);
            TestBuilder.saveSuiteSteps(stepsPath, healResult.testResults);
            logLine(
              INDENT_LEVELS.step,
              `${statusLabel("check")} Healer regenerated static test: ${staticTestPath}`
            );

            // Verify the regenerated static tests actually run
            logLine(
              INDENT_LEVELS.step,
              `${statusLabel("info")} Verifying regenerated static tests...`
            );
            const verified = await runStaticTest(
              staticTestPath,
              baseUrl,
              headless
            );
            if (verified.passed) {
              passed = testSuite.tests.length;
              failed = 0;
              logLine(
                INDENT_LEVELS.step,
                `${statusLabel("check")} Healed static tests verified`
              );
            } else {
              passed = healResult.passed;
              failed = testSuite.tests.length - healResult.passed;
              logLine(
                INDENT_LEVELS.step,
                `${statusLabel("fail")} Regenerated static tests still fail`
              );
            }
          } else {
            // Agentic healing produced no results at all
            failed = testSuite.tests.length;
            logLine(
              INDENT_LEVELS.step,
              `${statusLabel("fail")} Healer failed: agentic run produced no passing tests`
            );
          }
        } finally {
          await healPage.close();
        }
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
): Promise<StaticTestResult> {
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
    return { passed: false };
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

  // Use JSON reporter alongside list to identify which test failed
  const jsonResultsPath = path.join(
    tmpdir(),
    `zentest-results-${Date.now()}.json`
  );
  args.push("--reporter=list,json");

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        ZENTEST_BASE_URL: baseUrl,
        PLAYWRIGHT_JSON_OUTPUT_NAME: jsonResultsPath,
      },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });

  // Parse JSON results to find which test failed
  const failedTestName = parseFailedTestName(jsonResultsPath);

  // Clean up temp file
  try {
    fs.unlinkSync(jsonResultsPath);
  } catch {}

  if (exitCode === 0) {
    logLine(
      INDENT_LEVELS.step,
      `${statusLabel("check")} Static test passed`
    );
    return { passed: true };
  }

  if (failedTestName) {
    logLine(
      INDENT_LEVELS.step,
      `${statusLabel("fail")} Static test failed at: ${failedTestName}`
    );
  } else {
    logLine(INDENT_LEVELS.step, `${statusLabel("fail")} Static test failed`);
  }
  return { passed: false, failedTestName };
}

/**
 * Parse Playwright JSON reporter output to find the first failed test name.
 */
function parseFailedTestName(jsonPath: string): string | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const specs: Array<{ title: string; ok: boolean }> = [];

    function collectSpecs(suite: { specs?: Array<{ title: string; ok: boolean }>; suites?: typeof suite[] }) {
      for (const spec of suite.specs || []) {
        specs.push({ title: spec.title, ok: spec.ok });
      }
      for (const child of suite.suites || []) {
        collectSpecs(child);
      }
    }

    for (const suite of data.suites || []) {
      collectSpecs(suite);
    }

    const failed = specs.find((s) => !s.ok);
    return failed?.title;
  } catch {
    return undefined;
  }
}
