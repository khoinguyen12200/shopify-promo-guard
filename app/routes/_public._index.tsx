/**
 * See: docs/landing-page-spec.md §4
 */

import type { MetaFunction } from "react-router";

import { ComparisonTable } from "../components/public/comparison-table";
import { FaqAccordion } from "../components/public/faq-accordion";
import { Hero } from "../components/public/hero";
import { ProblemBlock } from "../components/public/problem-block";
import { ThreeStep } from "../components/public/three-step";

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
