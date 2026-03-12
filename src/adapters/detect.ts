import { existsSync } from "fs";
import { resolve } from "path";
import type { BundlerAdapter } from "./types.js";

const KNOWN_BUNDLERS = [
  { name: "vite", configBase: "vite.config" },
  { name: "webpack", configBase: "webpack.config" },
  { name: "rollup", configBase: "rollup.config" },
];

const CONFIG_EXTENSIONS = [".ts", ".js", ".mjs", ".mts"];

export function detectBundler(rootDir: string): string {
  for (const { name, configBase } of KNOWN_BUNDLERS) {
    for (const ext of CONFIG_EXTENSIONS) {
      if (existsSync(resolve(rootDir, configBase + ext))) {
        return name;
      }
    }
  }
  throw new Error(
    "Could not detect bundler. No vite.config.*, webpack.config.*, or rollup.config.* found.\n" +
      "Use --bundler <name> to specify explicitly.",
  );
}

export async function loadAdapter(
  bundlerName: string,
): Promise<BundlerAdapter> {
  switch (bundlerName) {
    case "vite": {
      const { createViteAdapter } = await import("./vite.js");
      return createViteAdapter();
    }
    default:
      throw new Error(
        `Unsupported bundler: "${bundlerName}". Currently supported: vite.\n` +
          `Webpack and Rollup adapters are planned for a future release.`,
      );
  }
}
