/**
 * See: docs/admin-ui-spec.md §5 (discount suggestion / code picker)
 */

import prisma from "../db.server.js";
import type { AdminGqlClient } from "./admin-graphql.server.js";

// -- Types ------------------------------------------------------------------

export interface DiscountSuggestion {
  discountNodeId: string;
  title: string;
  codes: string[];
  appliesOncePerCustomer: boolean;
  /** "ACTIVE" | "EXPIRED" | "SCHEDULED" */
  status: string;
}

export interface SuggestDiscountsArgs {
  client: AdminGqlClient;
  /** Prisma Shop.id */
  shopId: string;
  maxResults?: number;
}

// -- GraphQL query ----------------------------------------------------------

const SUGGEST_DISCOUNTS = /* GraphQL */ `
  query SuggestDiscounts($cursor: String, $first: Int!) {
    discountNodes(
      first: $first
      after: $cursor
      sortKey: CREATED_AT
      reverse: true
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          discount {
            ... on DiscountCodeBasic {
              title
              status
              appliesOncePerCustomer
              startsAt
              endsAt
              codes(first: 5) {
                edges {
                  node {
                    code
                  }
                }
              }
            }
            ... on DiscountCodeBxgy {
              title
              status
              appliesOncePerCustomer
              codes(first: 5) {
                edges {
                  node {
                    code
                  }
                }
              }
            }
            ... on DiscountCodeFreeShipping {
              title
              status
              appliesOncePerCustomer
              codes(first: 5) {
                edges {
                  node {
                    code
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// -- Response shapes --------------------------------------------------------

interface CodeEdge {
  node: { code: string };
}

interface DiscountDetail {
  title?: string;
  status?: string;
  appliesOncePerCustomer?: boolean;
  codes?: { edges: CodeEdge[] };
}

interface DiscountNodeEdge {
  node: {
    id: string;
    discount?: DiscountDetail | null;
  };
}

interface DiscountNodesData {
  discountNodes: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: DiscountNodeEdge[];
  };
}

interface GqlResponse<TData> {
  data?: TData;
  errors?: Array<{ message: string }>;
}

interface ResponseLike {
  status?: number;
  json: () => Promise<unknown>;
}

// -- Constants --------------------------------------------------------------

const PAGE_SIZE = 50;
const DEFAULT_MAX_RESULTS = 100;

const NAME_MATCH_SCORES: Array<{ re: RegExp; score: number }> = [
  { re: /welcome/i, score: 4 },
  { re: /first/i, score: 3 },
  { re: /\bnew\b|newbie|newcustomer/i, score: 2 },
  { re: /intro/i, score: 1 },
];

// -- Helpers ----------------------------------------------------------------

function isResponseLike(x: unknown): x is ResponseLike {
  return !!x && typeof (x as ResponseLike).json === "function";
}

function nameMatchScore(title: string, codes: string[]): number {
  const hay = [title, ...codes].join(" ");
  for (const { re, score } of NAME_MATCH_SCORES) {
    if (re.test(hay)) return score;
  }
  return 0;
}

async function runQuery<TData>(
  client: AdminGqlClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<GqlResponse<TData>> {
  const call = client as unknown as (
    q: string,
    opts?: { variables: Record<string, unknown> },
  ) => Promise<unknown>;

  const raw = await call(query, { variables });
  if (isResponseLike(raw)) {
    return (await raw.json()) as GqlResponse<TData>;
  }
  return raw as GqlResponse<TData>;
}

// -- Public API -------------------------------------------------------------

export async function suggestDiscounts(
  args: SuggestDiscountsArgs,
): Promise<DiscountSuggestion[]> {
  const { client, shopId } = args;
  const maxResults = args.maxResults ?? DEFAULT_MAX_RESULTS;

  // 1. Page through discountNodes.
  const raw: DiscountSuggestion[] = [];
  let cursor: string | null = null;
  let guard = 0;
  while (guard++ < 50) {
    const body: GqlResponse<DiscountNodesData> = await runQuery<DiscountNodesData>(
      client,
      SUGGEST_DISCOUNTS,
      { cursor, first: PAGE_SIZE },
    );

    if (body.errors && body.errors.length > 0) {
      throw new Error(
        `suggestDiscounts: GraphQL errored: ${body.errors
          .map((e) => e.message)
          .join("; ")}`,
      );
    }

    const page = body.data?.discountNodes;
    if (!page) break;

    for (const edge of page.edges) {
      const node = edge.node;
      const detail = node.discount;
      if (!detail) continue;
      const status = detail.status ?? "";
      // 3. Filter: only ACTIVE or SCHEDULED (drop EXPIRED / archived).
      if (status !== "ACTIVE" && status !== "SCHEDULED") continue;

      const codes = (detail.codes?.edges ?? [])
        .map((e) => e.node?.code)
        .filter((c): c is string => typeof c === "string" && c.length > 0);
      if (codes.length === 0) continue;

      raw.push({
        discountNodeId: node.id,
        title: detail.title ?? "",
        codes,
        appliesOncePerCustomer: Boolean(detail.appliesOncePerCustomer),
        status,
      });
    }

    if (!page.pageInfo.hasNextPage) break;
    if (raw.length >= maxResults * 2) break; // soft cap; we'll sort+slice
    cursor = page.pageInfo.endCursor;
    if (!cursor) break;
  }

  // 4. Filter out already-protected codes for this shop.
  // ProtectedOffer stores `codeUpper` (uppercase plaintext). We compare by
  // uppercase to stay consistent with how the ingest path stores them.
  const candidateCodesUpper = Array.from(
    new Set(raw.flatMap((s) => s.codes.map((c) => c.toUpperCase()))),
  );

  const protectedRows =
    candidateCodesUpper.length === 0
      ? []
      : await prisma.protectedOffer.findMany({
          where: {
            shopId,
            archivedAt: null,
            codeUpper: { in: candidateCodesUpper },
          },
          select: { codeUpper: true },
        });
  const protectedSet = new Set(protectedRows.map((r) => r.codeUpper));

  const filtered = raw.filter(
    (s) => !s.codes.some((c) => protectedSet.has(c.toUpperCase())),
  );

  // 5. Sort: appliesOncePerCustomer DESC, then name-match DESC.
  // (Input is already CREATED_AT DESC from the query, so stable sort
  // preserves recency as a tiebreaker.)
  const withIdx = filtered.map((s, i) => ({
    s,
    i,
    score: nameMatchScore(s.title, s.codes),
  }));
  withIdx.sort((a, b) => {
    const aOnce = a.s.appliesOncePerCustomer ? 1 : 0;
    const bOnce = b.s.appliesOncePerCustomer ? 1 : 0;
    if (aOnce !== bOnce) return bOnce - aOnce;
    if (a.score !== b.score) return b.score - a.score;
    return a.i - b.i;
  });

  return withIdx.slice(0, maxResults).map((x) => x.s);
}
