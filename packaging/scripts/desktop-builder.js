#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const {
  PROJECT_ROOT,
  loadPackagingDependency,
  resolvePackagingDependency
} = require("./tooling");
const { resolveDesktopBuildVersion } = require("./release-version");
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, "package.json");
const { build, Platform, Arch, DIR_TARGET } = loadPackagingDependency("electron-builder");
const { serializeToYaml } = loadPackagingDependency("builder-util");
const ELECTRON_PACKAGE = loadPackagingDependency("electron/package.json");
const ELECTRON_DIST_PATH = path.join(
  path.dirname(resolvePackagingDependency("electron/package.json")),
  "dist"
);

const PLATFORM_SPECS = {
  macos: {
    key: "macos",
    label: "macOS",
    builderPlatform: Platform.MAC,
    configKey: "mac",
    defaultTargets: ["dmg", "zip"],
    entryScript: "macos-package.js",
    preferredHost: "darwin"
  },
  windows: {
    key: "windows",
    label: "Windows",
    builderPlatform: Platform.WINDOWS,
    configKey: "win",
    defaultTargets: ["nsis"],
    entryScript: "windows-package.js",
    preferredHost: "win32"
  },
  linux: {
    key: "linux",
    label: "Linux",
    builderPlatform: Platform.LINUX,
    configKey: "linux",
    defaultTargets: ["AppImage"],
    entryScript: "linux-package.js",
    preferredHost: "linux"
  }
};

const ARCH_NAMES = new Set(["x64", "arm64", "universal"]);
const ARCH_VALUES = {
  x64: Arch.x64,
  arm64: Arch.arm64,
  universal: Arch.universal
};

const PLATFORM_UPDATE_CHANNELS = {
  macos: "metadata-latest",
  windows: "metadata-latest-windows",
  linux: "metadata-latest"
};

function readPackageJson() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
}

function isTruthyEnv(value) {
  return ["1", "true", "yes"].includes(String(value || "").trim().toLowerCase());
}

function applyAppleCredentialAliases(env = process.env) {
  if (!env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_PASSWORD) {
    env.APPLE_APP_SPECIFIC_PASSWORD = env.APPLE_PASSWORD;
  }
}

