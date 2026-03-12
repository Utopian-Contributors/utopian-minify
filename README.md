# utopian-minify

A post-processing tool that creates dual builds with import maps for cross-origin dependency caching. It runs after your bundler's build, creates a second "mini" build with dependencies externalized to a CDN via import maps, and rewrites `index.html` to conditionally load the mini build when the [Sustainable Browser Extension](https://chromewebstore.google.com/detail/sustainable-browser/cdpbgdconlejjfnpifkpalpcfohmiolf) is installed.

## Installation

```bash
npm install -D utopian-minify
```

## Usage

Add to your `package.json` scripts:

```json
{
  "scripts": {
    "build": "vite build",
    "postbuild": "utopian-minify"
  }
}
```

The bundler is auto-detected from your config file (`vite.config.ts`, `webpack.config.js`, `rollup.config.mjs`, etc.).

### CLI Options

```bash
utopian-minify --bundler vite        # explicit bundler override
utopian-minify --outDir dist         # custom output directory
utopian-minify --exclude lodash,dayjs  # exclude packages from externalization
utopian-minify --verbose             # detailed logging
```

| Option | Default | Description |
|--------|---------|-------------|
| `--bundler` | auto-detect | Bundler to use (`vite`, more coming) |
| `--root` | `cwd` | Project root directory |
| `--outDir` | `dist` | Build output directory |
| `--exclude` | none | Comma-separated packages to keep bundled |
| `--verbose` | off | Print detailed build info |

## How It Works

1. Reads your `package.json` dependencies and their exact installed versions from `node_modules`
2. Runs a second build with all dependencies marked as external
3. Scans the mini build output with [es-module-lexer](https://github.com/nicolo-ribaudo/es-module-lexer) to find the actual import specifiers used
4. Generates an import map mapping each specifier to a `native://esm/{pkg}@{version}` URL
5. Rewrites `index.html` with the import map and conditional loading:

```html
<script type="importmap">
  { "imports": { "react": "native://esm/react@18.3.1" } }
</script>
<script type="module">
  if (window.NATIVE_SCHEME_SUPPORT) {
    await import("/mini/index-abc123.js");
  } else {
    await import("/assets/index-abc123.js");
  }
</script>
```

## Output

```
dist/
├── index.html           # unified loader with import map
├── assets/              # standard build (fallback)
│   ├── index-xxxxx.js
│   └── index-xxxxx.css
└── mini/                # externalized build
    └── index-xxxxx.js
```

## Bundler Support

Currently supports **Vite**. Webpack and Rollup adapters are planned. The architecture uses a bundler adapter pattern — contributions for new adapters are welcome.

## License

MIT
