/**
 * See: docs/admin-ui-spec.md §7 (Flagged orders — row)
 * Related: docs/database-design.md (FlaggedOrder model)
 */
import { Form } from "react-router";

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
  // orderGid shape: gid://shopify/Order/<id>
  const parts = orderGid.split("/");
  return parts[parts.length - 1] ?? orderGid;
}

export function FlaggedOrderRow({ order, shopDomain }: FlaggedOrderRowProps) {
  const numericOrderId = extractNumericOrderId(order.orderGid);
  const cancelHref = `https://admin.shopify.com/store/${shopDomain}/orders/${numericOrderId}`;
  const isPending = order.merchantAction === "pending";

  return (
    <s-stack gap="small">
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-heading>{order.orderName}</s-heading>
        <s-badge tone={riskTone(order.riskLevel)}>
          {order.riskLevel.toUpperCase()}
        </s-badge>
        {!isPending ? (
          <s-badge tone={actionTone(order.merchantAction)}>
            {order.merchantAction.charAt(0).toUpperCase() +
              order.merchantAction.slice(1)}
          </s-badge>
        ) : null}
      </s-stack>

      {order.customerEmail ? (
        <s-text>{order.customerEmail}</s-text>
      ) : (
        <s-text color="subdued">Customer redacted</s-text>
      )}

      <s-text color="subdued">Score: {order.score}</s-text>

      {order.reasons.length > 0 ? (
        <s-stack gap="small-100">
          {order.reasons.map((reason, idx) => (
            <s-text key={idx}>• {reason}</s-text>
          ))}
        </s-stack>
      ) : null}

      <s-stack direction="inline" gap="base">
        {isPending ? (
          <Form method="post">
            <input type="hidden" name="intent" value="dismiss" />
            <input type="hidden" name="flaggedOrderId" value={order.id} />
            <s-button type="submit">Dismiss</s-button>
          </Form>
        ) : null}
        <a href={cancelHref} target="_blank" rel="noopener noreferrer">
          Cancel order →
        </a>
      </s-stack>
    </s-stack>
  );
}
