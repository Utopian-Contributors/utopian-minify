import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { join } from "path";
import type { BundlerAdapter, BuildResult } from "../adapters/types.js";
import { createDualBuild } from "../postprocess.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "postprocess");

function createMockAdapter(overrides: Partial<BundlerAdapter> = {}): BundlerAdapter {
  return {
    name: "mock",
    configFileNames: ["mock.config"],

    async buildWithExternals(options): Promise<BuildResult> {
      // Simulate a mini build: create assets dir with an entry JS file
      const assetsDir = join(options.outDir, "assets");
      mkdirSync(assetsDir, { recursive: true });

      // Write a mini JS file that has external imports
      const entryFile = "index-mini123.js";
      writeFileSync(
        join(assetsDir, entryFile),
        'import React from "react";\nimport "react/jsx-runtime";\nconsole.log("mini");',
      );

      // Write a mini index.html (the tool reads this to clean up)
      writeFileSync(
        join(options.outDir, "index.html"),
        "<html><head></head><body></body></html>",
      );

      return { entryFile: `assets/${entryFile}` };
    },

    parseHtmlOutput(html) {
      const styleMatch = html.match(
        /<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+)">/,
      );
      const headMatch = html.match(/<head>([\s\S]*?)<\/head>/);
      const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/);

      // Strip script and stylesheet tags from head
      let headContent = "";
      if (headMatch?.[1]) {
        headContent = headMatch[1]
          .split("\n")
          .filter((line) => {
            const trimmed = line.trim();
            return (
              trimmed.length > 0 &&
              !trimmed.match(/crossorigin src=/) &&
              !trimmed.match(/crossorigin href=/)
            );
          })
          .join("\n");
      }

      return {
        stylePath: styleMatch?.[1] || "",
        headContent,
        bodyContent: bodyMatch?.[1] || "",
      };
    },

    ...overrides,
  };
}

