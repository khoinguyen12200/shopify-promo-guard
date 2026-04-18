// See: docs/admin-ui-spec.md §8 (Admin UI extension — order details block)
// T40 scaffolds. T41 wires flagged-order fetch + dismiss action.
import "@shopify/ui-extensions/preact";
import { render } from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  // When unflagged, the block renders nothing and collapses to zero height.
  // T41 replaces this with a real fetch against the app's flagged-order API.
  return null;
}
