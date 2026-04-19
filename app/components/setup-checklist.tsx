/**
 * See: docs/admin-ui-spec.md §3 (Onboarding)
 * Standard: docs/polaris-standards.md §12 (Setup guide pattern)
 *
 * Step status is derived from loader data — the icon is a read-only
 * indicator, never a user input. Users advance steps by taking the
 * action (creating an offer, redeeming a code) or clicking the step CTA.
 */
import { Fragment } from "react";

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

function stepIcon(item: ChecklistItem): {
  type: "check-circle-filled" | "circle-dashed" | "circle";
  tone: "success" | "auto";
  color: "base" | "subdued";
} {
  if (item.done) return { type: "check-circle-filled", tone: "success", color: "base" };
  if (item.disabled) return { type: "circle-dashed", tone: "auto", color: "subdued" };
  return { type: "circle", tone: "auto", color: "base" };
}

export function SetupChecklist({ items }: SetupChecklistProps) {
  const doneCount = items.filter((i) => i.done).length;

  return (
    <s-grid gap="small">
      <s-paragraph color="subdued">
        {doneCount} out of {items.length} steps completed
      </s-paragraph>

      <s-box
        borderRadius="base"
        borderWidth="base"
        borderColor="base"
        background="base"
      >
        {items.map((item, i) => {
          const icon = stepIcon(item);
          return (
            <Fragment key={item.id}>
              <s-box padding="base">
                <s-grid
                  gridTemplateColumns="auto 1fr"
                  gap="base"
                  alignItems="start"
                >
                  <s-icon
                    type={icon.type}
                    tone={icon.tone}
                    color={icon.color}
                    size="base"
                  />
                  <s-stack gap="small-200">
                    <s-text type="strong">{item.title}</s-text>
                    <s-paragraph color="subdued">
                      {item.description}
                    </s-paragraph>
                    {item.cta && !item.done && !item.disabled ? (
                      <s-stack direction="inline" gap="small-200">
                        <s-button
                          variant="primary"
                          href={item.cta.href}
                          {...(item.cta.external
                            ? { target: "_blank" }
                            : {})}
                        >
                          {item.cta.label}
                        </s-button>
                      </s-stack>
                    ) : null}
                  </s-stack>
                </s-grid>
              </s-box>
              {i < items.length - 1 ? <s-divider /> : null}
            </Fragment>
          );
        })}
      </s-box>
    </s-grid>
  );
}
