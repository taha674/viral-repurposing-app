"use client";

import { diffWords } from "@/lib/diff";

// Word-level colored diff of the source transcript vs the adapted script —
// red-line-compliance edits should be visible at a glance, not something you
// have to eyeball two textareas to spot.
export default function DiffView({ before, after }: { before: string; after: string }) {
  const tokens = diffWords(before, after);
  return (
    <div className="diff-view">
      {tokens.map((t, i) => {
        if (t.op === "equal") return <span key={i}>{t.text}</span>;
        const cls = t.op === "delete" ? "diff-delete" : "diff-insert";
        return (
          <span key={i} className={cls}>
            {t.text}
          </span>
        );
      })}
    </div>
  );
}
