import type { Brand } from "./types";

// Every brand the pipeline runs for (multi-brand, 2026-10-17). Cyrus is the
// default everywhere a brand isn't given, so pre-brand callers (old bookmarks,
// the Instagram bot, Hermes without the new arg) keep meaning Cyrus.
export const BRANDS: { id: Brand; label: string }[] = [
  { id: "cyrus", label: "Cyrus Amin" },
  { id: "nuronomics", label: "Nuronomics" },
];

export const DEFAULT_BRAND: Brand = "cyrus";

export function isBrand(v: unknown): v is Brand {
  return BRANDS.some((b) => b.id === v);
}

// Missing → default; present but unknown → throw, so a typo never silently
// files a reel under the wrong brand.
export function parseBrand(v: unknown): Brand {
  if (v === undefined || v === null || v === "") return DEFAULT_BRAND;
  if (!isBrand(v)) throw new Error(`Unknown brand: ${String(v)}`);
  return v;
}

// Settings key for a brand-scoped setting. Cyrus keeps the bare pre-brand
// key so overrides saved before multi-brand still apply to it.
export function brandKey(key: string, brand: Brand): string {
  return brand === DEFAULT_BRAND ? key : `${key}:${brand}`;
}
