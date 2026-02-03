import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

export interface ZentestConfig {
  baseUrl: string;
  environments: Record<string, { url: string }>;
}

const DEFAULT_CONFIG: ZentestConfig = {
  baseUrl: "http://localhost:3000",
  environments: {},
};

export async function loadConfig(cwd: string): Promise<ZentestConfig> {
  const configPath = path.join(cwd, "zentest.config.ts");
  const configPathJs = path.join(cwd, "zentest.config.js");

  // Try .js first (already compiled or plain JS)
  if (fs.existsSync(configPathJs)) {
    try {
      const configUrl = pathToFileURL(configPathJs).href;
      const module = await import(configUrl);
      return { ...DEFAULT_CONFIG, ...module.default };
    } catch (e) {
      console.warn("Warning: Could not load zentest.config.js", e);
    }
  }

  // For .ts, we'd need tsx or ts-node - for now just warn
  if (fs.existsSync(configPath)) {
    console.warn(
      "Warning: TypeScript config found but not yet supported. Use zentest.config.js instead."
    );
  }

  return DEFAULT_CONFIG;
}
