import path from "node:path";
import { fileURLToPath } from "node:url";

import { interpolateTemplate, loadPromptTemplate } from "../prompts.mjs";
import { listProviders } from "../providers.mjs";

// Council seats, lenses and the round, repair and retry prompts. The brief carries the question,
// the target paths, the options and the claims marked observed or assumed; the templates add the
// lens, the read-only rule and the answer schema, and name no seat, family or model.

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAX_SEATS = 5;

export const FAMILIES = ["claude", "codex", "agy"];

/**
 * The notice a seat that is still working gets once when its round reaches quorum. It is not a
 * prompt: it needs no reply of its own and does not extend any deadline.
 */
export const CUTOFF_NOTICE =
  "The other seats of the panel have answered. You have five minutes from now to give your answer in the required JSON form; after that the round closes without it.";

const FAMILY_PROVIDERS = { claude: null, codex: "codex", agy: "agy" };

export const DEFAULT_LENSES = {
  review: ["correctness", "security", "maintainability"],
  decision: ["what could fail", "first principles", "cost of carrying it out"],
  question: ["evidence", "first principles", "counterexamples"],
  open: ["evidence", "first principles", "counterexamples"]
};

// What a seat writes in its first answer, by kind: findings and a stance for a review or a
// decision; a statement of its own answer, with findings as its supporting points, for a question
// or an open council.
const ROUND1_RULES = {
  findings:
    "Give each finding an id `f1`, `f2` and so on, a severity from `P1` (most severe) to `P3`, the claim, the file path and line (or null when the finding has none), and the evidence that supports it. State what you assumed under `assumptions`, and say under `wouldChangeMind` what would change your view. For a decision, set `stance` to one of the options the brief names; for a review, set `stance` to null.",
  ownWords:
    "Answer the question in `answer`: one statement in your own words, at most 500 characters. Give the points that support it as findings: each with an id `f1`, `f2` and so on, a weight from `P1` (most important) to `P3` in `severity`, the claim, the file path and line (or null when the point has none), and the evidence. State what you assumed under `assumptions`, and say under `wouldChangeMind` what would change your answer. Set `stance` to null."
};

function round1Rules(kind) {
  return kind === "question" || kind === "open" ? ROUND1_RULES.ownWords : ROUND1_RULES.findings;
}

// The Round 2 instruction on the stance, by kind; for a question or open council it also says how
// to name the members' answers by label, and which label is the seat's own (null for a fresh
// stand-in, which has no answer of its own).
function round2StanceRule(kind, ownLabel) {
  const own = ownLabel ? ` Your own answer is labelled ${ownLabel}.` : "";
  if (kind === "question") {
    return `Separately, set the top-level \`sameAs\` to the pairs of answer labels that say the same thing in substance, for example \`[["A", "C"]]\`, or to \`[]\` when no two do; answers linked this way become one option of the vote. Set \`stance\` to the label of the answer you endorse, which may be your own.${own}`;
  }
  if (kind === "open") {
    return `Set \`agreesWith\` to the labels of the answers you agree with in substance, or to \`[]\`; there is no vote, and the leader judges how far the members agree. Set \`stance\` to null.${own}`;
  }
  return "For a decision, set `stance` to your final choice among the options the brief names; for a review, set `stance` to null.";
}

// The provider id that runs a family's seats, or null for the host family and unknown names.
export function familyProvider(family) {
  const id = Object.prototype.hasOwnProperty.call(FAMILY_PROVIDERS, family) ? FAMILY_PROVIDERS[family] : null;
  return id !== null && listProviders().some((provider) => provider.id === id) ? id : null;
}

function parseSeatSpec(spec) {
  const text = String(spec);
  const colon = text.indexOf(":");
  const family = colon === -1 ? "" : text.slice(0, colon).trim();
  const lens = colon === -1 ? "" : text.slice(colon + 1).trim();
  if (!family || !lens) {
    throw new Error(`Seat "${text}" must be <family>:<lens>.`);
  }
  if (!FAMILIES.includes(family)) {
    throw new Error(`Unknown seat family "${family}". Families: ${FAMILIES.join(", ")}.`);
  }
  return { family, lens };
}

// Seats in order: the three default seats with the kind's lenses when no seat spec is given,
// otherwise one seat per `<family>:<lens>` spec. A refused plan throws with the message to show.
export function planSeats({ kind, seatSpecs = [] } = {}) {
  const lenses = DEFAULT_LENSES[kind];
  if (!lenses) {
    throw new Error(`Unknown council kind "${kind}". Kinds: ${Object.keys(DEFAULT_LENSES).join(", ")}.`);
  }
  const specs = seatSpecs ?? [];
  if (specs.length === 0) {
    return FAMILIES.map((family, index) => ({ seat: `s${index + 1}`, family, lens: lenses[index] }));
  }
  if (specs.length > MAX_SEATS) {
    throw new Error(`A council has at most ${MAX_SEATS} seats.`);
  }
  const seen = new Set();
  let hostSeats = 0;
  return specs.map((spec, index) => {
    const { family, lens } = parseSeatSpec(spec);
    const key = `${family}:${lens}`;
    if (seen.has(key)) {
      throw new Error(`Seat ${key} is given twice.`);
    }
    seen.add(key);
    if (family === "claude") {
      hostSeats += 1;
      if (hostSeats > 1) {
        throw new Error("A fourth or fifth seat goes to Codex or Antigravity before a second Claude seat.");
      }
    }
    return { seat: `s${index + 1}`, family, lens };
  });
}

