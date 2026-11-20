// What a review covers: the git changes of a repository, or the current files of a folder (a
// project). Both providers' review commands resolve their target here.

import fs from "node:fs";
import path from "node:path";

import {
  countCommitsAhead,
  detectDefaultBranch,
  getRepoRoot,
  getWorkingTreeState,
  isGitRepository,
  listChangedPaths,
  resolveChangesTarget
} from "./git.mjs";
import { enqueueBackgroundTask, normalizeArgv, outputCommandResult, parseCommandInput } from "./companion-cli.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./prompts.mjs";

export const REVIEW_TARGET_KINDS = ["auto", "changes", "project"];
export const REVIEW_STANCES = ["peer", "critical"];

const NO_GIT_MESSAGE = "No git repository here. Use --target project to review the current files.";
const BASE_SCOPE_MESSAGE = "--base and --scope apply only to --target changes.";
const NO_CHANGES_MESSAGE = "No changes under the given --path. Use --target project to review those files.";
const NOTHING_TO_REVIEW_MESSAGE = "No changes to review. Use --target project to review the current files.";
const BLANK_PATH_MESSAGE = "--path needs a file or folder; an empty value is not allowed.";

function isGiven(value) {
  return value != null && String(value).trim() !== "";
}

// Throws when the option `name` was given with a blank value, such as `--base=`, so the option is
// never treated as absent; a missing value (undefined or null) is left alone.
function refuseBlankOption(name, value) {
  if (value != null && !isGiven(value)) {
    throw new Error(`--${name} needs a value; an empty value is not allowed.`);
  }
}

function lower(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isInside(realRoot, real) {
  const relative = path.relative(lower(realRoot), lower(real));
  return relative === "" || !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

// The real path of `absolute`, as the operating system resolves it (a link's relative text, 8.3
// short names and case included). A path that does not exist and is not a link (a deleted file) is
// resolved through its nearest existing folder. Returns null when it cannot be resolved, which
// includes a link whose target is missing.
function resolveReal(absolute) {
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    // Fall through to the existence check below.
  }
  try {
    fs.lstatSync(absolute);
    return null;
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) {
      return null;
    }
    const real = resolveReal(parent);
    return real === null ? null : path.join(real, path.basename(absolute));
  }
}

// The path of `given` relative to `root` with forward slashes, "." for the root itself, or null
// when its real path cannot be resolved inside the root's real path.
function relativeInside(root, cwd, given) {
  const absolute = path.resolve(cwd, given);
  const realRoot = fs.realpathSync.native(root);
  const real = resolveReal(absolute);
  if (real === null || !isInside(realRoot, real)) {
    return null;
  }
  const relative = path.relative(lower(realRoot), lower(real));
  if (relative === "") {
    return { absolute, relative: "." };
  }
  // The relative path keeps the spelling the caller gave, apart from the separators.
  const spelled = path.relative(path.resolve(root), absolute);
  const usable = spelled && !spelled.startsWith("..") && !path.isAbsolute(spelled) ? spelled : path.relative(realRoot, real);
  return { absolute, relative: usable.split(path.sep).join("/") };
}

function coversChangedPath(reviewPath, changedPath) {
  if (reviewPath === ".") {
    return true;
  }
  const compare = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const wanted = compare(reviewPath);
  const changed = compare(changedPath);
  return changed === wanted || changed.startsWith(`${wanted}/`);
}

// Checks each --path against the root and returns them relative to it, without repeats.
function resolvePaths(root, cwd, paths, { kind, changedPaths }) {
  const resolved = [];
  for (const given of paths) {
    const inside = relativeInside(root, cwd, given);
    if (!inside) {
      throw new Error(`--path ${given} cannot be resolved inside the review root.`);
    }
    const exists = fs.existsSync(inside.absolute);
    const changed = kind === "changes" && changedPaths.some((entry) => coversChangedPath(inside.relative, entry));
    if (!exists && !changed) {
      throw new Error(`--path ${given} does not exist.`);
    }
    if (!resolved.includes(inside.relative)) {
      resolved.push(inside.relative);
    }
  }
  return resolved;
}

