/**
 * See: docs/admin-ui-spec.md §5 (Case B — inline create-new-discount subform)
 * Standard: docs/polaris-standards.md §3 (nested sections), §5 (form fields),
 *           §9 (Stack vs Grid)
 * Related: app/lib/offer-service.server.ts (discountCodeAppCreate wrapper)
 */
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

export type CreateNewDiscountResult = {
  code: string;
  discountNodeId: string;
};

export type CreateNewDiscountProps = {
  code: string;
  onCreated: (result: CreateNewDiscountResult) => void;
  onCancel: () => void;
};

type ActionResponse =
  | { ok: true; code: string; discountNodeId: string }
  | { ok: false; error: string };

export function CreateNewDiscount({
  code,
  onCreated,
  onCancel,
}: CreateNewDiscountProps) {
  const fetcher = useFetcher<ActionResponse>();
  const submitting =
    fetcher.state === "submitting" || fetcher.state === "loading";

  const [amountKind, setAmountKind] = useState<"percentage" | "fixed">(
    "percentage",
  );
  const [percent, setPercent] = useState("10");
  const [fixed, setFixed] = useState("5");
  const [oncePerCustomer, setOncePerCustomer] = useState(true);
  const [hasEndsAt, setHasEndsAt] = useState(false);
  const [endsAt, setEndsAt] = useState("");

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      onCreated({
        code: fetcher.data.code,
        discountNodeId: fetcher.data.discountNodeId,
      });
    }
  }, [fetcher.state, fetcher.data, onCreated]);

  const actionError =
    fetcher.state === "idle" && fetcher.data && !fetcher.data.ok
      ? fetcher.data.error
      : null;

  function submit() {
    const form = new FormData();
    form.set("intent", "create-discount");
    form.set("code", code);
    form.set("amountKind", amountKind);
    if (amountKind === "percentage") {
      form.set("percent", percent);
    } else {
      form.set("fixed", fixed);
    }
    form.set("appliesOncePerCustomer", oncePerCustomer ? "1" : "0");
    if (hasEndsAt && endsAt) form.set("endsAt", endsAt);
    fetcher.submit(form, { method: "post" });
  }

  return (
    <s-section heading={`Create "${code}" through Promo Guard?`}>
      <s-stack gap="base">
        {actionError ? (
          <s-banner tone="critical">{actionError}</s-banner>
        ) : null}

        <s-section heading="Discount amount">
          <s-grid gap="base">
            <s-choice-list
              name="amount-kind"
              label="Discount type"
              labelAccessibilityVisibility="exclusive"
              values={[amountKind]}
              onChange={(e) => {
                const value = (e.target as HTMLInputElement | null)?.value;
                if (value === "percentage" || value === "fixed")
                  setAmountKind(value);
              }}
            >
              <s-choice value="percentage">Percentage</s-choice>
              <s-choice value="fixed">Fixed amount</s-choice>
            </s-choice-list>
            {amountKind === "percentage" ? (
              <s-number-field
                name="percent-input"
                label="Percentage off"
                labelAccessibilityVisibility="visible"
                value={percent}
                min={1}
                max={99}
                details="Whole number between 1 and 99."
                onChange={(e: { currentTarget: { value: string } }) =>
                  setPercent(e.currentTarget.value)
                }
              />
            ) : (
              <s-money-field
                name="fixed-input"
                label="Fixed amount"
                labelAccessibilityVisibility="visible"
                value={fixed}
                min={0}
                onChange={(e: { currentTarget: { value: string } }) =>
                  setFixed(e.currentTarget.value)
                }
              />
            )}
          </s-grid>
        </s-section>

        <s-section heading="Redemption limits">
          <s-grid gap="base">
            <s-checkbox
              name="once-per-customer"
              label="Limit to one use per customer"
              details="Recommended for welcome offers so each shopper gets exactly one."
              checked={oncePerCustomer}
              onChange={(e) => setOncePerCustomer(e.currentTarget.checked)}
            />
            <s-checkbox
              name="has-expiry"
              label="Set an expiry date"
              details="The discount stops applying after this date."
              checked={hasEndsAt}
              onChange={(e) => setHasEndsAt(e.currentTarget.checked)}
            />
            {hasEndsAt ? (
              <s-date-field
                name="ends-at"
                label="Expires on"
                labelAccessibilityVisibility="visible"
                value={endsAt}
                onChange={(e: { currentTarget: { value: string } }) =>
                  setEndsAt(e.currentTarget.value)
                }
              />
            ) : null}
          </s-grid>
        </s-section>

        <s-stack direction="inline" gap="small-300">
          <s-button onClick={onCancel} disabled={submitting}>
            Cancel
          </s-button>
          <s-button
            variant="primary"
            onClick={submit}
            disabled={submitting}
          >
            {submitting ? "Creating…" : "Create"}
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
