import { readdirSync } from "fs";
import { join } from "path";
import type {
  BundlerAdapter,
  BuildResult,
  BuildWithExternalsOptions,
  ParsedBuildOutput,
} from "./types.js";

function extractAdditionalHeadContent(html: string): string {
  const headMatch = html.match(/<head>([\s\S]*?)<\/head>/);
  if (!headMatch || !headMatch[1]) return "";

  const headContent = headMatch[1];
  const lines: string[] = [];

  const headLines = headContent.split("\n");

  for (const line of headLines) {
    const trimmed = line.trim();

    if (
      trimmed.match(/<script type="module" crossorigin src="\/assets\//) ||
      trimmed.match(/<link rel="stylesheet" crossorigin href="\/assets\//)
    ) {
      continue;
    }

    if (trimmed.length > 0) {
      lines.push(line);
    }
  }

  return lines.length > 0 ? "\n" + lines.join("\n") : "";
}

function extractBodyContent(html: string): string {
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/);
  if (!bodyMatch || !bodyMatch[1]) return "";
  return bodyMatch[1];
}

export function createViteAdapter(): BundlerAdapter {
  return {
    name: "vite",
    configFileNames: ["vite.config"],

    async buildWithExternals(
      options: BuildWithExternalsOptions,
    ): Promise<BuildResult> {
      const { build: viteBuild } = await import("vite");
      type InlineConfig = import("vite").InlineConfig;

      const config: InlineConfig = {
        root: options.rootDir,
        mode: "production",
        build: {
          outDir: options.outDir,
          emptyOutDir: true,
          copyPublicDir: false,
          rollupOptions: {
            external: (id: string) =>
              options.externals.some(
                (dep) => id === dep || id.startsWith(dep + "/"),
              ),
            output: {
              format: "es",
              entryFileNames: "assets/index-[hash].js",
              chunkFileNames: "assets/[name]-[hash].js",
              assetFileNames: "assets/[name]-[hash].[ext]",
            },
          },
        },
        configFile: options.configFile,
      };

      await viteBuild(config);

      // Find the entry file produced by the build
      const assetsDir = join(options.outDir, "assets");
      const jsFiles = readdirSync(assetsDir).filter(
        (f) => f.startsWith("index-") && f.endsWith(".js"),
      );
      if (jsFiles.length === 0) {
        throw new Error("No entry JS file found in build output");
      }

      return { entryFile: `assets/${jsFiles[0]}` };
    },

    parseHtmlOutput(html: string): ParsedBuildOutput {
      const styleMatch = html.match(
        /<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+)">/,
      );

      return {
        stylePath: styleMatch?.[1] || "",
        headContent: extractAdditionalHeadContent(html),
        bodyContent: extractBodyContent(html),
      };
    },
  };
}
