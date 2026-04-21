/**
 * See: docs/admin-ui-spec.md §5 (Create offer — code picker)
 * Standard: docs/polaris-standards.md §6 (text-field), §9 (Stack vs Grid)
 * Related: app/lib/discount-query.server.ts (suggestDiscounts)
 *
 * Search field with a typeahead dropdown. One code per offer. We auto-refresh
 * the suggestion list when the merchant returns to the tab — they often hop
 * over to Shopify admin to create a discount via the deep-link button below.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";

import type { DiscountSuggestion } from "../lib/discount-query.server";

export type CodePickerSuggestion = DiscountSuggestion;

export type SelectedCode = {
  code: string;
  discountNodeId?: string;
};

export type CodePickerProps = {
  suggestions: CodePickerSuggestion[];
  shopDomain: string;
  initialValue?: SelectedCode | null;
  error?: string;
};

const MAX_RESULTS = 8;

function toUpper(s: string) {
  return s.trim().toUpperCase();
}

function describeSuggestion(s: CodePickerSuggestion): string {
  const parts: string[] = [s.title];
  if (s.appliesOncePerCustomer) parts.push("once per customer");
  parts.push(s.status.toLowerCase());
  return parts.join(" · ");
}

function filterSuggestions(
  list: CodePickerSuggestion[],
  search: string,
): CodePickerSuggestion[] {
  const upper = toUpper(search);
  if (!upper) return list.slice(0, MAX_RESULTS);
  return list
    .filter(
      (s) =>
        s.codes.some((c) => toUpper(c).includes(upper)) ||
        s.title.toUpperCase().includes(upper),
    )
    .slice(0, MAX_RESULTS);
}

type RefreshData = {
  suggestions?: CodePickerSuggestion[];
};

export function CodePicker({
  suggestions: initialSuggestions,
  shopDomain,
  initialValue,
  error,
}: CodePickerProps) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<SelectedCode | null>(
    initialValue ?? null,
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useFetcher<RefreshData>();

  // Re-query the merchant's discounts when they return to this tab (they
  // often hop to Shopify admin to create a discount via the button below).
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") {
        refresh.load("?_data=suggestions");
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const suggestions = refresh.data?.suggestions ?? initialSuggestions;
  const filtered = filterSuggestions(suggestions, search);
  const noMatch = search.trim().length > 0 && filtered.length === 0;

  const newDiscountUrl = useMemo(
    () => `https://admin.shopify.com/store/${shopDomain}/discounts/new`,
    [shopDomain],
  );

  function openDropdown() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  }

  // Delay close so dropdown clicks register before blur hides them.
  function scheduleClose() {
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }

  function pick(s: CodePickerSuggestion) {
    const code = s.codes[0] ?? "";
    setSelected({ code, discountNodeId: s.discountNodeId });
    setSearch("");
    setOpen(false);
  }

  function clear() {
    setSelected(null);
  }

  if (selected) {
    return (
      <s-stack gap="small-300">
        {error ? <s-banner tone="critical">{error}</s-banner> : null}
        <input type="hidden" name="code" value={selected.code} />
        <input
          type="hidden"
          name="discountNodeId"
          value={selected.discountNodeId ?? ""}
        />
        <s-grid
          gridTemplateColumns="1fr auto"
          gap="small-300"
          alignItems="center"
        >
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-badge tone="info">{selected.code}</s-badge>
          </s-stack>
          <s-button
            variant="tertiary"
            icon="x"
            accessibilityLabel={`Remove ${selected.code}`}
            onClick={clear}
          />
        </s-grid>
        <s-paragraph color="subdued">
          One code per protected offer. Remove this one to pick a different
          code.
        </s-paragraph>
      </s-stack>
    );
  }

  return (
    <s-stack gap="small-300">
      {error ? <s-banner tone="critical">{error}</s-banner> : null}

      <s-text-field
        label="Discount code"
        labelAccessibilityVisibility="visible"
        placeholder="Search your store's discount codes"
        value={search}
        onChange={(e) => {
          setSearch(e.currentTarget.value);
          setOpen(true);
        }}
        onFocus={openDropdown}
        onBlur={scheduleClose}
      />

      {open && (filtered.length > 0 || noMatch) ? (
        <div
          style={{
            background: "var(--s-color-bg-surface, #fff)",
            border: "1px solid var(--s-color-border, #e0e0e0)",
            borderRadius: "var(--s-border-radius-base, 4px)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
            maxHeight: "280px",
            overflowY: "auto",
          }}
        >
            {filtered.map((s) => (
              <button
                key={s.discountNodeId}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "start",
                  padding: "10px 14px",
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  borderBlockEnd:
                    "1px solid var(--s-color-border-subdued, #f0f0f0)",
                  fontSize: "inherit",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "var(--s-color-bg-surface-hover, #f6f6f7)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "none";
                }}
              >
                <div style={{ fontWeight: 500 }}>{s.codes.join(", ")}</div>
                <div
                  style={{
                    fontSize: "0.85em",
                    color: "var(--s-color-text-subdued, #6d7175)",
                    marginBlockStart: "2px",
                  }}
                >
                  {describeSuggestion(s)}
                </div>
              </button>
            ))}

            {noMatch ? (
              <div style={{ padding: "10px 14px" }}>
                <s-paragraph color="subdued">
                  No code matches &quot;{search.trim()}&quot;. Create it in
                  Shopify first using the button below.
                </s-paragraph>
              </div>
          ) : null}
        </div>
      ) : null}

      <s-paragraph color="subdued">
        Don&apos;t see your code? Create the discount in Shopify, then come
        back — the list refreshes automatically.
      </s-paragraph>
      <s-stack direction="inline" gap="small-300">
        <s-button href={newDiscountUrl} target="_blank">
          Create a discount in Shopify ↗
        </s-button>
      </s-stack>
    </s-stack>
  );
}
