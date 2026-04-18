/**
 * See: docs/admin-ui-spec.md §3 (Onboarding)
 */

export type ChecklistItem = {
  id: string;
  title: string;
  description: string;
  cta?: { label: string; href: string; external?: boolean };
  done: boolean;
  disabled?: boolean;
};

export type SetupChecklistProps = {
  items: ChecklistItem[];
};

export function SetupChecklist({ items }: SetupChecklistProps) {
  return (
    <s-stack gap="large">
      {items.map((item) => (
        <s-stack key={item.id} direction="inline" gap="base" alignItems="start">
          <s-text>{item.done ? "✓" : item.disabled ? "○" : "□"}</s-text>
          <s-stack gap="small">
            <s-heading>{item.title}</s-heading>
            <s-text tone={item.disabled ? "neutral" : undefined}>
              {item.description}
            </s-text>
            {item.done ? (
              <s-text tone="success">Done</s-text>
            ) : item.cta && !item.disabled ? (
              <s-button
                variant="primary"
                href={item.cta.href}
                {...(item.cta.external ? { target: "_blank" } : {})}
              >
                {item.cta.label}
              </s-button>
            ) : null}
          </s-stack>
        </s-stack>
      ))}
    </s-stack>
  );
}
