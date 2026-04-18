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
} from "../lib/admin-auth.server.js";

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

    // In production, send via email. For now, surface in non-prod.
    if (process.env.NODE_ENV !== "production") {
      return { sent: true, devLink: link };
    }

    return { sent: true, devLink: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("allowlist")) {
      // Don't leak whether the email is in the allowlist to an attacker;
      // show the same "check your inbox" message. We still return the real
      // error only in non-production for developer convenience.
      if (process.env.NODE_ENV !== "production") {
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

  // If loader returned an error (bad token), we render it below via actionData-like pattern.
  // The loader returns null | { error } but useLoaderData would need import; keep it simple
  // — the loader redirects on success or returns { error } which we handle here.

  if (hasToken && !actionData) {
    // Token is being processed — loader will redirect or return error.
    // On error, the loader returns data that React Router surfaces via the component.
    // We get here if the loader returned { error }.
    return (
      <div style={containerStyle}>
        <h1 style={headingStyle}>Promo Guard — Platform</h1>
        <p style={{ color: "#f88" }}>
          Magic link is invalid, expired, or already used. Please request a new
          one.
        </p>
        <a href="/admin/login" style={{ color: "#f0c040" }}>
          Request new link
        </a>
      </div>
    );
  }

  if (actionData && "sent" in actionData && actionData.sent) {
    return (
      <div style={containerStyle}>
        <h1 style={headingStyle}>Check your inbox</h1>
        <p>A magic link has been sent to your email address.</p>
        {"devLink" in actionData && actionData.devLink ? (
          <p style={{ marginTop: "16px", fontSize: "12px", color: "#aaa" }}>
            <strong>[dev]</strong>{" "}
            <a href={actionData.devLink} style={{ color: "#f0c040" }}>
              {actionData.devLink}
            </a>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <h1 style={headingStyle}>Promo Guard — Platform</h1>
      <p style={{ color: "#aaa", marginBottom: "24px" }}>
        Enter your team email to receive a magic sign-in link.
      </p>
      <form method="post">
        <div style={{ marginBottom: "12px" }}>
          <label htmlFor="email" style={{ display: "block", marginBottom: "4px" }}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            style={inputStyle}
            placeholder="you@promo-guard.com"
          />
        </div>
        {actionData && "error" in actionData && actionData.error ? (
          <p style={{ color: "#f88", marginBottom: "8px" }}>{actionData.error}</p>
        ) : null}
        <button type="submit" style={buttonStyle}>
          Send magic link
        </button>
      </form>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  fontFamily: "monospace",
  maxWidth: "400px",
  margin: "80px auto",
  padding: "32px",
  background: "#1a1a2e",
  color: "#eee",
  borderRadius: "8px",
};

const headingStyle: React.CSSProperties = {
  color: "#f0c040",
  marginBottom: "8px",
  fontSize: "20px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px",
  background: "#0f0f1a",
  border: "1px solid #444",
  color: "#eee",
  fontFamily: "monospace",
  fontSize: "14px",
  boxSizing: "border-box",
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 16px",
  background: "#f0c040",
  color: "#1a1a2e",
  border: "none",
  fontFamily: "monospace",
  fontSize: "14px",
  cursor: "pointer",
  fontWeight: "bold",
};