// The kind plain `auto` picks in a repository: changes when the working tree has any anywhere in
// the repository, also outside the folder it runs from, or the branch is ahead of its detected
// base, and otherwise the project, also when no base is found.
function autoKind(cwd) {
  const repoRoot = getRepoRoot(cwd);
  if (getWorkingTreeState(repoRoot).isDirty) {
    return "changes";
  }
  try {
    return countCommitsAhead(repoRoot, detectDefaultBranch(repoRoot)) > 0 ? "changes" : "project";
  } catch {
    return "project";
  }
}

function describe(base, paths) {
  return paths.length > 0 ? `${base} (paths: ${paths.join(", ")})` : base;
}

/**
 * Resolves what a review covers.
 *
 * `target` is `auto` (the default), `changes` or `project`. Outside a git repository only a
 * project review is possible, rooted at `cwd`. In a repository, `auto` with `base` or `scope` is a
 * changes review, and plain `auto` is a changes review when the working tree has changes or the
 * branch is ahead of its base, else a project review; the working tree is checked for the whole
 * repository, whatever folder `cwd` is. `paths` narrow either kind; each must be non-blank and
 * lie inside the root, a symlink's target included, a project path must exist, and a changes
 * path may be a deleted file or the old path of a renamed one. An explicit `base` must name a
 * commit that shares history with HEAD. A changes target with no changed file in it and a clean
 * working tree is refused. A
 * `target`, `base` or `scope` given as a blank string is refused rather than treated as absent.
 *
 * Returns `{ kind, root, paths, base, label, changes }`, where `changes` is the
 * `resolveChangesTarget` result for a changes review and null for a project review.
 */
export function resolveReviewTarget(cwd, { target = "auto", paths = [], base, scope } = {}) {
  refuseBlankOption("target", target);
  refuseBlankOption("base", base);
  refuseBlankOption("scope", scope);
  const requested = isGiven(target) ? String(target).trim() : "auto";
  if (!REVIEW_TARGET_KINDS.includes(requested)) {
    throw new Error(`Unsupported review target "${requested}". Use one of: ${REVIEW_TARGET_KINDS.join(", ")}.`);
  }
  const hasBase = isGiven(base);
  const hasScope = isGiven(scope);
  // A blank --path is refused rather than dropped, so a narrowed review never widens silently.
  const givenPaths = (paths == null ? [] : Array.isArray(paths) ? paths : [paths]).map((entry) => String(entry ?? ""));
  if (givenPaths.some((entry) => !isGiven(entry))) {
    throw new Error(BLANK_PATH_MESSAGE);
  }

  if (requested === "project" && (hasBase || hasScope)) {
    throw new Error(BASE_SCOPE_MESSAGE);
  }

  let kind;
  if (!isGitRepository(cwd)) {
    if (requested === "changes" || hasBase || hasScope) {
      throw new Error(NO_GIT_MESSAGE);
    }
    kind = "project";
  } else if (requested === "project") {
    kind = "project";
  } else if (requested === "changes" || hasBase || hasScope) {
    kind = "changes";
  } else {
    kind = autoKind(cwd);
  }

  if (kind === "project") {
    const root = path.resolve(cwd);
    const resolvedPaths = resolvePaths(root, cwd, givenPaths, { kind, changedPaths: [] });
    return {
      kind,
      root,
      paths: resolvedPaths,
      base: null,
      label: describe(`project ${root}`, resolvedPaths),
      changes: null
    };
  }

  const changes = resolveChangesTarget(cwd, {
    ...(hasBase ? { base: String(base).trim() } : {}),
    ...(hasScope ? { scope: String(scope).trim() } : {})
  });
  const root = path.resolve(getRepoRoot(cwd));
  const changedPaths = listChangedPaths(root, changes);
  // A branch comparison with no commits to compare still has work to review while the working
  // tree has changes, because Codex's built-in reviewer compares the base with the working tree.
  if (changedPaths.length === 0 && !getWorkingTreeState(root).isDirty) {
    throw new Error(NOTHING_TO_REVIEW_MESSAGE);
  }
  const resolvedPaths = resolvePaths(root, cwd, givenPaths, { kind, changedPaths });
  if (
    resolvedPaths.length > 0 &&
    !changedPaths.some((entry) => resolvedPaths.some((reviewPath) => coversChangedPath(reviewPath, entry)))
  ) {
    throw new Error(NO_CHANGES_MESSAGE);
  }
  return {
    kind,
    root,
    paths: resolvedPaths,
    base: changes.baseRef ?? null,
    label: describe(changes.label, resolvedPaths),
    changes
  };
}

