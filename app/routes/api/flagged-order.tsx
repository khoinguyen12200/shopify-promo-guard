/**
 * See: docs/admin-ui-spec.md §8 (Admin UI extension — order details block)
 * Related: extensions/promo-guard-order-block/src/BlockExtension.jsx
 *
 * JSON API consumed by the order-details block extension.
 * Auth: Shopify session-token bearer (authenticate.admin validates).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";

function parseReasons(facts: string): string[] {
  try {
    const parsed = JSON.parse(facts);
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => (typeof v === "string" ? v : String(v)))
        .filter((v) => v.length > 0);
    }
    return [];
  } catch {
    return [];
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const orderGid = url.searchParams.get("orderGid");
  if (!orderGid) {
    return Response.json({ flagged: null }, { status: 400 });
  }

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) return Response.json({ flagged: null });

  const flagged = await prisma.flaggedOrder.findUnique({
    where: {
      shopId_orderGid: {
        shopId: shop.id,
        orderGid,
      },
    },
    select: {
      id: true,
      orderName: true,
      riskLevel: true,
      score: true,
      facts: true,
      merchantAction: true,
      createdAt: true,
      protectedOffer: {
        select: { id: true, name: true, code: true },
      },
    },
  });

  if (!flagged) return Response.json({ flagged: null });

  return Response.json({
    flagged: {
      id: flagged.id,
      orderName: flagged.orderName,
      riskLevel: flagged.riskLevel,
      score: flagged.score,
      reasons: parseReasons(flagged.facts),
      merchantAction: flagged.merchantAction,
      createdAt: flagged.createdAt.toISOString(),
      offer: {
        id: flagged.protectedOffer.id,
        name: flagged.protectedOffer.name,
        code: flagged.protectedOffer.code,
      },
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) {
    return Response.json({ ok: false, error: "shop not found" }, { status: 404 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const flaggedId = String(form.get("flaggedId") ?? "");
  if (!flaggedId) {
    return Response.json({ ok: false, error: "flaggedId required" }, { status: 400 });
  }
  if (intent !== "dismiss") {
    return Response.json({ ok: false, error: "unknown intent" }, { status: 400 });
  }

  const updated = await prisma.flaggedOrder.updateMany({
    where: { id: flaggedId, shopId: shop.id },
    data: {
      merchantAction: "dismissed",
      merchantActionAt: new Date(),
    },
  });
  if (updated.count === 0) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
};
