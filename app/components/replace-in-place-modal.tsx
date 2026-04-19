/**
 * See: docs/admin-ui-spec.md §5 (Silent-strip + existing code → confirmation modal)
 * Standard: docs/polaris-standards.md §8 (use <s-modal> for confirmations)
 * Related: docs/system-design.md § Replace-in-place (deactivate-first ordering)
 *
 * Uses the App Bridge modal API (`shopify.modal.show` / `hide`) via an effect
 * on mount so the parent can keep its conditional-render pattern. Clicking
 * the modal backdrop or pressing Escape fires `hide` — we wire the callback
 * to `onCancel` so parent state stays in sync.
 */
import { useEffect, useId } from "react";

export type ReplaceInPlaceModalProps = {
  codes: string[];
  onConfirm: () => void;
  onCancel: () => void;
};

declare const shopify: {
  modal: {
    show: (id: string) => Promise<void>;
    hide: (id: string) => Promise<void>;
  };
};

export function ReplaceInPlaceModal({
  codes,
  onConfirm,
  onCancel,
}: ReplaceInPlaceModalProps) {
  const reactId = useId();
  // shopify.modal.* requires a valid HTML id (no ":" which useId() emits).
  const modalId = `replace-in-place-${reactId.replace(/:/g, "")}`;
  const quoted = codes
    .map((c) => `"${c}"`)
    .join(codes.length === 2 ? " and " : ", ");

  useEffect(() => {
    if (typeof shopify !== "undefined") {
      void shopify.modal.show(modalId);
    }
  }, [modalId]);

  function handleConfirm() {
    if (typeof shopify !== "undefined") {
      void shopify.modal.hide(modalId);
    }
    onConfirm();
  }

  return (
    <s-modal
      id={modalId}
      heading="Replace your existing discount?"
      onHide={onCancel}
    >
      <s-stack gap="base">
        <s-paragraph>
          To silently skip the discount for abusers, we need to replace{" "}
          {quoted} with protected{" "}
          {codes.length === 1 ? "version" : "versions"}.
        </s-paragraph>
        <s-stack gap="small-200">
          <s-paragraph>
            Codes stay the same — links in your emails keep working.
          </s-paragraph>
          <s-paragraph>
            Discount amount, minimum, dates, and limits are all copied.
          </s-paragraph>
          <s-paragraph>
            Old discounts are archived — you can restore them anytime.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">
              Analytics for these codes reset.
            </s-text>
          </s-paragraph>
        </s-stack>
      </s-stack>

      <s-button
        slot="secondary-actions"
        onClick={() => {
          if (typeof shopify !== "undefined") {
            void shopify.modal.hide(modalId);
          }
          onCancel();
        }}
      >
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={handleConfirm}
      >
        Replace &amp; protect
      </s-button>
    </s-modal>
  );
}
