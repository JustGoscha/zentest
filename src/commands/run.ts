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
import { TestBuilder, TestResult, SerializedSuiteSteps } from "../agents/testBuilder.js";
import { TestHealer } from "../agents/testHealer.js";
import { TestRewriter } from "../agents/testRewriter.js";
import { replaySteps } from "../runner/stepReplayer.js";
import { RecordedStep } from "../types/actions.js";
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
  testDurations?: Map<string, number>;
  errorMessage?: string;
  errorStack?: string;
  failureScreenshotPath?: string;
  runArtifactsDir?: string;
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
  let savedStepsData: SerializedSuiteSteps | undefined;
  let firstMissingTestIndex = 0;
  if (hasStaticTest) {
    const savedSteps = TestBuilder.loadSuiteSteps(stepsPath);
    if (savedSteps) {
      const savedNames = new Set(savedSteps.tests.map((t) => t.name));
      const missingTests = testSuite.tests.filter((t) => !savedNames.has(t.name));
      if (missingTests.length > 0) {
        staticTestsOutdated = true;
        savedStepsData = savedSteps;
        firstMissingTestIndex = testSuite.tests.findIndex((t) => !savedNames.has(t.name));
        logLine(1, color.yellow(`${sym.warn} Static tests cover ${savedNames.size}/${testSuite.tests.length} tests — missing: ${missingTests.map((t) => t.name).join(", ")}`));
        if (firstMissingTestIndex > 0) {
          logLine(1, color.dim(`${sym.info} Replaying ${firstMissingTestIndex} saved test(s), then running agentically from '${testSuite.tests[firstMissingTestIndex].name}'...`));
        } else {
          logLine(1, color.dim(`${sym.info} Running suite agentically...`));
        }
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
      // Phase 1: Replay saved steps for tests we already have coverage for
      const canPartialReplay = savedStepsData && firstMissingTestIndex > 0;
      let agenticStartIndex = 0;

      if (canPartialReplay) {
        await page.goto(baseUrl, { waitUntil: "networkidle" });
        isFirstTest = false;

        for (let i = 0; i < firstMissingTestIndex; i++) {
          const test = testSuite.tests[i];
          const saved = savedStepsData!.tests.find((t) => t.name === test.name);

          if (!saved) {
            logLine(2, `${color.yellow(sym.warn)} No saved steps for '${test.name}', falling back to full agentic`);
            // Reset — run everything agentically from scratch
            await page.goto(baseUrl, { waitUntil: "networkidle" });
            testResults.length = 0;
            agenticStartIndex = 0;
            break;
          }

          logBlank();
          logLine(1, formatTestName(test.name));
          logLine(2, `${color.cyan(sym.info)} Replaying saved steps...`);

          try {
            await replaySteps(page, saved.steps as RecordedStep[]);
            testResults.push({ test, steps: saved.steps as RecordedStep[] });
            summaryRows.push({ name: test.name, passed: true, durationMs: 0, actionCount: 0 });
            logLine(2, `${color.green(sym.pass)} Replay complete`);
            agenticStartIndex = i + 1;
          } catch (error) {
            logLine(2, `${color.yellow(sym.warn)} Replay failed: ${error instanceof Error ? error.message : error}`);
            logLine(2, `${color.cyan(sym.info)} Falling back to full agentic run...`);
            await page.goto(baseUrl, { waitUntil: "networkidle" });
            testResults.length = 0;
            agenticStartIndex = 0;
            break;
          }
        }
      }

      // Phase 2: Run remaining tests agentically
      for (let i = agenticStartIndex; i < testSuite.tests.length; i++) {
        const test = testSuite.tests[i];
        logBlank();
        logLine(1, formatTestName(test.name));
        logLine(2, color.dim(`"${test.description}"`));
        logBlank();

        const tester = new AgenticTester(page, baseUrl, agenticProvider, {
          maxSteps: config.maxSteps,
          viewport: config.viewport,
          verbose: options.verbose,
        }, mcpExecutor);

        const skipNav = canPartialReplay ? true : (i > 0 || !isFirstTest);
        const result = await tester.run(test, { skipNavigation: skipNav });
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

        // Verify the generated static tests actually work
        logLine(2, color.dim(`${sym.info} Verifying generated static tests...`));
        const verifyResult = await runStaticTest(staticTestPath, baseUrl, headless);

        if (verifyResult.passed) {
          logLine(2, `${color.green(sym.pass)} Static tests verified`);
        } else if (verifyResult.failedTestName && verifyResult.errorMessage) {
          logLine(2, `${color.yellow(sym.warn)} Static test failed at: ${verifyResult.failedTestName}`);

          try {
            const rewriter = new TestRewriter(config);
            let currentResult = verifyResult;
            let fixed = false;

            for (let attempt = 1; attempt <= rewriter.maxAttempts; attempt++) {
              logBlank();
              logLine(1, `\u{270D}\u{FE0F}  ${color.magenta("Rewriter Agent")} ${color.dim(`(attempt ${attempt}/${rewriter.maxAttempts})`)}`);

              const testFileContents = fs.readFileSync(staticTestPath, "utf-8");
              const analysis = await rewriter.analyze({
                failedTestName: currentResult.failedTestName!,
                errorMessage: currentResult.errorMessage!,
                errorStack: currentResult.errorStack,
                testFileContents,
                screenshotPath: currentResult.failureScreenshotPath,
              });

              logLine(2, `\u{1F4AD} ${color.dim(analysis.reasoning)}`);

              if (analysis.decision === "AGENTIC") {
                logLine(2, color.dim(`${sym.arrow} Cannot fix, keeping original`));
                break;
              }

              if (analysis.decision === "REWRITE" && analysis.rewrittenCode) {
                fs.writeFileSync(staticTestPath, analysis.rewrittenCode);
                logLine(2, color.cyan(`${sym.arrow} Rewrote '${currentResult.failedTestName}', verifying...`));

                const reVerify = await runStaticTest(staticTestPath, baseUrl, headless);
                if (reVerify.passed) {
                  logLine(2, `${color.green(sym.pass)} Rewrite fixed the test`);
                  fixed = true;
                  break;
                } else {
                  logLine(2, `${color.red(sym.fail)} Still failing`);
                  currentResult = reVerify;
                }
              }
            }

            if (!fixed) {
              logLine(2, color.dim(`${sym.info} Could not fix generated test, keeping best attempt`));
            }
          } catch (error) {
            logLine(2, color.dim(`${sym.info} Rewriter error: ${error instanceof Error ? error.message : error}`));
          }
        }
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
        summaryRows.push({ name: test.name, passed: true, durationMs: staticResult.testDurations?.get(test.name) ?? Math.round(staticDuration / testSuite.tests.length), actionCount: 0 });
      }
    } else {
      // Self-healing
      if (options.heal === false) {
        for (const test of testSuite.tests) {
          summaryRows.push({ name: test.name, passed: false, durationMs: 0, actionCount: 0 });
        }
        logLine(2, color.dim(`${sym.info} Self-healing disabled (--no-heal)`));
      } else {
        // ─── Phase 0: Smart Test Rewrite ───────────────────
        let rewriteSucceeded = false;

        if (staticResult.failedTestName && staticResult.errorMessage) {
          logBlank();
          logLine(1, `\u{270D}\u{FE0F}  ${color.magenta("Rewriter Agent")} ${color.dim(`(attempt 1/${new TestRewriter(config).maxAttempts})`)}`);

          try {
            const rewriter = new TestRewriter(config);
            let currentResult = staticResult;
            let attempt = 0;

            while (attempt < rewriter.maxAttempts) {
              attempt++;
              if (attempt > 1) {
                logBlank();
                logLine(1, `\u{270D}\u{FE0F}  ${color.magenta("Rewriter Agent")} ${color.dim(`(attempt ${attempt}/${rewriter.maxAttempts})`)}`);
              }

              const testFileContents = fs.readFileSync(staticTestPath, "utf-8");

              const analysis = await rewriter.analyze({
                failedTestName: currentResult.failedTestName!,
                errorMessage: currentResult.errorMessage!,
                errorStack: currentResult.errorStack,
                testFileContents,
                screenshotPath: currentResult.failureScreenshotPath,
              });

              logLine(2, `\u{1F4AD} ${color.dim(analysis.reasoning)}`);

              if (analysis.decision === "AGENTIC") {
                logLine(2, color.dim(`${sym.arrow} Recommends agentic re-run`));
                break;
              }

              if (analysis.decision === "REWRITE" && analysis.rewrittenCode) {
                // Write the corrected test file
                fs.writeFileSync(staticTestPath, analysis.rewrittenCode);
                logLine(2, color.cyan(`${sym.arrow} Rewrote '${currentResult.failedTestName}', verifying...`));

                // Re-run the static test
                const verifyResult = await runStaticTest(staticTestPath, baseUrl, headless);

                if (verifyResult.passed) {
                  logLine(2, `${color.green(sym.pass)} Rewrite fixed the test`);
                  for (const test of testSuite.tests) {
                    summaryRows.push({
                      name: test.name,
                      passed: true,
                      durationMs: verifyResult.testDurations?.get(test.name) ?? 0,
                      actionCount: 0,
                    });
                  }
                  rewriteSucceeded = true;
                  break;
                } else {
                  logLine(2, color.dim(`${color.red(sym.fail)} Still failing`));
                  currentResult = verifyResult;
                  // Loop continues with new error info
                }
              }
            }

            if (!rewriteSucceeded && attempt >= rewriter.maxAttempts) {
              logLine(2, color.dim(`${sym.info} Rewrite attempts exhausted, falling back to agentic healing...`));
            }
          } catch (error) {
            logLine(2, color.dim(`${sym.info} Rewriter error: ${error instanceof Error ? error.message : error}, falling back to agentic...`));
          }
        }

        // ─── Phase 1+2: Agentic TestHealer (existing flow) ───────
        if (!rewriteSucceeded) {
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

  // Create run artifacts directory
  const suiteName = path.basename(staticTestPath, ".spec.js");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runsDir = path.join(cwd, "zentests", "runs");
  const runArtifactsDir = path.join(runsDir, `${suiteName}-${timestamp}`);

  cleanupOldRuns(runsDir);

  const args = [cliPath, "test", staticTestPath];

  // Create a temp Playwright config with screenshot + output settings
  // (Playwright doesn't support --screenshot as a CLI flag)
  // We read the user's config to preserve timeout and other settings,
  // then write a self-contained temp config with screenshot + outputDir added.
  const userConfigPath = path.join(cwd, "playwright.config.ts");
  // Place temp config in project dir so @playwright/test resolves from node_modules
  const tempConfigPath = path.join(cwd, `.zentest-pw-config-${Date.now()}.ts`);
  let userTimeout = 120_000;
  let userUseBlock = "";
  if (fs.existsSync(userConfigPath)) {
    try {
      const src = fs.readFileSync(userConfigPath, "utf-8");
      const timeoutMatch = src.match(/timeout\s*:\s*(\d[\d_]*)/);
      if (timeoutMatch) userTimeout = Number(timeoutMatch[1].replace(/_/g, ""));
      // Extract the use block content with balanced-brace parsing
      // (handles nested objects like launchOptions: { args: [...] })
      const useStart = src.match(/use\s*:\s*\{/);
      if (useStart && useStart.index !== undefined) {
        let depth = 1;
        let i = useStart.index + useStart[0].length;
        const start = i;
        while (i < src.length && depth > 0) {
          if (src[i] === "{") depth++;
          if (src[i] === "}") depth--;
          i++;
        }
        if (depth === 0) {
          userUseBlock = src.slice(start, i - 1);
        }
      }
    } catch {}
  }
  const tempConfigContent = [
    `import { defineConfig } from '@playwright/test';`,
    `export default defineConfig({`,
    `  timeout: ${userTimeout},`,
    `  use: {${userUseBlock}`,
    `    screenshot: 'on',`,
    `  },`,
    `  outputDir: ${JSON.stringify(runArtifactsDir)},`,
    `});`,
  ].join("\n");
  fs.writeFileSync(tempConfigPath, tempConfigContent);
  args.push("--config", tempConfigPath);

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

  // Clean up temp config
  try { fs.unlinkSync(tempConfigPath); } catch {}

  const { failedTestName, testDurations, errorMessage, errorStack } =
    parseTestResults(jsonResultsPath);

  // Save JSON results to artifacts dir
  if (!fs.existsSync(runArtifactsDir)) {
    fs.mkdirSync(runArtifactsDir, { recursive: true });
  }
  try {
    fs.copyFileSync(jsonResultsPath, path.join(runArtifactsDir, "results.json"));
    fs.unlinkSync(jsonResultsPath);
  } catch {
    try { fs.unlinkSync(jsonResultsPath); } catch {}
  }

  if (exitCode === 0) {
    logLine(2, `${color.green(sym.pass)} Static test passed`);
    logLine(2, color.dim(`${sym.info} Run artifacts: ${runArtifactsDir}`));
    return { passed: true, testDurations, runArtifactsDir };
  }

  // On failure: save additional artifacts
  if (errorMessage || errorStack) {
    fs.writeFileSync(
      path.join(runArtifactsDir, "error.txt"),
      `Test: ${failedTestName || "unknown"}\n\nError: ${errorMessage || ""}\n\nStack:\n${errorStack || ""}`
    );
  }

  try {
    fs.copyFileSync(staticTestPath, path.join(runArtifactsDir, path.basename(staticTestPath)));
  } catch {}

  const failureScreenshotPath = findFailureScreenshot(runArtifactsDir);

  if (failedTestName) {
    logLine(2, `${color.red(sym.fail)} Static test failed at: ${failedTestName}`);
  } else {
    logLine(2, `${color.red(sym.fail)} Static test failed`);
  }

  if (failureScreenshotPath) {
    logLine(2, color.dim(`${sym.info} Failure screenshot: ${failureScreenshotPath}`));
  }
  logLine(2, color.dim(`${sym.info} Run artifacts: ${runArtifactsDir}`));

  return {
    passed: false,
    failedTestName,
    testDurations,
    errorMessage,
    errorStack,
    failureScreenshotPath,
    runArtifactsDir,
  };
}

function findFailureScreenshot(dir: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFailureScreenshot(fullPath);
        if (found) return found;
      } else if (entry.name.endsWith(".png")) {
        return fullPath;
      }
    }
  } catch {}
  return undefined;
}

function cleanupOldRuns(runsDir: string, keepLast = 10): void {
  if (!fs.existsSync(runsDir)) return;
  try {
    const entries = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: path.join(runsDir, e.name) }))
      .sort((a, b) => b.name.localeCompare(a.name)); // newest first (timestamp in name)

    for (const entry of entries.slice(keepLast)) {
      fs.rmSync(entry.path, { recursive: true, force: true });
    }
  } catch {}
}

