// app/lib/points-mojito.server.js
//
// Loyalty points ke Mojito APIs.
//   (kuch nahi) / POINTS_API_MODE=mojito -> asli APIs (fabindia.mojitolabs.com)  <- DEFAULT
//   POINTS_API_MODE=dummy                 -> nakli points, sirf LOCAL testing ke liye.
//
// SECURITY: dummy kabhi apne aap chalu nahi hota, aur live (NODE_ENV=production) mein
// dummy likha ho to bhi nahi chalta - app Fabcoins dena band kar deta hai (fail closed).
//
// Asli mode ke liye env (dono mein se koi ek tareeka):
//   MOJITO_BASIC_AUTH=...   (Postman ke Authorization header ki value, "Basic " ke baad wala hissa)
//   ya MOJITO_API_USER=... + MOJITO_API_PASS=...
//   MOJITO_POINTS_BASE_URL   (optional, default https://fabindia.mojitolabs.com)
//   POINTS_RUPEE_PER_POINT   (optional, default 1  -> Mojito currencyRate 1.0)
//
// Live store aur testing store ka alag Mojito (ek hi app, ek hi server):
//   MOJITO_LIVE_SHOPS        (optional, default fabindia2.myshopify.com) -> MOJITO_POINTS_BASE_URL
//   MOJITO_TEST_SHOPS        (jaise staging-fabindia.myshopify.com)      -> MOJITO_TEST_BASE_URL
//   MOJITO_TEST_BASE_URL     (testing wala Mojito domain)
//   MOJITO_TEST_BASIC_AUTH   (optional; na ho to live wala MOJITO_BASIC_AUTH hi)
//   Kai store hon to comma se: a.myshopify.com,b.myshopify.com
// SECURITY: jo store kisi list mein nahi, uske liye Fabcoins band. Testing store kabhi
// galti se live Mojito pe nahi jayega (aur test URL na mila to bhi live pe nahi jayega).
//   POINTS_MIN_REDEEM        (optional, default 1 = koi minimum nahi)

import crypto from "node:crypto";

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const MODE = String(process.env.POINTS_API_MODE || "mojito").trim().toLowerCase();
// Nakli points sirf tab: saaf "dummy" likha ho AUR live server na ho
const IS_DUMMY = MODE === "dummy" && !IS_PRODUCTION;
const IS_LIVE = !IS_DUMMY;
// Galat setting (live pe dummy, ya koi aur shabd) -> koi points nahi
const CONFIG_PROBLEM =
  MODE === "dummy" && IS_PRODUCTION
    ? "POINTS_API_MODE=dummy live server pe allowed nahi"
    : MODE !== "dummy" && MODE !== "mojito"
      ? `POINTS_API_MODE="${MODE}" samajh nahi aaya (mojito ya dummy)`
      : "";

const RUPEE_PER_POINT = Number(process.env.POINTS_RUPEE_PER_POINT || "1");
// Default 1 = customer kitne bhi points (1 se upar) redeem kar sakta hai
const MIN_REDEEM_POINTS = Math.max(1, Number(process.env.POINTS_MIN_REDEEM || "1"));

