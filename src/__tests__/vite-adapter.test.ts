import { describe, it, expect } from "vitest";
import { createViteAdapter } from "../adapters/vite.js";

const adapter = createViteAdapter();

describe("vite adapter parseHtmlOutput", () => {
  it("extracts stylesheet path from vite react build", () => {
    const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + React</title>
    <script type="module" crossorigin src="/assets/index-Bf2ZN4aE.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-DPfhLfgY.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

    const result = adapter.parseHtmlOutput(html);
    expect(result).toMatchSnapshot();
  });

  it("extracts stylesheet path from vite vue build", () => {
    const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="/favicon.ico" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite App</title>
    <script type="module" crossorigin src="/assets/index-BqR1h3k9.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-CvK8x2wL.css">
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>`;

    const result = adapter.parseHtmlOutput(html);
    expect(result).toMatchSnapshot();
  });

  it("handles build with no stylesheet", () => {
    const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Vite App</title>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
  </head>
  <body></body>
</html>`;

    const result = adapter.parseHtmlOutput(html);
    expect(result.stylePath).toBe("");
    expect(result.bodyContent).toBe("");
  });

  it("preserves head content excluding script and stylesheet tags", () => {
    const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
    <meta name="description" content="A cool app" />
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-def456.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

    const result = adapter.parseHtmlOutput(html);
    expect(result.headContent).toContain('<meta charset="UTF-8" />');
    expect(result.headContent).toContain('<title>My App</title>');
    expect(result.headContent).toContain('content="A cool app"');
    expect(result.headContent).not.toContain("crossorigin src=");
    expect(result.headContent).not.toContain("crossorigin href=");
  });

  it("preserves body content with mount point", () => {
    const html = `<!DOCTYPE html>
<html lang="en">
  <head><title>App</title></head>
  <body>
    <div id="root"></div>
    <noscript>You need JavaScript</noscript>
  </body>
</html>`;

    const result = adapter.parseHtmlOutput(html);
    expect(result.bodyContent).toContain('<div id="root"></div>');
    expect(result.bodyContent).toContain("<noscript>");
  });
});
