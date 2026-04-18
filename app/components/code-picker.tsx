/**
 * See: docs/admin-ui-spec.md §5 (Suggested + Other sections, manual code entry)
 * Related: app/lib/discount-query.server.ts (suggestDiscounts)
 */
import { useCallback, useState } from "react";

import type { DiscountSuggestion } from "../lib/discount-query.server";
import {
  CreateNewDiscount,
  type CreateNewDiscountResult,
} from "./create-new-discount";

export type CodePickerSuggestion = DiscountSuggestion;

export type SelectedCode = {
  code: string;
  discountNodeId?: string;
  isAppOwned?: boolean;
  /**
   * "existing" = we resolved it against Shopify and it already exists there.
   * "manual-missing" = merchant typed a code we couldn't find; T33 creates it.
   */
  origin: "suggested" | "other" | "existing" | "manual-missing";
};

export type CodePickerProps = {
  /**
   * Suggested discounts, already split into two tabs by the server:
   * "suggested" = appliesOncePerCustomer + welcome-named.
   * "other" = everything else.
   */
  suggested: CodePickerSuggestion[];
  other: CodePickerSuggestion[];
  error?: string;
};

function toUpper(code: string): string {
  return code.trim().toUpperCase();
}

function findSuggestionByCode(
  list: CodePickerSuggestion[],
  code: string,
): CodePickerSuggestion | undefined {
  const upper = toUpper(code);
  return list.find((s) => s.codes.some((c) => toUpper(c) === upper));
}

export function CodePicker({ suggested, other, error }: CodePickerProps) {
  const [selected, setSelected] = useState<SelectedCode[]>([]);
  const [manual, setManual] = useState("");
  const [manualMissing, setManualMissing] = useState<string | null>(null);
  const [tab, setTab] = useState<"suggested" | "other">("suggested");

  function isSelectedCode(upper: string): boolean {
    return selected.some((s) => toUpper(s.code) === upper);
  }

  function addFromSuggestion(
    s: CodePickerSuggestion,
    origin: "suggested" | "other",
  ) {
    // Add every code attached to this discount node.
    const next = [...selected];
    for (const code of s.codes) {
      if (isSelectedCode(toUpper(code))) continue;
      next.push({
        code,
        discountNodeId: s.discountNodeId,
        isAppOwned: false,
        origin,
      });
    }
    setSelected(next);
  }

  function removeFromSuggestion(s: CodePickerSuggestion) {
    const upperSet = new Set(s.codes.map(toUpper));
    setSelected((cur) =>
      cur.filter((c) => !upperSet.has(toUpper(c.code))),
    );
  }

  function isSuggestionChecked(s: CodePickerSuggestion): boolean {
    return s.codes.every((c) => isSelectedCode(toUpper(c)));
  }

  function toggleSuggestion(
    s: CodePickerSuggestion,
    origin: "suggested" | "other",
  ) {
    if (isSuggestionChecked(s)) {
      removeFromSuggestion(s);
    } else {
      addFromSuggestion(s, origin);
    }
  }

  function onAddManual() {
    const code = manual.trim();
    if (!code) return;
    setManualMissing(null);
    if (isSelectedCode(toUpper(code))) {
      setManual("");
      return;
    }
    // Case A: code matches one of the suggestion nodes we already fetched.
    const hitSuggested = findSuggestionByCode(suggested, code);
    const hitOther = findSuggestionByCode(other, code);
    const hit = hitSuggested ?? hitOther;
    if (hit) {
      addFromSuggestion(hit, hitSuggested ? "suggested" : "other");
      setManual("");
      return;
    }
    // Case B: doesn't exist (that we know of). Open T33 subform.
    setManualMissing(code);
  }

  function removeSelected(upper: string) {
    setSelected((cur) => cur.filter((s) => toUpper(s.code) !== upper));
  }

  const onCreatedManual = useCallback(
    (result: CreateNewDiscountResult) => {
      setSelected((cur) => {
        const upper = toUpper(result.code);
        if (cur.some((s) => toUpper(s.code) === upper)) return cur;
        return [
          ...cur,
          {
            code: result.code,
            discountNodeId: result.discountNodeId,
            isAppOwned: true,
            origin: "manual-missing",
          },
        ];
      });
      setManualMissing(null);
      setManual("");
    },
    [],
  );

  const tabsButton = (which: "suggested" | "other") => (
    <s-button
      key={which}
      variant={tab === which ? "primary" : "secondary"}
      onClick={() => setTab(which)}
    >
      {which === "suggested"
        ? `Suggested (${suggested.length})`
        : `Other (${other.length})`}
    </s-button>
  );

  const active = tab === "suggested" ? suggested : other;

  return (
    <s-stack gap="base">
      <s-heading>Which codes count as this welcome offer?</s-heading>

      {error ? <s-banner tone="critical">{error}</s-banner> : null}

      <s-stack direction="inline" gap="small">
        {tabsButton("suggested")}
        {tabsButton("other")}
      </s-stack>

      {active.length === 0 ? (
        <s-text color="subdued">
          {tab === "suggested"
            ? "No welcome-style discounts found in your store yet."
            : "No other active discounts found."}
        </s-text>
      ) : (
        <s-stack gap="small">
          {active.map((s) => {
            const checked = isSuggestionChecked(s);
            return (
              <s-stack
                key={s.discountNodeId}
                direction="inline"
                gap="base"
                alignItems="center"
              >
                <s-checkbox
                  name={`suggestion-${s.discountNodeId}`}
                  label={s.codes.join(", ")}
                  checked={checked}
                  onChange={() => toggleSuggestion(s, tab)}
                />
                <s-text color="subdued">
                  {s.title}
                  {s.appliesOncePerCustomer ? " · once per customer" : ""}
                  {" · "}
                  {s.status.toLowerCase()}
                </s-text>
              </s-stack>
            );
          })}
        </s-stack>
      )}

      <s-divider />

      <s-heading>Or add a code manually</s-heading>
      <s-stack direction="inline" gap="base" alignItems="end">
        <s-text-field
          name="manual-code"
          label="Code"
          value={manual}
          onChange={(e) => setManual(e.currentTarget.value)}
        />
        <s-button onClick={onAddManual}>Add</s-button>
      </s-stack>

      {manualMissing ? (
        <CreateNewDiscount
          code={manualMissing}
          onCreated={onCreatedManual}
          onCancel={() => setManualMissing(null)}
        />
      ) : null}

      <s-divider />

      <s-heading>Selected</s-heading>
      {selected.length === 0 ? (
        <s-text color="subdued">No codes selected yet.</s-text>
      ) : (
        <s-stack direction="inline" gap="small">
          {selected.map((s) => (
            <s-stack
              key={toUpper(s.code)}
              direction="inline"
              gap="small"
              alignItems="center"
            >
              <s-badge tone="info">{s.code}</s-badge>
              <s-button
                variant="tertiary"
                onClick={() => removeSelected(toUpper(s.code))}
              >
                Remove
              </s-button>
            </s-stack>
          ))}
        </s-stack>
      )}

      {/* Hidden input carries the selected list across form submit. */}
      <input
        type="hidden"
        name="selectedCodes"
        value={JSON.stringify(selected)}
      />
    </s-stack>
  );
}
