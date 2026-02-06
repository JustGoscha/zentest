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

  // Check if initialized
  if (!fs.existsSync(zentestsPath)) {
    console.error("Zentest is not initialized in this folder.");
    console.error("");
    console.error("First run steps:");
    console.error("  1. Install zentest");
    console.error("  2. Run: zentest init");
    console.error("  3. Edit zentest.config.js with your app URL");
    console.error("  4. Copy .env.example to .env and add your API key");
    console.error("  5. Write tests in zentests/*.md");
    console.error("  6. Run: zentest run");
    process.exit(1);
  }

  if (!fs.existsSync(configPath)) {
    console.error("zentest.config.js not found. Run 'zentest init' first.");
    process.exit(1);
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

  // Create provider for agentic tester
  const apiKey = getApiKey(config);
  const agenticProvider = createProvider({
    provider: config.provider,
    model: config.models.agenticModel,
    apiKey,
  });

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
      `${suiteName}.${test.name}.spec.ts`
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
  const cliPath = path.join(
    process.cwd(),
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
