"use client";

import { useSyncExternalStore } from "react";
import { BRANDS, DEFAULT_BRAND, isBrand } from "@/lib/brands";
import type { Brand } from "@/lib/types";

const KEY = "brand";

// The brand every page is currently showing. Per-browser (localStorage), so
// it follows the operator across Board / Discovery / Settings without
// threading it through every link. Call from effects/handlers only.
export function currentBrand(): Brand {
  try {
    const v = localStorage.getItem(KEY);
    return isBrand(v) ? v : DEFAULT_BRAND;
  } catch {
    return DEFAULT_BRAND;
  }
}

const noSubscribe = () => () => {};

// Switching reloads the page: every page fetches its data for currentBrand()
// on mount, so a reload is the whole "refetch everything" story.
export function BrandSwitcher() {
  // null on the server render (no localStorage there), real value on the client.
  const brand = useSyncExternalStore(noSubscribe, currentBrand, () => null);

  return (
    <select
      aria-label="Brand"
      value={brand ?? DEFAULT_BRAND}
      disabled={brand === null}
      onChange={(e) => {
        try {
          localStorage.setItem(KEY, e.target.value);
        } catch {}
        window.location.reload();
      }}
    >
      {BRANDS.map((b) => (
        <option key={b.id} value={b.id}>
          {b.label}
        </option>
      ))}
    </select>
  );
}
