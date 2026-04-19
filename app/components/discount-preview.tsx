/**
 * See: docs/admin-ui-spec.md §5 (Create offer form)
 * Standard: docs/polaris-standards.md §14 (Details / edit-form pattern)
 */
import type { NewDiscountState } from "./discount-creation-form";

export type CodeSummary =
  | { kind: "none" }
  | { kind: "existing"; code: string; description: string }
  | { kind: "new"; state: NewDiscountState };

function formatDate(iso: string): string {
  if (!iso) return "today";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function typeLabel(state: NewDiscountState): string {
  const val =
    state.valueType === "percentage"
      ? `${state.value || "0"}%`
      : `$${state.value || "0"}`;
  return `${val} off ${state.discountType}`;
}

function eligibilityLabel(e: NewDiscountState["eligibility"]): string {
  if (e === "segments") return "Specific customer segments";
  if (e === "specific") return "Specific customers";
  return "All customers";
}

function minLabel(s: NewDiscountState): string {
  if (s.minRequirement === "amount")
    return `Minimum purchase of $${s.minAmount || "0"}`;
  if (s.minRequirement === "quantity")
    return `Minimum ${s.minQuantity || "0"} items`;
  return "No minimum purchase requirement";
}

function usageLabel(s: NewDiscountState): string {
  if (s.hasUsageLimit && s.usageLimit) return `${s.usageLimit} total uses`;
  return "No usage limits";
}

function combineLabel(s: NewDiscountState): string {
  const parts: string[] = [];
  if (s.combineProduct) parts.push("product discounts");
  if (s.combineOrder) parts.push("order discounts");
  if (s.combineShipping) parts.push("shipping discounts");
  if (!parts.length) return "Can't combine with other discounts";
  return `Combines with ${parts.join(", ")}`;
}

function Row({ text }: { text: string }) {
  return <s-paragraph>• {text}</s-paragraph>;
}

export function DiscountPreview({ summary }: { summary: CodeSummary }) {
  if (summary.kind === "none") {
    return (
      <s-stack gap="small-300">
        <s-paragraph color="subdued">No discount code yet</s-paragraph>
        <s-paragraph color="subdued">Details</s-paragraph>
        <Row text="For Online Store" />
        <Row text="Applies to one-time purchases" />
        <Row text="No minimum purchase requirement" />
        <Row text="No usage limits" />
        <Row text="Can't combine with other discounts" />
        <Row text="Active from today" />
      </s-stack>
    );
  }

  if (summary.kind === "existing") {
    return (
      <s-stack gap="small-300">
        <s-heading>{summary.code}</s-heading>
        <s-paragraph color="subdued">{summary.description}</s-paragraph>
        <s-paragraph color="subdued">Details</s-paragraph>
        <Row text="For Online Store" />
        <Row text="Applies to one-time purchases" />
      </s-stack>
    );
  }

  const { state } = summary;
  return (
    <s-stack gap="small-300">
      <s-heading>{state.code || "No discount code yet"}</s-heading>
      <s-badge tone="info">{typeLabel(state)}</s-badge>
      <s-paragraph color="subdued">Details</s-paragraph>
      <Row text={eligibilityLabel(state.eligibility)} />
      <Row text="For Online Store" />
      <Row text="Applies to one-time purchases" />
      <Row text={minLabel(state)} />
      <Row text={usageLabel(state)} />
      <Row text={combineLabel(state)} />
      <Row text={`Active from ${formatDate(state.startDate)}`} />
    </s-stack>
  );
}
