// app/lib/points-checkout.server.js
//
// Loyalty points ka server wala kaam (wallet jaisa):
//   balance -> points dikhana
//   sendOtp -> customer ke profile wale mobile pe OTP (Gupshup)
//   redeem  -> OTP check + points kaatna + utne Rs ka Shopify gift card banana
//   cancel  -> gift card band + points wapas
//   ping    -> checkout zinda hai (har 20 sec)

import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  fetchPointsBalance,
  redeemPoints,
  cancelPointsRedeem,
  getPointsConfig,
  rupeesToMaxPoints,
  PointsApiError,
  isPointsDummy,
  phoneTo10,
} from "./points-mojito.server";
import { sendOtp, verifyOtp, normalizeIndianPhone, maskPhone, isOtpDummy } from "./otp.server";

// Gift card ke note mein sabse pehle ye likha jayega (wallet wale cards se alag pehchaan)
const POINTS_SOURCE_LABEL = process.env.POINTS_SOURCE_LABEL || "XENO LOYALTY POINTS";

const STALE_ACTIVE_MS = 10 * 60 * 1000; // 10 min ping nahi aaya
const STALE_PENDING_MS = 2 * 60 * 1000; // pending 2 min se zyada = kuch atka

// ---------------- OTP settings ----------------
const OTP_REQUIRED = process.env.POINTS_OTP_REQUIRED !== "false"; // default: OTP chahiye
const OTP_RESEND_AFTER_MS = 30 * 1000; // resend 30 sec baad
const OTP_SESSION_MS = 10 * 60 * 1000; // bheja hua OTP 10 min tak use ho sakta hai
const OTP_MAX_VERIFY_ATTEMPTS = 3; // 3 galat -> naya OTP mangao
// Limits env se badal sakte ho (Render -> Environment), code nahi chhedna
const OTP_MAX_SENDS = Number(process.env.OTP_MAX_SENDS || "5"); // itni der mein zyada se zyada itne OTP
const OTP_SEND_WINDOW_MS = Number(process.env.OTP_SEND_WINDOW_MIN || "15") * 60 * 1000;
// OTP sahi daalne ke baad itni der tak dobara OTP nahi maangenge (redeem kisi aur wajah se fail ho to)
const OTP_VERIFIED_MS = 5 * 60 * 1000;

// customerGid -> { phone, sentAt, attempts, sends: [timestamps] }
// (memory mein; server restart pe reset - theek hai)
const otpState = new Map();

// ---------------- Helpers ----------------

function fail(code, message) {
  return { ok: false, code, message };
}

// Local test (shopify app dev) mein asli wajah bhi message mein dikhao.
// Live server (NODE_ENV=production) pe customer ko sirf simple message dikhega.
const IS_DEV = process.env.NODE_ENV !== "production";
function devMsg(message, detail) {
  return IS_DEV && detail ? `${message} [${detail}]` : message;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}



// Dummy / asli API ke errors ko customer ke samajhne layak message mein badlo
function apiErrorToFail(err) {
  const cfg = getPointsConfig();
  if (err instanceof PointsApiError) {
    switch (err.code) {
      case "INSUFFICIENT_POINTS":
        return fail(err.code, devMsg("You don't have enough points.", err.message));
      case "BELOW_MINIMUM":
        return fail(err.code, `Minimum ${cfg.minRedeemPoints} points can be redeemed.`);
      case "API_ERROR":
      case "CONFIG":
        return fail(err.code, devMsg("Loyalty service is not available right now. Please try again.", err.message));
      case "TIMEOUT":
        return fail(err.code, "Loyalty service is taking too long. Please try again.");
      case "NOT_MEMBER":
        return fail(err.code, devMsg("No loyalty account found for your mobile number.", err.message));
      case "API_REJECTED":
        return fail(err.code, err.message || "Couldn't process your points. Please try again.");
      default:
        return fail(err.code || "API_ERROR", "Couldn't process your points. Please try again.");
    }
  }
  return fail("API_ERROR", "Couldn't process your points. Please try again.");
}

async function adminGraphql(shop, query, variables) {
  const { admin } = await unauthenticated.admin(shop);
  const res = await admin.graphql(query, { variables });
  return res.json();
}

