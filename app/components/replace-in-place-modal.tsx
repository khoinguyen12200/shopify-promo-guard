/**
 * See: docs/admin-ui-spec.md §5 (Silent-strip + existing code → confirmation modal)
 * Related: docs/system-design.md § Replace-in-place (deactivate-first ordering)
 */

export type ReplaceInPlaceModalProps = {
  codes: string[];
  onConfirm: () => void;
  onCancel: () => void;
};

export function ReplaceInPlaceModal({
  codes,
  onConfirm,
  onCancel,
}: ReplaceInPlaceModalProps) {
  const quoted = codes.map((c) => `"${c}"`).join(codes.length === 2 ? " and " : ", ");
  return (
    <s-banner tone="warning" heading="Replace your existing discount?">
      <s-stack gap="base">
        <s-text>
          To silently skip the discount for abusers, we need to replace{" "}
          {quoted} with protected {codes.length === 1 ? "version" : "versions"}.
        </s-text>
        <s-stack gap="small">
          <s-text>
            ✓ Codes stay the same — links in your emails keep working
          </s-text>
          <s-text>✓ Discount amount, minimum, dates, limits all copied</s-text>
          <s-text>
            ✓ Old discounts are archived (you can restore them anytime)
          </s-text>
          <s-text>⚠ Analytics for these codes reset</s-text>
        </s-stack>
        <s-stack direction="inline" gap="small">
          <s-button onClick={onCancel}>Cancel</s-button>
          <s-button variant="primary" onClick={onConfirm}>
            Replace &amp; protect
          </s-button>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}
