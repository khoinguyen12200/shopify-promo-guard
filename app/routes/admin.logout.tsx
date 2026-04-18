/**
 * See: docs/platform-admin-spec.md §2 (access control / logout)
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import {
  clearSessionCookie,
  revokeAdminSession,
} from "../lib/admin-auth.server.js";

async function handle(request: Request) {
  await revokeAdminSession(request);
  throw redirect("/admin/login", {
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => handle(request);
export const action = async ({ request }: ActionFunctionArgs) => handle(request);