async function createGiftCard(shop, amount, note) {
  const json = await adminGraphql(
    shop,
    `#graphql
    mutation PointsGiftCardCreate($input: GiftCardCreateInput!) {
      giftCardCreate(input: $input) {
        giftCard { id lastCharacters }
        giftCardCode
        userErrors { field message }
      }
    }`,
    { input: { initialValue: Number(amount).toFixed(2), note } },
  );
  const payload = json?.data?.giftCardCreate;
  if (!payload?.giftCard?.id || !payload?.giftCardCode) {
    const msg =
      payload?.userErrors?.[0]?.message || json?.errors?.[0]?.message || "No gift card returned";
    throw new Error(msg);
  }
  return {
    id: payload.giftCard.id,
    code: payload.giftCardCode,
    last4: payload.giftCard.lastCharacters,
  };
}

async function getGiftCardState(shop, giftCardId) {
  const json = await adminGraphql(
    shop,
    `#graphql
    query PointsGiftCard($id: ID!) {
      giftCard(id: $id) {
        id
        enabled
        balance { amount }
        initialValue { amount }
      }
    }`,
    { id: giftCardId },
  );
  const gc = json?.data?.giftCard;
  if (!gc) throw new Error(json?.errors?.[0]?.message || "Gift card not found");
  return {
    enabled: gc.enabled,
    balance: Number(gc.balance?.amount || 0),
    initial: Number(gc.initialValue?.amount || 0),
  };
}

async function deactivateGiftCard(shop, giftCardId) {
  const json = await adminGraphql(
    shop,
    `#graphql
    mutation PointsGiftCardDeactivate($id: ID!) {
      giftCardDeactivate(id: $id) {
        giftCard { id enabled }
        userErrors { field message }
      }
    }`,
    { id: giftCardId },
  );
  const payload = json?.data?.giftCardDeactivate;
  const msg = payload?.userErrors?.[0]?.message || json?.errors?.[0]?.message;
  if (!payload?.giftCard || msg) throw new Error(msg || "Gift card deactivate failed");
}

// Customer ki profile se mobile number (OTP isi pe jayega)
// Zaroori: app scope "read_customers" + dashboard mein Protected customer data -> Phone
async function getCustomerPhone(shop, customerGid) {
  const queries = [
    `#graphql
    query PointsCustomerPhone($id: ID!) {
      customer(id: $id) {
        defaultPhoneNumber { phoneNumber }
        defaultAddress { phone }
      }
    }`,
    `#graphql
    query PointsCustomerPhoneOld($id: ID!) {
      customer(id: $id) {
        phone
        defaultAddress { phone }
      }
    }`,
  ];
  let lastError = null;
  for (const q of queries) {
    try {
      const json = await adminGraphql(shop, q, { id: customerGid });
      if (json?.errors?.length) {
        lastError = json.errors[0]?.message;
        continue;
      }
      const c = json?.data?.customer;
      const raw = c?.defaultPhoneNumber?.phoneNumber || c?.phone || c?.defaultAddress?.phone || "";
      return { phone: normalizeIndianPhone(raw), error: null };
    } catch (err) {
      lastError = String(err?.message || err);
    }
  }
  return { phone: null, error: lastError };
}

// Customer ka phone 5 min tak yaad rakho (baar-baar Shopify se na mangna pade)
const phoneCache = new Map(); // customerGid -> { phone, at }
async function getCustomerPhoneCached(shop, customerGid) {
  const c = phoneCache.get(customerGid);
  if (c && Date.now() - c.at < 5 * 60 * 1000) return { phone: c.phone, error: null };
  const r = await getCustomerPhone(shop, customerGid);
  if (r.phone) phoneCache.set(customerGid, { phone: r.phone, at: Date.now() });
  return r;
}

// Mojito member = customer ka 10 digit mobile (dummy mode mein Shopify customer number)
async function resolveMemberId(shop, customerGid) {
  if (isPointsDummy()) {
    return { memberId: String(customerGid).split("/").pop() };
  }
  const { phone, error } = await getCustomerPhoneCached(shop, customerGid);
  const memberId = phoneTo10(phone);
  if (!memberId) {
    return {
      fail: fail("NO_PHONE", devMsg("Add a mobile number to your account to use loyalty points.", error)),
    };
  }
  return { memberId };
}

