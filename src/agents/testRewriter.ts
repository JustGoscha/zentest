import * as fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getApiKey, ZentestConfig } from "../config/loader.js";
import { color, sym, logLine } from "../ui/cliOutput.js";

export interface RewriteAnalysis {
  decision: "REWRITE" | "AGENTIC";
  reasoning: string;
  rewrittenCode?: string;
}

const REWRITER_PROMPT = (params: {
  failedTestName: string;
  failedTestCode: string;
  errorMessage: string;
  errorStack?: string;
  testFileContents: string;
  hasScreenshot: boolean;
}) => `A Playwright test has failed. Analyze the failure and decide the best fix.

## Failed Test
Name: ${params.failedTestName}

## Failing Test Code
\`\`\`javascript
${params.failedTestCode}
\`\`\`

## Error
${params.errorMessage}
${params.errorStack ? `\nStack:\n${params.errorStack}` : ""}

## Full Test File (for context — helpers, shared state, other tests)
\`\`\`javascript
${params.testFileContents}
\`\`\`

${params.hasScreenshot ? "A screenshot of the page at the time of failure is attached above." : "No screenshot available."}

## Instructions
Decide whether to REWRITE the failing test or fall back to AGENTIC mode.

- **REWRITE** if the fix is straightforward: a selector changed, a timing issue needs a longer timeout, a locator needs updating based on what you see in the screenshot, text content changed slightly, etc. Return ONLY the rewritten test function body (everything between \`test('${params.failedTestName}', async () => {\` and the closing \`});\`). Do NOT return the full file — only the failing test's inner code.
- **AGENTIC** if the page looks fundamentally different from what the test expects, the application flow changed, or you cannot determine a code fix from the available information.

Respond with JSON only:
{
  "decision": "REWRITE" | "AGENTIC",
  "reasoning": "your analysis of what went wrong",
  "rewrittenTestBody": "the corrected test body code (only the inner code of the test function, excluding the test('name', async () => { wrapper)"
}`;

/**
 * Extract a single test block from a spec file by test name.
 * Returns { startIndex, endIndex, testBody } or undefined.
 */
function extractTestBlock(fileContents: string, testName: string): {
  startIndex: number;
  endIndex: number;
  testBody: string;
  fullMatch: string;
} | undefined {
  // Match test('name', async () => { ... });
  // We need to find the matching closing brace by counting braces
  const escapedName = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const testStartRegex = new RegExp(`(  test\\('${escapedName}',\\s*async\\s*\\(\\)\\s*=>\\s*\\{)`);
  const match = fileContents.match(testStartRegex);
  if (!match || match.index === undefined) return undefined;

  const headerEnd = match.index + match[1].length;
  let braceDepth = 1;
  let i = headerEnd;

  while (i < fileContents.length && braceDepth > 0) {
    if (fileContents[i] === "{") braceDepth++;
    else if (fileContents[i] === "}") braceDepth--;
    i++;
  }

  // Now i is right after the closing } of the test function
  // Skip the closing ");' after the function body
  const afterClose = fileContents.substring(i).match(/^\s*\)\s*;/);
  const endIndex = afterClose ? i + afterClose[0].length : i;

  const fullMatch = fileContents.substring(match.index, endIndex);
  const testBody = fileContents.substring(headerEnd, i - 1); // inner body (between { and })

  return { startIndex: match.index, endIndex, testBody: testBody.trim(), fullMatch };
}

export class TestRewriter {
  private config: ZentestConfig;
  private model: string;
  private apiKey: string;
  readonly maxAttempts: number;

  constructor(config: ZentestConfig, maxAttempts = 3) {
    const apiKey = getApiKey(config);
    if (!apiKey) {
      throw new Error("API key required for test rewriter");
    }
    this.config = config;
    this.apiKey = apiKey;
    this.model = config.models.healerModel;
    this.maxAttempts = maxAttempts;
  }

  async analyze(params: {
    failedTestName: string;
    errorMessage: string;
    errorStack?: string;
    testFileContents: string;
    screenshotPath?: string;
  }): Promise<RewriteAnalysis> {
    const { failedTestName, screenshotPath, testFileContents } = params;

    // Extract the failing test's code
    const testBlock = extractTestBlock(testFileContents, failedTestName);
    const failedTestCode = testBlock?.fullMatch || "(could not extract test code)";

    let screenshotBase64: string | undefined;
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      screenshotBase64 = fs.readFileSync(screenshotPath).toString("base64");
    }

    const promptText = REWRITER_PROMPT({
      ...params,
      failedTestCode,
      hasScreenshot: !!screenshotBase64,
    });

    logLine(3, color.dim(`${sym.info} Sending failure to rewriter (${this.model})...`));

    const responseText = this.config.provider === "anthropic"
      ? await this.callAnthropic(promptText, screenshotBase64)
      : await this.callOpenAICompatible(promptText, screenshotBase64);

    const analysis = this.parseResponse(responseText);

    // If rewrite, splice the new test body back into the full file
    if (analysis.decision === "REWRITE" && analysis.rewrittenCode && testBlock) {
      const newTestBlock = `  test('${failedTestName}', async () => {\n${analysis.rewrittenCode}\n  });`;
      const newFileContents =
        testFileContents.substring(0, testBlock.startIndex) +
        newTestBlock +
        testFileContents.substring(testBlock.endIndex);
      analysis.rewrittenCode = newFileContents;
    }

    return analysis;
  }

  private async callAnthropic(promptText: string, screenshotBase64?: string): Promise<string> {
    const client = new Anthropic({ apiKey: this.apiKey });

    const userContent: Anthropic.Messages.ContentBlockParam[] = [];
    if (screenshotBase64) {
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: screenshotBase64 },
      });
    }
    userContent.push({ type: "text", text: promptText });

    const response = await client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: userContent }],
    });

    const textBlock = response.content.find(
      (block): block is Anthropic.Messages.TextBlock => block.type === "text"
    );
    return textBlock?.text || "";
  }

  private async callOpenAICompatible(promptText: string, screenshotBase64?: string): Promise<string> {
    const isOpenRouter = this.config.provider === "openrouter";
    const client = new OpenAI({
      apiKey: this.apiKey,
      ...(isOpenRouter && {
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": "https://zentest.dev",
          "X-Title": "Zentest",
        },
      }),
    });

    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    if (screenshotBase64) {
      content.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${screenshotBase64}` },
      });
    }
    content.push({ type: "text", text: promptText });

    const response = await client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content }],
    });

    return response.choices[0]?.message?.content || "";
  }

  private parseResponse(text: string): RewriteAnalysis {
    try {
      // Extract JSON from the response (handle markdown code blocks)
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();
      const parsed = JSON.parse(jsonStr);

      if (parsed.decision === "REWRITE" && parsed.rewrittenTestBody) {
        return {
          decision: "REWRITE",
          reasoning: parsed.reasoning || "Rewriting test",
          rewrittenCode: parsed.rewrittenTestBody,
        };
      }

      return {
        decision: "AGENTIC",
        reasoning: parsed.reasoning || "Falling back to agentic mode",
      };
    } catch {
      return {
        decision: "AGENTIC",
        reasoning: "Could not parse rewriter response, falling back to agentic mode",
      };
    }
  }
}
