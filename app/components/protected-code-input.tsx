/**
 * See: docs/admin-ui-spec.md §5 (Create offer form)
 * Standard: docs/polaris-standards.md §14 (Details / edit-form pattern)
 */
import { useRef, useState } from "react";

import type { CodePickerSuggestion } from "./code-picker";
import { DiscountCreationForm, type NewDiscountState } from "./discount-creation-form";
import type { CodeSummary } from "./discount-preview";

export type { CodePickerSuggestion };

type SelectedCode = {
  code: string;
  discountNodeId?: string;
  isAppOwned: boolean;
  origin: "existing" | "new";
};

export type ProtectedCodeInputProps = {
  mode: "block" | "silent_strip";
  suggestions: CodePickerSuggestion[];
  error?: string;
  onSummaryChange?: (summary: CodeSummary) => void;
};

function toUpper(s: string) {
  return s.trim().toUpperCase();
}

const MAX_RESULTS = 8;

function filterSuggestions(list: CodePickerSuggestion[], search: string) {
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

function describeCode(s: CodePickerSuggestion): string {
  const parts = [s.title];
  if (s.appliesOncePerCustomer) parts.push("once per customer");
  parts.push(s.status.toLowerCase());
  return parts.join(" · ");
}

export function ProtectedCodeInput({
  mode,
  suggestions,
  error,
  onSummaryChange,
}: ProtectedCodeInputProps) {
  const [search, setSearch] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [selected, setSelected] = useState<SelectedCode | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [discountState, setDiscountState] = useState<NewDiscountState | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filtered = filterSuggestions(suggestions, search);
  const noMatch = search.trim().length > 0 && filtered.length === 0;
  const capped = filtered.length === MAX_RESULTS;

  function openDropdown() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setDropdownOpen(true);
  }

  // Delay close so clicks on dropdown items register first
  function scheduleClose() {
    closeTimer.current = setTimeout(() => setDropdownOpen(false), 150);
  }

  function pickExisting(s: CodePickerSuggestion) {
    setSelected({
      code: s.codes[0] ?? search.trim(),
      discountNodeId: s.discountNodeId,
      isAppOwned: false,
      origin: "existing",
    });
    setSearch("");
    setDropdownOpen(false);
    setCreatingNew(false);
    onSummaryChange?.({
      kind: "existing",
      code: s.codes[0] ?? search.trim(),
      description: describeCode(s),
    });
  }

  function clearSelected() {
    setSelected(null);
    setCreatingNew(false);
    onSummaryChange?.({ kind: "none" });
  }

  function startCreatingNew() {
    setSelected(null);
    setCreatingNew(true);
    setDropdownOpen(false);
    onSummaryChange?.({ kind: "none" });
  }

  function cancelCreatingNew() {
    setCreatingNew(false);
    onSummaryChange?.({ kind: "none" });
  }

  function onDiscountChange(state: NewDiscountState) {
    setSelected({ code: state.code, isAppOwned: true, origin: "new" });
    setDiscountState(state);
    onSummaryChange?.({ kind: "new", state });
  }

  const hiddenInputs = selected ? (
    <>
      <input type="hidden" name="protectedCode" value={selected.code} />
      <input
        type="hidden"
        name="protectedCodeDiscountId"
        value={selected.discountNodeId ?? ""}
      />
      <input
        type="hidden"
        name="protectedCodeIsAppOwned"
        value={selected.isAppOwned ? "true" : "false"}
      />
      <input type="hidden" name="protectedCodeOrigin" value={selected.origin} />
      {selected.origin === "new" && discountState ? (
        <input
          type="hidden"
          name="newDiscountData"
          value={JSON.stringify(discountState)}
        />
      ) : null}
    </>
  ) : null;

  // ── Selected existing code ─────────────────────────────────────────────────
  if (selected && !creatingNew) {
    return (
      <s-stack gap="small-300">
        {error ? <s-banner tone="critical">{error}</s-banner> : null}
        {hiddenInputs}
        <s-grid
          gridTemplateColumns="1fr auto"
          gap="small-300"
          alignItems="center"
        >
          <s-badge tone="info">{selected.code}</s-badge>
          <s-button
            variant="tertiary"
            icon="x"
            accessibilityLabel={`Remove ${selected.code}`}
            onClick={clearSelected}
          />
        </s-grid>
      </s-stack>
    );
  }

  // ── Creating a new discount ────────────────────────────────────────────────
  if (creatingNew) {
    return (
      <s-stack gap="base">
        {error ? <s-banner tone="critical">{error}</s-banner> : null}
        {hiddenInputs}
        <DiscountCreationForm initialCode="" onChange={onDiscountChange} />
        <s-button variant="tertiary" onClick={cancelCreatingNew}>
          ← Use an existing code instead
        </s-button>
      </s-stack>
    );
  }

  // ── Search with dropdown ───────────────────────────────────────────────────
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
          setDropdownOpen(true);
        }}
        onFocus={openDropdown}
        onBlur={scheduleClose}
      />

      {dropdownOpen && (filtered.length > 0 || noMatch) ? (
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
                pickExisting(s);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "10px 14px",
                border: "none",
                background: "none",
                cursor: "pointer",
                borderBottom: "1px solid var(--s-color-border-subdued, #f0f0f0)",
                fontSize: "inherit",
                fontFamily: "inherit",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "var(--s-color-bg-surface-hover, #f6f6f7)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "none";
              }}
            >
              <div style={{ fontWeight: 500 }}>{s.codes.join(", ")}</div>
              <div
                style={{
                  fontSize: "0.85em",
                  color: "var(--s-color-text-subdued, #6d7175)",
                  marginTop: "2px",
                }}
              >
                {describeCode(s)}
              </div>
            </button>
          ))}

          {capped ? (
            <div
              style={{
                padding: "8px 14px",
                borderTop: "1px solid var(--s-color-border-subdued, #f0f0f0)",
              }}
            >
              <s-paragraph color="subdued">
                Type to narrow results
              </s-paragraph>
            </div>
          ) : null}

          {noMatch ? (
            <div style={{ padding: "10px 14px" }}>
              {mode === "block" ? (
                <s-paragraph color="subdued">
                  No code found. Create it in Shopify first:{" "}
                  <s-link
                    href="https://admin.shopify.com/discounts/new"
                    target="_blank"
                  >
                    New discount →
                  </s-link>
                </s-paragraph>
              ) : (
                <s-paragraph color="subdued">
                  No code found. Use &quot;Create a new protected code&quot;
                  below.
                </s-paragraph>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {mode === "silent_strip" ? (
        <s-button variant="secondary" onClick={startCreatingNew}>
          + Create a new protected code
        </s-button>
      ) : null}
    </s-stack>
  );
}