// Redeem / OTP dono se pehle points ki basic jaanch
function validateRedeemInput(pts, bill) {
  const cfg = getPointsConfig();
  if (!Number.isInteger(pts) || pts <= 0) {
    return fail("INVALID_POINTS", "Enter a valid number of points.");
  }
  if (pts < cfg.minRedeemPoints) {
    return fail("BELOW_MINIMUM", `Minimum ${cfg.minRedeemPoints} points can be redeemed.`);
  }
  if (!(bill > 0)) {
    return fail("INVALID_BILL", "Order amount is not valid.");
  }
  const maxPoints = rupeesToMaxPoints(bill);
  if (pts > maxPoints) {
    return fail("MORE_THAN_BILL", `You can redeem up to ${maxPoints} points on this order.`);
  }
  return null;
}

// ---------------- Reverse (cancel / 10 min / sweeper sab yahi use karte hain) ----------------

export async function reverseRedemption(row, finalStatus = "reversed") {
  // 1) Gift card: agar order mein use ho chuka to points wapas NAHI
  if (row.giftCardId) {
    try {
      const state = await getGiftCardState(row.shop, row.giftCardId);
      if (state.balance < state.initial) {
        await prisma.pointsRedemption.update({
          where: { id: row.id },
          data: { status: "used" },
        });
        return { ok: true, status: "used" };
      }
      if (state.enabled) {
        await deactivateGiftCard(row.shop, row.giftCardId);
      }
    } catch (err) {
      // Gift card band nahi hua -> status same rakho, baad mein dobara try hoga
      await prisma.pointsRedemption.update({
        where: { id: row.id },
        data: {
          reverseAttempts: { increment: 1 },
          errorMessage: `Gift card: ${String(err?.message || err)}`,
        },
      });
      return { ok: false, status: row.status };
    }
  }

  // 2) Points wapas
  if (row.invoiceNumber) {
    try {
      await cancelPointsRedeem({
        invoiceNumber: row.invoiceNumber,
        memberId: row.memberId,
        points: row.pointsRedeemed ?? row.pointsRequested,
      });
    } catch (err) {
      // Gift card band ho gaya par points wapas nahi hue -> haath se check
      await prisma.pointsRedemption.update({
        where: { id: row.id },
        data: {
          status: "check_needed",
          reverseAttempts: { increment: 1 },
          errorMessage: `Points cancel: ${String(err?.message || err)}`,
        },
      });
      return { ok: false, status: "check_needed" };
    }
  }

  await prisma.pointsRedemption.update({
    where: { id: row.id },
    data: { status: finalStatus, reverseAttempts: { increment: 1 } },
  });
  return { ok: true, status: finalStatus };
}

// ---------------- Customer ke purane redeem suljhao ----------------
// - Gift card order mein use ho chuka -> "used" (points wapas NAHI)
// - Purane / doosre checkout ka ya 10 min se ping nahi -> gift card band + points wapas
// - Isi checkout pe abhi laga hua hai -> ALREADY_ACTIVE
async function settleOldRedemptions({ customerGid, checkoutToken }) {
  const rows = await prisma.pointsRedemption.findMany({
    where: { customerId: customerGid, status: { in: ["pending", "active"] } },
    orderBy: { createdAt: "desc" },
  });

  for (const row of rows) {
    if (row.status === "pending") {
      const age = Date.now() - new Date(row.createdAt).getTime();
      if (age > STALE_PENDING_MS) {
        await prisma.pointsRedemption.update({
          where: { id: row.id },
          data: { status: "check_needed", errorMessage: "Pending too long" },
        });
        continue;
      }
      return fail("ALREADY_ACTIVE", "Your points are being processed. Please wait a moment.");
    }

    // active: pehle dekho gift card order mein use to nahi ho gaya
    if (row.giftCardId) {
      try {
        const state = await getGiftCardState(row.shop, row.giftCardId);
        if (state.balance < state.initial) {
          await prisma.pointsRedemption.update({
            where: { id: row.id },
            data: { status: "used" },
          });
          continue;
        }
      } catch (err) {
        console.error("[points] gift card check failed:", err);
        return fail("ALREADY_ACTIVE", "Please try again in a minute.");
      }
    }

    const sameCheckout =
      checkoutToken && row.checkoutToken && row.checkoutToken === String(checkoutToken);
    const pingAge = Date.now() - new Date(row.lastPingAt).getTime();
    if (sameCheckout && pingAge <= STALE_ACTIVE_MS) {
      return fail(
        "ALREADY_ACTIVE",
        "Points are already applied. Remove them first to change the amount.",
      );
    }

    // Purana / chhoda hua redeem -> wapas
    const r = await reverseRedemption(row, "reversed");
    if (!r.ok && r.status === "active") {
      return fail("ALREADY_ACTIVE", "Please try again in a minute.");
    }
  }
  return null;
}

