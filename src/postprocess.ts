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
import semver from "semver";
import type { InlineConfig } from "vite";
import { build as viteBuild } from "vite";
import availableExports from "./cdn-exports.json" with { type: "json" };
import cdnMappings from "./cdn-mappings.json" with { type: "json" };

interface PeerDependencies {
  [packageName: string]: string;
}

interface AnalyzedDependency {
  name: string;
  version: string;
  url: string;
  peerContext?: { [peerName: string]: string };
  peerDependencies?: PeerDependencies;
}

interface StandaloneSubpath {
  name: string;
  fromVersion: string;
}

interface AvailableExports {
  availableVersions: { [packageName: string]: string[] }; // Array of available versions
  packages: AnalyzedDependency[]; // Array of available versions
  standaloneSubpaths?: { [packageName: string]: StandaloneSubpath[] };
}

export interface PostProcessOptions {
  root?: string;
  outDir?: string;
  exclude?: string[];
}

async function getAllLockDependencies(
  rootPath: string,
): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};

  try {
    // Try yarn.lock first
    const yarnLockPath = resolve(rootPath, "yarn.lock");
    if (existsSync(yarnLockPath)) {
      const yarnLock = readFileSync(yarnLockPath, "utf-8");

      // Parse yarn.lock format
      const lines = yarnLock.split("\n");
      let currentPackage = "";

      for (const line of lines) {
        // Match package declaration like: "package@version": or "@scope/package@version":
        // Need to handle scoped packages which start with @
        const packageMatch = line.match(/^"?(@?[^@\s]+)@[^"]*"?:$/);
        if (packageMatch && packageMatch[1]) {
          currentPackage = packageMatch[1];
          continue;
        }

        // Match version field
        if (currentPackage && line.trim().startsWith("version")) {
          const versionMatch = line.match(/version\s+"([^"]+)"/);
          if (versionMatch && versionMatch[1]) {
            versions[currentPackage] = versionMatch[1];
            currentPackage = "";
          }
        }
      }
      return versions;
    }

    // Try package-lock.json
    const packageLockPath = resolve(rootPath, "package-lock.json");
    if (existsSync(packageLockPath)) {
      const packageLock = JSON.parse(readFileSync(packageLockPath, "utf-8"));

      if (packageLock.packages) {
        // npm v7+ format - get ALL packages, not just top-level
        Object.keys(packageLock.packages).forEach((path) => {
          if (path.startsWith("node_modules/")) {
            const parts = path.replace("node_modules/", "").split("/");
            // Handle scoped packages like @scope/package
            let packageName: string;
            if (parts[0]?.startsWith("@") && parts[1]) {
              packageName = `${parts[0]}/${parts[1]}`;
            } else {
              packageName = parts[0] || "";
            }
            if (packageName) {
              const packageData = packageLock.packages[path];
              if (packageData.version && !versions[packageName]) {
                versions[packageName] = packageData.version;
              }
            }
          }
        });
      } else if (packageLock.dependencies) {
        // npm v6 format - recursively get all dependencies
        const extractDeps = (deps: any) => {
          Object.keys(deps).forEach((packageName) => {
            const dep = deps[packageName];
            if (dep.version) {
              versions[packageName] = dep.version;
            }
            if (dep.dependencies) {
              extractDeps(dep.dependencies);
            }
          });
        };
        extractDeps(packageLock.dependencies);
      }
    }
  } catch (error) {
    console.warn("⚠️ Could not read lock file for exact versions:", error);
  }

  return versions;
}

/**
 * Gets package.json dependencies with their version ranges
 */
async function getPackageJsonDependencies(
  rootPath: string,
): Promise<Record<string, string>> {
  const dependencies: Record<string, string> = {};

  try {
    const packageJsonPath = resolve(rootPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      
      // Combine dependencies and devDependencies
      if (packageJson.dependencies) {
        Object.assign(dependencies, packageJson.dependencies);
      }
      if (packageJson.devDependencies) {
        Object.assign(dependencies, packageJson.devDependencies);
      }
    }
  } catch (error) {
    console.warn("⚠️ Could not read package.json:", error);
  }

  return dependencies;
}

