// Word-level diff between a source transcript and its adapted script, for
// the Adaptation stage popup's colored diff view. A plain LCS table is
// enough here: both texts are capped well under VOICEOVER_MAX_CHARS (6000
// chars, config.ts), so this never runs on anything large enough to need a
// smarter algorithm (Myers, etc.) or a dependency.

export type DiffOp = "equal" | "delete" | "insert";
export interface DiffToken {
  op: DiffOp;
  text: string; // the token, plus the whitespace that followed it in the source
}

// Splits on whitespace but keeps the whitespace attached to the preceding
// word, so re-joining tokens in order reproduces the original spacing.
function tokenize(text: string): string[] {
  const matches = text.match(/\S+\s*/g);
  return matches ?? [];
}

export function diffWords(before: string, after: string): DiffToken[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;

  // Standard LCS DP table over tokens (compared trimmed, so trailing
  // whitespace differences don't break a match).
  const key = (t: string) => t.trim();
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        key(a[i]) === key(b[j])
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) {
      tokens.push({ op: "equal", text: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      tokens.push({ op: "delete", text: a[i] });
      i++;
    } else {
      tokens.push({ op: "insert", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    tokens.push({ op: "delete", text: a[i] });
    i++;
  }
  while (j < m) {
    tokens.push({ op: "insert", text: b[j] });
    j++;
  }
  return tokens;
}
