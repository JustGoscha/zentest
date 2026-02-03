import * as fs from "fs";
import * as path from "path";

const ZENTESTS_DIR = "zentests";

const DEFAULT_CONFIG = `export default {
  baseUrl: "https://example.com",
  environments: {
    production: { url: "https://example.com" },
    dev: { url: "https://dev.example.com" }
  }
}
`;

const EXAMPLE_TEST = `# Example Tests

## example-test
A user can visit the homepage and see a welcome message
`;

export async function init() {
  const cwd = process.cwd();
  const zentestsPath = path.join(cwd, ZENTESTS_DIR);
  const configPath = path.join(cwd, "zentest.config.ts");

  // Check if already initialized
  if (fs.existsSync(zentestsPath)) {
    console.log("zentests/ folder already exists");
    return;
  }

  // Create directories
  fs.mkdirSync(zentestsPath, { recursive: true });
  fs.mkdirSync(path.join(zentestsPath, "runs"), { recursive: true });
  fs.mkdirSync(path.join(zentestsPath, "static-tests"), { recursive: true });

  // Create example test file
  fs.writeFileSync(
    path.join(zentestsPath, "example-tests.md"),
    EXAMPLE_TEST
  );

  // Create config file
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, DEFAULT_CONFIG);
  }

  console.log("Initialized zentest:");
  console.log("  - Created zentests/ folder");
  console.log("  - Created zentests/example-tests.md");
  console.log("  - Created zentest.config.ts");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit zentest.config.ts with your app URL");
  console.log("  2. Write tests in zentests/*.md files");
  console.log("  3. Run: zentest run");
}
