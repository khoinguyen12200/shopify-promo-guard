/**
 * See: docs/admin-ui-spec.md §5 (Case B — inline create-new-discount subform)
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
    <s-banner
      tone="info"
      heading={`Create "${code}" through Promo Guard?`}
    >
      <s-stack gap="base">
        {actionError ? (
          <s-banner tone="critical">{actionError}</s-banner>
        ) : null}

        <s-stack gap="small">
          <s-heading>Amount</s-heading>
          <s-stack direction="inline" gap="base" alignItems="center">
            <input
              type="radio"
              id="amount-percent"
              checked={amountKind === "percentage"}
              onChange={() => setAmountKind("percentage")}
            />
            <label htmlFor="amount-percent">
              <s-text>Percentage</s-text>
            </label>
            <s-text-field
              name="percent-input"
              label="%"
              value={percent}
              disabled={amountKind !== "percentage"}
              onChange={(e) => setPercent(e.currentTarget.value)}
            />
          </s-stack>
          <s-stack direction="inline" gap="base" alignItems="center">
            <input
              type="radio"
              id="amount-fixed"
              checked={amountKind === "fixed"}
              onChange={() => setAmountKind("fixed")}
            />
            <label htmlFor="amount-fixed">
              <s-text>Fixed amount</s-text>
            </label>
            <s-text-field
              name="fixed-input"
              label="$"
              value={fixed}
              disabled={amountKind !== "fixed"}
              onChange={(e) => setFixed(e.currentTarget.value)}
            />
          </s-stack>
        </s-stack>

        <s-stack gap="small">
          <s-heading>Usage</s-heading>
          <s-checkbox
            name="once-per-customer"
            label="Once per customer"
            checked={oncePerCustomer}
            onChange={(e) => setOncePerCustomer(e.currentTarget.checked)}
          />
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-checkbox
              name="has-expiry"
              label="Expires on"
              checked={hasEndsAt}
              onChange={(e) => setHasEndsAt(e.currentTarget.checked)}
            />
            <input
              type="date"
              aria-label="Expiry date"
              value={endsAt}
              disabled={!hasEndsAt}
              onChange={(e) => setEndsAt(e.currentTarget.value)}
            />
          </s-stack>
        </s-stack>

        <s-stack direction="inline" gap="small">
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
    </s-banner>
  );
}
