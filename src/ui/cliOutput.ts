const supportsColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== "1";

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

export const INDENT_LEVELS = {
  suite: 0,
  test: 1,
  step: 2,
  detail: 3,
};

export const symbols = {
  check: "[+]",
  fail: "[x]",
  warn: "[!]",
  info: "[i]",
  arrow: "->",
  step: ">>",
  suite: "==",
};

const applyColor = (text: string, color: string) =>
  supportsColor ? `${color}${text}${ansi.reset}` : text;

export const color = {
  bold: (text: string) => applyColor(text, ansi.bold),
  dim: (text: string) => applyColor(text, ansi.dim),
  red: (text: string) => applyColor(text, ansi.red),
  green: (text: string) => applyColor(text, ansi.green),
  yellow: (text: string) => applyColor(text, ansi.yellow),
  blue: (text: string) => applyColor(text, ansi.blue),
  magenta: (text: string) => applyColor(text, ansi.magenta),
  cyan: (text: string) => applyColor(text, ansi.cyan),
  gray: (text: string) => applyColor(text, ansi.gray),
};

export const indent = (level: number) => "  ".repeat(level);

export const logLine = (level: number, message: string) => {
  console.log(`${indent(level)}${message}`);
};

export const statusLabel = (kind: "check" | "fail" | "warn" | "info") => {
  const label =
    kind === "check" ? "CHECK" : kind === "fail" ? "FAIL" : kind === "warn" ? "WARN" : "INFO";
  const symbol =
    kind === "check" ? symbols.check : kind === "fail" ? symbols.fail : kind === "warn" ? symbols.warn : symbols.info;
  const text = `${symbol} ${label}`;
  if (kind === "check") return color.green(text);
  if (kind === "fail") return color.red(text);
  if (kind === "warn") return color.yellow(text);
  return color.cyan(text);
};

export const formatSuiteHeader = (name: string) =>
  color.cyan(`${symbols.suite} ${name} ${symbols.suite}`);

export const formatTestHeader = (name: string) =>
  color.blue(`${symbols.step} ${name}`);

export type SpinnerHandle = {
  update: (message: string) => void;
  stop: (finalMessage?: string, finalKind?: "check" | "fail" | "warn" | "info") => void;
};

export const startSpinner = (level: number, message: string): SpinnerHandle => {
  if (!process.stdout.isTTY) {
    logLine(level, `${symbols.arrow} ${message}`);
    return {
      update: (nextMessage: string) => {
        logLine(level, `${symbols.arrow} ${nextMessage}`);
      },
      stop: (finalMessage?: string, finalKind: "check" | "fail" | "warn" | "info" = "info") => {
        if (finalMessage) {
          logLine(level, `${statusLabel(finalKind)} ${finalMessage}`);
        }
      },
    };
  }

  const frames = ["|", "/", "-", "\\"];
  let index = 0;
  let lastLength = 0;
  let currentMessage = message;
  const prefix = indent(level);

  const render = () => {
    const frame = frames[index++ % frames.length];
    const text = `${prefix}${frame} ${currentMessage}`;
    const padded = text.padEnd(Math.max(lastLength, text.length));
    lastLength = Math.max(lastLength, text.length);
    process.stdout.write(`\r${padded}`);
  };

  render();
  const timer = setInterval(render, 120);

  return {
    update: (nextMessage: string) => {
      currentMessage = nextMessage;
      render();
    },
    stop: (finalMessage?: string, finalKind: "check" | "fail" | "warn" | "info" = "info") => {
      clearInterval(timer);
      if (process.stdout.clearLine) process.stdout.clearLine(0);
      if (process.stdout.cursorTo) process.stdout.cursorTo(0);
      if (finalMessage) {
        process.stdout.write(`${prefix}${statusLabel(finalKind)} ${finalMessage}\n`);
      } else {
        process.stdout.write("\n");
      }
    },
  };
};
