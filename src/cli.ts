#!/usr/bin/env node

import { createDualBuild } from './postprocess.js';

interface CLIOptions {
  root?: string;
  outDir?: string;
  cdnMappingsPath?: string;
  exclude?: string[];
}

// Parse command line arguments
const args = process.argv.slice(2);
const options: CLIOptions = {};

for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.replace('--', '');
  const value = args[i + 1];
  
  if (key === 'exclude' && value) {
    options.exclude = value.split(',');
  } else if (key === 'root' && value) {
    options.root = value;
  } else if (key === 'outDir' && value) {
    options.outDir = value;
  }
}

// Default to current working directory as root (where the command is run)
if (!options.root) {
  options.root = process.cwd();
}

console.log('🚀 Running sustainable post-processing with options:', options);

createDualBuild(options)
  .then(() => {
    console.log('✅ Post-processing complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Post-processing failed:', error);
    process.exit(1);
  });
