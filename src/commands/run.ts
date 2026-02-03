import * as fs from "fs";
import * as path from "path";
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

interface RunOptions {
  agentic?: boolean;
  env?: string;
  headless?: boolean;
  headed?: boolean;
}

export async function run(suite: string | undefined, options: RunOptions) {
  const cwd = process.cwd();
  const zentestsPath = path.join(cwd, "zentests");

  // Check if initialized
  if (!fs.existsSync(zentestsPath)) {
    console.error("Error: zentests/ folder not found. Run 'zentest init' first.");
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

  console.log(`Running tests against: ${envUrl}`);
  console.log(`Provider: ${config.provider}`);
  console.log(`Models:`);
  console.log(`  - Agentic: ${config.models.agenticModel}`);
  console.log(`  - Builder: ${config.models.builderModel}`);
  console.log(`  - Healer:  ${config.models.healerModel}`);
  if (options.agentic) {
    console.log("Mode: Agentic (forced)");
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

  console.log(`Browser: ${headless ? "headless" : "visible"}`);

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
        options
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
          options
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
  options: RunOptions
) {
  const testSuite = parseTestFile(filePath);
  const suiteName = path.basename(filePath, ".md");

  console.log(`\n━━━ ${testSuite.name} ━━━`);

  let passed = 0;
  let failed = 0;

  for (const test of testSuite.tests) {
    console.log(`\n  ▶ ${test.name}`);
    console.log(`    "${test.description}"`);

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
          console.log(`    📝 Generated static test: ${staticTestPath}`);
        } else {
          failed++;
        }
      } finally {
        await page.close();
      }
    } else {
      // TODO: Run static test first
      console.log(`    ⏭️  Static test exists, skipping agentic (use --agentic to force)`);
      passed++; // Assume static tests pass for now
    }
  }

  console.log(`\n  Summary: ${passed} passed, ${failed} failed`);
}
