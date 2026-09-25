/**
 * Auto-reply rules can use regular expressions, and they run on every incoming message. A pattern
 * like (a+)+ or (x|xy)* takes exponential time on some inputs and would freeze the server for every
 * business, so patterns with repetition inside a repeated group, or with back-references, are refused.
 */
export function regexProblem(pattern: string): string | null {
  if (pattern.length > 200) return 'Keep patterns under 200 characters';
  if (/\\[1-9]|\\k</.test(pattern)) return 'Back-references (\\1, \\k<name>) are not allowed';
  const groups: Array<{ repeats: boolean }> = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      groups.push({ repeats: false });
      // Skip group markers such as ?: ?= ?! ?<= ?<! ?<name> so they aren't read as quantifiers.
      if (pattern[i + 1] === '?') {
        const named = /^\?<[A-Za-z_$][\w$]*>/.exec(pattern.slice(i + 1));
        i += named ? named[0].length : pattern[i + 2] === '<' ? 3 : 2;
      }
      continue;
    }
    if (ch === ')') {
      const group = groups.pop();
      const quantified = /[*+{]/.test(pattern[i + 1] ?? '');
      if (group?.repeats && quantified) return 'Repetition inside a repeated group, like (a+)+ or (a|b)*, is not allowed';
      if (groups.length && (group?.repeats || quantified)) groups[groups.length - 1].repeats = true;
      continue;
    }
    if (ch === '|' || ch === '*' || ch === '+' || ch === '{') {
      if (groups.length) groups[groups.length - 1].repeats = true;
    }
  }
  return null;
}
