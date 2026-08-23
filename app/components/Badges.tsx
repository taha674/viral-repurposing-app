import type { RedLineFlag } from "@/lib/types";

export function FlagBadge({ flag }: { flag: RedLineFlag }) {
  if (flag === "rejected") return <span className="badge red">rejected</span>;
  if (flag === "needs_review")
    return <span className="badge amber">needs review</span>;
  return <span className="badge">no flag</span>;
}

export function Badge({
  tone,
  children,
}: {
  tone?: "green" | "amber" | "red";
  children: React.ReactNode;
}) {
  return <span className={`badge ${tone ?? ""}`}>{children}</span>;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