// ---------------- Actions ----------------

async function getBalance(shop, customerGid) {
  const m = await resolveMemberId(shop, customerGid);
  if (m.fail) return m.fail;
  try {
    const b = await fetchPointsBalance({ memberId: m.memberId });
    return {
      ok: true,
      points: b.points,
      rupeeValue: b.rupeeValue,
      rupeePerPoint: b.rupeePerPoint,
      minRedeemPoints: b.minRedeemPoints,
      otpRequired: OTP_REQUIRED,
    };
  } catch (err) {
    return apiErrorToFail(err);
  }
}

// ---------------- OTP bhejo ----------------
async function sendRedeemOtp({ shop, customerGid, points, billAmount, checkoutToken }) {
  const pts = Number(points);
  const bill = round2(billAmount);
  const bad = validateRedeemInput(pts, bill);
  if (bad) return bad;

  // Purane redeem pehle suljhao (bekaar OTP na jaye)
  const blocked = await settleOldRedemptions({ customerGid, checkoutToken });
  if (blocked) return blocked;

  // Itne points hain bhi? (OTP bhejne se pehle hi bata do)
  const m = await resolveMemberId(shop, customerGid);
  if (m.fail) return m.fail;
  try {
    const b = await fetchPointsBalance({ memberId: m.memberId });
    if (pts > b.points) return fail("INSUFFICIENT_POINTS", "You don't have enough points.");
  } catch (err) {
    return apiErrorToFail(err);
  }

  // OTP abhi-abhi verify hua tha -> naya SMS mat bhejo, seedha redeem hone do
  if (OTP_REQUIRED && hasFreshVerifiedOtp(customerGid)) {
    return { ok: true, alreadyVerified: true };
  }

  const now = Date.now();
  const st = otpState.get(customerGid) || { sends: [] };
  st.sends = (st.sends || []).filter((t) => now - t < OTP_SEND_WINDOW_MS);

  if (st.sentAt && now - st.sentAt < OTP_RESEND_AFTER_MS) {
    const wait = Math.ceil((OTP_RESEND_AFTER_MS - (now - st.sentAt)) / 1000);
    return fail("OTP_WAIT", `Please wait ${wait} seconds before requesting a new OTP.`);
  }
  if (st.sends.length >= OTP_MAX_SENDS) {
    return fail("OTP_LIMIT", "Too many OTP requests. Please try again after 15 minutes.");
  }

  // Mobile number profile se
  let { phone, error } = await getCustomerPhoneCached(shop, customerGid);
  if (!phone && isOtpDummy()) {
    console.warn("[otp] customer phone nahi mila, DUMMY mode mein test number use:", error || "no phone");
    phone = "910000000000";
  }
  if (!phone) {
    if (error) console.error("[otp] customer phone read failed:", error);
    return fail(
      "NO_PHONE",
      devMsg("Add a mobile number to your account to redeem points.", error),
    );
  }

  const r = await sendOtp(phone);
  if (!r.ok) {
    return fail(
      "OTP_SEND_FAILED",
      devMsg("Couldn't send OTP. Please try again.", `${r.details} | ${maskPhone(phone)}`),
    );
  }

  st.phone = phone;
  st.sentAt = now;
  st.attempts = 0;
  st.sends.push(now);
  otpState.set(customerGid, st);

  return {
    ok: true,
    maskedPhone: maskPhone(phone),
    resendAfterSec: OTP_RESEND_AFTER_MS / 1000,
    dummy: r.dummy === true,
  };
}

// OTP abhi-abhi sahi daala gaya tha? (5 min tak dobara OTP nahi)
function hasFreshVerifiedOtp(customerGid) {
  const st = otpState.get(customerGid);
  return !!(st?.verifiedAt && Date.now() - st.verifiedAt < OTP_VERIFIED_MS);
}

