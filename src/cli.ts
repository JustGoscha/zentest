#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
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
  .version("0.2.0");

program
  .command("init")
  .description("Initialize zentest in the current directory")
  .action(init);

program
  .command("run [suite]")
  .description("Run tests")
  .option("--agentic", "Force agentic mode (skip static tests)")
  .option("--no-heal", "Disable self-healing when static tests fail")
  .option("--verbose", "Log full reasoning and tool use")
  .option("--env <environment>", "Run against specific environment")
  .option("--headless", "Run browser in headless mode")
  .option("--headed", "Run browser in visible mode (overrides auto-detect)")
  .action(run);

// Default action: auto-init XOR auto-run (with same options as run)
program
  .option("--agentic", "Force agentic mode (skip static tests)")
  .option("--no-heal", "Disable self-healing when static tests fail")
  .option("--verbose", "Log full reasoning and tool use")
  .option("--env <environment>", "Run against specific environment")
  .option("--headless", "Run browser in headless mode")
  .option("--headed", "Run browser in visible mode (overrides auto-detect)")
  .action(async (args, command) => {
    const options = command.opts();
    const cwd = process.cwd();
    const zentestsPath = path.join(cwd, "zentests");
    const configPath = path.join(cwd, "zentest.config.js");
    
    // If not initialized, ask whether to run init
    if (!fs.existsSync(zentestsPath) || !fs.existsSync(configPath)) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question("zentest is not initialized in this directory. Initialize now? (y/N) ", resolve);
      });
      rl.close();
      if (answer.trim().toLowerCase() !== "y") {
        return;
      }
      await init();
      return;
    }
    
    // Otherwise, run tests with options
    await run(undefined, options);
  });

program.parse();
