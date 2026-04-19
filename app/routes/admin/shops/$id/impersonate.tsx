/**
 * See: docs/platform-admin-spec.md §8 (support-mode impersonation)
 */
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { requireAdminSession } from "~/lib/admin-auth.server.js";
import { logAdminAction } from "~/lib/admin-audit.server.js";
import {
  buildImpersonationCookie,
  mintImpersonationToken,
} from "~/lib/admin-impersonation.server.js";
import prisma from "~/db.server.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const adminUser = await requireAdminSession(request);
  const id = params.id;
  if (!id) throw new Response("Not found", { status: 404 });

  const shop = await prisma.shop.findUnique({
    where: { id },
    select: { id: true, shopDomain: true },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const token = mintImpersonationToken({
    shopId: shop.id,
    adminUserId: adminUser.id,
    shopDomain: shop.shopDomain,
  });

  await logAdminAction({
    adminUserId: adminUser.id,
    action: "impersonate",
    targetType: "Shop",
    targetId: shop.id,
    metadata: { shopDomain: shop.shopDomain },
    ipAddress:
      request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
      undefined,
    userAgent: request.headers.get("User-Agent") ?? undefined,
  });

  // Redirect to the merchant UI; the banner renders itself from app.tsx.
  return redirect("/app", {
    headers: {
      "Set-Cookie": buildImpersonationCookie(token),
    },
  });
};
