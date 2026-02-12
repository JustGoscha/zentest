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
import { MCPBrowserClient } from "../mcp/mcpClient.js";
import { MCPExecutor } from "../mcp/mcpExecutor.js";
import {
  color,
  sym,
  logLine,
  logBlank,
  formatHeader,
  formatSuiteBar,
  formatTestName,
  printSummaryTable,
  type TestSummaryRow,
  type TokenTotals,
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

  // Determine headless mode
  let headless: boolean;
  if (options.headless) {
    headless = true;
  } else if (options.headed) {
    headless = false;
  } else {
    headless = shouldRunHeadless(config);
  }

  // Print compact header
  const headerLines = formatHeader(
    envUrl,
    config.provider,
    config.automationMode === "mcp" ? "mcp" : "vision",
    headless ? "headless" : "headed"
  );
  for (const line of headerLines) logLine(0, line);
  logBlank();

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

  const suiteStartTime = Date.now();
  const summaryRows: TestSummaryRow[] = [];
  const tokenTotals: TokenTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

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
        headless,
        summaryRows,
        tokenTotals
      );
    } else {
      for (const file of testFiles) {
        await runTestFile(
          path.join(zentestsPath, file),
          envUrl,
          config,
          context,
          agenticProvider,
          options,
          headless,
          summaryRows,
          tokenTotals
        );
      }
    }
  } finally {
    await browser.close();
  }

  // Print summary table
  if (summaryRows.length > 0) {
    const totalDuration = Date.now() - suiteStartTime;
    printSummaryTable(summaryRows, totalDuration, tokenTotals.totalTokens > 0 ? tokenTotals : undefined);
  }
}

