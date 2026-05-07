#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const DEFAULT_GITHUB_REPO = "agent0ai/a0-launcher";
const OUTPUT_FILE = path.join(__dirname, "..", "shell", "build-info.json");

function safeExec(command) {
  try {
    return execSync(command, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function normalizeOwnerRepo(value) {
  const raw = (value || "").trim();
  if (!raw) return "";

  // Accept common shorthand forms like "owner/repo.git".
  const cleaned = raw.endsWith(".git") ? raw.slice(0, -4) : raw;

  // Plain "owner/repo"
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleaned)) return cleaned;

  // HTTPS GitHub URL (with or without credentials, with optional .git suffix)
  // Examples:
  // - https://github.com/owner/repo.git
  // - https://x-access-token:***@github.com/owner/repo.git
  const httpsMatch = cleaned.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?$/);
  if (httpsMatch?.[1]) return httpsMatch[1];

  // SSH GitHub URL
  // Example: git@github.com:owner/repo.git
  const sshMatch = cleaned.match(/github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?$/);
  if (sshMatch?.[1]) return sshMatch[1];

  return "";
}

function writeBuildInfo(payload) {
  try {
    fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    // Do not block local dev builds if this file cannot be written.
    // The runtime falls back to the default repo when this file is absent.
    process.stderr.write(
      `[build-info] WARNING: failed to write ${OUTPUT_FILE}: ${error?.message || String(error)}\n`,
    );
    return false;
  }
}

const envRepo =
  normalizeOwnerRepo(process.env.A0_LAUNCHER_GITHUB_REPO) ||
  normalizeOwnerRepo(process.env.GITHUB_REPOSITORY);

let githubRepo = envRepo;
let source = "env";

if (!githubRepo) {
  const originUrl = safeExec("git config --get remote.origin.url");
  githubRepo = normalizeOwnerRepo(originUrl);
  source = githubRepo ? "git" : "default";
}

if (!githubRepo) githubRepo = DEFAULT_GITHUB_REPO;

const payload = {
  githubRepo,
  source,
  generatedAt: new Date().toISOString(),
};

writeBuildInfo(payload);
process.stdout.write(`[build-info] githubRepo=${githubRepo} source=${source}\n`);


