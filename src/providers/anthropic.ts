import Anthropic from "@anthropic-ai/sdk";
import {
  ComputerUseProvider,
  GetNextActionParams,
  GetNextActionResult,
  TokenUsage,
} from "./base.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { parseJsonResponse } from "./actionParser.js";

/**
 * Claude provider using native Anthropic SDK
 */
export class AnthropicProvider implements ComputerUseProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;

  constructor(apiKey?: string, model: string = "claude-sonnet-4-20250514") {
    const key = apiKey || process.env.ZENTEST_ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "API key required. Set ONE of: ZENTEST_ANTHROPIC_API_KEY, ZENTEST_OPENAI_API_KEY, or ZENTEST_OPENROUTER_API_KEY"
      );
    }
    this.client = new Anthropic({ apiKey: key });
    this.model = model;
  }

  async getNextAction(params: GetNextActionParams): Promise<GetNextActionResult> {
    const { screenshot, testDescription, actionHistory, viewport, lastFailureText } =
      params;

    const systemPrompt = buildSystemPrompt({
      testDescription,
      actionHistory,
      viewport,
      mode: params.promptMode || "json",
      codeHistory: params.codeHistory,
    });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: screenshot.toString("base64"),
              },
            },
            {
              type: "text",
              text: `${
                lastFailureText
                  ? `Last instruction failed: ${lastFailureText}. Try a different action.\n\n`
                  : ""
              }Did we complete the test? If not, what action should I take next to complete the test? Respond with JSON.`,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find(
      (block): block is Anthropic.Messages.TextBlock => block.type === "text"
    );

    const parsed = parseJsonResponse(textBlock?.text);
    return {
      ...parsed,
      usage: this.extractUsage(response),
    };
  }

  private extractUsage(response: Anthropic.Messages.Message): TokenUsage | undefined {
    const usage = response.usage;
    if (!usage) return undefined;
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    return {
      inputTokens,
      outputTokens,
      totalTokens:
        typeof inputTokens === "number" && typeof outputTokens === "number"
          ? inputTokens + outputTokens
          : undefined,
    };
  }
}