// Redeem safal hone pe verified OTP khatam (agle redeem ke liye naya OTP)
function consumeVerifiedOtp(customerGid) {
  const st = otpState.get(customerGid);
  if (st) st.verifiedAt = null;
}

// Redeem se pehle OTP check. Sahi hai to null, warna fail(...)
async function checkRedeemOtp(customerGid, otp) {
  if (!OTP_REQUIRED) return null;
  if (hasFreshVerifiedOtp(customerGid)) return null;
  const st = otpState.get(customerGid);
  if (!st?.sentAt || !st.phone) {
    return fail("OTP_REQUIRED", "Please request an OTP first.");
  }
  if (Date.now() - st.sentAt > OTP_SESSION_MS) {
    st.sentAt = null;
    return fail("OTP_EXPIRED", "OTP expired. Please request a new OTP.");
  }
  if ((st.attempts || 0) >= OTP_MAX_VERIFY_ATTEMPTS) {
    return fail("OTP_LOCKED", "Too many incorrect attempts. Please request a new OTP.");
  }

  const r = await verifyOtp(st.phone, otp);
  if (!r.ok) {
    st.attempts = (st.attempts || 0) + 1;
    const left = OTP_MAX_VERIFY_ATTEMPTS - st.attempts;
    if (left <= 0) {
      return fail("OTP_LOCKED", "Too many incorrect attempts. Please request a new OTP.");
    }
    return fail("OTP_INVALID", `Incorrect OTP. ${left} attempt${left === 1 ? "" : "s"} left.`);
  }

  // OTP ek hi baar kaam aata hai; 5 min tak "verified" maano (redeem fail ho to dobara OTP na lage)
  st.sentAt = null;
  st.attempts = 0;
  st.verifiedAt = Date.now();
  return null;
}

async function redeem({ shop, customerGid, points, billAmount, checkoutToken, otp, cart }) {
  const pts = Number(points);
  const bill = round2(billAmount);

  const bad = validateRedeemInput(pts, bill);
  if (bad) return bad;

  const m = await resolveMemberId(shop, customerGid);
  if (m.fail) return m.fail;
  const memberId = m.memberId;

  // Double redeem lock + purane redeem suljhao
  const blocked = await settleOldRedemptions({ customerGid, checkoutToken });
  if (blocked) return blocked;

  // OTP check (points kaatne se pehle)
  const otpFail = await checkRedeemOtp(customerGid, otp);
  if (otpFail) return otpFail;

  const row = await prisma.pointsRedemption.create({
    data: {
      shop,
      customerId: customerGid,
      memberId,
      checkoutToken: checkoutToken ? String(checkoutToken) : null,
      pointsRequested: pts,
      billAmount: bill,
      status: "pending",
    },
  });

  // 1) Points kaato
  let r;
  try {
    r = await redeemPoints({ memberId, points: pts, requestId: row.id, billAmount: bill, cart });
  } catch (err) {
    console.error("[points] redeem failed:", err?.code, err?.message);
    // Timeout: ho sakta hai points block ho gaye hon -> haath se check
    const unsure = err?.code === "TIMEOUT";
    await prisma.pointsRedemption.update({
      where: { id: row.id },
      data: {
        status: unsure ? "check_needed" : "failed",
        approvalCode: err?.billNo ? String(err.billNo) : null,
        errorMessage: String(err?.message || err),
      },
    });
    return apiErrorToFail(err);
  }

  // 2) Utne Rs ka gift card banao
  let gc;
  try {
    gc = await createGiftCard(
      shop,
      r.amountRedeemed,
      [
        POINTS_SOURCE_LABEL,
        `Points: ${r.pointsRedeemed}`,
        `Amount: Rs ${Number(r.amountRedeemed).toFixed(2)}`,
        `Invoice: ${r.invoiceNumber}`,
        `Approval: ${r.approvalCode}`,
        `Customer: ${customerGid}`,
        `Ref: ${row.id}`,
      ].join(" | "),
    );
  } catch (err) {
    // Gift card nahi bana -> points turant wapas
    let pointsBack = false;
    try {
      await cancelPointsRedeem({ invoiceNumber: r.invoiceNumber, memberId, points: r.pointsRedeemed });
      pointsBack = true;
    } catch {
      pointsBack = false;
    }
    await prisma.pointsRedemption.update({
      where: { id: row.id },
      data: {
        status: pointsBack ? "failed" : "check_needed",
        invoiceNumber: r.invoiceNumber,
        errorMessage: `Gift card create: ${String(err?.message || err)}`,
      },
    });
    console.error("[points] gift card create failed:", err);
    return fail(
      "GIFT_CARD_FAILED",
      devMsg("Couldn't apply your points right now. Please try again.", String(err?.message || err)),
    );
  }

  const amountToPay = Math.max(0, round2(bill - r.amountRedeemed));
  consumeVerifiedOtp(customerGid);

  await prisma.pointsRedemption.update({
    where: { id: row.id },
    data: {
      status: "active",
      pointsRedeemed: r.pointsRedeemed,
      amountRedeemed: r.amountRedeemed,
      amountToPay,
      invoiceNumber: r.invoiceNumber,
      approvalCode: r.approvalCode,
      currentBatchNumber: r.currentBatchNumber,
      transactionDate: r.transactionDate,
      giftCardId: gc.id,
      giftCardLast4: gc.last4,
      lastPingAt: new Date(),
    },
  });

  return {
    ok: true,
    redemptionId: row.id,
    giftCardCode: gc.code,
    pointsRedeemed: r.pointsRedeemed,
    amountRedeemed: r.amountRedeemed,
    invoiceNumber: r.invoiceNumber,
    approvalCode: r.approvalCode,
    currentBatchNumber: r.currentBatchNumber,
    transactionDate: r.transactionDate,
    billAmount: bill,
    amountToPay,
    balanceAfter: r.balanceAfter,
    // Order notes (loyalty_*) ke liye - Mojito ko jo bheja wahi
    referenceId: r.invoiceNumber,
    billNo: r.approvalCode,
    totalNetAmount: r.totalNetAmount,
    totalGrossAmount: r.totalGrossAmount,
  };
}

