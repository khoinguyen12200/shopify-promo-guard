/**
 * See: docs/admin-ui-spec.md §5 (Create offer form + silent-strip confirmation)
 * Related: docs/system-design.md § Replace-in-place (T34)
 */
import { Form, useSubmit } from "react-router";
import { useRef, useState } from "react";

import {
  CodePicker,
  type CodePickerSuggestion,
  type SelectedCode,
} from "./code-picker";
import { ReplaceInPlaceModal } from "./replace-in-place-modal";

export type OfferFormProps = {
  suggested: CodePickerSuggestion[];
  other: CodePickerSuggestion[];
  fieldErrors?: {
    name?: string;
    codes?: string;
    form?: string;
  };
  defaultValues?: {
    name?: string;
    mode?: "block" | "silent_strip";
  };
};

function nativeCodesNeedingReplacement(selected: SelectedCode[]): string[] {
  // "suggested" / "other" / "existing" all mean the code resolves to a native
  // non-app-owned Shopify discount. "manual-missing" means we just created
  // an app-owned discount for it via T33 — no replace-in-place needed.
  return selected
    .filter((s) => !s.isAppOwned && s.origin !== "manual-missing")
    .map((s) => s.code);
}

export function OfferForm({
  suggested,
  other,
  fieldErrors,
  defaultValues,
}: OfferFormProps) {
  const [name, setName] = useState(defaultValues?.name ?? "");
  const [mode, setMode] = useState<"block" | "silent_strip">(
    defaultValues?.mode ?? "silent_strip",
  );
  const [pendingReplaceCodes, setPendingReplaceCodes] = useState<
    string[] | null
  >(null);
  const formRef = useRef<HTMLFormElement>(null);
  const submit = useSubmit();

  function readSelectedFromForm(): SelectedCode[] {
    const form = formRef.current;
    if (!form) return [];
    const raw = new FormData(form).get("selectedCodes");
    if (typeof raw !== "string") return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SelectedCode[]) : [];
    } catch {
      return [];
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    if (mode !== "silent_strip") return;
    const selected = readSelectedFromForm();
    const needs = nativeCodesNeedingReplacement(selected);
    if (needs.length === 0) return;
    e.preventDefault();
    setPendingReplaceCodes(needs);
  }

  function confirmReplace() {
    setPendingReplaceCodes(null);
    if (formRef.current) submit(formRef.current);
  }

  return (
    <Form method="post" ref={formRef} onSubmit={onSubmit}>
      {fieldErrors?.form ? (
        <s-banner tone="critical">{fieldErrors.form}</s-banner>
      ) : null}

      {pendingReplaceCodes ? (
        <s-section>
          <ReplaceInPlaceModal
            codes={pendingReplaceCodes}
            onConfirm={confirmReplace}
            onCancel={() => setPendingReplaceCodes(null)}
          />
        </s-section>
      ) : null}

      <s-section heading="Name">
        <s-text-field
          name="name"
          label="Name"
          value={name}
          required
          error={fieldErrors?.name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </s-section>

      <s-section heading="Codes">
        <CodePicker
          suggested={suggested}
          other={other}
          error={fieldErrors?.codes}
        />
      </s-section>

      <s-section heading="What happens when someone reuses this offer?">
        <s-stack gap="base">
          <s-stack direction="inline" gap="small" alignItems="start">
            <input
              type="radio"
              id="mode-silent"
              name="mode"
              value="silent_strip"
              checked={mode === "silent_strip"}
              onChange={() => setMode("silent_strip")}
            />
            <s-stack gap="small">
              <label htmlFor="mode-silent">
                <s-text>Silently don&apos;t apply the discount (recommended)</s-text>
              </label>
              <s-text color="subdued">
                The customer can still check out — they just don&apos;t get the
                discount. Works best for most stores.
              </s-text>
            </s-stack>
          </s-stack>
          <s-stack direction="inline" gap="small" alignItems="start">
            <input
              type="radio"
              id="mode-block"
              name="mode"
              value="block"
              checked={mode === "block"}
              onChange={() => setMode("block")}
            />
            <s-stack gap="small">
              <label htmlFor="mode-block">
                <s-text>Block their checkout</s-text>
              </label>
              <s-text color="subdued">
                Stops the checkout with an error message. Stronger, but can
                frustrate legitimate customers.
              </s-text>
            </s-stack>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack direction="inline" gap="base">
          <s-button href="/app/offers">Cancel</s-button>
          <s-button type="submit" variant="primary">
            Create offer
          </s-button>
        </s-stack>
      </s-section>
    </Form>
  );
}
