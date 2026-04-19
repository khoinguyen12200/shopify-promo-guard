/**
 * See: docs/admin-ui-spec.md §6 (Offer detail page + stats + pause/resume)
 * Standard: docs/polaris-standards.md §14 (Details / edit-form pattern),
 *           §11 (Metrics card), §2 (page-slot actions)
 * Related: docs/database-design.md (ProtectedOffer, ProtectedCode, RedemptionRecord, FlaggedOrder)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs, HeadersFunction } from "react-router";
import { Form, useLoaderData } from "react-router";

import { StatsCard } from "~/components/stats-card";
import prisma from "~/db.server";
import { requireReadOnly } from "~/lib/admin-impersonation.server";
import { setOfferStatus } from "~/lib/offer-service.server";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function statusBadge(offer: {
  status: string;
  mode: string;
  validationFunctionActivated: boolean;
}) {
  if (
    offer.status === "active" &&
    offer.mode === "block" &&
    !offer.validationFunctionActivated
  ) {
    return { tone: "warning" as const, label: "Needs activation" };
  }
  if (offer.status === "active") {
    return { tone: "success" as const, label: "Active" };
  }
  if (offer.status === "paused") {
    return { tone: "neutral" as const, label: "Paused" };
  }
  return { tone: "info" as const, label: "Draft" };
}

function modeLabel(mode: string) {
  if (mode === "block") return "Block at checkout";
  if (mode === "silent_strip") return "Silent strip";
  return mode;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) {
    throw new Response("Not found", { status: 404 });
  }

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  const offer = await prisma.protectedOffer.findFirst({
    where: { id, shopId: shop.id, archivedAt: null },
    include: {
      codes: {
        where: { archivedAt: null },
        orderBy: { addedAt: "asc" },
      },
    },
  });
  if (!offer) {
    throw new Response("Offer not found", { status: 404 });
  }

  const since = new Date(Date.now() - THIRTY_DAYS_MS);

  const [redemptionCount, flaggedCount, recentFlagged, totalFlagged] =
    await Promise.all([
      prisma.redemptionRecord.count({
        where: { protectedOfferId: offer.id, createdAt: { gte: since } },
      }),
      prisma.flaggedOrder.count({
        where: { protectedOfferId: offer.id, createdAt: { gte: since } },
      }),
      prisma.flaggedOrder.findMany({
        where: { protectedOfferId: offer.id },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          orderName: true,
          riskLevel: true,
          score: true,
          createdAt: true,
          merchantAction: true,
        },
      }),
      prisma.flaggedOrder.count({
        where: { protectedOfferId: offer.id },
      }),
    ]);

  return {
    offer: {
      id: offer.id,
      name: offer.name,
      mode: offer.mode,
      status: offer.status,
      validationFunctionActivated: offer.validationFunctionActivated,
      createdAt: offer.createdAt.toISOString(),
      codes: offer.codes.map((c) => ({ id: c.id, code: c.code })),
    },
    metrics: {
      redemptions: redemptionCount,
      blocked: 0, // dedicated counter ships later (see T35 note in app.offers._index)
      flagged: flaggedCount,
    },
    recentFlagged: recentFlagged.map((f) => ({
      id: f.id,
      orderName: f.orderName,
      riskLevel: f.riskLevel,
      score: f.score,
      merchantAction: f.merchantAction,
      createdAt: f.createdAt.toISOString(),
    })),
    totalFlagged,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  requireReadOnly(request);
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Not found", { status: 404 });

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "pause") {
    await setOfferStatus({
      offerId: id,
      shopId: shop.id,
      status: "paused",
    });
    return { ok: true as const };
  }
  if (intent === "resume") {
    await setOfferStatus({
      offerId: id,
      shopId: shop.id,
      status: "active",
    });
    return { ok: true as const };
  }
  throw new Response("Unknown intent", { status: 400 });
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function riskTone(level: string): "critical" | "warning" | "info" {
  if (level === "HIGH") return "critical";
  if (level === "MEDIUM") return "warning";
  return "info";
}

export default function OfferDetail() {
  const { offer, metrics, recentFlagged, totalFlagged } =
    useLoaderData<typeof loader>();
  const badge = statusBadge(offer);
  const flaggedHref = `/app/flagged?offerId=${encodeURIComponent(offer.id)}`;
  const editHref = `/app/offers/${offer.id}/edit`;
  const deleteHref = `/app/offers/${offer.id}/delete`;
  const pauseIntent = offer.status === "paused" ? "resume" : "pause";
  const pauseLabel = offer.status === "paused" ? "Resume" : "Pause";

  return (
    <s-page heading={offer.name}>
      <s-link slot="breadcrumb-actions" href="/app/offers">
        Offers
      </s-link>
      <s-button slot="secondary-actions" href={deleteHref} tone="critical">
        Delete
      </s-button>
      <s-button slot="primary-action" variant="primary" href={editHref}>
        Edit offer
      </s-button>

      {/* Aside: secondary metadata — status, mode, codes */}
      <s-section slot="aside" heading="Status">
        <s-grid gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-badge tone={badge.tone}>{badge.label}</s-badge>
            <s-text>{modeLabel(offer.mode)}</s-text>
          </s-stack>
          <s-paragraph color="subdued">
            Created {formatDate(offer.createdAt)}
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value={pauseIntent} />
            <s-button type="submit">{pauseLabel}</s-button>
          </Form>
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="Protected codes">
        {offer.codes.length === 0 ? (
          <s-paragraph color="subdued">No active codes.</s-paragraph>
        ) : (
          <s-stack direction="inline" gap="small-200">
            {offer.codes.map((c) => (
              <s-badge key={c.id} tone="info">
                {c.code}
              </s-badge>
            ))}
          </s-stack>
        )}
      </s-section>

      {/* Main: metrics + flagged orders */}
      <s-section heading="Last 30 days">
        <s-grid
          gap="base"
          gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))"
        >
          <StatsCard
            heading="Redemptions"
            value={metrics.redemptions}
            sublabel="Successful uses"
          />
          <StatsCard
            heading="Blocked at checkout"
            value={metrics.blocked}
            sublabel="Stopped before payment"
          />
          <StatsCard
            heading="Flagged for review"
            value={metrics.flagged}
            sublabel="Needs your attention"
          />
        </s-grid>
      </s-section>

      <s-section heading="Recent flagged orders">
        {recentFlagged.length === 0 ? (
          <s-paragraph color="subdued">
            No flagged orders yet for this offer.
          </s-paragraph>
        ) : (
          <s-stack gap="base">
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Order</s-table-header>
                <s-table-header listSlot="secondary">Risk</s-table-header>
                <s-table-header format="numeric">Score</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>When</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {recentFlagged.map((row) => (
                  <s-table-row key={row.id}>
                    <s-table-cell>{row.orderName}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={riskTone(row.riskLevel)}>
                        {row.riskLevel}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{row.score.toLocaleString()}</s-table-cell>
                    <s-table-cell>{row.merchantAction}</s-table-cell>
                    <s-table-cell>{formatDate(row.createdAt)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            <s-stack direction="inline" gap="small-300">
              <s-button href={flaggedHref}>View all flagged</s-button>
            </s-stack>
          </s-stack>
        )}
      </s-section>

      {totalFlagged > 0 ? (
        <s-section heading={`Flagged orders needing review (${totalFlagged})`}>
          <s-stack gap="base">
            <s-paragraph>
              Orders that got through checkout but matched a prior redemption.
              Review and decide whether to cancel.
            </s-paragraph>
            <s-stack direction="inline" gap="small-300">
              <s-button href={flaggedHref} variant="primary">
                Review flagged orders
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      ) : null}
    </s-page>
  );
}

// Every /app/* route must emit the Shopify iframe-allow headers or the
// response gets stripped of them on navigation inside the embedded admin.
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
