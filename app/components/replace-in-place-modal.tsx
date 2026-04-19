/**
 * See: docs/admin-ui-spec.md §5 (Silent-strip + existing code → confirmation modal)
 * Related: docs/system-design.md § Replace-in-place (deactivate-first ordering)
 *
 * <s-modal> uses the command API (commandFor / command="--show" / "--hide") for
 * open/close. The modal stays mounted at all times — useEffect drives show/hide
 * so the close animation completes before parent state changes.
 */
import { useEffect, useRef } from "react";

const MODAL_ID = "promo-guard-replace-modal";

export type ReplaceInPlaceModalProps = {
  code: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ReplaceInPlaceModal({
  code,
  onConfirm,
  onCancel,
}: ReplaceInPlaceModalProps) {
  const modalRef = useRef<HTMLElementTagNameMap["s-modal"]>(null);
  // Track which action triggered the hide so onHide knows what to do.
  const pendingAction = useRef<"confirm" | "cancel" | null>(null);

  useEffect(() => {
    if (code) {
      pendingAction.current = null;
      modalRef.current?.showOverlay();
    } else {
      modalRef.current?.hideOverlay();
    }
  }, [code]);

  function handleConfirmClick() {
    pendingAction.current = "confirm";
    modalRef.current?.hideOverlay();
  }

  function handleHide() {
    const action = pendingAction.current ?? "cancel";
    pendingAction.current = null;
    if (action === "confirm") {
      onConfirm();
    } else {
      onCancel();
    }
  }

  return (
    <s-modal
      ref={modalRef}
      id={MODAL_ID}
      heading="Replace your existing discount?"
      onHide={handleHide}
    >
      <s-stack gap="base">
        <s-paragraph>
          To silently skip the discount for abusers, we need to replace{" "}
          <s-text type="strong">&quot;{code}&quot;</s-text> with a protected
          version.
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
            <s-text type="strong">Analytics for these codes reset.</s-text>
          </s-paragraph>
        </s-stack>
      </s-stack>

      <s-button
        slot="secondary-actions"
        commandFor={MODAL_ID}
        command="--hide"
      >
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={handleConfirmClick}
      >
        Replace &amp; protect
      </s-button>
    </s-modal>
  );
}
