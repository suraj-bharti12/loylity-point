// app/lib/points-mojito.server.js
//
// Loyalty points ke Mojito APIs.
//   POINTS_API_MODE=mojito  -> asli APIs (fabindia.mojitolabs.com)
//   (kuch nahi / dummy)      -> DUMMY: fake points, memory mein (local testing)
//
// Asli mode ke liye env (dono mein se koi ek tareeka):
//   MOJITO_BASIC_AUTH=dXNlcl9m...   (Postman ke Authorization header ki value, "Basic " ke baad wala hissa)
//   ya MOJITO_API_USER=... + MOJITO_API_PASS=...
//   MOJITO_POINTS_BASE_URL   (optional, default https://fabindia.mojitolabs.com)
//   POINTS_RUPEE_PER_POINT   (optional, default 1  -> Mojito currencyRate 1.0)
//   POINTS_MIN_REDEEM        (optional, default 100)

import crypto from "node:crypto";

const MODE = String(process.env.POINTS_API_MODE || "dummy").trim().toLowerCase();
const IS_LIVE = MODE === "mojito";

const RUPEE_PER_POINT = Number(process.env.POINTS_RUPEE_PER_POINT || "1");
const MIN_REDEEM_POINTS = Number(process.env.POINTS_MIN_REDEEM || "100");

const BASE_URL = String(process.env.MOJITO_POINTS_BASE_URL || "https://fabindia.mojitolabs.com")
  .trim()
  .replace(/\/+$/, "");
const API_USER = String(process.env.MOJITO_API_USER || "").trim();
const API_PASS = String(process.env.MOJITO_API_PASS || "").trim();
// Postman wala header seedha: "Basic dXNl..." ya sirf "dXNl..."
const BASIC_TOKEN = String(process.env.MOJITO_BASIC_AUTH || "")
  .trim()
  .replace(/^Basic\s+/i, "");

function authHeader() {
  if (BASIC_TOKEN) return `Basic ${BASIC_TOKEN}`;
  if (API_USER && API_PASS) {
    return `Basic ${Buffer.from(`${API_USER}:${API_PASS}`).toString("base64")}`;
  }
  return null;
}
const TIMEOUT_MS = 12 * 1000;

if (IS_LIVE && !authHeader()) {
  console.error("[points] POINTS_API_MODE=mojito hai par MOJITO_BASIC_AUTH (ya USER/PASS) nahi mila");
}
if (!IS_LIVE) {
  console.warn("[points] DUMMY points mode (POINTS_API_MODE=mojito nahi hai)");
}

export class PointsApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PointsApiError";
    this.code = code;
  }
}

// ---------------- Helpers ----------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// IST time, Mojito format: 2026-09-29T14:05:09.123
function nowIST() {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return d.toISOString().replace("Z", "");
}

// "gid://shopify/ProductVariant/123?x=y" -> "123"
function numericId(gid) {
  return String(gid || "").split("/").pop().split("?")[0];
}

export function isPointsDummy() {
  return !IS_LIVE;
}

