/**
 * See: docs/landing-page-spec.md §4
 *
 * The loader forwards any request carrying a Shopify embed param (`shop=…`)
 * straight into `/app?…`, so opening the app from
 * `admin.shopify.com/store/…/apps/promo-guard` lands on the embedded UI
 * instead of the public marketing page. A plain visit renders the landing.
 */

import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";

import { ComparisonTable } from "../components/public/comparison-table";
import { FaqAccordion } from "../components/public/faq-accordion";
import { Hero } from "../components/public/hero";
import { ProblemBlock } from "../components/public/problem-block";
import { ThreeStep } from "../components/public/three-step";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    // Preserve every Shopify launch param (shop, host, hmac, embedded,
    // id_token, session, timestamp, locale) so /app can finish OAuth.
    // `throw redirect` (rather than `return`) matches the Shopify Remix
    // scaffold exactly and ensures the response short-circuits cleanly.
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return null;
};

export const meta: MetaFunction = () => [
  { title: "Promo Guard — stop welcome-offer abuse on Shopify" },
  {
    name: "description",
    content:
      "Promo Guard catches repeat welcome-offer redemptions even when the abuser uses a new email. Ship in 5 minutes. Works on every Shopify plan.",
  },
];

export default function PublicIndex() {
  return (
    <>
      <Hero />
      <ProblemBlock />
      <ThreeStep />
      <ComparisonTable />
      <FaqAccordion />
    </>
  );
}
