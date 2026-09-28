// app/routes/api.points.jsx
// Checkout ka loyalty points box yahi URL call karta hai: POST /api/points
// Box token ko body mein bhejta hai (text/plain), taaki browser preflight na kare.

import { authenticate } from "../shopify.server";
import { handlePointsAction } from "../lib/points-checkout.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "7200",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") return preflight();
  return json({ ok: false, message: "Use POST" }, 405);
};

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") return preflight();

  // 1) Body padho: { action, token, ...baaki }
  let body = {};
  try {
    body = JSON.parse(await request.text());
  } catch {
    body = {};
  }

  // 2) Token body se (ya purane tareeke se header se)
  const headerToken = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const token = body.token || headerToken;
  delete body.token;
  if (!token) {
    return json({ ok: false, code: "UNAUTHORIZED", message: "Session expired. Please refresh the page." }, 401);
  }

  // 3) Token Shopify ke tareeke se verify (header mein daal ke)
  let sessionToken;
  try {
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const origin = request.headers.get("Origin");
    const userAgent = request.headers.get("User-Agent");
    if (origin) headers.set("Origin", origin);
    if (userAgent) headers.set("User-Agent", userAgent);
    const authRequest = new Request(request.url, { method: "POST", headers });
    ({ sessionToken } = await authenticate.public.checkout(authRequest));
  } catch (err) {
    console.error("[points] session token check failed:", err?.status || err);
    return json({ ok: false, code: "UNAUTHORIZED", message: "Session expired. Please refresh the page." }, 401);
  }

  const shop = String(sessionToken.dest || "").replace(/^https?:\/\//, "");
  const customerGid = sessionToken.sub || null; // login nahi to null

  // 4) Asli kaam
  try {
    const result = await handlePointsAction({ shop, customerGid, body });
    return json(result);
  } catch (err) {
    console.error("[points] server error:", err);
    return json({ ok: false, code: "SERVER_ERROR", message: "Something went wrong. Please try again." }, 500);
  }
};