import OpenAI from "openai";
import {
  ComputerUseProvider,
  GetNextActionParams,
  GetNextActionResult,
  TokenUsage,
} from "./base.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { parseJsonResponse } from "./actionParser.js";

/**
 * OpenAI computer use provider
 */
export class OpenAIProvider implements ComputerUseProvider {
  readonly name = "openai";
  private client: OpenAI;
  private model: string;

  constructor(apiKey?: string, model: string = "gpt-4o") {
    const key = apiKey || process.env.ZENTEST_OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        "API key required. Set ONE of: ZENTEST_ANTHROPIC_API_KEY, ZENTEST_OPENAI_API_KEY, or ZENTEST_OPENROUTER_API_KEY"
      );
    }
    this.client = new OpenAI({ apiKey: key });
    this.model = model;
  }

  async getNextAction(params: GetNextActionParams): Promise<GetNextActionResult> {
    const { screenshot, testDescription, actionHistory, viewport, lastFailureText } =
      params;

    const systemPrompt = buildSystemPrompt({
      testDescription,
      actionHistory,
      viewport,
      mode: "json",
    });

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${screenshot.toString("base64")}`,
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

    const parsed = parseJsonResponse(response.choices[0]?.message?.content);
    return {
      ...parsed,
      usage: this.extractUsage(response),
    };
  }

  private extractUsage(
    response: OpenAI.Chat.Completions.ChatCompletion
  ): TokenUsage | undefined {
    const usage = response.usage;
    if (!usage) return undefined;
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    };
  }
}