// "919870579335" / "+91 98705 79335" -> "9870579335" (Mojito 10 digit leta hai)
export function phoneTo10(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

export function pointsToRupees(points) {
  return round2(Number(points) * RUPEE_PER_POINT);
}

export function rupeesToMaxPoints(rupees) {
  if (RUPEE_PER_POINT <= 0) return 0;
  return Math.floor((Number(rupees) + 1e-9) / RUPEE_PER_POINT);
}

export function getPointsConfig() {
  return { mode: IS_LIVE ? "mojito" : "dummy", rupeePerPoint: RUPEE_PER_POINT, minRedeemPoints: MIN_REDEEM_POINTS };
}

// ======================= ASLI MOJITO =======================

async function callMojito(path, payload) {
  const auth = authHeader();
  if (!auth) {
    throw new PointsApiError("Mojito credentials missing (MOJITO_BASIC_AUTH)", "CONFIG");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (res.status === 401) {
      throw new PointsApiError("Mojito unauthorized (username/password check karo)", "API_ERROR");
    }
    if (!json) {
      throw new PointsApiError(`Mojito bad response (${res.status}): ${text.slice(0, 150)}`, "API_ERROR");
    }
    return json;
  } catch (err) {
    if (err instanceof PointsApiError) throw err;
    if (err?.name === "AbortError") throw new PointsApiError("Mojito timeout", "TIMEOUT");
    throw new PointsApiError(`Mojito network error: ${err?.message || err}`, "API_ERROR");
  } finally {
    clearTimeout(timer);
  }
}

async function liveBalance(phone) {
  const json = await callMojito("points_history.php", { customerphone: Number(phone) });
  if (json.success !== true) {
    throw new PointsApiError(json.message || "Customer not found", "NOT_MEMBER");
  }
  const s = json.summary || {};
  // current_points = abhi use ho sakne wale points (blocked points isme se pehle hi minus hote hain)
  const pts = Math.floor(Number(s.current_points ?? s.total_available_points ?? 0));
  return Math.max(0, pts);
}

// Checkout ke cart ko Mojito ke cartItems format mein
function toCartItems(cart) {
  const items = Array.isArray(cart?.items) ? cart.items.slice(0, 100) : [];
  return items.map((it) => {
    const variantNum = numericId(it.variantId);
    const productNum = numericId(it.productId);
    const lineKey = numericId(it.lineItemId);
    const qty = Math.max(0, Math.floor(Number(it.quantity) || 0));
    const net = round2(Number(it.netAmount) || 0);
    const disc = round2(Math.max(0, Number(it.discount) || 0));
    return {
      lineItemId: variantNum ? `${variantNum}:${lineKey}` : lineKey,
      skuId: String(it.sku || variantNum || ""),
      categoryId: productNum,
      subCategoryId: variantNum,
      departmentId: productNum,
      skuName: String(it.name || "").slice(0, 200),
      productQuantity: qty,
      productNetAmount: net,
      productGrossAmount: round2(net + disc),
      productDiscount: disc,
    };
  });
}

// Har block ke liye alag bill number (15 digit)
function makeBillNo() {
  return Number(`${Date.now()}${crypto.randomInt(10, 100)}`);
}

async function liveBlock({ phone, points, billAmount, cart }) {
  const billNo = makeBillNo();
  const cartItems = toCartItems(cart);
  const totalNet = cartItems.length
    ? round2(cartItems.reduce((s, c) => s + c.productNetAmount, 0))
    : round2(billAmount);
  const totalGross = cartItems.length
    ? round2(cartItems.reduce((s, c) => s + c.productGrossAmount, 0))
    : totalNet;

  const payload = {
    customerPhone: String(phone),
    points: Number(points),
    transactionDetails: {
      billNo,
      totalNetAmount: totalNet,
      totalGrossAmount: totalGross,
      currencyCode: "INR",
      currentTimestamp: nowIST(),
      storeId: "shopify",
      channel: "shopify",
      cartItems,
    },
  };

  let json;
  try {
    json = await callMojito("block_points_loyal.php", payload);
  } catch (err) {
    err.billNo = billNo; // timeout pe baad mein haath se dhoondhne ke liye
    throw err;
  }

  if (json.success !== true || !json.data?.referenceId) {
    const msg = json.message || "Points block failed";
    const code = /insufficient|not enough|less than|exceed|balance/i.test(msg)
      ? "INSUFFICIENT_POINTS"
      : "API_REJECTED";
    throw new PointsApiError(msg, code);
  }

  const d = json.data;
  const pointsRedeemed = Math.round(Number(d.points ?? points));
  const amountRedeemed = round2(
    Number(d.preciseCurrencyValue ?? d.currencyValue ?? pointsRedeemed * RUPEE_PER_POINT),
  );
  return {
    memberId: String(phone),
    invoiceNumber: String(d.referenceId), // unblock ke liye yahi chahiye
    approvalCode: String(billNo), // hamara bheja hua bill number
    currentBatchNumber: "",
    pointsRedeemed,
    amountRedeemed,
    balanceAfter: null,
    transactionDate: nowIST(),
    duplicate: false,
  };
}

async function liveUnblock({ phone, points, referenceId }) {
  const json = await callMojito("unblock_points_loyal.php", {
    customerPhone: String(phone),
    points: Number(points),
    referenceId: String(referenceId),
  });
  if (json.success !== true) {
    throw new PointsApiError(json.message || "Points unblock failed", "API_REJECTED");
  }
  return {
    invoiceNumber: String(referenceId),
    pointsReversed: Number(points),
    balanceAfter: null,
    alreadyCancelled: false,
  };
}

// ======================= DUMMY (local testing) =======================

const DUMMY_START_BALANCE = 1000;
const DUMMY_DELAY_MS = 500;
const dummyBalances = new Map();
const dummyRedeemsByRequest = new Map();
const dummyRedeemsByInvoice = new Map();

function getDummyBalance(memberId) {
  if (!dummyBalances.has(memberId)) {
    dummyBalances.set(memberId, String(memberId).endsWith("0000") ? 0 : DUMMY_START_BALANCE);
  }
  return dummyBalances.get(memberId);
}

async function dummyNetwork(memberId) {
  await sleep(DUMMY_DELAY_MS);
  if (String(memberId).endsWith("9999")) {
    throw new PointsApiError("Dummy: Mojito server down", "API_ERROR");
  }
}

// ======================= Public functions =======================

// memberId: asli mode mein 10 digit mobile, dummy mein kuch bhi
export async function fetchPointsBalance({ memberId }) {
  const id = String(memberId || "").trim();
  if (!id) throw new PointsApiError("memberId khali hai", "INVALID_INPUT");

  let points;
  if (IS_LIVE) {
    points = await liveBalance(id);
  } else {
    await dummyNetwork(id);
    points = getDummyBalance(id);
  }
  return {
    memberId: id,
    points,
    rupeeValue: pointsToRupees(points),
    rupeePerPoint: RUPEE_PER_POINT,
    minRedeemPoints: MIN_REDEEM_POINTS,
  };
}

// Points block (redeem)
export async function redeemPoints({ memberId, points, requestId, billAmount, cart }) {
  const id = String(memberId || "").trim();
  const pts = Number(points);
  if (!id) throw new PointsApiError("memberId khali hai", "INVALID_INPUT");
  if (!Number.isInteger(pts) || pts <= 0) throw new PointsApiError("Points sahi nahi", "INVALID_INPUT");

  if (IS_LIVE) {
    return liveBlock({ phone: id, points: pts, billAmount, cart });
  }

  // ---- dummy ----
  if (requestId && dummyRedeemsByRequest.has(requestId)) {
    return { ...dummyRedeemsByRequest.get(requestId), duplicate: true };
  }
  await dummyNetwork(id);
  const balance = getDummyBalance(id);
  if (pts > balance) {
    throw new PointsApiError(`Itne points nahi hain (balance: ${balance})`, "INSUFFICIENT_POINTS");
  }
  dummyBalances.set(id, balance - pts);
  const invoiceNumber = `PTS-DUMMY-${Date.now()}-${crypto.randomInt(1000, 10000)}`;
  const result = {
    memberId: id,
    invoiceNumber,
    approvalCode: String(crypto.randomInt(100000, 1000000)),
    currentBatchNumber: "DUMMYBATCH001",
    pointsRedeemed: pts,
    amountRedeemed: pointsToRupees(pts),
    balanceAfter: balance - pts,
    transactionDate: nowIST(),
    duplicate: false,
  };
  if (requestId) dummyRedeemsByRequest.set(requestId, result);
  dummyRedeemsByInvoice.set(invoiceNumber, { memberId: id, points: pts, cancelled: false });
  return result;
}

// Points unblock (cancel). invoiceNumber = Mojito referenceId
export async function cancelPointsRedeem({ invoiceNumber, memberId, points }) {
  const ref = String(invoiceNumber || "").trim();
  if (!ref) throw new PointsApiError("referenceId khali hai", "INVALID_INPUT");

  if (IS_LIVE) {
    return liveUnblock({ phone: String(memberId || "").trim(), points, referenceId: ref });
  }

  // ---- dummy ----
  const record = dummyRedeemsByInvoice.get(ref);
  if (!record) throw new PointsApiError("Invoice nahi mila (dummy data restart pe reset)", "NOT_FOUND");
  await dummyNetwork(record.memberId);
  if (record.cancelled) {
    return { invoiceNumber: ref, pointsReversed: 0, balanceAfter: getDummyBalance(record.memberId), alreadyCancelled: true };
  }
  const balanceAfter = getDummyBalance(record.memberId) + record.points;
  dummyBalances.set(record.memberId, balanceAfter);
  record.cancelled = true;
  return { invoiceNumber: ref, pointsReversed: record.points, balanceAfter, alreadyCancelled: false };
}