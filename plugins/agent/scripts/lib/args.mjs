/**
 * Parses options and positionals. `--help` and `-h` set `options.help` only before the first
 * positional, so they can appear in prompt or focus text. With `stopAtFirstPositional`, every
 * token from the first positional on is a positional, which keeps option-like words in a
 * prompt as text.
 */
export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      if (config.stopAtFirstPositional) {
        passthrough = true;
      }
      continue;
    }

    if ((token === "--help" || token === "-h") && positionals.length === 0) {
      options.help = true;
      continue;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equalsAt = body.indexOf("=");
      const rawKey = equalsAt === -1 ? body : body.slice(0, equalsAt);
      const inlineValue = equalsAt === -1 ? undefined : body.slice(equalsAt + 1);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      // A value option takes the next token as its value even when that token looks like an
      // option, so `--model --help` stores "--help" as the model.
      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

// A backslash escapes only a quote, whitespace, or another backslash, so Windows paths such as
// C:\work\notes.json keep their separators. A backslash at the start of a token does not escape a
// following backslash, so a UNC path such as \\server\share keeps both leading backslashes.
function isEscapable(character, atTokenStart) {
  if (character === "\\") {
    return !atTokenStart;
  }
  return character === "\"" || character === "'" || /\s/.test(character ?? "");
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let quotedToken = false;
  const characters = [...raw];

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\" && isEscapable(characters[index + 1], current === "")) {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      quotedToken = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (current || quotedToken) {
        tokens.push(current);
        current = "";
        quotedToken = false;
      }
      continue;
    }

    current += character;
  }

  if (current || quotedToken) {
    tokens.push(current);
  }

  return tokens;
}
