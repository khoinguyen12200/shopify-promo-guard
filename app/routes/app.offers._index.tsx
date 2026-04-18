/**
 * See: docs/admin-ui-spec.md §4 (offers list)
 * Placeholder — full list ships in T30.
 */
import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function OffersIndex() {
  return (
    <s-page heading="Protected offers">
      <s-section heading="Offers">
        <s-text>Offers list — full table ships in T30.</s-text>
      </s-section>
    </s-page>
  );
}
