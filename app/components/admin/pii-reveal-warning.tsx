/**
 * See: docs/platform-admin-spec.md §7 (reason-before-reveal warning)
 */
import { Form } from "react-router";
import { useState } from "react";

export type PiiRevealWarningProps = {
  shopDomain: string;
  error?: string;
};

export function PiiRevealWarning({
  shopDomain,
  error,
}: PiiRevealWarningProps) {
  const [reason, setReason] = useState("");
  const canSubmit = reason.trim().length >= 5;

  return (
    <s-section>
      <s-banner tone="warning" heading="Viewing customer PII">
        <s-stack gap="base">
          <s-text>
            You&apos;re about to see decrypted email, phone, and address data
            for <strong>{shopDomain}</strong>.
          </s-text>
          <Form method="post">
            <s-stack gap="small">
              <s-text-field
                name="reason"
                label="Reason (logged)"
                value={reason}
                required
                error={error}
                onChange={(e) => setReason(e.currentTarget.value)}
              />
              <s-text color="subdued">
                Common reasons: &quot;support ticket #123&quot;,
                &quot;debugging false positive report&quot;, &quot;GDPR
                data_request export&quot;.
              </s-text>
              <s-stack direction="inline" gap="base">
                <s-button href="..">Cancel</s-button>
                <s-button
                  type="submit"
                  variant="primary"
                  disabled={!canSubmit}
                >
                  View
                </s-button>
              </s-stack>
            </s-stack>
          </Form>
        </s-stack>
      </s-banner>
    </s-section>
  );
}
