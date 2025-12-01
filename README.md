# A0 Launcher

Desktop application shell for Agent Zero. This Electron app automatically downloads and displays the latest content from GitHub releases.

## Architecture

The app consists of two parts:

1. **Shell** (`shell/`) - The Electron executable that handles:
   - Window management
   - Checking for updates via GitHub Releases API
   - Downloading and caching content
   - Loading the downloaded content

2. **Content** (`app/`) - The actual application UI:
   - HTML, CSS, and JavaScript files
   - Bundled into `content.json` on each release
   - Downloaded at runtime by the shell

> **Note:** The `app/` folder exists in this repo as **source content** for the GitHub Action to bundle. The built executable does NOT include these files - it downloads them from GitHub Releases at runtime. This enables "build once, update forever" - content updates are deployed by creating new releases, not rebuilding the app.

## Development

### Prerequisites

- Node.js 20+
- npm 9+

### Setup

```bash
npm install
```

### Run in Development

```bash
npm start
```

### Build Executables

```bash
# All platforms (on respective OS)
npm run make

# Platform specific
npm run make:mac
npm run make:win
npm run make:linux
```

## Release Process

1. Update the content in `app/` directory
2. Create a new GitHub Release with a version tag (e.g., `v1.0.0`)
3. The `bundle-content.yml` workflow automatically:
   - Bundles all files in `app/` into `content.json`
   - Uploads `content.json` to the release

When users launch the app, it will:
1. Check the latest release via GitHub API
2. Compare timestamps with locally cached content
3. Download new content if available
4. Display the content

## Project Structure

```
a0-launcher/
├── .github/workflows/     # GitHub Actions
│   ├── bundle-content.yml # Bundles app/ on release
│   └── build.yml          # Builds executables
├── app/                   # Source content (bundled on release, NOT in executable)
│   └── index.html
├── shell/                 # Electron shell (packaged)
│   ├── assets/           # Icons and entitlements
│   ├── main.js           # Main process
│   ├── preload.js        # Context bridge
│   └── loading.html      # Loading screen
├── forge.config.js       # Electron Forge config
└── package.json
```

## License

MIT
