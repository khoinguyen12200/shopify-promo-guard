/**
 * See: docs/admin-ui-spec.md §9 (Settings page)
 * Related: docs/database-design.md (Shop.retentionDays + Shop.saltVersion)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs, HeadersFunction } from "react-router";
import { Form, redirect, useLoaderData, useSearchParams } from "react-router";

import prisma from "../db.server";
import { requireReadOnly } from "../lib/admin-impersonation.server";
import { enqueueJob } from "../lib/jobs.server";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

const ALLOWED_RETENTION = [90, 180, 365] as const;
type RetentionDays = (typeof ALLOWED_RETENTION)[number];

function parseRetention(raw: FormDataEntryValue | null): RetentionDays {
  const n = Number(raw);
  if ((ALLOWED_RETENTION as readonly number[]).includes(n)) {
    return n as RetentionDays;
  }
  return 365;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true, retentionDays: true, saltVersion: true },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }
  return {
    retentionDays: shop.retentionDays,
    saltVersion: shop.saltVersion,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  requireReadOnly(request);
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "retention") {
    const retentionDays = parseRetention(formData.get("retentionDays"));
    await prisma.shop.update({
      where: { id: shop.id },
      data: { retentionDays },
    });
    return redirect("/app/settings?saved=retention");
  }

  if (intent === "rotate-salt") {
    const url = new URL(request.url);
    const confirm = url.searchParams.get("confirm");
    if (confirm !== "1") {
      // First click — bounce back with a confirm prompt rendered.
      return redirect("/app/settings?confirm=1");
    }
    // Handler in app/jobs/rotate-salt.ts: generates a new salt, re-hashes
    // every RedemptionRecord from ciphertext, rebuilds the shop-wide shard.
    await enqueueJob({
      shopId: shop.id,
      type: "rotate_salt",
      payload: { requestedAt: new Date().toISOString() },
    });
    return redirect("/app/settings?saved=rotate");
  }

  return redirect("/app/settings");
};

export default function Settings() {
  const { retentionDays, saltVersion } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const confirm = searchParams.get("confirm") === "1";
  const saved = searchParams.get("saved");

  return (
    <s-page heading="Settings">
      {saved === "retention" ? (
        <s-section>
          <s-banner tone="success">Retention setting saved.</s-banner>
        </s-section>
      ) : null}
      {saved === "rotate" ? (
        <s-section>
          <s-banner tone="success">
            Salt rotation queued. The protection ledger is being rebuilt in the
            background.
          </s-banner>
        </s-section>
      ) : null}

      <s-section heading="Data retention">
        <Form method="post">
          <input type="hidden" name="intent" value="retention" />
          <s-stack gap="base">
            <s-text>
              Keep redemption history for this long before automatic deletion.
            </s-text>
            <s-select
              name="retentionDays"
              label="Retention period"
              value={String(retentionDays)}
            >
              <option value="365">365 days (recommended)</option>
              <option value="180">180 days</option>
              <option value="90">90 days</option>
            </s-select>
            <s-button type="submit" variant="primary">
              Save retention
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Reset all detection">
        <s-stack gap="base">
          <s-banner tone="warning">
            Rotating the salt clears the protection ledger for all offers.
            Future redemptions start fresh — prior abusers won&apos;t be recognized.
            This cannot be undone.
          </s-banner>
          <s-text>Current salt version: {saltVersion}</s-text>

          {confirm ? (
            <Form method="post" action="/app/settings?confirm=1">
              <input type="hidden" name="intent" value="rotate-salt" />
              <s-stack direction="inline" gap="base">
                <s-button type="submit" variant="primary" tone="critical">
                  Yes, rotate salt and reset ledger
                </s-button>
                <s-button href="/app/settings">Cancel</s-button>
              </s-stack>
            </Form>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="rotate-salt" />
              <s-button type="submit" tone="critical">
                Rotate salt and reset ledger
              </s-button>
            </Form>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Uninstall">
        <s-text>
          When you uninstall Promo Guard, we keep your data for 48 hours in
          case you reinstall, then delete everything permanently.
        </s-text>
      </s-section>
    </s-page>
  );
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
