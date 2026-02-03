import * as fs from "fs";
import * as path from "path";

export interface Test {
  name: string;
  description: string;
}

export interface TestSuite {
  name: string;
  tests: Test[];
}

/**
 * Parse a markdown test file into a TestSuite
 *
 * Format:
 * # Suite Name
 *
 * ## test-name
 * Description in plain English
 *
 * ## another-test
 * Another description
 */
export function parseTestFile(filePath: string): TestSuite {
  const content = fs.readFileSync(filePath, "utf-8");
  const fileName = path.basename(filePath, ".md");

  const lines = content.split("\n");

  let suiteName = fileName;
  const tests: Test[] = [];

  let currentTest: { name: string; lines: string[] } | null = null;

  for (const line of lines) {
    // Suite name (h1)
    if (line.startsWith("# ")) {
      suiteName = line.slice(2).trim();
      continue;
    }

    // Test name (h2)
    if (line.startsWith("## ")) {
      // Save previous test
      if (currentTest) {
        tests.push({
          name: currentTest.name,
          description: currentTest.lines.join("\n").trim(),
        });
      }

      currentTest = {
        name: line.slice(3).trim(),
        lines: [],
      };
      continue;
    }

    // Test description content
    if (currentTest) {
      currentTest.lines.push(line);
    }
  }

  // Save last test
  if (currentTest) {
    tests.push({
      name: currentTest.name,
      description: currentTest.lines.join("\n").trim(),
    });
  }

  return { name: suiteName, tests };
}
