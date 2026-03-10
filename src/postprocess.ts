import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import type { InlineConfig } from "vite";
import { build as viteBuild } from "vite";
import { gzipSync } from "zlib";
import { init as initLexer, parse as parseImports } from "es-module-lexer";

export interface PostProcessOptions {
  root?: string;
  outDir?: string;
  exclude?: string[];
  verbose?: boolean;
}

function getInstalledVersions(
  rootPath: string,
  depNames: string[],
  verbose: boolean,
): Record<string, string> {
  const versions: Record<string, string> = {};

  for (const depName of depNames) {
    const depPackageJsonPath = resolve(
      rootPath,
      "node_modules",
      depName,
      "package.json",
    );
    if (!existsSync(depPackageJsonPath)) {
      throw new Error(
        `Could not find ${depName} in node_modules. Run your package manager's install command first.`,
      );
    }
    const depPackageJson = JSON.parse(
      readFileSync(depPackageJsonPath, "utf-8"),
    );
    if (!depPackageJson.version) {
      throw new Error(
        `No version field in ${depPackageJsonPath}`,
      );
    }
    versions[depName] = depPackageJson.version;
    if (verbose) {
      console.log(`  ${depName}@${depPackageJson.version}`);
    }
  }

  return versions;
}

/**
 * Gets runtime dependencies from package.json
 */
async function getPackageJsonDependencies(
  rootPath: string,
): Promise<Record<string, string>> {
  const dependencies: Record<string, string> = {};

  try {
    const packageJsonPath = resolve(rootPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

      if (packageJson.dependencies) {
        Object.assign(dependencies, packageJson.dependencies);
      }
    }
  } catch (error) {
    console.warn("Warning: Could not read package.json:", error);
  }

  return dependencies;
}

/**
 * Scans JS files for bare import specifiers that match externalized dependencies.
 * Uses es-module-lexer for accurate parsing of minified ES module output.
 * Returns all unique specifiers found (e.g. "react", "react/jsx-runtime").
 */
async function collectExternalImports(
  jsDir: string,
  dependencies: string[],
): Promise<Set<string>> {
  const specifiers = new Set<string>();
  if (!existsSync(jsDir)) return specifiers;

  await initLexer;

  const files = readdirSync(jsDir).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    const content = readFileSync(join(jsDir, file), "utf-8");
    const [imports] = parseImports(content);

    for (const imp of imports) {
      const specifier = imp.n;
      if (!specifier) continue;
      for (const dep of dependencies) {
        if (specifier === dep || specifier.startsWith(dep + "/")) {
          specifiers.add(specifier);
          break;
        }
      }
    }
  }

  return specifiers;
}

/**
 * Maps a bare specifier to its package name (handling scoped packages).
 */
function specifierToPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split("/")[0] || specifier;
}

/**
 * Generates an import map with native://esm/ URLs for all import specifiers.
 *
 * Uses ?deps= to pin peerDependency versions on esm.sh. Unlike ?external=
 * (which emits bare specifiers requiring import map resolution inside CDN
 * modules — broken with native:// protocol), ?deps= makes esm.sh resolve
 * dependencies internally via absolute URLs like /react@18.3.1/es2022/react.mjs.
 * All CDN modules pinned to the same version share the same absolute URL,
 * ensuring a single module instance without relying on the import map.
 */
