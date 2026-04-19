/**
 * See: docs/admin-ui-spec.md §5 (Suggested + Other sections, manual code entry)
 * Standard: docs/polaris-standards.md §9 (Stack vs Grid), §6 (Choice list / checkbox)
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

function describeSuggestion(s: CodePickerSuggestion): string {
  const parts: string[] = [s.title];
  if (s.appliesOncePerCustomer) parts.push("once per customer");
  parts.push(s.status.toLowerCase());
  return parts.join(" · ");
}

export function CodePicker({ suggested, other, error }: CodePickerProps) {
  const [selected, setSelected] = useState<SelectedCode[]>([]);
  const [manual, setManual] = useState("");
  const [manualMissing, setManualMissing] = useState<string | null>(null);

  function isSelectedCode(upper: string): boolean {
    return selected.some((s) => toUpper(s.code) === upper);
  }

  function addFromSuggestion(
    s: CodePickerSuggestion,
    origin: "suggested" | "other",
  ) {
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
    setSelected((cur) => cur.filter((c) => !upperSet.has(toUpper(c.code))));
  }

  function isSuggestionChecked(s: CodePickerSuggestion): boolean {
    return s.codes.every((c) => isSelectedCode(toUpper(c)));
  }

  function toggleSuggestion(
    s: CodePickerSuggestion,
    origin: "suggested" | "other",
  ) {
    if (isSuggestionChecked(s)) removeFromSuggestion(s);
    else addFromSuggestion(s, origin);
  }

  function onAddManual() {
    const code = manual.trim();
    if (!code) return;
    setManualMissing(null);
    if (isSelectedCode(toUpper(code))) {
      setManual("");
      return;
    }
    const hitSuggested = findSuggestionByCode(suggested, code);
    const hitOther = findSuggestionByCode(other, code);
    const hit = hitSuggested ?? hitOther;
    if (hit) {
      addFromSuggestion(hit, hitSuggested ? "suggested" : "other");
      setManual("");
      return;
    }
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

  return (
    <s-stack gap="base">
      {error ? <s-banner tone="critical">{error}</s-banner> : null}

      <s-section heading="Suggested codes">
        {suggested.length === 0 ? (
          <s-paragraph color="subdued">
            No welcome-style discounts found in your store yet.
          </s-paragraph>
        ) : (
          <s-stack gap="small-300">
            {suggested.map((s) => (
              <s-checkbox
                key={s.discountNodeId}
                name={`suggestion-${s.discountNodeId}`}
                label={s.codes.join(", ")}
                details={describeSuggestion(s)}
                checked={isSuggestionChecked(s)}
                onChange={() => toggleSuggestion(s, "suggested")}
              />
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Other active discounts">
        {other.length === 0 ? (
          <s-paragraph color="subdued">
            No other active discounts found.
          </s-paragraph>
        ) : (
          <s-stack gap="small-300">
            {other.map((s) => (
              <s-checkbox
                key={s.discountNodeId}
                name={`suggestion-${s.discountNodeId}`}
                label={s.codes.join(", ")}
                details={describeSuggestion(s)}
                checked={isSuggestionChecked(s)}
                onChange={() => toggleSuggestion(s, "other")}
              />
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Add a code manually">
        <s-grid gridTemplateColumns="1fr auto" gap="small-300" alignItems="end">
          <s-text-field
            name="manual-code"
            label="Discount code"
            labelAccessibilityVisibility="exclusive"
            placeholder="Enter a discount code"
            value={manual}
            onChange={(e) => setManual(e.currentTarget.value)}
          />
          <s-button variant="secondary" onClick={onAddManual}>
            Add
          </s-button>
        </s-grid>

        {manualMissing ? (
          <CreateNewDiscount
            code={manualMissing}
            onCreated={onCreatedManual}
            onCancel={() => setManualMissing(null)}
          />
        ) : null}
      </s-section>

      <s-section heading="Selected">
        {selected.length === 0 ? (
          <s-paragraph color="subdued">No codes selected yet.</s-paragraph>
        ) : (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            {selected.map((s) => (
              <s-stack
                key={toUpper(s.code)}
                direction="inline"
                gap="small-100"
                alignItems="center"
              >
                <s-badge tone="info">{s.code}</s-badge>
                <s-button
                  variant="tertiary"
                  icon="x"
                  accessibilityLabel={`Remove ${s.code}`}
                  onClick={() => removeSelected(toUpper(s.code))}
                />
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-section>

      <input
        type="hidden"
        name="selectedCodes"
        value={JSON.stringify(selected)}
      />
    </s-stack>
  );
}
