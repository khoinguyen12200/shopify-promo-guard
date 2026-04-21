/**
 * See: docs/admin-ui-spec.md §5 (Create offer form)
 * Standard: docs/polaris-standards.md §14 (Details / edit-form pattern)
 */
import { Form, useNavigation } from "react-router";
import { useState } from "react";

import {
  CodePicker,
  type CodePickerSuggestion,
  type SelectedCode,
} from "./code-picker";

export type { CodePickerSuggestion };

export type OfferFormProps = {
  pageHeading: string;
  submitLabel: string;
  suggestions: CodePickerSuggestion[];
  shopDomain: string;
  fieldErrors?: {
    name?: string;
    code?: string;
    form?: string;
  };
  defaultValues?: {
    name?: string;
    code?: SelectedCode | null;
  };
  suggestError?: string | null;
};

export function OfferForm({
  pageHeading,
  submitLabel,
  suggestions,
  shopDomain,
  fieldErrors,
  defaultValues,
  suggestError,
}: OfferFormProps) {
  const [name, setName] = useState(defaultValues?.name ?? "");
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  return (
    <Form method="post">
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
          type="submit"
          disabled={isSubmitting}
        >
          {isSubmitting ? "Saving…" : submitLabel}
        </s-button>

        {suggestError ? (
          <s-banner tone="warning">
            We couldn&apos;t load discounts from your store. ({suggestError})
          </s-banner>
        ) : null}

        {fieldErrors?.form ? (
          <s-banner tone="critical">{fieldErrors.form}</s-banner>
        ) : null}

        <s-section heading="Offer information">
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
        </s-section>

        <s-section heading="Which code does this welcome offer protect?">
          <CodePicker
            suggestions={suggestions}
            shopDomain={shopDomain}
            initialValue={defaultValues?.code ?? null}
            error={fieldErrors?.code}
          />
        </s-section>
      </s-page>
    </Form>
  );
}
