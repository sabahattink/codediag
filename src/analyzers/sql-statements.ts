/**
 * Splits PostgreSQL source into statements for pattern matching, without a
 * full parser. Comments are dropped, string literals and dollar-quoted
 * bodies (function definitions) become '', quoted identifiers are kept, and
 * whitespace collapses to single spaces.
 */

export interface SqlStatement {
  text: string;
  /** Offset of the statement's first character in the source. */
  offset: number;
}

const IDENTIFIER_CHAR = /[\w$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/** The index just past a quoted run that starts at `start`; doubled quotes escape. */
function skipQuoted(
  source: string,
  start: number,
  quote: string,
  backslashEscapes: boolean,
): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (backslashEscapes && char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) {
      if (source[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index++;
  }
  return source.length;
}

/** The index just past a block comment; PostgreSQL block comments nest. */
function skipBlockComment(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    if (source.startsWith("/*", index)) {
      depth++;
      index += 2;
    } else if (source.startsWith("*/", index)) {
      depth--;
      index += 2;
      if (depth === 0) return index;
    } else {
      index++;
    }
  }
  return source.length;
}

export function sqlStatements(source: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let buffer = "";
  let start = -1;
  let index = 0;

  const flush = () => {
    const text = buffer.replace(/\s+/g, " ").trim();
    if (text && start >= 0) statements.push({ text, offset: start });
    buffer = "";
    start = -1;
  };
  const begin = () => {
    if (start < 0) start = index;
  };

  while (index < source.length) {
    const char = source[index] ?? "";
    if (source.startsWith("--", index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      buffer += " ";
    } else if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index);
      buffer += " ";
    } else if (char === "'") {
      begin();
      // E'...' strings accept backslash escapes.
      const escapes =
        /[eE]/.test(source[index - 1] ?? "") &&
        !IDENTIFIER_CHAR.test(source[index - 2] ?? "");
      index = skipQuoted(source, index, "'", escapes);
      buffer += "''";
    } else if (char === '"') {
      begin();
      const end = skipQuoted(source, index, '"', false);
      buffer += source.slice(index, end);
      index = end;
    } else if (
      char === "$" &&
      !IDENTIFIER_CHAR.test(source[index - 1] ?? "") &&
      DOLLAR_TAG.test(source.slice(index, index + 66))
    ) {
      begin();
      const tag = DOLLAR_TAG.exec(source.slice(index, index + 66))?.[0] ?? "$$";
      const end = source.indexOf(tag, index + tag.length);
      index = end === -1 ? source.length : end + tag.length;
      buffer += "''";
    } else if (char === ";") {
      flush();
      index++;
    } else {
      if (!/\s/.test(char)) begin();
      buffer += char;
      index++;
    }
  }
  flush();
  return statements;
}

/** One identifier: "Quoted ""Name""" or unquoted_name. */
export const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
/** An optionally schema-qualified name. */
export const QUALIFIED_NAME = String.raw`${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?`;

/** Unquoted identifiers fold to lower case; quoted ones keep their text. */
export function identifierValue(text: string): string {
  return text.startsWith('"')
    ? text.slice(1, -1).replace(/""/g, '"')
    : text.toLowerCase();
}

export interface QualifiedName {
  schema: string | null;
  name: string;
}

export function qualifiedName(text: string): QualifiedName {
  const parts = text.trim().match(new RegExp(IDENTIFIER, "g")) ?? [];
  const [first = "", second] = parts;
  return second === undefined
    ? { schema: null, name: identifierValue(first) }
    : { schema: identifierValue(first), name: identifierValue(second) };
}

/** The text inside the parentheses that open at `open`, or null if unbalanced. */
export function parenthesized(text: string, open: number): string | null {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")") {
      depth--;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return null;
}

/** The 1-based line of an offset. */
export function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}
