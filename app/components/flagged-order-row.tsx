/**
 * See: docs/admin-ui-spec.md §7 (Flagged orders — row)
 * Related: docs/database-design.md (FlaggedOrder model)
 */
import { useFetcher } from "react-router";

export type FlaggedOrderRowOrder = {
  id: string;
  orderGid: string;
  orderName: string;
  riskLevel: string;
  score: number;
  reasons: string[];
  customerEmail: string | null;
  merchantAction: string;
  createdAt: string;
};

export type FlaggedOrderRowProps = {
  order: FlaggedOrderRowOrder;
  shopDomain: string;
};

function riskTone(level: string): "critical" | "warning" | "info" | "neutral" {
  const l = level.toLowerCase();
  if (l === "high") return "critical";
  if (l === "medium") return "warning";
  if (l === "low") return "info";
  return "neutral";
}

function actionTone(
  action: string,
): "success" | "neutral" | "info" | "warning" {
  if (action === "dismissed") return "neutral";
  if (action === "cancelled") return "success";
  return "info";
}

function extractNumericOrderId(orderGid: string): string {
  const parts = orderGid.split("/");
  return parts[parts.length - 1] ?? orderGid;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function FlaggedOrderRow({ order, shopDomain }: FlaggedOrderRowProps) {
  const fetcher = useFetcher();
  const numericOrderId = extractNumericOrderId(order.orderGid);
  const orderHref = `https://admin.shopify.com/store/${shopDomain}/orders/${numericOrderId}`;
  const isPending = order.merchantAction === "pending";
  const dismissing = fetcher.state !== "idle";

  function dismiss() {
    const form = new FormData();
    form.set("intent", "dismiss");
    form.set("flaggedOrderId", order.id);
    fetcher.submit(form, { method: "post" });
  }

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack gap="small-100">
          <s-link href={orderHref} target="_blank">
            {order.orderName}
          </s-link>
          {order.reasons.length > 0 ? (
            <s-paragraph color="subdued">
              {order.reasons.join(" · ")}
            </s-paragraph>
          ) : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={riskTone(order.riskLevel)}>
          {order.riskLevel.toUpperCase()}
        </s-badge>
      </s-table-cell>
      <s-table-cell>{order.score.toLocaleString()}</s-table-cell>
      <s-table-cell>
        <s-badge tone={actionTone(order.merchantAction)}>
          {order.merchantAction.charAt(0).toUpperCase() +
            order.merchantAction.slice(1)}
        </s-badge>
      </s-table-cell>
      <s-table-cell>{formatDate(order.createdAt)}</s-table-cell>
      <s-table-cell>
        {isPending ? (
          <s-button
            variant="tertiary"
            disabled={dismissing}
            onClick={dismiss}
          >
            {dismissing ? "Dismissing…" : "Dismiss"}
          </s-button>
        ) : null}
      </s-table-cell>
    </s-table-row>
  );
}