function generateImportMap(
  rootPath: string,
  specifiers: Set<string>,
  installedVersions: Record<string, string>,
  verbose: boolean,
): Record<string, string> {
  const importMap: Record<string, string> = {};
  // Cache ?deps= params per package: pins peerDependencies to exact versions
  const depsParamCache: Record<string, string> = {};

  for (const specifier of specifiers) {
    const packageName = specifierToPackageName(specifier);
    const version = installedVersions[packageName];
    if (!version) {
      console.warn(
        `Warning: No version found for ${packageName}, skipping ${specifier}`,
      );
      continue;
    }

    if (!(packageName in depsParamCache)) {
      const depPkgJsonPath = resolve(rootPath, "node_modules", packageName, "package.json");
      let depsParam = "";
      if (existsSync(depPkgJsonPath)) {
        const depPkgJson = JSON.parse(readFileSync(depPkgJsonPath, "utf-8"));
        const peerDeps = Object.keys(depPkgJson.peerDependencies || {});
        const pinnedPeers = peerDeps
          .filter((d) => d in installedVersions)
          .map((d) => `${d}@${installedVersions[d]}`);
        if (pinnedPeers.length > 0) {
          depsParam = `?deps=${pinnedPeers.join(",")}`;
        }
      }
      depsParamCache[packageName] = depsParam;
    }

    const depsParam = depsParamCache[packageName];
    const subpath = specifier === packageName ? "" : specifier.slice(packageName.length);
    importMap[specifier] = `native://esm/${packageName}@${version}${subpath}${depsParam}`;

    if (verbose) {
      console.log(`  ${specifier} -> ${importMap[specifier]}`);
    }
  }

  return importMap;
}

