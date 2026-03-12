export interface BuildWithExternalsOptions {
  rootDir: string;
  outDir: string;
  externals: string[];
  configFile: string | false;
}

export interface BuildResult {
  /** Relative path to the entry JS file within outDir, e.g. "assets/index-abc123.js" */
  entryFile: string;
}

export interface ParsedBuildOutput {
  stylePath: string;
  headContent: string;
  bodyContent: string;
}

export interface BundlerAdapter {
  name: string;
  configFileNames: string[];
  buildWithExternals(options: BuildWithExternalsOptions): Promise<BuildResult>;
  parseHtmlOutput(html: string): ParsedBuildOutput;
}