/**
 * Returns the stance a review command was given, `peer` when none; throws for a blank or an
 * unknown one.
 */
export function resolveReviewStance(value) {
  refuseBlankOption("stance", value);
  const stance = isGiven(value) ? String(value).trim() : "peer";
  if (!REVIEW_STANCES.includes(stance)) {
    throw new Error(`Unsupported review stance "${stance}". Use one of: ${REVIEW_STANCES.join(", ")}.`);
  }
  return stance;
}

/**
 * Removes every `--<name> <value>` and `--<name>=<value>` that comes before a `--` from `argv`, so
 * the option can be repeated. Returns the values in order and the remaining arguments.
 */
export function takeRepeatedOption(argv, name) {
  const flag = `--${name}`;
  const values = [];
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      rest.push(...argv.slice(index));
      break;
    }
    if (token === flag) {
      if (index + 1 >= argv.length) {
        throw new Error(`Missing value for ${flag}`);
      }
      values.push(argv[index + 1]);
      index += 1;
    } else if (token.startsWith(`${flag}=`)) {
      values.push(token.slice(flag.length + 1));
    } else {
      rest.push(token);
    }
  }
  return { values, rest };
}

/**
 * Parses the arguments every provider's review command takes: `--target`, repeated `--path`,
 * `--stance`, `--base`, `--scope`, `--model`, `--effort`, `--cwd`, `--wait` or `--background`,
 * `--json`, and the instructions as the remaining words.
 * Returns `{ options, paths, stance, instructions, background }`.
 */
export function parseReviewArguments(argv, { aliasMap = {} } = {}) {
  const { values: paths, rest } = takeRepeatedOption(normalizeArgv(argv), "path");
  // The arguments are split once, above, so instruction text left after --path stays text.
  const { options, positionals } = parseCommandInput(rest, {
    valueOptions: ["target", "stance", "base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap,
    split: false
  });
  if (options.background && options.wait) {
    throw new Error("Choose only one of --wait and --background.");
  }
  return {
    options,
    paths,
    stance: resolveReviewStance(options.stance),
    instructions: positionals.join(" ").trim(),
    background: Boolean(options.background)
  };
}

/**
 * Queues the review `request` of `job` for the background worker of `workerScript`, which runs
 * a request marked `requestKind: "review"` as a review, and prints the job id.
 */
export function enqueueBackgroundReview(cwd, job, request, { workerScript, json = false }) {
  const { payload } = enqueueBackgroundTask(cwd, job, { ...request, requestKind: "review" }, { workerScript });
  outputCommandResult(
    payload,
    `${payload.title} started in the background as ${payload.jobId}. Check /agent:status ${payload.jobId} for progress.\n`,
    json
  );
  return payload;
}

const PROJECT_COLLECTION_GUIDANCE = "Read the files under the review root yourself with read-only commands before finalizing findings.";

/**
 * Builds the prompt of a schema-bound review. `stance` picks the template: `critical` challenges
 * the target, `peer` asks for an independent second opinion. A changes review inlines the git
 * context `context` (a `collectReviewContext` result); a project review names the root, the paths
 * and the checklist, and the reviewer reads the files itself.
 */
export function buildReviewPrompt({ rootDir, providerLabel, target, stance = "peer", instructions = "", context = null }) {
  const template = loadPromptTemplate(rootDir, resolveReviewStance(stance) === "critical" ? "critical-review" : "peer-review");
  let reviewInput;
  let collectionGuidance;
  if (target.kind === "project") {
    reviewInput = interpolateTemplate(loadPromptTemplate(rootDir, "project-target"), {
      REVIEW_ROOT: target.root,
      REVIEW_PATHS:
        target.paths.length > 0 ? target.paths.map((entry) => `- ${entry}`).join("\n") : "- every file under the review root"
    });
    collectionGuidance = PROJECT_COLLECTION_GUIDANCE;
  } else {
    reviewInput = context?.content ?? "";
    collectionGuidance = context?.collectionGuidance ?? "";
  }
  const focus = String(instructions ?? "").trim();
  return interpolateTemplate(template, {
    AGENT_NAME: providerLabel,
    TARGET_LABEL: target.label,
    TARGET_KIND: target.kind,
    USER_FOCUS: focus || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: collectionGuidance,
    REVIEW_INPUT: reviewInput
  });
}
