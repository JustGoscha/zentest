/**
 * Common action types for computer use across all providers
 */

// Mouse actions
export type MouseAction =
  | { type: "mouse_move"; x: number; y: number }
  | {
      type: "mouse_down";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
    }
  | {
      type: "mouse_up";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
    }
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { type: "double_click"; x: number; y: number }
  | {
      type: "drag";
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    };

export type ClickButtonAction = {
  type: "click_button";
  name: string;
  exact?: boolean;
};

export type ClickTextAction = {
  type: "click_text";
  text: string;
  exact?: boolean;
};

export type SelectInputAction = {
  type: "select_input";
  field: string;
  value: string;
  exact?: boolean;
};

// Keyboard actions
export type KeyboardAction =
  | { type: "type"; text: string }
  | { type: "key"; key: string };

// Scroll actions
export type ScrollAction = {
  type: "scroll";
  x: number;
  y: number;
  direction: "up" | "down";
  amount?: number;
};

// Control actions
export type ControlAction =
  | { type: "screenshot" }
  | { type: "wait"; ms: number }
  | { type: "done"; success: boolean; reason: string };

// Assertion actions
export type AssertAction =
  | { type: "assert_visible"; x: number; y: number }
  | { type: "assert_text"; text: string }
  | { type: "assert_not_text"; text: string };

// Union of all action types
export type Action =
  | MouseAction
  | ClickButtonAction
  | ClickTextAction
  | SelectInputAction
  | KeyboardAction
  | ScrollAction
  | ControlAction
  | AssertAction;

/**
 * Information about an element at a given coordinate
 */
export interface ElementInfo {
  tagName: string;
  text?: string;
  role?: string;
  name?: string;
  id?: string;
  className?: string;
  href?: string;
  placeholder?: string;
  ariaLabel?: string;
  selector: string;
}

/**
 * Result of executing an action
 */
export interface ActionResult {
  action: Action;
  screenshot?: Buffer;
  elementInfo?: ElementInfo;
  error?: string;
  timestamp: number;
}

/**
 * A recorded step in the test, combining action with metadata
 */
export interface RecordedStep {
  action: Action;
  reasoning: string;
  elementInfo?: ElementInfo;
  screenshot?: Buffer;
  /** Playwright code — always set in code mode, optionally set in MCP mode */
  generatedCode?: string;
  error?: string;
  timestamp: number;
  /** Execution mode that produced this step */
  mode?: "vision" | "mcp" | "code";
}

/**
 * History entry for prompt context (vision/mcp modes)
 */
export interface ActionHistoryEntry {
  action: Action;
  reasoning: string;
  error?: string;
}

/**
 * History entry for code mode prompt context
 */
export interface CodeHistoryEntry {
  code: string;
  reasoning: string;
  error?: string;
}

/**
 * Parsed AI response in code mode
 */
export interface CodeModeResponse {
  code: string[];
  reasoning: string;
  done: boolean;
  success?: boolean;
  reason?: string;
}
