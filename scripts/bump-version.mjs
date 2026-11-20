#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const TARGETS = [
  {
    file: "package.json",
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      }
    ]
  },
  {
    file: "package-lock.json",
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      },
      {
        label: "packages[\"\"].version",
        get: (json) => json.packages?.[""]?.version,
        set: (json, version) => {
          requireObject(json.packages?.[""], "package-lock.json packages[\"\"]");
          json.packages[""].version = version;
        }
      }
    ]
  },
  {
    file: "plugins/agent/.claude-plugin/plugin.json",
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      }
    ]
  },
  {
    file: ".claude-plugin/marketplace.json",
    values: [
      {
        label: "metadata.version",
        get: (json) => json.metadata?.version,
        set: (json, version) => {
          requireObject(json.metadata, ".claude-plugin/marketplace.json metadata");
          json.metadata.version = version;
        }
      },
      {
        label: "plugins[agent].version",
        get: (json) => json.plugins?.find((entry) => entry?.name === "agent")?.version,
        set: (json, version) => {
          findMarketplacePlugin(json).version = version;
        }
      }
    ]
  }
];

function usage() {
  return [
    "Usage:",
    "  node scripts/bump-version.mjs <version>",
    "  node scripts/bump-version.mjs --check [version]",
    "",
    "Options:",
    "  --check       Verify manifest versions. Uses package.json when version is omitted.",
    "  --root <dir>  Run against a different repository root.",
    "  --help       Print this help."
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    check: false,
    root: process.cwd(),
    version: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--root") {
      const root = argv[i + 1];
      if (!root || root.startsWith("-")) {
        throw new Error("--root requires a directory.");
      }
      options.root = root;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.version) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    } else {
      options.version = arg;
    }
  }

  options.root = path.resolve(options.root);
  return options;
}

function validateVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Expected a semver-like version such as 1.0.3, got: ${version}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
}

function findMarketplacePlugin(json) {
  const plugin = json.plugins?.find((entry) => entry?.name === "agent");
  requireObject(plugin, ".claude-plugin/marketplace.json plugins[agent]");
  return plugin;
}

// Returns the parsed file with the line ending and indent it uses, so a rewrite keeps both.
function readManifest(root, file) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  requireObject(json, file);
  return {
    json,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    indent: text.match(/^([ \t]+)"/m)?.[1] ?? "  "
  };
}

function readJson(root, file) {
  return readManifest(root, file).json;
}

function writeJson(root, file, { json, eol, indent }) {
  const text = `${JSON.stringify(json, null, indent)}\n`;
  fs.writeFileSync(path.join(root, file), eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
}

function readPackageVersion(root) {
  const packageJson = readJson(root, "package.json");
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version must be a string.");
  }
  validateVersion(packageJson.version);
  return packageJson.version;
}

function checkVersions(root, expectedVersion) {
  const mismatches = [];

  for (const target of TARGETS) {
    const json = readJson(root, target.file);
    for (const value of target.values) {
      const actual = value.get(json);
      if (actual !== expectedVersion) {
        mismatches.push(`${target.file} ${value.label}: expected ${expectedVersion}, found ${actual ?? "<missing>"}`);
      }
    }
  }

  return mismatches;
}

// Every target is read and updated in memory first, so a target that cannot be bumped, such
// as one that is not a JSON object or has no version field, leaves all files unchanged.
function bumpVersion(root, version) {
  const pending = [];

  for (const target of TARGETS) {
    const manifest = readManifest(root, target.file);
    const before = JSON.stringify(manifest.json);

    for (const value of target.values) {
      if (typeof value.get(manifest.json) !== "string") {
        throw new Error(`${target.file} has no ${value.label} to update.`);
      }
      value.set(manifest.json, version);
    }

    if (JSON.stringify(manifest.json) !== before) {
      pending.push({ file: target.file, manifest });
    }
  }

  for (const { file, manifest } of pending) {
    writeJson(root, file, manifest);
  }
  return pending.map(({ file }) => file);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const version = options.version ?? (options.check ? readPackageVersion(options.root) : null);
  if (!version) {
    throw new Error(`Missing version.\n\n${usage()}`);
  }
  validateVersion(version);

  if (options.check) {
    const mismatches = checkVersions(options.root, version);
    if (mismatches.length > 0) {
      throw new Error(`Version metadata is out of sync:\n${mismatches.join("\n")}`);
    }
    console.log(`All version metadata matches ${version}.`);
    return;
  }

  const changedFiles = bumpVersion(options.root, version);
  const touched = changedFiles.length > 0 ? changedFiles.join(", ") : "no files changed";
  console.log(`Set version metadata to ${version}: ${touched}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
