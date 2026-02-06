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
  | { type: "assert_text"; x: number; y: number; text: string };

// Union of all action types
export type Action =
  | MouseAction
  | ClickButtonAction
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
  selector: string; // Best selector for this element
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
  error?: string;
  timestamp: number;
}

/**
 * History entry for prompt context
 */
export interface ActionHistoryEntry {
  action: Action;
  reasoning: string;
  error?: string;
}