function isFlag(value, ...names) {
  return names.includes(value);
}

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flagName} requires a value.`);
  }

  return value;
}

function normalizeArchName(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "x64") {
    return "x64";
  }
  if (normalized === "arm64") {
    return "arm64";
  }
  if (normalized === "universal") {
    return "universal";
  }

  return null;
}

function defaultArchName(platformSpec) {
  if (platformSpec.key === "macos") {
    const normalized = normalizeArchName(process.arch);
    return normalized || "x64";
  }

  return "x64";
}

function addArchName(targetArchs, archName, platformSpec) {
  if (!ARCH_NAMES.has(archName)) {
    throw new Error(`Unsupported arch "${archName}". Use x64, arm64, or universal.`);
  }

  if (archName === "universal" && platformSpec.key !== "macos") {
    throw new Error("The universal arch target is only supported for macOS packaging.");
  }

  if (!targetArchs.includes(archName)) {
    targetArchs.push(archName);
  }
}

function parseArchList(rawValue, platformSpec) {
  const parts = String(rawValue)
    .split(",")
    .map((part) => normalizeArchName(part))
    .filter(Boolean);

  if (!parts.length) {
    throw new Error("Expected at least one arch value.");
  }

  const archs = [];
  parts.forEach((archName) => addArchName(archs, archName, platformSpec));
  return archs;
}

function parsePackagingArgs(argv, platformSpec) {
  const options = {
    appVersion: "",
    dir: false,
    dryRun: false,
    help: false,
    archs: [defaultArchName(platformSpec)]
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (isFlag(arg, "--help", "-h")) {
      options.help = true;
      continue;
    }

    if (arg === "--dir") {
      options.dir = true;
      continue;
    }

    if (arg === "--app-version") {
      options.appVersion = readFlagValue(argv, index, "--app-version");
      index += 1;
      continue;
    }

    if (arg.startsWith("--app-version=")) {
      options.appVersion = arg.slice("--app-version=".length).trim();
      if (!options.appVersion) {
        throw new Error("--app-version requires a value.");
      }
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (isFlag(arg, "--x64", "--arm64", "--universal")) {
      const archName = arg.replace(/^--/, "");
      options.archs = [];
      addArchName(options.archs, archName, platformSpec);
      continue;
    }

    if (arg === "--arch") {
      options.archs = parseArchList(readFlagValue(argv, index, "--arch"), platformSpec);
      index += 1;
      continue;
    }

    if (arg.startsWith("--arch=")) {
      options.archs = parseArchList(arg.slice("--arch=".length), platformSpec);
      continue;
    }

    if (arg === "--publish" || arg.startsWith("--publish=")) {
      throw new Error(
        "The packaging scripts do not support --publish. They only build local artifacts; GitHub Release upload is handled by .github/workflows/build.yml."
      );
    }

    throw new Error(`Unknown packaging argument: ${arg}`);
  }

  return options;
}

function cloneBuildConfig(packageJson) {
  return JSON.parse(JSON.stringify(packageJson.build || {}));
}

function resolveProjectPath(relativePath) {
  return path.join(PROJECT_ROOT, relativePath);
}

function maybeStripMissingPath(object, key, warnings, description) {
  if (!object || typeof object[key] !== "string") {
    return;
  }

  if (fs.existsSync(resolveProjectPath(object[key]))) {
    return;
  }

  warnings.push(`Skipping missing ${description}: ${object[key]}`);
  delete object[key];
}

function resolvePlatformUpdateChannel(platformSpec) {
  return PLATFORM_UPDATE_CHANNELS[platformSpec.key] || "metadata-latest";
}

function normalizePublishEntries(value) {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  return entries
    .filter((entry) => entry !== null && entry !== undefined)
    .map((entry) => (typeof entry === "string" ? { provider: entry } : { ...entry }))
    .filter((entry) => typeof entry.provider === "string" && entry.provider.trim());
}

function applyPlatformPublishConfig(buildConfig, platformConfig, platformSpec) {
  const rootPublishEntries = normalizePublishEntries(buildConfig.publish);
  const platformPublishEntries = normalizePublishEntries(platformConfig.publish);
  const sourceEntries = platformPublishEntries.length ? platformPublishEntries : rootPublishEntries;

  if (!sourceEntries.length) {
    return;
  }

  const channel = resolvePlatformUpdateChannel(platformSpec);
  const configuredEntries = sourceEntries.map((entry) => ({
    ...entry,
    channel
  }));

  platformConfig.publish =
    Array.isArray(platformConfig.publish) || (!platformPublishEntries.length && Array.isArray(buildConfig.publish))
      ? configuredEntries
      : configuredEntries[0];
}

function createBuildConfig(platformSpec, options) {
  const packageJson = readPackageJson();
  const buildConfig = cloneBuildConfig(packageJson);
  const platformConfig = {
    ...(buildConfig[platformSpec.configKey] || {})
  };
  const buildVersion = resolveDesktopBuildVersion({
    explicitValue: options.appVersion,
    packageVersion: packageJson.version,
    cwd: PROJECT_ROOT
  });
  const skipSigning = isTruthyEnv(process.env.SKIP_SIGNING);
  const warnings = [];

  maybeStripMissingPath(platformConfig, "icon", warnings, `${platformSpec.label} icon`);
  maybeStripMissingPath(platformConfig, "entitlements", warnings, `${platformSpec.label} entitlements`);
  maybeStripMissingPath(
    platformConfig,
    "entitlementsInherit",
    warnings,
    `${platformSpec.label} inherited entitlements`
  );

  if (skipSigning && platformSpec.key === "macos") {
    platformConfig.identity = null;
    platformConfig.notarize = false;
  }

  applyPlatformPublishConfig(buildConfig, platformConfig, platformSpec);
  buildConfig[platformSpec.configKey] = platformConfig;
  buildConfig.directories = {
    ...(buildConfig.directories || {}),
    output: path.join("dist", "desktop", platformSpec.key)
  };
  buildConfig.asar = false;
  buildConfig.buildVersion = buildVersion;
  buildConfig.electronVersion = ELECTRON_PACKAGE.version;
  if (process.platform === platformSpec.preferredHost) {
    buildConfig.electronDist = ELECTRON_DIST_PATH;
  } else {
    delete buildConfig.electronDist;
    warnings.push(
      `Skipping local Electron dist override while packaging ${platformSpec.label} from ${process.platform}; electron-builder will resolve the target runtime instead.`
    );
  }
  buildConfig.extraMetadata = {
    ...(buildConfig.extraMetadata || {}),
    version: buildVersion
  };

  return {
    buildConfig,
    buildVersion,
    packageJson,
    warnings
  };
}

function createTargets(platformSpec, options) {
  const targetNames = options.dir ? DIR_TARGET : platformSpec.defaultTargets;
  const archValues = options.archs.map((archName) => ARCH_VALUES[archName]);
  return platformSpec.builderPlatform.createTarget(targetNames, ...archValues);
}

function resolveUpdaterCacheDirName(packageJson, buildConfig) {
  const baseName = String(packageJson.name || buildConfig.productName || "app")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return `${baseName || "app"}-updater`;
}

function resolvePrimaryPublishConfig(buildConfig, platformSpec) {
  const platformConfig = buildConfig[platformSpec.configKey] || {};
  const platformPublishEntries = normalizePublishEntries(platformConfig.publish);
  const rootPublishEntries = normalizePublishEntries(buildConfig.publish);
  return platformPublishEntries[0] || rootPublishEntries[0] || null;
}

function resolveMacDirAppPath(outputDir, productName, archName) {
  return path.join(
    resolveProjectPath(outputDir),
    `mac-${archName === "universal" ? "universal" : archName}`,
    `${productName}.app`
  );
}

function writeMacDirBuildUpdateConfig(options, buildConfig, packageJson, platformSpec) {
  if (!options.dir) {
    return [];
  }

  const publishConfig = resolvePrimaryPublishConfig(buildConfig, platformSpec);
  if (!publishConfig) {
    return [];
  }

  const productName = buildConfig.productName || packageJson.productName || packageJson.name;
  const appUpdateConfig = {
    ...publishConfig,
    updaterCacheDirName: resolveUpdaterCacheDirName(packageJson, buildConfig)
  };
  const writtenPaths = [];

  options.archs.forEach((archName) => {
    const resourcesDir = path.join(
      resolveMacDirAppPath(buildConfig.directories.output, productName, archName),
      "Contents",
      "Resources"
    );

    if (!fs.existsSync(resourcesDir)) {
      throw new Error(
        `Expected macOS unpacked app resources at ${path.relative(PROJECT_ROOT, resourcesDir)} after packaging.`
      );
    }

    const appUpdateConfigPath = path.join(resourcesDir, "app-update.yml");
    fs.writeFileSync(appUpdateConfigPath, serializeToYaml(appUpdateConfig));
    writtenPaths.push(appUpdateConfigPath);
  });

  return writtenPaths;
}

function printHelp(platformSpec) {
  console.log(`${platformSpec.label} packaging script`);
  console.log("");
  console.log("Usage:");
  console.log(`  node packaging/scripts/${platformSpec.entryScript} [options]`);
  console.log("");
  console.log("Options:");
  console.log("  --app-version <tag> Desktop app version or tag, for example v0.22 or 0.22.");
  console.log("  --dir              Build an unpacked app directory instead of installers.");
  console.log("  --arch <list>      Arch list: x64, arm64, universal (macOS only).");
  console.log("  --x64              Shortcut for --arch x64.");
  console.log("  --arm64            Shortcut for --arch arm64.");
  console.log("  --universal        Shortcut for --arch universal (macOS only).");
  console.log("  --dry-run          Print the resolved packaging plan without building.");
}

function printPlan(platformSpec, options, warnings, buildConfig, buildVersion) {
  console.log(`${platformSpec.label} packaging plan`);
  console.log("");
  console.log(`Host platform: ${process.platform}`);
  console.log(`Preferred host: ${platformSpec.preferredHost}`);
  console.log(`Build version: ${buildVersion}`);
  console.log(`Output directory: ${buildConfig.directories.output}`);
  console.log(`Targets: ${(options.dir ? [DIR_TARGET] : platformSpec.defaultTargets).join(", ")}`);
  console.log(`Archs: ${options.archs.join(", ")}`);

  if (warnings.length) {
    console.log("");
    warnings.forEach((warning) => {
      console.log(`Warning: ${warning}`);
    });
  }
}

function printHostNote(platformSpec) {
  if (process.platform === platformSpec.preferredHost) {
    return;
  }

  console.warn(
    `Packaging ${platformSpec.label} from ${process.platform} may require additional host tooling or may be unsupported by the target toolchain.`
  );
}

async function runDesktopPackaging(platformKey, argv = process.argv.slice(2)) {
  const platformSpec = PLATFORM_SPECS[platformKey];
  if (!platformSpec) {
    throw new Error(`Unknown desktop packaging platform: ${platformKey}`);
  }

  applyAppleCredentialAliases();

  const options = parsePackagingArgs(argv, platformSpec);
  if (options.help) {
    printHelp(platformSpec);
    return [];
  }

  const { buildConfig, buildVersion, packageJson, warnings } = createBuildConfig(platformSpec, options);
  printHostNote(platformSpec);

  if (options.dryRun) {
    printPlan(platformSpec, options, warnings, buildConfig, buildVersion);
    return [];
  }

  warnings.forEach((warning) => {
    console.warn(`Warning: ${warning}`);
  });

  console.log(`Packaging Agent Zero Launcher for ${platformSpec.label}...`);

  const artifacts = await build({
    projectDir: PROJECT_ROOT,
    config: buildConfig,
    targets: createTargets(platformSpec, options),
    publish: null
  });

  const localUpdateConfigPaths =
    platformSpec.key === "macos" ? writeMacDirBuildUpdateConfig(options, buildConfig, packageJson, platformSpec) : [];

  localUpdateConfigPaths.forEach((appUpdateConfigPath) => {
    console.log(`Wrote ${path.relative(PROJECT_ROOT, appUpdateConfigPath)} for local updater testing.`);
  });

  if (options.dir) {
    console.log(`Created unpacked app output in ${buildConfig.directories.output}.`);
  } else {
    console.log(`Created ${artifacts.length} artifact(s) in ${buildConfig.directories.output}.`);
    artifacts.forEach((artifactPath) => {
      console.log(`- ${path.relative(PROJECT_ROOT, artifactPath)}`);
    });
  }

  return artifacts;
}

module.exports = {
  runDesktopPackaging
};