/**
 * Finds the best matching version from available versions using semver
 * Priority 1: Exact match with lock file version
 * Priority 2: Highest version that satisfies package.json semver range
 * Otherwise: Throws an error
 */
function findClosestVersion(
  lockVersion: string,
  packageJsonRange: string | undefined,
  availableVersions: string[],
  packageName: string,
): string {
  if (availableVersions.length === 0) {
    throw new Error(
      `No versions available for ${packageName} in manifest`
    );
  }

  // Priority 1: Check for exact match with lock file version
  if (availableVersions.includes(lockVersion)) {
    return lockVersion;
  }

  // Priority 2: If package.json range is available, find a compatible version
  if (packageJsonRange) {
    // Filter and sort available versions in descending order
    const validVersions = availableVersions
      .filter((v) => semver.valid(v))
      .sort((a, b) => semver.rcompare(a, b)); // highest first

    // Find the highest version that satisfies the package.json range
    for (const version of validVersions) {
      if (semver.satisfies(version, packageJsonRange)) {
        return version;
      }
    }
  }

  // No compatible version found - throw error
  throw new Error(
    `No compatible version found for ${packageName}. Lock file has ${lockVersion}, package.json specifies ${packageJsonRange || "N/A"}, but available versions are: ${availableVersions.join(", ")}`
  );
}

/**
 * Maps lock file versions to the closest available versions from the manifest
 */
function mapToAvailableVersions(
  lockDependencies: Record<string, string>,
  packageJsonDependencies: Record<string, string>,
  availableExports: AvailableExports,
): Record<string, string> {
  const mappedVersions: Record<string, string> = {};

  Object.keys(lockDependencies).forEach((packageName) => {
    const lockVersion = lockDependencies[packageName];
    if (!lockVersion) return;

    const availableVersions = availableExports.availableVersions[packageName];

    if (!availableVersions || availableVersions.length === 0) {
      throw new Error(
        `⚠️ ${packageName}: Not available in the manifest. Please exclude it manually from being processed.`,
      );
    }

    try {
      const packageJsonRange = packageJsonDependencies[packageName];
      const closestVersion = findClosestVersion(
        lockVersion,
        packageJsonRange,
        availableVersions,
        packageName,
      );
      
      mappedVersions[packageName] = closestVersion;
      
      if (closestVersion === lockVersion) {
        console.log(`  ✓ ${packageName}: ${lockVersion} (exact match)`);
      } else {
        console.log(
          `  📦 ${packageName}: ${lockVersion} → ${closestVersion} (satisfies ${packageJsonRange || "lock version"})`,
        );
      }
    } catch (error) {
      // Re-throw with package name for context
      throw error;
    }
  });

  return mappedVersions;
}