function parseTestResults(jsonPath: string): {
  failedTestName?: string;
  testDurations: Map<string, number>;
  errorMessage?: string;
  errorStack?: string;
} {
  const testDurations = new Map<string, number>();
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const specs: Array<{ title: string; ok: boolean; duration: number; errorMessage?: string; errorStack?: string }> = [];

    function collectSpecs(suite: {
      specs?: Array<{
        title: string;
        ok: boolean;
        tests?: Array<{ results?: Array<{ duration?: number; error?: { message?: string; stack?: string } }> }>;
      }>;
      suites?: typeof suite[];
    }) {
      for (const spec of suite.specs || []) {
        let duration = 0;
        let errorMessage: string | undefined;
        let errorStack: string | undefined;
        for (const test of spec.tests || []) {
          for (const result of test.results || []) {
            duration += result.duration || 0;
            if (result.error) {
              errorMessage = result.error.message;
              errorStack = result.error.stack;
            }
          }
        }
        specs.push({ title: spec.title, ok: spec.ok, duration, errorMessage, errorStack });
      }
      for (const child of suite.suites || []) {
        collectSpecs(child);
      }
    }

    for (const suite of data.suites || []) {
      collectSpecs(suite);
    }

    for (const spec of specs) {
      testDurations.set(spec.title, spec.duration);
    }

    const failed = specs.find((s) => !s.ok);
    return {
      failedTestName: failed?.title,
      testDurations,
      errorMessage: failed?.errorMessage,
      errorStack: failed?.errorStack,
    };
  } catch {
    return { testDurations };
  }
}