function cleanUrl(v) {
  return String(v || "").trim().replace(/\/+$/, "");
}
// "https://Fabindia2.myshopify.com/" -> "fabindia2.myshopify.com"
function normalizeShop(v) {
  return String(v || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}
function parseShops(v) {
  return new Set(String(v || "").split(/[\s,]+/).map(normalizeShop).filter(Boolean));
}

const BASE_URL = cleanUrl(process.env.MOJITO_POINTS_BASE_URL || "https://fabindia.mojitolabs.com");
const TEST_BASE_URL = cleanUrl(process.env.MOJITO_TEST_BASE_URL);
const LIVE_SHOPS = parseShops(process.env.MOJITO_LIVE_SHOPS || "fabindia2.myshopify.com");
const TEST_SHOPS = parseShops(process.env.MOJITO_TEST_SHOPS);

const API_USER = String(process.env.MOJITO_API_USER || "").trim();
const API_PASS = String(process.env.MOJITO_API_PASS || "").trim();
// Postman wala header seedha: "Basic xxxx..." ya sirf "xxxx..."
const BASIC_TOKEN = String(process.env.MOJITO_BASIC_AUTH || "")
  .trim()
  .replace(/^Basic\s+/i, "");
const TEST_BASIC_TOKEN = String(process.env.MOJITO_TEST_BASIC_AUTH || "")
  .trim()
  .replace(/^Basic\s+/i, "");

function authHeader() {
  if (BASIC_TOKEN) return `Basic ${BASIC_TOKEN}`;
  if (API_USER && API_PASS) {
    return `Basic ${Buffer.from(`${API_USER}:${API_PASS}`).toString("base64")}`;
  }
  return null;
}
function testAuthHeader() {
  return TEST_BASIC_TOKEN ? `Basic ${TEST_BASIC_TOKEN}` : authHeader();
}
const TIMEOUT_MS = 12 * 1000;

if (CONFIG_PROBLEM) {
  console.error(`[points] ${CONFIG_PROBLEM} -> Fabcoins BAND (koi points/gift card nahi banega)`);
} else if (IS_LIVE && !authHeader()) {
  console.error("[points] MOJITO_BASIC_AUTH (ya USER/PASS) nahi mila -> Fabcoins BAND");
} else if (IS_DUMMY) {
  console.warn("[points] DUMMY points mode (sirf local testing) - POINTS_API_MODE=dummy");
}
if (IS_LIVE) {
  console.log(`[points] LIVE Mojito ${BASE_URL} <- ${[...LIVE_SHOPS].join(", ") || "(koi store nahi)"}`);
  if (TEST_SHOPS.size) {
    console.log(`[points] TEST Mojito ${TEST_BASE_URL || "(MOJITO_TEST_BASE_URL nahi mila -> BAND)"} <- ${[...TEST_SHOPS].join(", ")}`);
  }
}

export class PointsApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PointsApiError";
    this.code = code;
  }
}

