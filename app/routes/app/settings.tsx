/**
 * See: docs/admin-ui-spec.md §9 (Settings page)
 * Standard: docs/polaris-standards.md §2 (banners outside sections), §5 (s-option in s-select)
 * Related: docs/database-design.md (Shop.retentionDays + Shop.saltVersion)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs, HeadersFunction } from "react-router";
import { Form, redirect, useLoaderData, useSearchParams } from "react-router";

import prisma from "~/db.server";
import { requireReadOnly } from "~/lib/admin-impersonation.server";
import { enqueueJob } from "~/lib/jobs.server";
import { authenticate } from "~/shopify.server";
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
      return redirect("/app/settings?confirm=1");
    }
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
        <s-banner tone="success">Retention setting saved.</s-banner>
      ) : null}
      {saved === "rotate" ? (
        <s-banner tone="success">
          Salt rotation queued. The protection ledger is being rebuilt in the
          background.
        </s-banner>
      ) : null}

      {/* Aside: low-frequency info */}
      <s-section slot="aside" heading="Uninstall">
        <s-paragraph>
          When you uninstall Promo Guard, we keep your data for 48 hours in
          case you reinstall, then delete everything permanently.
        </s-paragraph>
      </s-section>

      <s-section heading="Data retention">
        <Form method="post">
          <input type="hidden" name="intent" value="retention" />
          <s-grid gap="base">
            <s-paragraph>
              Keep redemption history for this long before automatic deletion.
            </s-paragraph>
            <s-select
              name="retentionDays"
              label="Retention period"
              labelAccessibilityVisibility="visible"
              value={String(retentionDays)}
            >
              <s-option value="365">365 days (recommended)</s-option>
              <s-option value="180">180 days</s-option>
              <s-option value="90">90 days</s-option>
            </s-select>
            <s-stack direction="inline">
              <s-button type="submit" variant="primary">
                Save retention
              </s-button>
            </s-stack>
          </s-grid>
        </Form>
      </s-section>

      <s-section heading="Reset all detection">
        <s-grid gap="base">
          <s-banner tone="warning">
            Rotating the salt clears the protection ledger for all offers.
            Future redemptions start fresh — prior abusers won&apos;t be
            recognized. This cannot be undone.
          </s-banner>
          <s-paragraph>Current salt version: {saltVersion}</s-paragraph>

          {confirm ? (
            <Form method="post" action="/app/settings?confirm=1">
              <input type="hidden" name="intent" value="rotate-salt" />
              <s-stack direction="inline" gap="small-300">
                <s-button type="submit" variant="primary" tone="critical">
                  Yes, rotate salt and reset ledger
                </s-button>
                <s-button href="/app/settings">Cancel</s-button>
              </s-stack>
            </Form>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="rotate-salt" />
              <s-stack direction="inline">
                <s-button type="submit" tone="critical">
                  Rotate salt and reset ledger
                </s-button>
              </s-stack>
            </Form>
          )}
        </s-grid>
      </s-section>

    </s-page>
  );
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
