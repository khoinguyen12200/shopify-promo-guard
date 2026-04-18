/**
 * See: docs/platform-admin-spec.md §13 (feature flags)
 * Related: app/lib/feature-flags.server.ts (60s cache, toggle invalidation)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import { requireAdminSession } from "../lib/admin-auth.server.js";
import { logAdminAction } from "../lib/admin-audit.server.js";
import { setDefault, setOverride } from "../lib/feature-flags.server.js";
import prisma from "../db.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdminSession(request);

  const flags = await prisma.featureFlag.findMany({
    orderBy: { key: "asc" },
    include: {
      overrides: {
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
  });

  const overrideShopIds = Array.from(
    new Set(flags.flatMap((f) => f.overrides.map((o) => o.shopId).filter(Boolean))),
  ) as string[];
  const shops = overrideShopIds.length
    ? await prisma.shop.findMany({
        where: { id: { in: overrideShopIds } },
        select: { id: true, shopDomain: true },
      })
    : [];
  const domainById = new Map(shops.map((s) => [s.id, s.shopDomain]));

  return {
    flags: flags.map((f) => ({
      id: f.id,
      key: f.key,
      description: f.description,
      defaultValue: f.defaultValue,
      overrides: f.overrides.map((o) => ({
        id: o.id,
        shopId: o.shopId,
        shopDomain: o.shopId ? domainById.get(o.shopId) ?? o.shopId : "(global)",
        value: o.value,
      })),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const adminUser = await requireAdminSession(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const flagKey = String(form.get("flagKey") ?? "");

  if (!flagKey) return { error: "flagKey required" };

  if (intent === "toggle-default") {
    const current = await prisma.featureFlag.findUnique({
      where: { key: flagKey },
      select: { defaultValue: true },
    });
    if (!current) return { error: "Unknown flag." };
    const nextValue = !current.defaultValue;
    await setDefault({ flagKey, value: nextValue });
    await logAdminAction({
      adminUserId: adminUser.id,
      action: "feature_flag_set_default",
      targetType: "FeatureFlag",
      targetId: flagKey,
      metadata: { value: nextValue },
    });
    return { ok: true as const };
  }

  if (intent === "add-override") {
    const shopDomain = String(form.get("shopDomain") ?? "").trim().toLowerCase();
    const valueRaw = String(form.get("value") ?? "");
    if (!shopDomain) return { error: "shop domain required" };
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      select: { id: true },
    });
    if (!shop) return { error: `shop "${shopDomain}" not found` };
    const value = valueRaw === "on" ? true : valueRaw === "off" ? false : null;
    await setOverride({
      flagKey,
      shopId: shop.id,
      value,
      adminUserId: adminUser.id,
    });
    await logAdminAction({
      adminUserId: adminUser.id,
      action: "feature_flag_set_override",
      targetType: "FeatureFlag",
      targetId: flagKey,
      metadata: { shopDomain, value },
    });
    return { ok: true as const };
  }

  return { error: "Unknown intent." };
};

export default function AdminFeatureFlags() {
  const { flags } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Feature flags">
      {actionData?.error ? (
        <s-section>
          <s-banner tone="critical">{actionData.error}</s-banner>
        </s-section>
      ) : null}
      {actionData && "ok" in actionData && actionData.ok ? (
        <s-section>
          <s-banner tone="success">Saved. Effect applies within 60s.</s-banner>
        </s-section>
      ) : null}

      {flags.length === 0 ? (
        <s-section>
          <s-text color="subdued">No feature flags defined yet.</s-text>
        </s-section>
      ) : (
        flags.map((f) => (
          <s-section key={f.id} heading={f.key}>
            <s-stack gap="small">
              {f.description ? (
                <s-text color="subdued">{f.description}</s-text>
              ) : null}
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-text>
                  Default: <strong>{f.defaultValue ? "on" : "off"}</strong>
                </s-text>
                <Form method="post">
                  <input type="hidden" name="intent" value="toggle-default" />
                  <input type="hidden" name="flagKey" value={f.key} />
                  <s-button type="submit">Toggle default</s-button>
                </Form>
              </s-stack>

              <s-text>Shop overrides</s-text>
              {f.overrides.length === 0 ? (
                <s-text color="subdued">None.</s-text>
              ) : (
                <s-stack gap="small">
                  {f.overrides.map((o) => (
                    <s-text key={o.id}>
                      {o.shopDomain}: {o.value ? "on" : "off"}
                    </s-text>
                  ))}
                </s-stack>
              )}

              <Form method="post">
                <input type="hidden" name="intent" value="add-override" />
                <input type="hidden" name="flagKey" value={f.key} />
                <s-stack direction="inline" gap="small" alignItems="end">
                  <s-text-field
                    name="shopDomain"
                    label="Shop domain"
                    placeholder="bar-cosmetics.myshopify.com"
                  />
                  <s-select name="value" label="Value">
                    <s-option value="on">on</s-option>
                    <s-option value="off">off</s-option>
                    <s-option value="clear">clear override</s-option>
                  </s-select>
                  <s-button type="submit">Set override</s-button>
                </s-stack>
              </Form>
            </s-stack>
          </s-section>
        ))
      )}
    </s-page>
  );
}