// Setting galat ho to koi bhi points wala kaam mat karo
function assertConfigured() {
  if (CONFIG_PROBLEM) throw new PointsApiError(CONFIG_PROBLEM, "CONFIG");
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
  return IS_DUMMY;
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

// Kaunse store ke liye kaunsa Mojito. Har store ka faisla ek baar log mein bhi dikhta hai.
const targetLogged = new Set();
function mojitoTarget(shop) {
  const s = normalizeShop(shop);
  const isLive = LIVE_SHOPS.has(s);
  const isTest = TEST_SHOPS.has(s);
  let target = null;
  let problem = "";
  if (isLive && isTest) {
    problem = `store ${s} LIVE aur TEST dono list mein hai`;
  } else if (isTest) {
    if (TEST_BASE_URL) target = { env: "TEST", baseUrl: TEST_BASE_URL, auth: testAuthHeader() };
    else problem = `store ${s} testing store hai par MOJITO_TEST_BASE_URL nahi mila`;
  } else if (isLive) {
    target = { env: "LIVE", baseUrl: BASE_URL, auth: authHeader() };
  } else {
    problem = `store ${s || "(khali)"} kisi list mein nahi (MOJITO_LIVE_SHOPS / MOJITO_TEST_SHOPS)`;
  }
  const key = `${s}|${target?.env || "BAND"}`;
  if (!targetLogged.has(key)) {
    targetLogged.add(key);
    if (target) console.log(`[points] ${s} -> ${target.env} Mojito (${target.baseUrl})`);
    else console.error(`[points] ${problem} -> is store pe Fabcoins BAND`);
  }
  if (!target) throw new PointsApiError(problem, "CONFIG");
  return target;
}

async function callMojito(target, path, payload) {
  const auth = target.auth;
  if (!auth) {
    throw new PointsApiError("Mojito credentials missing (MOJITO_BASIC_AUTH)", "CONFIG");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${target.baseUrl}/${path}`, {
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

async function liveBalance(target, phone) {
  const json = await callMojito(target, "points_history.php", { customerphone: Number(phone) });
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

// Mojito ke totalNetAmount / totalGrossAmount (block request aur order notes dono mein yahi).
// Mojito Fabcoins ki limit totalNetAmount se banata hai, isliye shipping bhi isme jodte hain
// (taaki Fabcoins se shipping bhi pay ho sake, wallet jaisa).
export function computeTotals(cart, billAmount) {
  const cartItems = toCartItems(cart);
  const shipping = round2(Math.max(0, Number(cart?.shipping) || 0));
  const totalNetAmount = cartItems.length
    ? round2(cartItems.reduce((s, c) => s + c.productNetAmount, 0) + shipping)
    : round2(billAmount);
  const totalGrossAmount = cartItems.length
    ? round2(cartItems.reduce((s, c) => s + c.productGrossAmount, 0) + shipping)
    : totalNetAmount;
  return { cartItems, totalNetAmount, totalGrossAmount, shipping };
}

// Har block ke liye alag bill number (15 digit)
function makeBillNo() {
  return Number(`${Date.now()}${crypto.randomInt(10, 100)}`);
}

async function liveBlock(target, { phone, points, billAmount, cart }) {
  const billNo = makeBillNo();
  const { cartItems, totalNetAmount: totalNet, totalGrossAmount: totalGross } = computeTotals(cart, billAmount);

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
    json = await callMojito(target, "block_points_loyal.php", payload);
  } catch (err) {
    err.billNo = billNo; // timeout pe baad mein haath se dhoondhne ke liye
    throw err;
  }

  if (json.success !== true || !json.data?.referenceId) {
    const msg = json.message || "Points block failed";
    console.error("[points] Mojito block rejected:", msg, "| points:", points, "| totalNet:", totalNet);
    // Sirf saaf "kam points" wale message ko hi INSUFFICIENT maano, baaki Mojito ka asli message dikhao
    const code = /insufficient|not enough/i.test(msg) ? "INSUFFICIENT_POINTS" : "API_REJECTED";
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
    totalNetAmount: totalNet,
    totalGrossAmount: totalGross,
    balanceAfter: null,
    transactionDate: nowIST(),
    duplicate: false,
  };
}

async function liveUnblock(target, { phone, points, referenceId }) {
  const json = await callMojito(target, "unblock_points_loyal.php", {
    customerPhone: String(phone),
    points: Number(points),
    referenceId: String(referenceId),
  });
  if (json.success !== true) {
    console.error("[points] Mojito unblock rejected:", json.message, "| ref:", referenceId);
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
// shop: kaunse store ka checkout (usi se live / test Mojito chuna jata hai)
export async function fetchPointsBalance({ shop, memberId }) {
  assertConfigured();
  const id = String(memberId || "").trim();
  if (!id) throw new PointsApiError("memberId khali hai", "INVALID_INPUT");

  let points;
  if (IS_LIVE) {
    points = await liveBalance(mojitoTarget(shop), id);
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
export async function redeemPoints({ shop, memberId, points, requestId, billAmount, cart }) {
  assertConfigured();
  const id = String(memberId || "").trim();
  const pts = Number(points);
  if (!id) throw new PointsApiError("memberId khali hai", "INVALID_INPUT");
  if (!Number.isInteger(pts) || pts <= 0) throw new PointsApiError("Points sahi nahi", "INVALID_INPUT");

  if (IS_LIVE) {
    return liveBlock(mojitoTarget(shop), { phone: id, points: pts, billAmount, cart });
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
  const invoiceNumber = `DUMMY${crypto.randomInt(10000, 100000)}`;
  const totals = computeTotals(cart, billAmount);
  const result = {
    memberId: id,
    invoiceNumber,
    approvalCode: String(makeBillNo()),
    currentBatchNumber: "DUMMYBATCH001",
    pointsRedeemed: pts,
    amountRedeemed: pointsToRupees(pts),
    totalNetAmount: totals.totalNetAmount,
    totalGrossAmount: totals.totalGrossAmount,
    balanceAfter: balance - pts,
    transactionDate: nowIST(),
    duplicate: false,
  };
  if (requestId) dummyRedeemsByRequest.set(requestId, result);
  dummyRedeemsByInvoice.set(invoiceNumber, { memberId: id, points: pts, cancelled: false });
  return result;
}

// Points unblock (cancel). invoiceNumber = Mojito referenceId
// shop: jis store pe points block hue the (unblock bhi usi Mojito pe hona chahiye)
export async function cancelPointsRedeem({ shop, invoiceNumber, memberId, points }) {
  assertConfigured();
  const ref = String(invoiceNumber || "").trim();
  if (!ref) throw new PointsApiError("referenceId khali hai", "INVALID_INPUT");

  if (IS_LIVE) {
    return liveUnblock(mojitoTarget(shop), { phone: String(memberId || "").trim(), points, referenceId: ref });
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