#!/usr/bin/env node

import { createDualBuild } from './postprocess.js';
import { detectBundler, loadAdapter } from './adapters/detect.js';

interface CLIOptions {
  root?: string;
  outDir?: string;
  exclude?: string[];
  verbose?: boolean;
  bundler?: string;
}

// Parse command line arguments
const args = process.argv.slice(2);
const options: CLIOptions = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--verbose') {
    options.verbose = true;
    continue;
  }

  const key = arg?.replace('--', '');
  const value = args[i + 1];

  if (key === 'exclude' && value) {
    options.exclude = value.split(',');
    i++;
  } else if (key === 'root' && value) {
    options.root = value;
    i++;
  } else if (key === 'outDir' && value) {
    options.outDir = value;
    i++;
  } else if (key === 'bundler' && value) {
    options.bundler = value;
    i++;
  }
}

// Default to current working directory as root (where the command is run)
if (!options.root) {
  options.root = process.cwd();
}

const bundlerName = options.bundler || detectBundler(options.root);
const adapter = await loadAdapter(bundlerName);

createDualBuild(options, adapter)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Post-processing failed:', error);
    process.exit(1);
  });
