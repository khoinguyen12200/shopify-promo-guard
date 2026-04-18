/**
 * See: docs/admin-ui-spec.md §5 (Create offer form)
 */
import { Form } from "react-router";
import { useState } from "react";

import { CodePicker, type CodePickerSuggestion } from "./code-picker";

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

  return (
    <Form method="post">
      {fieldErrors?.form ? (
        <s-banner tone="critical">{fieldErrors.form}</s-banner>
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