async function runTestFile(
  filePath: string,
  baseUrl: string,
  config: ZentestConfig,
  context: Awaited<ReturnType<Browser["newContext"]>>,
  agenticProvider: ComputerUseProvider,
  options: RunOptions,
  headless: boolean,
  summaryRows: TestSummaryRow[],
  tokenTotals: TokenTotals
) {
  const testSuite = parseTestFile(filePath);
  const suiteName = path.basename(filePath, ".md");

  logBlank();
  logLine(0, formatSuiteBar(testSuite.name));

  // Static test path is now a single file for the entire suite
  const staticTestsDir = path.join(path.dirname(filePath), "static-tests");
  const staticTestPath = path.join(staticTestsDir, `${suiteName}.spec.js`);
  const stepsPath = staticTestPath.replace(/\.spec\.js$/, ".steps.json");
  const hasStaticTest = fs.existsSync(staticTestPath);

  // Check if the static test covers all tests in the .md
  let staticTestsOutdated = false;
  if (hasStaticTest) {
    const savedSteps = TestBuilder.loadSuiteSteps(stepsPath);
    if (savedSteps) {
      const savedNames = new Set(savedSteps.tests.map((t) => t.name));
      const missingTests = testSuite.tests.filter((t) => !savedNames.has(t.name));
      if (missingTests.length > 0) {
        staticTestsOutdated = true;
        logLine(1, color.yellow(`${sym.warn} Static tests cover ${savedNames.size}/${testSuite.tests.length} tests — missing: ${missingTests.map((t) => t.name).join(", ")}`));
        logLine(1, color.dim(`${sym.info} Re-running full suite agentically...`));
      }
    } else if (!fs.existsSync(stepsPath)) {
      // No steps.json at all — can't verify coverage, force agentic
      staticTestsOutdated = true;
      logLine(1, color.yellow(`${sym.warn} No steps.json found — re-running agentically`));
    }
  }

  // Decide whether to run agentic for the whole suite
  const runAgentic = options.agentic || !hasStaticTest || staticTestsOutdated;

  if (runAgentic) {
    // Run agentic tests
    const page = await context.newPage();
    const testResults: TestResult[] = [];
    let isFirstTest = true;

    let mcpClient: MCPBrowserClient | undefined;
    let mcpExecutor: MCPExecutor | undefined;
    if (config.automationMode === "mcp") {
      mcpClient = await MCPBrowserClient.create(context);
      mcpExecutor = new MCPExecutor(page, mcpClient);
    }

    try {
      for (const test of testSuite.tests) {
        logBlank();
        logLine(1, formatTestName(test.name));
        logLine(2, color.dim(`"${test.description}"`));
        logBlank();

        const tester = new AgenticTester(page, baseUrl, agenticProvider, {
          maxSteps: config.maxSteps,
          viewport: config.viewport,
          verbose: options.verbose,
        }, mcpExecutor);

        const result = await tester.run(test, { skipNavigation: !isFirstTest });
        isFirstTest = false;

        // Collect stats
        summaryRows.push({
          name: test.name,
          passed: result.success,
          durationMs: result.durationMs,
          actionCount: result.steps.length,
        });
        tokenTotals.inputTokens += result.tokenUsage.inputTokens;
        tokenTotals.outputTokens += result.tokenUsage.outputTokens;
        tokenTotals.totalTokens += result.tokenUsage.totalTokens;

        if (result.success) {
          testResults.push({ test, steps: result.steps });
        } else {
          logLine(2, color.yellow(`${sym.warn} Stopping suite — subsequent tests depend on previous state`));
          break;
        }
      }

      // Generate static test file
      if (testResults.length > 0) {
        if (!fs.existsSync(staticTestsDir)) {
          fs.mkdirSync(staticTestsDir, { recursive: true });
        }

        const builder = new TestBuilder(suiteName, "", config.automationMode);
        const testCode = builder.generateSuite(testResults, testSuite);
        fs.writeFileSync(staticTestPath, testCode);

        TestBuilder.saveSuiteSteps(stepsPath, testResults, config.automationMode);

        logBlank();
        logLine(1, `${color.green(sym.pass)} Saved ${sym.arrow} ${color.dim(staticTestPath)}`);
      }
    } finally {
      if (mcpClient) await mcpClient.close();
      await page.close();
    }
  } else {
    // Run static tests
    const staticStartTime = Date.now();
    const staticResult = await runStaticTest(staticTestPath, baseUrl, headless);
    const staticDuration = Date.now() - staticStartTime;

    if (staticResult.passed) {
      for (const test of testSuite.tests) {
        summaryRows.push({ name: test.name, passed: true, durationMs: Math.round(staticDuration / testSuite.tests.length), actionCount: 0 });
      }
    } else {
      // Self-healing
      if (options.heal === false) {
        for (const test of testSuite.tests) {
          summaryRows.push({ name: test.name, passed: false, durationMs: 0, actionCount: 0 });
        }
        logLine(2, color.dim(`${sym.info} Self-healing disabled (--no-heal)`));
      } else {
        const savedSteps = TestBuilder.loadSuiteSteps(stepsPath);

        let failedTestIndex = 0;
        if (staticResult.failedTestName && savedSteps) {
          const idx = testSuite.tests.findIndex(
            (t) => t.name === staticResult.failedTestName
          );
          if (idx >= 0) failedTestIndex = idx;
        }

        const canPartialReplay = savedSteps && failedTestIndex > 0;

        if (canPartialReplay) {
          logLine(2, color.dim(`${sym.info} Healing: replaying ${failedTestIndex} passing test(s), then agentic from '${staticResult.failedTestName}'...`));
        } else {
          logLine(2, color.dim(`${sym.info} Healing: re-running suite agentically...`));
        }

        const healPage = await context.newPage();
        let healMcpClient: MCPBrowserClient | undefined;
        let healMcpExecutor: MCPExecutor | undefined;
        if (config.automationMode === "mcp") {
          healMcpClient = await MCPBrowserClient.create(context);
          healMcpExecutor = new MCPExecutor(healPage, healMcpClient);
        }
        try {
          const healer = new TestHealer(healPage, baseUrl, agenticProvider, {
            maxSteps: config.maxSteps,
            viewport: config.viewport,
            verbose: options.verbose,
          }, healMcpExecutor);

          const healResult = await healer.healSuite(testSuite, {
            savedSteps: canPartialReplay ? savedSteps : undefined,
            failedTestIndex: canPartialReplay ? failedTestIndex : undefined,
          });

          if (healResult.testResults.length > 0) {
            if (!fs.existsSync(staticTestsDir)) {
              fs.mkdirSync(staticTestsDir, { recursive: true });
            }
            const builder = new TestBuilder(suiteName, "", config.automationMode);
            const testCode = builder.generateSuite(
              healResult.testResults,
              testSuite
            );
            fs.writeFileSync(staticTestPath, testCode);
            TestBuilder.saveSuiteSteps(stepsPath, healResult.testResults, config.automationMode);
            logLine(1, `${color.green(sym.pass)} Healer saved ${sym.arrow} ${color.dim(staticTestPath)}`);

            // Verify
            logLine(2, color.dim(`${sym.info} Verifying regenerated static tests...`));
            const verified = await runStaticTest(staticTestPath, baseUrl, headless);
            // Only mark tests that the healer actually produced results for
            const healedNames = new Set(healResult.testResults.map((r) => r.test.name));

            if (verified.passed) {
              for (const test of testSuite.tests) {
                summaryRows.push({
                  name: test.name,
                  passed: healedNames.has(test.name),
                  durationMs: 0,
                  actionCount: 0,
                });
              }
              const allHealed = healedNames.size === testSuite.tests.length;
              if (allHealed) {
                logLine(2, `${color.green(sym.pass)} Healed static tests verified`);
              } else {
                logLine(2, `${color.green(sym.pass)} Healed ${healedNames.size}/${testSuite.tests.length} tests verified`);
                logLine(2, `${color.yellow(sym.warn)} ${testSuite.tests.length - healedNames.size} test(s) could not be healed`);
              }
            } else {
              const verifiedFailed = verified.failedTestName;
              const failIdx = verifiedFailed
                ? testSuite.tests.findIndex((t) => t.name === verifiedFailed)
                : -1;
              for (let i = 0; i < testSuite.tests.length; i++) {
                summaryRows.push({
                  name: testSuite.tests[i].name,
                  passed: failIdx >= 0 ? i < failIdx : false,
                  durationMs: 0,
                  actionCount: 0,
                });
              }
              logLine(2, `${color.red(sym.fail)} Regenerated static tests still fail${verifiedFailed ? ` at: ${verifiedFailed}` : ""}`);
            }
          } else {
            for (const test of testSuite.tests) {
              summaryRows.push({ name: test.name, passed: false, durationMs: 0, actionCount: 0 });
            }
            logLine(2, `${color.red(sym.fail)} Healer failed: no passing tests`);
          }
        } finally {
          if (healMcpClient) await healMcpClient.close();
          await healPage.close();
        }
      }
    }
  }
}