async function cancel({ customerGid, redemptionId }) {
  const row = await prisma.pointsRedemption.findFirst({
    where: { id: String(redemptionId || ""), customerId: customerGid },
  });
  if (!row) return fail("NOT_FOUND", "Redemption not found.");
  if (row.status !== "active") return { ok: true, status: row.status };

  const r = await reverseRedemption(row, "cancelled");
  if (!r.ok) {
    return fail("CANCEL_FAILED", "Points will be returned to your account shortly.");
  }
  return { ok: true, status: r.status };
}

async function ping({ customerGid, redemptionId }) {
  const row = await prisma.pointsRedemption.findFirst({
    where: { id: String(redemptionId || ""), customerId: customerGid },
  });
  if (!row) return { ok: true, alive: false, status: "not_found" };
  if (row.status !== "active") return { ok: true, alive: false, status: row.status };

  await prisma.pointsRedemption.update({
    where: { id: row.id },
    data: { lastPingAt: new Date() },
  });
  return { ok: true, alive: true };
}

// ---------------- Route yahi function call karta hai ----------------

export async function handlePointsAction({ shop, customerGid, body }) {
  if (!customerGid) {
    return fail("NOT_LOGGED_IN", "Log in to use your loyalty points.");
  }
  const action = body?.action;
  try {
    switch (action) {
      case "balance":
        return await getBalance(shop, customerGid);
      case "sendOtp":
        return await sendRedeemOtp({
          shop,
          customerGid,
          points: body.points,
          billAmount: body.billAmount,
          checkoutToken: body.checkoutToken,
        });
      case "redeem":
        return await redeem({
          shop,
          customerGid,
          points: body.points,
          billAmount: body.billAmount,
          checkoutToken: body.checkoutToken,
          otp: body.otp,
          cart: body.cart,
        });
      case "cancel":
        return await cancel({ customerGid, redemptionId: body.redemptionId });
      case "ping":
        return await ping({ customerGid, redemptionId: body.redemptionId });
      default:
        return fail("BAD_ACTION", "Unknown action.");
    }
  } catch (err) {
    console.error("[points]", action, err);
    return fail("SERVER_ERROR", devMsg("Something went wrong. Please try again.", String(err?.message || err)));
  }
}