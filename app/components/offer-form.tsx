/**
 * See: docs/admin-ui-spec.md §5 (Create offer form + silent-strip confirmation)
 * Standard: docs/polaris-standards.md §14 (Details / edit-form pattern)
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
  pageHeading: string;
  submitLabel: string;
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
  suggestError?: string | null;
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
  pageHeading,
  submitLabel,
  suggested,
  other,
  fieldErrors,
  defaultValues,
  suggestError,
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
      <s-page heading={pageHeading}>
        <s-link slot="breadcrumb-actions" href="/app/offers">
          Offers
        </s-link>
        <s-button slot="secondary-actions" href="/app/offers">
          Cancel
        </s-button>
        <s-button slot="primary-action" variant="primary" type="submit">
          {submitLabel}
        </s-button>

        {suggestError ? (
          <s-banner tone="warning">
            We couldn&apos;t load discounts from your store. You can still add
            codes manually. ({suggestError})
          </s-banner>
        ) : null}

        {fieldErrors?.form ? (
          <s-banner tone="critical">{fieldErrors.form}</s-banner>
        ) : null}

        {pendingReplaceCodes ? (
          <ReplaceInPlaceModal
            codes={pendingReplaceCodes}
            onConfirm={confirmReplace}
            onCancel={() => setPendingReplaceCodes(null)}
          />
        ) : null}

        <s-section heading="Offer information">
          <s-grid gap="base">
            <s-text-field
              name="name"
              label="Name"
              labelAccessibilityVisibility="visible"
              value={name}
              required
              details="A short internal name you'll recognise in the offers list."
              error={fieldErrors?.name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </s-grid>
        </s-section>

        <s-section heading="Protected codes">
          <CodePicker
            suggested={suggested}
            other={other}
            error={fieldErrors?.codes}
          />
        </s-section>

        {/* Aside: enforcement mode is secondary — narrower column keeps the
            main flow focused on naming and picking codes */}
        <s-section slot="aside" heading="Enforcement mode">
          <s-grid gap="small-300">
            <s-choice-list
              name="mode"
              label="Enforcement mode"
              labelAccessibilityVisibility="exclusive"
              values={[mode]}
              onChange={(e) => {
                const value = (e.target as HTMLInputElement | null)?.value;
                if (value === "silent_strip" || value === "block") setMode(value);
              }}
            >
              <s-choice value="silent_strip">
                Silently skip the discount (recommended)
              </s-choice>
              <s-choice value="block">Block their checkout</s-choice>
            </s-choice-list>
            <s-paragraph color="subdued">
              {mode === "silent_strip"
                ? "The customer can still check out — they just won't get the discount. Works best for most stores."
                : "Stops the checkout with an error message. Stronger, but can frustrate legitimate customers."}
            </s-paragraph>
          </s-grid>
        </s-section>
      </s-page>
    </Form>
  );
}