export async function createDualBuild(options: PostProcessOptions = {}) {
  const {
    root = process.cwd(),
    outDir = "dist",
    exclude = [],
    verbose = false,
  } = options;

  const rootDir = resolve(root);
  const outputDir = resolve(rootDir, outDir);
  const miniDir = resolve(outputDir, "mini");

  try {
    // Get package.json dependencies (runtime only)
    const packageJsonDeps = await getPackageJsonDependencies(rootDir);
    const allDeps = Object.keys(packageJsonDeps);

    // Filter out excluded packages
    const depsToExternalize = allDeps.filter((dep) => !exclude.includes(dep));

    if (depsToExternalize.length === 0) {
      console.log("vite-utopian: No dependencies to externalize");
      return;
    }

    // Read exact versions from node_modules
    if (verbose) console.log("Dependencies:");
    const installedVersions = getInstalledVersions(
      rootDir,
      depsToExternalize,
      verbose,
    );

    console.log(
      `vite-utopian: Externalizing ${depsToExternalize.length} dependencies`,
    );

    // Check if build exists
    if (!existsSync(outputDir)) {
      console.error("Error: No build found at", outputDir);
      console.error("  Please run 'vite build' first before post-processing");
      return;
    }

    // Read existing build files
    const standardIndexPath = join(outputDir, "index.html");
    let standardHtml = "";
    let standardScriptPath = "";
    let standardStylePath = "";

    if (existsSync(standardIndexPath)) {
      standardHtml = readFileSync(standardIndexPath, "utf-8");

      const scriptMatch = standardHtml.match(
        /<script type="module" crossorigin src="(\/assets\/[^"]+)">/,
      );
      const styleMatch = standardHtml.match(
        /<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+)">/,
      );

      standardScriptPath = scriptMatch?.[1] || "";
      standardStylePath = styleMatch?.[1] || "";

      if (verbose && standardScriptPath) {
        const standardScriptFullPath = join(outputDir, standardScriptPath);
        if (existsSync(standardScriptFullPath)) {
          const content = readFileSync(standardScriptFullPath);
          const gzipped = gzipSync(content);
          console.log(`Standard build script: ${standardScriptPath} (${gzipped.length} bytes gzipped)`);
        }
      }
    } else {
      console.error("Error: No index.html found in build directory");
      return;
    }

    // Setup for mini build
    const viteConfigPath = resolve(rootDir, "vite.config.ts");
    const configFileExists = existsSync(viteConfigPath);

    // Run mini build with externalized dependencies
    if (verbose) {
      console.log("Building mini version with externalized dependencies...");
      console.log("Dependencies to externalize:", depsToExternalize);
    }

    const miniBuildConfig: InlineConfig = {
      root: rootDir,
      mode: "production",
      build: {
        outDir: miniDir,
        emptyOutDir: true,
        copyPublicDir: false,
        rollupOptions: {
          external: (id: string) => {
            return depsToExternalize.some((dep) => {
              if (id === dep) return true;
              if (id.startsWith(dep + "/")) return true;
              return false;
            });
          },
          output: {
            format: "es",
            entryFileNames: "assets/index-[hash].js",
            chunkFileNames: "assets/[name]-[hash].js",
            assetFileNames: "assets/[name]-[hash].[ext]",
          },
        },
      },
      configFile: configFileExists ? viteConfigPath : false,
    };

    await viteBuild(miniBuildConfig);
    if (verbose) console.log("Mini build completed");

    // Scan mini build output for actual external import specifiers
    const miniAssetsDir = join(miniDir, "assets");
    const externalSpecifiers = await collectExternalImports(
      miniAssetsDir,
      depsToExternalize,
    );
    if (verbose) {
      console.log(`Found ${externalSpecifiers.size} external import specifiers`);
    }

    // With ?deps=, CDN modules resolve dependencies internally via absolute URLs,
    // so only specifiers from the build output need import map entries.
    // Adding unused deps could create duplicate modules (e.g. react-router loaded
    // both via import map AND internally by react-router-dom from CDN).

    // Generate import map for externalized specifiers
    const importMap = generateImportMap(
      rootDir,
      externalSpecifiers,
      installedVersions,
      verbose,
    );

    // Get mini build file paths
    let miniScriptPath = "";

    const miniIndexPath = join(miniDir, "index.html");

    if (existsSync(miniIndexPath)) {
      const miniHtml = readFileSync(miniIndexPath, "utf-8");

      const miniScriptMatch = miniHtml.match(
        /<script type="module" crossorigin src="(\/[^"]+)">/,
      );

      if (miniScriptMatch?.[1]) {
        miniScriptPath = miniScriptMatch[1].replace("/assets/", "/mini/");
      } else {
        throw new Error("Could not find script path in mini build index.html");
      }
    }

    // Move mini assets to dist/mini and rename with file size
    const targetMiniDir = join(outputDir, "mini");

    if (existsSync(miniAssetsDir)) {
      const assetFiles = readdirSync(miniAssetsDir);

      mkdirSync(targetMiniDir, { recursive: true });

      // Move only JavaScript files (CSS is the same as standard build)
      const jsFiles = assetFiles.filter((file) => file.endsWith(".js"));
      if (verbose) console.log(`Moving ${jsFiles.length} JavaScript files`);

      jsFiles.forEach((file) => {
        const sourcePath = join(miniAssetsDir, file);
        const targetPath = join(targetMiniDir, file);
        cpSync(sourcePath, targetPath);
      });

      if (verbose) {
        // Log gzip size of entry without renaming
        const entryFileName = miniScriptPath.split("/").pop() || "";
        const entryPath = join(targetMiniDir, entryFileName);
        if (existsSync(entryPath)) {
          const content = readFileSync(entryPath);
          const gzipped = gzipSync(content);
          console.log(`Mini build script: ${miniScriptPath} (${gzipped.length} bytes gzipped)`);
        }
      }
    }

    // Extract additional head content and body from the original HTML
    const additionalHeadContent = extractAdditionalHeadContent(standardHtml);
    const bodyContent = extractBodyContent(standardHtml);

    // Create the unified index.html with conditional loading
    const unifiedHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    ${additionalHeadContent}

    <script type="importmap">
      ${JSON.stringify({ imports: importMap }, null, 6)}
    </script>

    <script type="module">
      if (window.NATIVE_SCHEME_SUPPORT) {
        await import("${miniScriptPath}");
      } else {
        await import("${standardScriptPath}");
      }
    </script>
    <link rel="stylesheet" crossorigin href="${standardStylePath}" />
  </head>
  <body>${bodyContent}</body>
</html>`;

    writeFileSync(standardIndexPath, unifiedHtml);

    // Clean up the mini build's separate files
    if (existsSync(miniIndexPath)) {
      rmSync(miniIndexPath);
    }
    if (existsSync(miniAssetsDir)) {
      rmSync(miniAssetsDir, { recursive: true });
    }

    console.log("vite-utopian: Post-processing complete");
  } catch (error) {
    console.error("Error during post-processing:", error);
    throw error;
  }
}


/**
 * Extracts additional scripts and meta tags from the head that should be preserved
 */
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

  const bodyContent = bodyMatch[1];
  return bodyContent;
}

// Allow running as a CLI script
if (import.meta.url === `file://${process.argv[1]}`) {
  createDualBuild().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
