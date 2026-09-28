// app/lib/points-mojito.server.js
//
// Loyalty points ke Mojito APIs.
// ABHI: DUMMY mode (fake data, memory mein).
// Asli API aane pe sirf IS FILE ko badalna hai. Route / checkout / sweeper same rahenge.
//
// Test ke liye special memberId:
//   ...0000  -> 0 points wala customer
//   ...9999  -> Mojito down (API error)
//   ...8888  -> bahut slow response (20 sec) - timeout test ke liye
//   baaki sab -> 1000 points se shuru

import crypto from "node:crypto";

const MODE = process.env.POINTS_API_MODE || "dummy";

// Developer se asli rate / minimum aane pe Render env mein badal dena
const RUPEE_PER_POINT = Number(process.env.POINTS_RUPEE_PER_POINT || "0.25");
const MIN_REDEEM_POINTS = Number(process.env.POINTS_MIN_REDEEM || "100");

const DUMMY_START_BALANCE = 1000;
const DUMMY_DELAY_MS = 600; // asli API jaisa thoda delay
const DUMMY_SLOW_DELAY_MS = 20000;

// Dummy "database" - memory mein. Server restart / deploy pe reset ho jayega.
const dummyBalances = new Map(); // memberId -> points
const dummyRedeemsByRequest = new Map(); // requestId -> redeem result (double redeem se bachav)
const dummyRedeemsByInvoice = new Map(); // invoiceNumber -> { memberId, points, cancelled }

export class PointsApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PointsApiError";
    this.code = code;
  }
}

// ---------- Helpers ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanMemberId(memberId) {
  const id = String(memberId || "").trim();
  if (!id) {
    throw new PointsApiError("memberId khali hai", "INVALID_INPUT");
  }
  return id;
}

function randomDigits(length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += crypto.randomInt(0, 10);
  }
  return out;
}

function nowIST() {
  // Format: 2026-09-27 14:05:09 (IST)
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

async function dummyNetwork(memberId) {
  if (memberId.endsWith("9999")) {
    await sleep(DUMMY_DELAY_MS);
    throw new PointsApiError("Dummy: Mojito server down", "API_ERROR");
  }
  if (memberId.endsWith("8888")) {
    await sleep(DUMMY_SLOW_DELAY_MS);
    return;
  }
  await sleep(DUMMY_DELAY_MS);
}

function getDummyBalance(memberId) {
  if (!dummyBalances.has(memberId)) {
    dummyBalances.set(memberId, memberId.endsWith("0000") ? 0 : DUMMY_START_BALANCE);
  }
  return dummyBalances.get(memberId);
}

function realNotReady(fnName) {
  throw new PointsApiError(
    `${fnName}: asli Mojito points API abhi nahi lagi (POINTS_API_MODE=${MODE})`,
    "NOT_IMPLEMENTED",
  );
}

// ---------- Public functions ----------

export function pointsToRupees(points) {
  return Math.round(Number(points) * RUPEE_PER_POINT * 100) / 100;
}

// Rupee se max kitne points lag sakte hain (bill se zyada redeem na ho)
export function rupeesToMaxPoints(rupees) {
  if (RUPEE_PER_POINT <= 0) return 0;
  return Math.floor((Number(rupees) + 1e-9) / RUPEE_PER_POINT);
}

export function getPointsConfig() {
  return {
    mode: MODE,
    rupeePerPoint: RUPEE_PER_POINT,
    minRedeemPoints: MIN_REDEEM_POINTS,
  };
}

// 1) Balance fetch
export async function fetchPointsBalance({ memberId }) {
  const id = cleanMemberId(memberId);
  if (MODE !== "dummy") return realNotReady("fetchPointsBalance");

  await dummyNetwork(id);
  const points = getDummyBalance(id);

  return {
    memberId: id,
    points,
    rupeeValue: pointsToRupees(points),
    rupeePerPoint: RUPEE_PER_POINT,
    minRedeemPoints: MIN_REDEEM_POINTS,
  };
}

// 2) Redeem (points kaato, rupee value lautao)
// requestId: har redeem ke liye unique id (DB row id). Same requestId dobara aaye
// to dobara points nahi katenge, pichla result hi wapas milega.
export async function redeemPoints({ memberId, points, requestId }) {
  const id = cleanMemberId(memberId);
  const pts = Number(points);

  if (!Number.isInteger(pts) || pts <= 0) {
    throw new PointsApiError("Points sahi number hone chahiye", "INVALID_INPUT");
  }
  if (!requestId) {
    throw new PointsApiError("requestId zaroori hai", "INVALID_INPUT");
  }
  if (MODE !== "dummy") return realNotReady("redeemPoints");

  const previous = dummyRedeemsByRequest.get(requestId);
  if (previous) {
    return { ...previous, duplicate: true };
  }

  await dummyNetwork(id);

  if (pts < MIN_REDEEM_POINTS) {
    throw new PointsApiError(
      `Kam se kam ${MIN_REDEEM_POINTS} points redeem kar sakte hain`,
      "BELOW_MINIMUM",
    );
  }

  const balance = getDummyBalance(id);
  if (pts > balance) {
    throw new PointsApiError(
      `Itne points nahi hain (balance: ${balance})`,
      "INSUFFICIENT_POINTS",
    );
  }

  const balanceAfter = balance - pts;
  dummyBalances.set(id, balanceAfter);

  const invoiceNumber = `PTS-DUMMY-${Date.now()}-${randomDigits(4)}`;
  const result = {
    memberId: id,
    invoiceNumber,
    approvalCode: randomDigits(6),
    currentBatchNumber: "DUMMYBATCH001",
    pointsRedeemed: pts,
    amountRedeemed: pointsToRupees(pts),
    balanceAfter,
    transactionDate: nowIST(),
    duplicate: false,
  };

  dummyRedeemsByRequest.set(requestId, result);
  dummyRedeemsByInvoice.set(invoiceNumber, {
    memberId: id,
    points: pts,
    cancelled: false,
  });

  return result;
}

// 3) Cancel / reverse (points wapas)
// Dobara call ho jaye (sweeper retry) to error nahi, alreadyCancelled: true milega.
export async function cancelPointsRedeem({ invoiceNumber }) {
  const inv = String(invoiceNumber || "").trim();
  if (!inv) {
    throw new PointsApiError("invoiceNumber khali hai", "INVALID_INPUT");
  }
  if (MODE !== "dummy") return realNotReady("cancelPointsRedeem");

  const record = dummyRedeemsByInvoice.get(inv);
  if (!record) {
    await sleep(DUMMY_DELAY_MS);
    throw new PointsApiError(
      "Ye invoice nahi mila (dummy data server restart pe reset ho jata hai)",
      "NOT_FOUND",
    );
  }

  await dummyNetwork(record.memberId);

  if (record.cancelled) {
    return {
      invoiceNumber: inv,
      pointsReversed: 0,
      balanceAfter: getDummyBalance(record.memberId),
      alreadyCancelled: true,
    };
  }

  const balanceAfter = getDummyBalance(record.memberId) + record.points;
  dummyBalances.set(record.memberId, balanceAfter);
  record.cancelled = true;

  return {
    invoiceNumber: inv,
    pointsReversed: record.points,
    balanceAfter,
    alreadyCancelled: false,
  };
}