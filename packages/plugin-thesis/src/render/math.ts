/**
 * Format-neutral pre-validation of LaTeX math (MTH-001). The Typst math converter fails hard on
 * unknown commands, breaks on a backtick inside `\text{}` and renders unbalanced groups silently
 * (spec 16.1), so every formula is checked here before any adapter sees it.
 */

export const maxMathLength = 2000;

// Commands that are not math: file access, macro definition, catcodes, shell escapes.
const forbidden =
  /\\(input|include|includeonly|write|read|openin|openout|immediate|def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|usepackage|documentclass|catcode|csname|expandafter|verb|lstinline|href|url|includegraphics|special|jobname|detokenize|scantokens|directlua|luaexec|pdfliteral|openout|closeout)(?![A-Za-z])/;

/** The first problem found in a LaTeX math fragment, or undefined when it is acceptable. */
export function validateLatex(latex: string): string | undefined {
  if (latex.trim() === "") return "Empty formula";
  if (latex.length > maxMathLength) return `Formula is longer than ${maxMathLength} characters`;
  if (latex.includes("`")) return "Formula contains a backtick";
  if (latex.includes("\0")) return "Formula contains a NUL character";
  const bad = forbidden.exec(latex);
  if (bad) return `Formula uses the non-math command \\${bad[1]}`;
  if (/(?<!\\)\$/.test(latex)) return "Formula contains an unescaped $";

  // Brace balance (escaped braces `\{` `\}` do not count).
  let depth = 0;
  for (let index = 0; index < latex.length; index += 1) {
    const char = latex[index] as string;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth < 0) return "Unbalanced braces: a } has no matching {";
    }
  }
  if (depth !== 0) return "Unbalanced braces: a { is never closed";

  // \left ... \right and \begin ... \end must pair up.
  const left = (latex.match(/\\left(?![A-Za-z])/g) ?? []).length;
  const right = (latex.match(/\\right(?![A-Za-z])/g) ?? []).length;
  if (left !== right) return "Unbalanced \\left / \\right delimiters";
  const stack: string[] = [];
  for (const match of latex.matchAll(/\\(begin|end)\{([A-Za-z*]+)\}/g)) {
    if (match[1] === "begin") stack.push(match[2] as string);
    else if (stack.pop() !== match[2]) return `Mismatched \\end{${match[2]}}`;
  }
  if (stack.length > 0) return `Environment ${stack[stack.length - 1]} is never closed`;

  // Plain (...) and [...] may be unbalanced in math (intervals such as [0, 1)), so only braces,
  // \left/\right and environments are enforced.
  return undefined;
}