export async function createDualBuild(options: PostProcessOptions = {}) {
  const { root = process.cwd(), outDir = "dist", exclude = [] } = options;

  const rootDir = resolve(root);
  const outputDir = resolve(rootDir, outDir);
  const miniDir = resolve(outputDir, "mini");

  console.log("🚀 Starting sustainable post-processing...");

  try {
    console.log(
      `📋 CDN mappings available for ${Object.keys(cdnMappings).length} packages`,
    );

    // Get all dependencies from lock file
    const allLockDependencies = await getAllLockDependencies(rootDir);

    console.log(
      `📦 Found ${Object.keys(allLockDependencies).length} dependencies in lock file`,
    );

    // Get package.json dependencies for semver range comparison
    const packageJsonDeps = await getPackageJsonDependencies(rootDir);

    // Filter dependencies to externalize based on CDN mappings and package.json presence
    const depsToExternalize = Object.keys(cdnMappings).filter(
      (dep) => allLockDependencies[dep] && !exclude.includes(dep) && packageJsonDeps[dep],
    );

    console.log(
      `🎯 Found ${depsToExternalize.length} dependencies that match CDN mappings`,
    );

    if (depsToExternalize.length === 0) {
      console.log("ℹ️ No dependencies to externalize");
      return;
    }

    // Get lock file versions for dependencies to externalize
    const depsWithVersions: Record<string, string> = {};
    depsToExternalize.forEach((dep) => {
      const version = allLockDependencies[dep];
      if (version) {
        depsWithVersions[dep] = version;
      }
    });

    // Map to available versions from manifest
    console.log("🔍 Mapping to available versions from browser extension...");
    const availableVersions = mapToAvailableVersions(
      depsWithVersions,
      packageJsonDeps,
      availableExports as AvailableExports,
    );

    console.log(
      `✅ Successfully mapped ${Object.keys(availableVersions).length} dependencies to available versions`,
    );

    if (depsToExternalize.length === 0) {
      console.log("ℹ️ No dependencies to externalize");
      return;
    }

    // Find matching package entries with peer dependencies
    console.log("🔗 Resolving peer dependencies...");
    const packageEntries: Record<string, AnalyzedDependency> = {};

    depsToExternalize.forEach((dep) => {
      const version = availableVersions[dep];
      if (!version) return;

      // Find all package entries that match name and version
      const matchingPackages = (
        availableExports as AvailableExports
      ).packages.filter((pkg) => pkg.name === dep && pkg.version === version);

      if (matchingPackages.length > 0) {
        // If there are multiple matches, prefer the one whose peerContext matches our available versions
        let selectedPackage = matchingPackages[0];

        if (matchingPackages.length > 1) {
          // Look for a package whose peerContext matches our resolved versions
          const matchingPeerPackage = matchingPackages.find((pkg) => {
            if (!pkg.peerContext) return false;

            // Check if all peer dependencies match our available versions
            return Object.entries(pkg.peerContext).every(
              ([peerName, peerVersion]) => {
                return availableVersions[peerName] === peerVersion;
              },
            );
          });

          if (matchingPeerPackage) {
            selectedPackage = matchingPeerPackage;
            console.log(
              `  🎯 ${dep}@${version} matched with peer context:`,
              Object.entries(matchingPeerPackage.peerContext || {})
                .map(([k, v]) => `${k}@${v}`)
                .join(", "),
            );
          } else {
            // If no exact match, just use the first one
            selectedPackage = matchingPackages[0];
            if (selectedPackage?.peerContext) {
              throw new Error(
                `  ⚠️  ${dep}@${version} has peer dependencies but no exact match found: ${Object.keys(selectedPackage.peerContext).join(", ")}`,
              );
            }
          }
        } else if (selectedPackage?.peerContext) {
          console.log(
            `  🔗 ${dep}@${version} has peer dependencies:`,
            Object.keys(selectedPackage.peerContext).join(", "),
          );
        } else {
          console.log(`  ✓ ${dep}@${version} (no peer dependencies)`);
        }

        if (selectedPackage) {
          packageEntries[dep] = selectedPackage;
        }
      }
    });

    // Generate import map using URLs from package entries
    const importMap: Record<string, string> = {};
    depsToExternalize.forEach((dep) => {
      const packageEntry = packageEntries[dep];
      if (packageEntry?.url) {
        // Use the URL from the package entry which includes peer dependencies
        importMap[dep] = packageEntry.url;
      } else {
        throw new Error("No package entry found for " + dep);
      }
    });

    // Add standalone subpaths to import map
    console.log("🔗 Adding standalone subpaths to import map...");
    const standaloneSubpaths = (availableExports as AvailableExports).standaloneSubpaths || {};
    
    depsToExternalize.forEach((dep) => {
      const version = availableVersions[dep];
      if (!version) return;

      const subpaths = standaloneSubpaths[dep];
      if (subpaths && subpaths.length > 0) {
        subpaths.forEach((subpath) => {
          // Check if the version satisfies the fromVersion requirement
          if (semver.satisfies(version, subpath.fromVersion)) {
            const subpathName = `${dep}/${subpath.name}`;
            
            // Find the package entry for this subpath in availableExports.packages
            const subpathPackage = (availableExports as AvailableExports).packages.find(
              (pkg) => pkg.name === subpathName && pkg.version === version
            );
            
            if (subpathPackage) {
              importMap[subpathName] = subpathPackage.url;
              console.log(`  ✓ Added subpath: ${subpathName}@${version}`);
            } else {
              console.warn(`  ⚠️  Subpath package not found: ${subpathName}@${version}`);
            }
          }
        });
      }
    });

    console.log("📦 Generated import map:", importMap);

    // Check if build exists
    if (!existsSync(outputDir)) {
      console.error("❌ No build found at", outputDir);
      console.error("   Please run 'vite build' first before post-processing");
      return;
    }

    // Read existing build files
    const standardIndexPath = join(outputDir, "index.html");
    let standardHtml = "";
    let standardScriptPath = "";
    let standardStylePath = "";

    if (existsSync(standardIndexPath)) {
      standardHtml = readFileSync(standardIndexPath, "utf-8");

      // Extract script and style paths
      const scriptMatch = standardHtml.match(
        /<script type="module" crossorigin src="(\/assets\/[^"]+)">/,
      );
      const styleMatch = standardHtml.match(
        /<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+)">/,
      );

      standardScriptPath = scriptMatch?.[1] || "";
      standardStylePath = styleMatch?.[1] || "";
    } else {
      console.error("❌ No index.html found in build directory");
      return;
    }

    // Setup for mini build
    const viteConfigPath = resolve(rootDir, "vite.config.ts");
    const configFileExists = existsSync(viteConfigPath);

    // Run mini build with externalized dependencies
    console.log("🔨 Building mini version with externalized dependencies...");
    console.log("🔍 Dependencies to externalize:", depsToExternalize);

    const miniBuildConfig: InlineConfig = {
      root: rootDir,
      mode: "production",
      build: {
        outDir: miniDir,
        emptyOutDir: true,
        copyPublicDir: false,
        rollupOptions: {
          external: (id: string) => {
            // Check if the import ID matches any of our externalized dependencies
            // This handles both regular imports and scoped packages
            return depsToExternalize.some(dep => {
              // Exact match
              if (id === dep) return true;
              // Handle subpath imports like "@emotion/is-prop-valid/lib/index.js"
              if (id.startsWith(dep + '/')) return true;
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
    console.log("✅ Mini build completed");

    // Get mini build file paths
    let miniScriptPath = "";

    const miniIndexPath = join(miniDir, "index.html");
    console.log(`🔍 Looking for mini index.html at: ${miniIndexPath}`);

    if (existsSync(miniIndexPath)) {
      const miniHtml = readFileSync(miniIndexPath, "utf-8");
      console.log(`📄 Mini index.html found, length: ${miniHtml.length} chars`);

      // Extract script and style paths from mini build
      const miniScriptMatch = miniHtml.match(
        /<script type="module" crossorigin src="(\/[^"]+)">/,
      );

      if (miniScriptMatch?.[1]) {
        // Convert to relative path from mini directory
        miniScriptPath = miniScriptMatch[1].replace("/assets/", "/mini/");
        console.log(`📄 Found mini script path: ${miniScriptPath}`);
      } else {
        console.error("❌ Could not find script path in mini build index.html");
        console.error("Mini HTML content:", miniHtml.substring(0, 500) + "...");
        throw new Error("Could not find script path in mini build index.html");
      }
    }

    // Move mini assets to dist/mini
    const miniAssetsDir = join(miniDir, "assets");
    const targetMiniDir = join(outputDir, "mini");

    console.log(`🔍 Looking for mini assets at: ${miniAssetsDir}`);

    if (existsSync(miniAssetsDir)) {
      const assetFiles = readdirSync(miniAssetsDir);
      console.log(`📦 Found ${assetFiles.length} asset files in mini build`);

      mkdirSync(targetMiniDir, { recursive: true });

      // Move only JavaScript files (CSS is the same as standard build)
      const jsFiles = assetFiles.filter(file => file.endsWith('.js'));
      console.log(`📦 Moving ${jsFiles.length} JavaScript files (CSS uses standard build)`);
      
      jsFiles.forEach((file) => {
        console.log(`  📄 Moving: ${file}`);
        cpSync(join(miniAssetsDir, file), join(targetMiniDir, file));
      });
    } else {
      console.warn(`⚠️  No assets directory found at: ${miniAssetsDir}`);
    }

    // Extract additional head content (analytics scripts, etc.) from the original HTML
    const additionalHeadContent = extractAdditionalHeadContent(standardHtml);

    // Create the unified index.html with conditional loading
    const unifiedHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/logo.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${getTitle(standardHtml)}</title>${additionalHeadContent}

    <script type="importmap">
      {
        "imports": ${JSON.stringify(importMap, null, 10)}
      }
    </script>

    <script type="module">
      await Promise.resolve(
        setTimeout(async () => {
          if (window.__SUSTAINABLE_BUILD__) {
            await import("${miniScriptPath}");
          } else {
            await import("${standardScriptPath}");
          }
        }, 10)
      );
    </script>
    <link rel="stylesheet" crossorigin href="${standardStylePath}" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

    // Write the unified HTML
    writeFileSync(standardIndexPath, unifiedHtml);
    console.log("📝 Updated index.html with conditional loading");

    // Clean up the mini build's separate files
    if (existsSync(miniIndexPath)) {
      rmSync(miniIndexPath);
    }
    if (existsSync(miniAssetsDir)) {
      rmSync(miniAssetsDir, { recursive: true });
    }

    console.log(`
🎉 Sustainable post-processing complete!
   
   Build structure:
   ${outputDir}/
   ├── index.html (updated with conditional loading)
   ├── index.original.html (backup of original)
   ├── assets/ (standard build)
   └── mini/ (externalized dependencies)
   
   The build will use:
   - Standard build when window.__SUSTAINABLE_BUILD__ is true
   - Mini build (with CDN dependencies) otherwise
`);
  } catch (error) {
    console.error("❌ Error during post-processing:", error);
    throw error;
  }
}

function getTitle(html: string): string {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  return titleMatch?.[1] || "Vite App";
}

/**
 * Extracts additional scripts and meta tags from the head that should be preserved
 * Excludes the build's module script and stylesheet links
 */
function extractAdditionalHeadContent(html: string): string {
  const headMatch = html.match(/<head>([\s\S]*?)<\/head>/);
  if (!headMatch || !headMatch[1]) return "";

  const headContent = headMatch[1];
  const lines: string[] = [];

  // Split by lines and filter out what we'll be replacing
  const headLines = headContent.split("\n");
  
  for (const line of headLines) {
    const trimmed = line.trim();
    
    // Skip if it's a charset, viewport, title, or the build's assets
    if (
      trimmed.startsWith("<meta charset") ||
      trimmed.startsWith('<meta name="viewport"') ||
      trimmed.startsWith("<title>") ||
      trimmed.startsWith('<link rel="icon"') ||
      trimmed.match(/<script type="module" crossorigin src="\/assets\//) ||
      trimmed.match(/<link rel="stylesheet" crossorigin href="\/assets\//)
    ) {
      continue;
    }
    
    // Keep everything else (analytics scripts, other meta tags, etc.)
    if (trimmed.length > 0) {
      lines.push(line);
    }
  }

  return lines.length > 0 ? "\n" + lines.join("\n") : "";
}

// Allow running as a CLI script
if (import.meta.url === `file://${process.argv[1]}`) {
  createDualBuild().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
