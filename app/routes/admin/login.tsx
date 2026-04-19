/**
 * See: docs/platform-admin-spec.md §3 (magic-link login route)
 * Related: docs/platform-admin-spec.md §17 (magic-link auth)
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useSearchParams } from "react-router";
import {
  requestMagicLink,
  verifyMagicLink,
  buildSessionCookie,
} from "~/lib/admin-auth.server.js";
import { env } from "~/lib/env.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (token) {
    const ipAddress =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      undefined;
    const userAgent = request.headers.get("user-agent") ?? undefined;

    try {
      const sessionToken = await verifyMagicLink(token, ipAddress, userAgent);
      const cookie = buildSessionCookie(sessionToken);
      return redirect("/admin", {
        headers: { "Set-Cookie": cookie },
      });
    } catch {
      return { error: "Magic link is invalid, expired, or already used." };
    }
  }

  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const email = (form.get("email") as string | null)?.trim() ?? "";

  if (!email) {
    return { error: "Email is required." };
  }

  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;

  try {
    const link = await requestMagicLink(email, ipAddress);

    if (env.NODE_ENV !== "production") {
      return { sent: true, devLink: link };
    }

    return { sent: true, devLink: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("allowlist")) {
      if (env.NODE_ENV !== "production") {
        return { error: message };
      }
      return { sent: true, devLink: null };
    }
    return { error: "Could not send magic link. Try again." };
  }
};

export default function AdminLogin() {
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const hasToken = searchParams.has("token");

  if (hasToken && !actionData) {
    return (
      <s-page heading="Promo Guard — Platform" inlineSize="small">
        <s-section>
          <s-stack gap="base">
            <s-banner tone="critical">
              Magic link is invalid, expired, or already used. Please request a new one.
            </s-banner>
            <s-link href="/admin/login">Request new link</s-link>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  if (actionData && "sent" in actionData && actionData.sent) {
    return (
      <s-page heading="Check your inbox" inlineSize="small">
        <s-section>
          <s-stack gap="base">
            <s-text>A magic link has been sent to your email address.</s-text>
            {"devLink" in actionData && actionData.devLink ? (
              <s-text color="subdued">
                [dev] <s-link href={actionData.devLink}>{actionData.devLink}</s-link>
              </s-text>
            ) : null}
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Promo Guard — Platform" inlineSize="small">
      <s-section>
        <form method="post">
          <s-stack gap="base">
            <s-text color="subdued">
              Enter your team email to receive a magic sign-in link.
            </s-text>
            {actionData && "error" in actionData && actionData.error ? (
              <s-banner tone="critical">{actionData.error}</s-banner>
            ) : null}
            <s-email-field
              label="Email"
              name="email"
              placeholder="you@promo-guard.com"
              autocomplete="email"
              required
            />
            <s-button type="submit" variant="primary">Send magic link</s-button>
          </s-stack>
        </form>
      </s-section>
    </s-page>
  );
}
