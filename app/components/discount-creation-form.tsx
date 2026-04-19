/**
 * See: docs/admin-ui-spec.md §5 (Create offer form)
 * Standard: docs/polaris-standards.md §14 (Details / edit-form pattern)
 */
import { useEffect, useState } from "react";

export type NewDiscountState = {
  discountType: "product" | "order";
  code: string;
  valueType: "percentage" | "fixed";
  value: string;
  eligibility: "all" | "segments" | "specific";
  minRequirement: "none" | "amount" | "quantity";
  minAmount: string;
  minQuantity: string;
  hasUsageLimit: boolean;
  usageLimit: string;
  combineProduct: boolean;
  combineOrder: boolean;
  combineShipping: boolean;
  startDate: string;
  startTime: string;
  hasEndDate: boolean;
  endDate: string;
  endTime: string;
};

export type DiscountCreationFormProps = {
  initialCode: string;
  onChange: (state: NewDiscountState) => void;
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function DiscountCreationForm({
  initialCode,
  onChange,
}: DiscountCreationFormProps) {
  const [state, setState] = useState<NewDiscountState>({
    discountType: "order",
    code: initialCode,
    valueType: "percentage",
    value: "",
    eligibility: "all",
    minRequirement: "none",
    minAmount: "",
    minQuantity: "",
    hasUsageLimit: false,
    usageLimit: "",
    combineProduct: false,
    combineOrder: false,
    combineShipping: false,
    startDate: todayISO(),
    startTime: "00:00",
    hasEndDate: false,
    endDate: "",
    endTime: "23:59",
  });

  useEffect(() => { onChange(state); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function update(patch: Partial<NewDiscountState>) {
    const next = { ...state, ...patch };
    setState(next);
    onChange(next);
  }

  return (
    <s-stack gap="base">
      <s-section heading="Discount type">
        <s-choice-list
          label="Discount type"
          labelAccessibilityVisibility="exclusive"
          values={[state.discountType]}
          onChange={(e) => {
            const el = e.currentTarget as HTMLElement & { values?: string[] };
            const [v] = el.values ?? [];
            if (v === "product" || v === "order") update({ discountType: v });
          }}
        >
          <s-choice value="product">Product discount</s-choice>
          <s-choice value="order">Order discount</s-choice>
        </s-choice-list>
      </s-section>

      <s-section heading="Discount code">
        <s-text-field
          label="Discount code"
          labelAccessibilityVisibility="visible"
          details="Customers must enter this code at checkout."
          value={state.code}
          onChange={(e) => update({ code: e.currentTarget.value })}
        />
      </s-section>

      <s-section heading="Discount value">
        <s-stack gap="small-300">
          <s-choice-list
            label="Value type"
            labelAccessibilityVisibility="exclusive"
            values={[state.valueType]}
            onChange={(e) => {
              const el = e.currentTarget as HTMLElement & { values?: string[] };
              const [v] = el.values ?? [];
              if (v === "percentage" || v === "fixed") update({ valueType: v });
            }}
          >
            <s-choice value="percentage">Percentage</s-choice>
            <s-choice value="fixed">Fixed amount</s-choice>
          </s-choice-list>
          {state.valueType === "percentage" ? (
            <s-number-field
              label="Percentage"
              labelAccessibilityVisibility="visible"
              min={1}
              max={99}
              suffix="%"
              value={state.value}
              onChange={(e) => update({ value: e.currentTarget.value })}
            />
          ) : (
            <s-money-field
              label="Amount"
              labelAccessibilityVisibility="visible"
              value={state.value}
              onChange={(e) => update({ value: e.currentTarget.value })}
            />
          )}
        </s-stack>
      </s-section>

      <s-section heading="Purchase type">
        <s-paragraph>One-time purchase</s-paragraph>
      </s-section>

      <s-section heading="Customer eligibility">
        <s-stack gap="small-300">
          <s-choice-list
            label="Eligibility"
            labelAccessibilityVisibility="exclusive"
            values={[state.eligibility]}
            onChange={(e) => {
              const el = e.currentTarget as HTMLElement & { values?: string[] };
              const [v] = el.values ?? [];
              if (v === "all" || v === "segments" || v === "specific") {
                update({ eligibility: v });
              }
            }}
          >
            <s-choice value="all">All customers</s-choice>
            <s-choice value="segments">Specific customer segments</s-choice>
            <s-choice value="specific">Specific customers</s-choice>
          </s-choice-list>
          {state.eligibility !== "all" ? (
            <s-text-field
              label={
                state.eligibility === "segments"
                  ? "Customer segments"
                  : "Customers"
              }
              labelAccessibilityVisibility="visible"
              placeholder="Search coming soon"
              value=""
              onChange={() => {}}
            />
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Minimum purchase requirements">
        <s-stack gap="small-300">
          <s-choice-list
            label="Minimum requirement"
            labelAccessibilityVisibility="exclusive"
            values={[state.minRequirement]}
            onChange={(e) => {
              const el = e.currentTarget as HTMLElement & { values?: string[] };
              const [v] = el.values ?? [];
              if (v === "none" || v === "amount" || v === "quantity") {
                update({ minRequirement: v });
              }
            }}
          >
            <s-choice value="none">No minimum requirements</s-choice>
            <s-choice value="amount">Minimum purchase amount ($)</s-choice>
            <s-choice value="quantity">Minimum quantity of items</s-choice>
          </s-choice-list>
          {state.minRequirement === "amount" ? (
            <s-money-field
              label="Minimum amount"
              labelAccessibilityVisibility="visible"
              value={state.minAmount}
              onChange={(e) => update({ minAmount: e.currentTarget.value })}
            />
          ) : null}
          {state.minRequirement === "quantity" ? (
            <s-number-field
              label="Minimum quantity"
              labelAccessibilityVisibility="visible"
              min={1}
              value={state.minQuantity}
              onChange={(e) => update({ minQuantity: e.currentTarget.value })}
            />
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Maximum discount uses">
        <s-stack gap="small-300">
          <s-checkbox
            label="Limit number of times this discount can be used in total"
            checked={state.hasUsageLimit}
            onChange={(e) =>
              update({ hasUsageLimit: e.currentTarget.checked })
            }
          />
          {state.hasUsageLimit ? (
            <s-number-field
              label="Total usage limit"
              labelAccessibilityVisibility="visible"
              min={1}
              value={state.usageLimit}
              onChange={(e) => update({ usageLimit: e.currentTarget.value })}
            />
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Combinations">
        <s-stack gap="small-300">
          <s-checkbox
            label="Product discounts"
            checked={state.combineProduct}
            onChange={(e) =>
              update({ combineProduct: e.currentTarget.checked })
            }
          />
          <s-checkbox
            label="Order discounts"
            checked={state.combineOrder}
            onChange={(e) =>
              update({ combineOrder: e.currentTarget.checked })
            }
          />
          <s-checkbox
            label="Shipping discounts"
            checked={state.combineShipping}
            onChange={(e) =>
              update({ combineShipping: e.currentTarget.checked })
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Active dates">
        <s-stack gap="small-300">
          <s-date-field
            label="Start date"
            labelAccessibilityVisibility="visible"
            value={state.startDate}
            onChange={(e) => update({ startDate: e.currentTarget.value })}
          />
          <s-text-field
            label="Start time"
            labelAccessibilityVisibility="visible"
            placeholder="HH:MM"
            value={state.startTime}
            onChange={(e) => update({ startTime: e.currentTarget.value })}
          />
          <s-checkbox
            label="Set end date"
            checked={state.hasEndDate}
            onChange={(e) => update({ hasEndDate: e.currentTarget.checked })}
          />
          {state.hasEndDate ? (
            <>
              <s-date-field
                label="End date"
                labelAccessibilityVisibility="visible"
                value={state.endDate}
                onChange={(e) => update({ endDate: e.currentTarget.value })}
              />
              <s-text-field
                label="End time"
                labelAccessibilityVisibility="visible"
                placeholder="HH:MM"
                value={state.endTime}
                onChange={(e) => update({ endTime: e.currentTarget.value })}
              />
            </>
          ) : null}
        </s-stack>
      </s-section>
    </s-stack>
  );
}