async function runStaticTest(
  staticTestPath: string,
  baseUrl: string,
  headless: boolean
): Promise<StaticTestResult> {
  const cwd = process.cwd();
  const cliPath = path.join(cwd, "node_modules", "@playwright", "test", "cli.js");

  if (!fs.existsSync(cliPath)) {
    logLine(2, `${color.red(sym.fail)} Playwright Test not found at ${cliPath}`);
    return { passed: false };
  }

  logLine(2, color.dim(`${sym.info} Running static test: ${staticTestPath}`));

  const args = [cliPath, "test", staticTestPath];

  const configPath = path.join(cwd, "playwright.config.ts");
  if (fs.existsSync(configPath)) {
    args.push("--config", configPath);
  }

  if (!headless) {
    args.push("--headed");
  }

  const jsonResultsPath = path.join(tmpdir(), `zentest-results-${Date.now()}.json`);
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

  const failedTestName = parseFailedTestName(jsonResultsPath);

  try { fs.unlinkSync(jsonResultsPath); } catch {}

  if (exitCode === 0) {
    logLine(2, `${color.green(sym.pass)} Static test passed`);
    return { passed: true };
  }

  if (failedTestName) {
    logLine(2, `${color.red(sym.fail)} Static test failed at: ${failedTestName}`);
  } else {
    logLine(2, `${color.red(sym.fail)} Static test failed`);
  }
  return { passed: false, failedTestName };
}

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
