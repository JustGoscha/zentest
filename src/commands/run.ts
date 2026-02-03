import * as fs from "fs";
import * as path from "path";
import { parseTestFile, TestSuite } from "../runner/testParser.js";
import { loadConfig, ZentestConfig } from "../config/loader.js";

interface RunOptions {
  agentic?: boolean;
  env?: string;
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
  if (options.agentic) {
    console.log("Mode: Agentic (forced)");
  }
  console.log("");

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
    await runTestFile(path.join(zentestsPath, suiteFile), envUrl, options);
  } else {
    // Run all test files
    for (const file of testFiles) {
      await runTestFile(path.join(zentestsPath, file), envUrl, options);
    }
  }
}

async function runTestFile(
  filePath: string,
  baseUrl: string,
  options: RunOptions
) {
  const testSuite = parseTestFile(filePath);

  console.log(`\n━━━ ${testSuite.name} ━━━`);

  for (const test of testSuite.tests) {
    console.log(`\n  ▶ ${test.name}`);
    console.log(`    "${test.description}"`);

    // TODO: Check if static test exists and run it first
    // TODO: If static fails or --agentic, run agentic tester
    // TODO: On agentic success, generate/update static test

    console.log(`    ⏳ Agentic testing not yet implemented`);
  }
}