function setupFixtureProject(opts: {
  dependencies?: Record<string, string>;
  nodeModules?: Record<string, { version: string; peerDependencies?: Record<string, string> }>;
  buildHtml?: string;
  buildJs?: string;
  buildCss?: string;
  entryFileName?: string;
}) {
  const {
    dependencies = { react: "^18.0.0", "react-dom": "^18.0.0" },
    nodeModules = {
      react: { version: "18.3.1" },
      "react-dom": { version: "18.3.1", peerDependencies: { react: "^18.0.0" } },
    },
    buildHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Test App</title>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-def456.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`,
    buildJs = 'console.log("standard build");',
    buildCss = "body { margin: 0; }",
    entryFileName = "index-abc123.js",
  } = opts;

  // Create project root with package.json
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(
    join(FIXTURE_DIR, "package.json"),
    JSON.stringify({ dependencies }),
  );

  // Create node_modules with package.json files
  for (const [name, meta] of Object.entries(nodeModules)) {
    const dir = join(FIXTURE_DIR, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name,
        version: meta.version,
        ...(meta.peerDependencies ? { peerDependencies: meta.peerDependencies } : {}),
      }),
    );
  }

  // Create existing build output
  const distDir = join(FIXTURE_DIR, "dist");
  const assetsDir = join(distDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), buildHtml);
  writeFileSync(join(assetsDir, entryFileName), buildJs);
  writeFileSync(join(assetsDir, "index-def456.css"), buildCss);

  // Create a mock bundler config so findConfigFile works
  writeFileSync(join(FIXTURE_DIR, "mock.config.ts"), "export default {}");
}

describe("createDualBuild", () => {
  beforeEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("produces correct unified HTML with React app", async () => {
    setupFixtureProject({});

    await createDualBuild(
      { root: FIXTURE_DIR, outDir: "dist" },
      createMockAdapter(),
    );

    const outputHtml = readFileSync(
      join(FIXTURE_DIR, "dist", "index.html"),
      "utf-8",
    );
    expect(outputHtml).toMatchSnapshot();
  });

  it("produces correct unified HTML with Vue app (#app mount)", async () => {
    setupFixtureProject({
      buildHtml: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="/favicon.ico" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vue App</title>
    <script type="module" crossorigin src="/assets/index-vue789.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-vuecss.css">
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>`,
      entryFileName: "index-vue789.js",
    });

    await createDualBuild(
      { root: FIXTURE_DIR, outDir: "dist" },
      createMockAdapter(),
    );

    const outputHtml = readFileSync(
      join(FIXTURE_DIR, "dist", "index.html"),
      "utf-8",
    );
    expect(outputHtml).toMatchSnapshot();
  });

  it("generates correct import map with peer dependency pinning", async () => {
    setupFixtureProject({});

    await createDualBuild(
      { root: FIXTURE_DIR, outDir: "dist" },
      createMockAdapter(),
    );

    const outputHtml = readFileSync(
      join(FIXTURE_DIR, "dist", "index.html"),
      "utf-8",
    );

    // Parse the import map from the output
    const importMapMatch = outputHtml.match(
      /<script type="importmap">\s*([\s\S]*?)\s*<\/script>/,
    );
    expect(importMapMatch).not.toBeNull();
    const importMap = JSON.parse(importMapMatch![1]!);

    // react should have no deps param (no peer deps)
    expect(importMap.imports["react"]).toBe("native://esm/react@18.3.1");

    // react/jsx-runtime should also map correctly
    expect(importMap.imports["react/jsx-runtime"]).toBe(
      "native://esm/react@18.3.1/jsx-runtime",
    );
  });

  it("excludes specified dependencies", async () => {
    setupFixtureProject({});

    await createDualBuild(
      { root: FIXTURE_DIR, outDir: "dist", exclude: ["react-dom"] },
      createMockAdapter(),
    );

    const outputHtml = readFileSync(
      join(FIXTURE_DIR, "dist", "index.html"),
      "utf-8",
    );

    const importMapMatch = outputHtml.match(
      /<script type="importmap">\s*([\s\S]*?)\s*<\/script>/,
    );
    const importMap = JSON.parse(importMapMatch![1]!);

    // react-dom should not be in the import map
    expect(importMap.imports["react-dom"]).toBeUndefined();
    // react should still be there
    expect(importMap.imports["react"]).toBeDefined();
  });

  it("cleans up mini build artifacts", async () => {
    setupFixtureProject({});

    await createDualBuild(
      { root: FIXTURE_DIR, outDir: "dist" },
      createMockAdapter(),
    );

    // mini/index.html and mini/assets/ should be cleaned up
    expect(existsSync(join(FIXTURE_DIR, "dist", "mini", "index.html"))).toBe(false);
    expect(existsSync(join(FIXTURE_DIR, "dist", "mini", "assets"))).toBe(false);

    // But mini JS files should exist in dist/mini/
    expect(existsSync(join(FIXTURE_DIR, "dist", "mini"))).toBe(true);
  });

  it("uses correct entry paths from adapter build result", async () => {
    setupFixtureProject({});

    await createDualBuild(
      { root: FIXTURE_DIR, outDir: "dist" },
      createMockAdapter(),
    );

    const outputHtml = readFileSync(
      join(FIXTURE_DIR, "dist", "index.html"),
      "utf-8",
    );

    // Standard build entry should reference the original assets
    expect(outputHtml).toContain('await import("/assets/index-abc123.js")');
    // Mini build entry should reference /mini/ path
    expect(outputHtml).toContain('await import("/mini/index-mini123.js")');
  });

  it("preserves additional head content", async () => {
    setupFixtureProject({
      buildHtml: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta property="og:title" content="My App" />
    <link rel="icon" href="/favicon.ico" />
    <title>My App</title>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-def456.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`,
    });

    await createDualBuild(
      { root: FIXTURE_DIR, outDir: "dist" },
      createMockAdapter(),
    );

    const outputHtml = readFileSync(
      join(FIXTURE_DIR, "dist", "index.html"),
      "utf-8",
    );

    expect(outputHtml).toContain('og:title');
    expect(outputHtml).toContain('favicon.ico');
    expect(outputHtml).toContain('<title>My App</title>');
  });
});
