import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";
const STAGING_DIR_PREFIX = ".agent-plugin-transfer-";

// Codex imports Claude sessions only from <home>/.claude/projects and does not read
// CLAUDE_CONFIG_DIR. Claude Code writes transcripts to $CLAUDE_CONFIG_DIR/projects when that
// variable is set, so those sources are copied under <home>/.claude/projects for the import.
function homeProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

function claudeProjectsDirs() {
  const dirs = [homeProjectsDir()];
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    dirs.push(path.join(path.resolve(configDir), "projects"));
  }
  return dirs;
}

function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  const source = realpathOrNull(sourcePath);
  if (!source) {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  const dirs = claudeProjectsDirs();
  if (!dirs.some((dir) => {
    const projects = realpathOrNull(dir);
    return projects !== null && isInside(projects, source);
  })) {
    throw new Error(`Codex can import Claude sessions only from ${dirs.join(" or ")}: ${source}`);
  }
  return source;
}

/**
 * Returns the path Codex should import for `sourcePath` and a cleanup function. A source under
 * <home>/.claude/projects is used in place. Any other source is copied into a new directory there,
 * which cleanup removes together with any parent directory the copy had to create.
 */
export function stageClaudeSessionForImport(sourcePath) {
  const projects = homeProjectsDir();
  const projectsReal = realpathOrNull(projects);
  if (projectsReal !== null && isInside(projectsReal, sourcePath)) {
    return { path: sourcePath, staged: false, cleanup() {} };
  }

  const claudeDir = path.dirname(projects);
  const createdDirs = [claudeDir, projects].filter((dir) => !fs.existsSync(dir));
  const stagingDir = path.join(projects, `${STAGING_DIR_PREFIX}${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const stagedPath = path.join(stagingDir, path.basename(sourcePath));
  fs.copyFileSync(sourcePath, stagedPath);

  return {
    path: stagedPath,
    staged: true,
    cleanup() {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      for (const dir of createdDirs.reverse()) {
        try {
          fs.rmdirSync(dir);
        } catch {
          // The directory is not empty or is already gone.
        }
      }
    }
  };
}
