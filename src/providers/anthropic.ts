import Anthropic from "@anthropic-ai/sdk";
import {
  ComputerUseProvider,
  GetNextActionParams,
  GetNextActionResult,
} from "./base.js";
import { Action } from "../types/actions.js";

/**
 * Claude computer use provider using native Anthropic SDK
 */
export class AnthropicProvider implements ComputerUseProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;

  constructor(apiKey?: string, model: string = "claude-sonnet-4-20250514") {
    const key = apiKey || process.env.ZENTEST_ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "Anthropic API key required. Set ZENTEST_ANTHROPIC_API_KEY or pass apiKey in config."
      );
    }
    this.client = new Anthropic({ apiKey: key });
    this.model = model;
  }

  async getNextAction(params: GetNextActionParams): Promise<GetNextActionResult> {
    const { screenshot, testDescription, actionHistory, viewport } = params;

    // Build conversation context
    const historyText =
      actionHistory.length > 0
        ? `\n\nActions taken so far:\n${actionHistory
            .map((h, i) => `${i + 1}. ${h.action.type}: ${h.reasoning}`)
            .join("\n")}`
        : "";

    const systemPrompt = `You are an AI testing assistant that helps execute end-to-end tests on web applications.
Your task is to complete the following test:
"${testDescription}"

${historyText}

Based on the current screenshot, decide what action to take next to complete the test.
When you have successfully completed the test, use the done action with success: true.
If you cannot complete the test, use the done action with success: false and explain why.

IMPORTANT:
- Coordinates should be within the viewport (${viewport.width}x${viewport.height})
- Click on elements that are visible and interactive
- Wait for page loads when necessary
- Use scroll if you need to see more content`;

    // Use beta API for computer use
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt,
      tools: [
        {
          type: "computer_20250124",
          name: "computer",
          display_width_px: viewport.width,
          display_height_px: viewport.height,
          display_number: 1,
        },
      ],
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
              text: "What action should I take next to complete the test?",
            },
          ],
        },
      ],
      betas: ["computer-use-2025-01-24"],
    });

    // Extract the action from the response
    return this.parseResponse(response);
  }

  private parseResponse(response: Anthropic.Beta.Messages.BetaMessage): GetNextActionResult {
    // Find tool use blocks
    const toolUse = response.content.find(
      (block): block is Anthropic.Beta.Messages.BetaToolUseBlock =>
        block.type === "tool_use"
    );

    // Find text blocks for reasoning
    const textBlock = response.content.find(
      (block): block is Anthropic.Beta.Messages.BetaTextBlock =>
        block.type === "text"
    );
    const reasoning = textBlock?.text || "No reasoning provided";

    if (!toolUse || toolUse.name !== "computer") {
      // No tool use, check if this is a completion message
      if (response.stop_reason === "end_turn") {
        return {
          action: { type: "done", success: true, reason: reasoning },
          reasoning,
        };
      }
      return {
        action: { type: "done", success: false, reason: "No action returned" },
        reasoning,
      };
    }

    const input = toolUse.input as Record<string, unknown>;
    const action = this.mapClaudeAction(input);

    return { action, reasoning };
  }

  private mapClaudeAction(input: Record<string, unknown>): Action {
    const actionType = input.action as string;
    const coordinate = input.coordinate as [number, number] | undefined;

    switch (actionType) {
      case "mouse_move":
        return {
          type: "mouse_move",
          x: coordinate?.[0] || 0,
          y: coordinate?.[1] || 0,
        };

      case "left_click":
      case "click":
        return {
          type: "click",
          x: coordinate?.[0] || 0,
          y: coordinate?.[1] || 0,
          button: "left",
        };

      case "right_click":
        return {
          type: "click",
          x: coordinate?.[0] || 0,
          y: coordinate?.[1] || 0,
          button: "right",
        };

      case "middle_click":
        return {
          type: "click",
          x: coordinate?.[0] || 0,
          y: coordinate?.[1] || 0,
          button: "middle",
        };

      case "double_click":
        return {
          type: "double_click",
          x: coordinate?.[0] || 0,
          y: coordinate?.[1] || 0,
        };

      case "left_click_drag": {
        const startCoordinate = input.start_coordinate as [number, number] | undefined;
        return {
          type: "drag",
          startX: startCoordinate?.[0] || 0,
          startY: startCoordinate?.[1] || 0,
          endX: coordinate?.[0] || 0,
          endY: coordinate?.[1] || 0,
        };
      }

      case "type":
        return {
          type: "type",
          text: (input.text as string) || "",
        };

      case "key":
        return {
          type: "key",
          key: (input.key as string) || "",
        };

      case "scroll": {
        const scrollCoordinate = input.coordinate as [number, number] | undefined;
        const scrollDirection = input.scroll_direction as string;
        const scrollAmount = input.scroll_amount as number | undefined;
        return {
          type: "scroll",
          x: scrollCoordinate?.[0] || 0,
          y: scrollCoordinate?.[1] || 0,
          direction: scrollDirection === "up" ? "up" : "down",
          amount: scrollAmount || 100,
        };
      }

      case "screenshot":
        return { type: "screenshot" };

      case "wait":
        return { type: "wait", ms: 1000 };

      default:
        return {
          type: "done",
          success: false,
          reason: `Unknown action type: ${actionType}`,
        };
    }
  }
}
