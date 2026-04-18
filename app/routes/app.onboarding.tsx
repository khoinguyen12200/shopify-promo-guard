/**
 * See: docs/admin-ui-spec.md §3 (first run / onboarding)
 * Placeholder — full checklist in T29.
 */
import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Onboarding() {
  return (
    <s-page heading="Welcome to Promo Guard">
      <s-section heading="Get started">
        <s-text>Onboarding checklist — full UI ships in T29.</s-text>
      </s-section>
    </s-page>
  );
}