function render(name, variables) {
  return interpolateTemplate(loadPromptTemplate(PLUGIN_ROOT, name), variables);
}

function trimEnd(text) {
  return String(text ?? "").replace(/\s+$/, "");
}

function jsonBlock(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function renderRound1Prompt({ brief, lens, kind, schemaText }) {
  return render("council-round1", {
    BRIEF: trimEnd(brief),
    KIND: kind,
    LENS: lens,
    KIND_RULES: round1Rules(kind),
    SCHEMA: trimEnd(schemaText)
  });
}

/**
 * The cross-examination prompt. `kind` defaults to `review`; for a question or open council,
 * `answers` is the recipient's answer bundle (answerBundle: `{ label, answer, yours? }`), shown
 * before the findings rules, and the stance rule names the recipient's own label.
 */
export function renderRound2Prompt({ brief, lens, ownFindings, bundle, schemaText, kind = "review", answers = [] }) {
  const ownWords = kind === "question" || kind === "open";
  const ownLabel = answers.find((entry) => entry.yours)?.label ?? null;
  return render("council-round2", {
    BRIEF: trimEnd(brief),
    LENS: lens,
    OWN_FINDINGS: jsonBlock(ownFindings ?? []),
    BUNDLE: jsonBlock(bundle ?? []),
    ANSWERS: ownWords ? `The members' answers to the question, each under a label (yours is marked \`"yours": true\`):\n\n${jsonBlock(answers)}\n\n` : "",
    STANCE_RULE: round2StanceRule(kind, ownLabel),
    SCHEMA: trimEnd(schemaText)
  });
}

// Self-contained: the round's committed prompt, then the validation errors and the schema.
export function renderRepairPrompt({ basePrompt, errors, schemaText }) {
  return render("council-repair", {
    BASE_PROMPT: trimEnd(basePrompt),
    ERRORS: (errors ?? []).map((error) => `- ${error}`).join("\n"),
    SCHEMA: trimEnd(schemaText)
  });
}

// The prompt of a Claude stand-in for a seat that ended the round without a valid answer: the
// round prompt for that seat's lens under a line that says whose place the stand-in takes.
export function renderSubstitutePrompt({ basePrompt }) {
  return render("council-substitute", { BASE_PROMPT: trimEnd(basePrompt) });
}

/**
 * The prompt of a follow-up question to one seat's actor after Round 2: the brief, the actor's
 * lens, its accepted Round 1 and Round 2 answers (null when it gave none), the target (a merged
 * cluster with no seat or family names, or `stance` on a decision), the question and the schema.
 * It is complete, so a new agent can answer it after a restart.
 */
export function renderFollowupPrompt({ brief, lens, round1, round2, target, cluster = null, question, kind, options = [], schemaText }) {
  const subject =
    target === "stance"
      ? `Your stance on the decision. The options are: ${options.join(", ")}.`
      : `Merged finding ${target}:\n\n${jsonBlock({
          severity: cluster?.severity ?? null,
          label: cluster?.label ?? null,
          path: cluster?.path ?? null,
          line: cluster?.line ?? null,
          claim: cluster?.claim ?? null,
          challenges: (cluster?.challenges ?? []).map((challenge) => ({ disputes: challenge.disputes, reason: challenge.reason }))
        })}`;
  const stanceRule =
    kind === "decision"
      ? `Set \`stance\` to your choice among the options (${options.join(", ")}) when the question changes it or you restate it; otherwise set it to null.`
      : "Set `stance` to null.";
  return render("council-followup", {
    BRIEF: trimEnd(brief),
    LENS: lens,
    FIRST_ANSWER: round1 ? jsonBlock(round1) : "(none: you did not answer the first round for this seat)",
    SECOND_ANSWER: jsonBlock(round2 ?? null),
    TARGET: subject,
    QUESTION: trimEnd(question),
    STANCE_RULE: stanceRule,
    SCHEMA: trimEnd(schemaText)
  });
}

// The round's prompt under a first line that names the reissue time and, when a reason is
// given, a second line that names what happened to the previous attempt. `round` is accepted
// for the caller's record and does not change the text.
export function renderRetryPrompt({ issuedAt, basePrompt, reason = null }) {
  const previous = reason === null || reason === undefined ? "" : `Previous attempt: ${String(reason).replace(/\.+$/, "")}.\n`;
  return render("council-retry", {
    ISSUED_AT: new Date(issuedAt).toISOString(),
    PREVIOUS_ATTEMPT: previous,
    BASE_PROMPT: trimEnd(basePrompt)
  });
}
