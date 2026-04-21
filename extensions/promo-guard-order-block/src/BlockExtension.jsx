// See: docs/admin-ui-spec.md §8 (Admin UI extension — order details block)
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function useFlaggedOrder(orderGid) {
  const [state, setState] = useState({ status: "loading", flagged: null });

  useEffect(() => {
    if (!orderGid) {
      setState({ status: "idle", flagged: null });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/flagged-order?orderGid=${encodeURIComponent(orderGid)}`,
        );
        if (!res.ok) {
          if (!cancelled) setState({ status: "idle", flagged: null });
          return;
        }
        const body = await res.json();
        if (!cancelled) {
          setState({ status: "idle", flagged: body.flagged ?? null });
        }
      } catch {
        if (!cancelled) setState({ status: "idle", flagged: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderGid]);

  return state;
}

function Extension() {
  // `shopify.data.selected[0].id` gives the order GID on the order-details
  // target. Using optional chaining so the block is safe to render during
  // the initial mount before data is populated.
  const orderGid = useMemo(() => {
    const selected = shopify?.data?.selected?.[0];
    return selected?.id ?? null;
  }, []);

  const { flagged } = useFlaggedOrder(orderGid);
  const [dismissed, setDismissed] = useState(false);

  // Spec §8: when not flagged, render nothing so the block collapses.
  if (!flagged || dismissed || flagged.merchantAction === "dismissed") {
    return null;
  }

  const tone = flagged.riskLevel === "HIGH" ? "critical" : "warning";

  async function onDismiss() {
    const form = new FormData();
    form.set("intent", "dismiss");
    form.set("flaggedId", flagged.id);
    try {
      const res = await fetch(`/api/flagged-order`, {
        method: "POST",
        body: form,
      });
      if (res.ok) setDismissed(true);
    } catch {
      // Network errors fall through — merchant can retry.
    }
  }

  function onCancelOrder() {
    // Deep-link to Shopify's native order-cancel flow. Use the Shopify order
    // GID from the block's own context — `flagged.id` is the FlaggedOrder row
    // PK, not the Shopify order.
    const numericId = orderGid ? orderGid.split("/").pop() : null;
    if (numericId && shopify?.navigate) {
      shopify.navigate(`shopify:admin/orders/${numericId}`);
    }
  }

  return (
    <s-admin-block heading="Promo Guard">
      <s-stack direction="block" gap="base">
        <s-badge tone={tone}>Flagged: {flagged.riskLevel}</s-badge>
        <s-text>
          This order matched a prior welcome-offer redemption.
        </s-text>

        {flagged.reasons.length > 0 ? (
          <s-stack direction="block" gap="small">
            {flagged.reasons.map((r) => (
              <s-text key={r}>• {r}</s-text>
            ))}
          </s-stack>
        ) : null}

        <s-stack direction="block" gap="small">
          <s-text>Offer: {flagged.offer.name}</s-text>
          {flagged.offer.code ? (
            <s-text>Code used: {flagged.offer.code}</s-text>
          ) : null}
        </s-stack>

        <s-stack direction="inline" gap="small">
          <s-button onClick={onDismiss}>Dismiss</s-button>
          <s-button variant="primary" onClick={onCancelOrder}>
            Cancel this order
          </s-button>
        </s-stack>
      </s-stack>
    </s-admin-block>
  );
}
