/**
 * Compact 30-day stacked bar chart for the dashboard. Pure SVG — no
 * chart library. Two series (redemptions + flagged) stacked per day.
 *
 * Why SVG vs. canvas: SSR-friendly, accessible (we expose a textual
 * summary), zero JS bundle cost, fits on the dashboard at any zoom.
 *
 * Colors are hand-picked hex matching Shopify admin tones (info-blue
 * for redemptions, critical-red for flagged) — using `var(--s-color-*)`
 * tokens here was unreliable across themes, so we hard-code.
 */

export type DailyPoint = {
  /** ISO YYYY-MM-DD date */
  date: string;
  redemptions: number;
  flagged: number;
};

export type DailyChartProps = {
  series: DailyPoint[];
  /** Pixel height of the chart area. Width fills the container. */
  height?: number;
};

const REDEMPTION_FILL = "#005bd3"; // Shopify info-blue
const FLAGGED_FILL = "#d72c0d"; // Shopify critical-red
const EMPTY_TICK = "#e1e3e5"; // Shopify border-subdued

export function DailyChart({ series, height = 160 }: DailyChartProps) {
  if (series.length === 0) return null;

  const max = Math.max(1, ...series.map((p) => p.redemptions + p.flagged));
  const barW = 100 / series.length;
  const gap = barW * 0.18;
  const innerW = barW - gap;

  const totalRedemptions = series.reduce((s, p) => s + p.redemptions, 0);
  const totalFlagged = series.reduce((s, p) => s + p.flagged, 0);
  const summary = `Last 30 days: ${totalRedemptions} redemptions, ${totalFlagged} flagged`;

  const firstDate = series[0]?.date ?? "";
  const lastDate = series[series.length - 1]?.date ?? "";

  return (
    <s-stack gap="small-300">
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        style={{ width: "100%", height: `${height}px`, display: "block" }}
      >
        {series.map((p, i) => {
          const x = i * barW + gap / 2;
          const total = p.redemptions + p.flagged;
          const totalH = (total / max) * (height - 2);
          const flaggedH = (p.flagged / max) * (height - 2);
          const redempH = totalH - flaggedH;
          const baseY = height - totalH;
          return (
            <g key={p.date}>
              {redempH > 0 ? (
                <rect
                  x={x}
                  y={baseY}
                  width={innerW}
                  height={redempH}
                  fill={REDEMPTION_FILL}
                  rx={0.6}
                >
                  <title>{`${p.date}: ${p.redemptions} redemptions`}</title>
                </rect>
              ) : null}
              {flaggedH > 0 ? (
                <rect
                  x={x}
                  y={baseY + redempH}
                  width={innerW}
                  height={flaggedH}
                  fill={FLAGGED_FILL}
                  rx={0.6}
                >
                  <title>{`${p.date}: ${p.flagged} flagged`}</title>
                </rect>
              ) : null}
              {total === 0 ? (
                <rect
                  x={x}
                  y={height - 1}
                  width={innerW}
                  height={1}
                  fill={EMPTY_TICK}
                />
              ) : null}
            </g>
          );
        })}
      </svg>

      <s-stack
        direction="inline"
        gap="base"
        alignItems="center"
        justifyContent="space-between"
      >
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: 2,
                background: REDEMPTION_FILL,
              }}
            />
            <s-text>Redemptions</s-text>
          </s-stack>
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: 2,
                background: FLAGGED_FILL,
              }}
            />
            <s-text>Flagged</s-text>
          </s-stack>
        </s-stack>
        <s-text>
          {firstDate} → {lastDate}
        </s-text>
      </s-stack>
    </s-stack>
  );
}

