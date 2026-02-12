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
 * OpenRouter provider - routes to various models via OpenAI-compatible API
 */
export class OpenRouterProvider implements ComputerUseProvider {
  readonly name = "openrouter";
  private client: OpenAI;
  private model: string;

  constructor(apiKey?: string, model: string = "anthropic/claude-sonnet-4") {
    const key = apiKey || process.env.ZENTEST_OPENROUTER_API_KEY;
    if (!key) {
      throw new Error(
        "API key required. Set ONE of: ZENTEST_ANTHROPIC_API_KEY, ZENTEST_OPENAI_API_KEY, or ZENTEST_OPENROUTER_API_KEY"
      );
    }
    this.client = new OpenAI({
      apiKey: key,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://zentest.dev",
        "X-Title": "Zentest",
      },
    });
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

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
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
    ];

    const response = await this.callWithRetry(messages);

    const parsed = parseJsonResponse(response.choices[0]?.message?.content);
    return {
      ...parsed,
      usage: this.extractUsage(response),
    };
  }

  private async callWithRetry(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    maxRetries = 3
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.client.chat.completions.create({
          model: this.model,
          max_tokens: 5000,
          response_format: { type: "json_object" },
          messages,
        });
      } catch (error) {
        const isRetryable =
          error instanceof Error &&
          (/5\d{2}|429|timeout|ECONNRESET|ETIMEDOUT/i.test(error.message));
        if (!isRetryable || attempt >= maxRetries) {
          throw error;
        }
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Unreachable");
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
