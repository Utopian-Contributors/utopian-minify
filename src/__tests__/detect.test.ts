import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { detectBundler, loadAdapter } from "../adapters/detect.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "detect");

describe("detectBundler", () => {
  beforeEach(() => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("detects vite from vite.config.ts", () => {
    writeFileSync(join(FIXTURE_DIR, "vite.config.ts"), "export default {}");
    expect(detectBundler(FIXTURE_DIR)).toBe("vite");
  });

  it("detects vite from vite.config.js", () => {
    writeFileSync(join(FIXTURE_DIR, "vite.config.js"), "export default {}");
    expect(detectBundler(FIXTURE_DIR)).toBe("vite");
  });

  it("detects vite from vite.config.mts", () => {
    writeFileSync(join(FIXTURE_DIR, "vite.config.mts"), "export default {}");
    expect(detectBundler(FIXTURE_DIR)).toBe("vite");
  });

  it("detects webpack from webpack.config.js", () => {
    writeFileSync(join(FIXTURE_DIR, "webpack.config.js"), "module.exports = {}");
    expect(detectBundler(FIXTURE_DIR)).toBe("webpack");
  });

  it("detects rollup from rollup.config.mjs", () => {
    writeFileSync(join(FIXTURE_DIR, "rollup.config.mjs"), "export default {}");
    expect(detectBundler(FIXTURE_DIR)).toBe("rollup");
  });

  it("prefers vite over webpack when both exist", () => {
    writeFileSync(join(FIXTURE_DIR, "vite.config.ts"), "export default {}");
    writeFileSync(join(FIXTURE_DIR, "webpack.config.js"), "module.exports = {}");
    expect(detectBundler(FIXTURE_DIR)).toBe("vite");
  });

  it("throws when no config file found", () => {
    expect(() => detectBundler(FIXTURE_DIR)).toThrow("Could not detect bundler");
  });
});

describe("loadAdapter", () => {
  it("loads vite adapter", async () => {
    const adapter = await loadAdapter("vite");
    expect(adapter.name).toBe("vite");
    expect(adapter.configFileNames).toContain("vite.config");
  });

  it("throws for unsupported bundler", async () => {
    await expect(loadAdapter("parcel")).rejects.toThrow('Unsupported bundler: "parcel"');
  });
});
