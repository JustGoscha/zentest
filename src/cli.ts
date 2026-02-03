#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import { config as loadEnv } from "dotenv";
import { Command } from "commander";
import { init } from "./commands/init.js";
import { run } from "./commands/run.js";

// Load .env file from current working directory if it exists
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  loadEnv({ path: envPath });
}

const program = new Command();

program
  .name("zentest")
  .description("Agentic QA testing framework - write tests in plain English")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize zentest in the current directory")
  .action(init);

program
  .command("run [suite]")
  .description("Run tests")
  .option("--agentic", "Force agentic mode (skip static tests)")
  .option("--env <environment>", "Run against specific environment")
  .option("--headless", "Run browser in headless mode")
  .option("--headed", "Run browser in visible mode (overrides auto-detect)")
  .action(run);

program.parse();
