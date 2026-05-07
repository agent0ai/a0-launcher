const path = require("node:path");

function isTruthyEnv(value) {
  return ["1", "true", "yes"].includes((value || "").trim().toLowerCase());
}

const entitlementsPath = path.join(
  __dirname,
  "shell",
  "assets",
  "entitlements.mac.plist",
);

// Local builds should not require Apple credentials. CI/release builds can opt in
// automatically when credentials are present, or explicitly via NOTARIZE=1.
const skipSigning =
  isTruthyEnv(process.env.SKIP_SIGNING) ||
  isTruthyEnv(process.env.SKIP_OSX_SIGN) ||
  isTruthyEnv(process.env.SKIP_MACOS_SIGN);

const shouldNotarize = (() => {
  if (skipSigning) return false;

  const explicit = (process.env.NOTARIZE || "").trim();
  if (explicit) return isTruthyEnv(explicit);

  // Default: notarize when credentials are available (typical CI release builds).
  return Boolean(
    process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID,
  );
})();

module.exports = {
  packagerConfig: {
    name: "A0 Launcher",
    executableName: "a0-launcher",
    appBundleId: "ai.agent0.launcher",
    asar: true,
    icon: path.join(__dirname, "shell", "assets", "icon"),
    appCategoryType: "public.app-category.developer-tools",
    osxSign: skipSigning
      ? undefined
      : {
          identity: "Developer ID Application", // autodetect actual cert
          hardenedRuntime: true,
          entitlements: entitlementsPath,
          "entitlements-inherit": entitlementsPath,
          "signature-flags": "library",
        },
    osxNotarize: shouldNotarize
      ? {
          tool: "notarytool",
          appleId: process.env.APPLE_ID,
          appleIdPassword: process.env.APPLE_PASSWORD,
          teamId: process.env.APPLE_TEAM_ID,
        }
      : undefined,
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "A0Launcher",
        authors: "Agent Zero Team",
        description: "Agent Zero Launcher",
        iconUrl:
          "https://raw.githubusercontent.com/agent0ai/a0-launcher/main/shell/assets/icon.ico",
        setupIcon: path.join(__dirname, "shell", "assets", "icon.ico"),
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        name: "A0 Launcher",
        icon: path.join(__dirname, "shell", "assets", "icon.icns"),
        format: "ULFO",
      },
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          name: "a0-launcher",
          productName: "A0 Launcher",
          maintainer: "Agent Zero Team",
          homepage: "https://github.com/agent0ai/a0-launcher",
          icon: path.join(__dirname, "shell", "assets", "icon.png"),
          categories: ["Development", "Utility"],
        },
      },
    },
    {
      name: "@electron-forge/maker-rpm",
      platforms: ["linux"],
      config: {
        options: {
          name: "a0-launcher",
          productName: "A0 Launcher",
          homepage: "https://github.com/agent0ai/a0-launcher",
          icon: path.join(__dirname, "shell", "assets", "icon.png"),
          categories: ["Development", "Utility"],
        },
      },
    },
  ],
};
