#!/usr/bin/env node

import { Command } from "commander";
import { init } from "./commands/init.js";
import { run } from "./commands/run.js";

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
  .action(run);

program.parse();
