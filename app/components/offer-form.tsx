/**
 * See: docs/admin-ui-spec.md §5 (Create offer form + silent-strip confirmation)
 * Standard: docs/polaris-standards.md §14 (Details / edit-form pattern)
 * Related: docs/system-design.md § Replace-in-place (T34)
 */
import { useSubmit, useNavigation } from "react-router";
import { useRef, useState } from "react";

import {
  ProtectedCodeInput,
  type CodePickerSuggestion,
} from "./protected-code-input";
import { ReplaceInPlaceModal } from "./replace-in-place-modal";
import { DiscountPreview, type CodeSummary } from "./discount-preview";

export type { CodePickerSuggestion };

export type OfferFormProps = {
  pageHeading: string;
  submitLabel: string;
  suggestions: CodePickerSuggestion[];
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

export function OfferForm({
  pageHeading,
  submitLabel,
  suggestions,
  fieldErrors,
  defaultValues,
  suggestError,
}: OfferFormProps) {
  const [name, setName] = useState(defaultValues?.name ?? "");
  const [mode, setMode] = useState<"block" | "silent_strip">(
    defaultValues?.mode ?? "silent_strip",
  );
  const [pendingReplaceCode, setPendingReplaceCode] = useState<string | null>(
    null,
  );
  const [summary, setSummary] = useState<CodeSummary>({ kind: "none" });
  const formRef = useRef<HTMLFormElement>(null);
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  function handleSubmit() {
    const form = formRef.current;
    if (!form) return;

    const data = new FormData(form);
    const origin = data.get("protectedCodeOrigin");
    const isAppOwned = data.get("protectedCodeIsAppOwned");
    const code = String(data.get("protectedCode") ?? "");
    const currentMode = String(data.get("mode") ?? mode);

    if (
      origin === "existing" &&
      isAppOwned === "false" &&
      currentMode === "silent_strip" &&
      code
    ) {
      setPendingReplaceCode(code);
      return;
    }

    submit(form);
  }

  function confirmReplace() {
    setPendingReplaceCode(null);
    if (formRef.current) submit(formRef.current);
  }

  return (
    <form method="post" ref={formRef}>
      <s-page heading={pageHeading}>
        <s-link slot="breadcrumb-actions" href="/app/offers">
          Offers
        </s-link>
        <s-button slot="secondary-actions" href="/app/offers">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={handleSubmit}
          disabled={isSubmitting}
        >
          {isSubmitting ? "Saving…" : submitLabel}
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

        <ReplaceInPlaceModal
          code={pendingReplaceCode}
          onConfirm={confirmReplace}
          onCancel={() => setPendingReplaceCode(null)}
        />

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
            <s-grid gap="small-300">
              <s-choice-list
                name="mode"
                label="Enforcement mode"
                labelAccessibilityVisibility="visible"
                values={[mode]}
                onChange={(e) => {
                  const el = e.currentTarget as HTMLElement & {
                    values?: string[];
                  };
                  const [value] = el.values ?? [];
                  if (value === "silent_strip" || value === "block")
                    setMode(value);
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
          </s-grid>
        </s-section>

        <s-section heading="Protected code">
          <ProtectedCodeInput
            mode={mode}
            suggestions={suggestions}
            error={fieldErrors?.codes}
            onSummaryChange={setSummary}
          />
        </s-section>

        <s-section slot="aside" heading="Summary">
          <DiscountPreview summary={summary} />
        </s-section>
      </s-page>
    </form>
  );
}
