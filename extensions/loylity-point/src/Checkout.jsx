import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";

// ================== Server kahan hai ==================
// Local test (shopify app dev) mein ye box trycloudflare tunnel se load hota hai,
// to apne aap wahi server use hoga. Kuch set karne ki zarurat nahi.
// Agar box mein "Server URL is not set" aaye, to terminal wala trycloudflare URL
// MANUAL_API_BASE mein daal do (end mein / nahi).
const MANUAL_API_BASE = "";
// Live ke liye (baad mein): naye app ke asli server ka URL
const PROD_API_BASE = "https://loylity-point.onrender.com";

// Testing ke time error mein server URL dikhao (live se pehle false kar dena)
const SHOW_DEBUG = true;

const PING_EVERY_MS = 20 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const STORAGE_KEY = "loyalty_points_redemption_v1";
// ============ Checkout editor ki settings (code chhede bina badlo) ============
// Checkout editor -> Fabcoins box pe click -> right side settings.
// Setting khali ho to ye default chalenge:
const DEFAULT_TITLE = "Fabcoins";
const DEFAULT_POINTS_LABEL = "Fabcoins"; // customer ko "points" ki jagah yahi shabd dikhega
// Abhi ka naam (settings se); har render pe update hota hai, har message isi se banta hai
let LABEL = DEFAULT_POINTS_LABEL;
const DEFAULT_HIDE_PRODUCT_TYPES = "gift cards, custom kurta";

function readSettings() {
  const s = shopify.settings?.value || {};
  const title = String(s.title || "").trim() || DEFAULT_TITLE;
  // Off (ya set nahi) = 0 points wale customer ko box nahi dikhega
  const showZeroPoints = s.show_zero_points === true;
  const typesText = String(s.hide_product_types || "").trim() || DEFAULT_HIDE_PRODUCT_TYPES;
  const hideProductTypes = typesText
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const pointsLabel = String(s.points_label || "").trim() || DEFAULT_POINTS_LABEL;
  LABEL = pointsLabel;
  return { title, showZeroPoints, hideProductTypes, pointsLabel };
}

// Order notes ("Additional details") keys
const ATTR_KEYS = {
  referenceId: "loyalty_referenceId",
  points: "loyalty_points",
  billNo: "loyalty_billno",
  totalNet: "loyalty_totalnet",
  gross: "loyalty_gross_amount",
};
// Chhupa hua note ("_" se customer ko nahi dikhta): points wale gift card ke last 4 characters.
// Payment breakup extension isi se points ko LOYALTYPOINTS aur wallet ko GIFTCARDWALLET mein alag karta hai.
const LOYALTY_GC_ATTR = "_loyalty_giftcard_last4";

// Fabcoins lagte hi ye cart attribute set hota hai, hatate hi hat jaata hai.
// Checkout Blocks app mein rule: cart attribute "fabcoins_applied" = "true" -> COD hide.
const FABCOINS_FLAG_ATTR = "fabcoins_applied";
const FABCOINS_FLAG_VALUE = "true";

// Purane test wali keys (Remove pe ye bhi saaf ho jayengi)
const LEGACY_ATTR_KEYS = [
  "PointsRedeemed",
  "PointsAmountRedeemed",
  "PointsInvoiceNumber",
  "PointsApprovalCode",
  "PointsBatchNumber",
  "PointsTransactionDate",
  "PointsBillAmount",
  "PointsAmountToPay",
];

export default async () => {
  render(<Extension />, document.body);
};

// ================== Helpers ==================

function getApiUrl() {
  if (MANUAL_API_BASE) return `${MANUAL_API_BASE}/api/points`;
  try {
    const origin = new URL(shopify.extension.scriptUrl).origin;
    if (origin.includes("trycloudflare.com")) return `${origin}/api/points`;
  } catch {
    // ignore
  }
  return PROD_API_BASE ? `${PROD_API_BASE}/api/points` : null;
}

async function callApi(action, body = {}) {
  const url = getApiUrl();
  if (!url) {
    return { ok: false, code: "NO_SERVER", message: "Server URL is not set." };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const token = await shopify.sessionToken.get();
    // Token body mein + "text/plain": isse browser ka extra "preflight" check nahi hota
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action, token, label: LABEL, ...body }),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return (
      data || { ok: false, code: "BAD_RESPONSE", message: "Something went wrong. Please try again." }
    );
  } catch (err) {
    if (err && err.name === "AbortError") {
      return { ok: false, code: "TIMEOUT", message: "The request took too long. Please try again." };
    }
    return {
      ok: false,
      code: "NETWORK",
      message: SHOW_DEBUG ? `Couldn't connect to ${url}` : "Couldn't connect. Please try again.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readSaved() {
  try {
    return (await shopify.storage.read(STORAGE_KEY)) || null;
  } catch {
    return null;
  }
}

async function writeSaved(value) {
  try {
    await shopify.storage.write(STORAGE_KEY, value);
  } catch {
    // ignore
  }
}

async function clearSaved() {
  try {
    await shopify.storage.delete(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function formatNum(n) {
  try {
    return shopify.i18n.formatNumber(Number(n || 0));
  } catch {
    return String(n);
  }
}

// Wallet button jaisa: ₹1,599.00
function formatRupee(n) {
  const v = Number(n || 0);
  try {
    return shopify.i18n.formatCurrency(v, { currency: "INR" });
  } catch {
    return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

function formatINR(n) {
  return `${Number(n || 0).toFixed(2)} INR`;
}

function isGiftCardApplied(appliedGiftCards, code) {
  if (!code) return false;
  const last4 = String(code).slice(-4).toLowerCase();
  return (appliedGiftCards || []).some(
    (g) => String(g?.lastCharacters || "").toLowerCase() === last4,
  );
}

// Mojito ko bhejne ke liye cart ki details
function buildCart() {
  const lines = shopify.lines.value || [];
  return {
    shipping: Number(shopify.cost.totalShippingAmount?.value?.amount || 0),
    items: lines.map((l) => {
      const net = Number(l?.cost?.totalAmount?.amount || 0);
      const discount = (l?.discountAllocations || []).reduce(
        (sum, d) => sum + Number(d?.discountedAmount?.amount || 0),
        0,
      );
      return {
        lineItemId: String(l?.id || ""),
        variantId: String(l?.merchandise?.id || ""),
        productId: String(l?.merchandise?.product?.id || ""),
        sku: String(l?.merchandise?.sku || ""),
        name: String(l?.merchandise?.title || ""),
        quantity: Number(l?.quantity || 0),
        netAmount: net,
        discount,
      };
    }),
  };
}

function canUpdateAttributes() {
  return shopify.instructions.value?.attributes?.canUpdateAttributes !== false;
}

async function setOrderAttributes(r) {
  if (!canUpdateAttributes()) return;
  const pairs = [
    // Sabse pehle: COD hide wala flag (Checkout Blocks rule isi ko dekhta hai)
    [FABCOINS_FLAG_ATTR, FABCOINS_FLAG_VALUE],
    [ATTR_KEYS.referenceId, r.referenceId],
    [ATTR_KEYS.points, r.pointsRedeemed],
    [ATTR_KEYS.billNo, r.billNo],
    [ATTR_KEYS.totalNet, r.totalNetAmount],
    [ATTR_KEYS.gross, r.totalGrossAmount],
    [LOYALTY_GC_ATTR, String(r.giftCardCode || "").slice(-4)],
  ];
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === "") continue;
    try {
      await shopify.applyAttributeChange({ type: "updateAttribute", key, value: String(value) });
    } catch {
      // ignore
    }
  }
}

async function clearOrderAttributes() {
  if (!canUpdateAttributes()) return;
  const present = new Set((shopify.attributes?.value || []).map((a) => a.key));
  const keys = [
    FABCOINS_FLAG_ATTR,
    ...Object.values(ATTR_KEYS),
    LOYALTY_GC_ATTR,
    ...LEGACY_ATTR_KEYS,
  ].filter((k) =>
    present.has(k),
  );
  for (const key of keys) {
    try {
      await shopify.applyAttributeChange({ type: "removeAttribute", key });
    } catch {
      // ignore
    }
  }
}

// ================== Box ==================

function Extension() {
  const lines = shopify.lines.value || [];
  const appliedGiftCards = shopify.appliedGiftCards.value || [];
  const totalMoney = shopify.cost.totalAmount.value;
  const instructions = shopify.instructions.value;
  const checkoutToken = shopify.checkoutToken?.value || null;

  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pointsInput, setPointsInput] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(null);
  // OTP: { points, maskedPhone, dummy } jab OTP bhej diya gaya ho
  const [otpStage, setOtpStage] = useState(null);
  const [otpInput, setOtpInput] = useState("");
  const [otpError, setOtpError] = useState("");
  const [resendIn, setResendIn] = useState(0);

  const busyRef = useRef(false); // double click / double redeem lock
  const activeRef = useRef(null);
  const seenAppliedRef = useRef(false);
  const missRef = useRef(0);
  const loadedRef = useRef(false);
  const restoredRef = useRef(false);

  function setBusyBoth(v) {
    busyRef.current = v;
    setBusy(v);
  }
  function setActiveBoth(v) {
    activeRef.current = v;
    setActive(v);
  }

  // ---------- Box chhupane wale rules (wallet jaise) ----------
  const settings = readSettings();
  const hasBlockedProduct = lines.some((l) =>
    settings.hideProductTypes.includes(
      String(l?.merchandise?.product?.productType || "").trim().toLowerCase(),
    ),
  );
  const canAddGiftCard = instructions?.giftCards?.canAddGiftCard !== false;
  const isINR = (totalMoney?.currencyCode || "INR") === "INR";
  const hidden = hasBlockedProduct || !canAddGiftCard || !isINR;

  // ---------- Bill mein kitna bacha (wallet gift card laga ho to wo minus) ----------
  const total = Number(totalMoney?.amount || 0);
  const giftCardsUsed = appliedGiftCards.reduce(
    (sum, g) => sum + Number(g?.amountUsed?.amount || 0),
    0,
  );
  const remaining = Math.max(0, Math.round((total - giftCardsUsed) * 100) / 100);

  const rate = Number(balance?.rupeePerPoint || 0);
  const minPoints = Number(balance?.minRedeemPoints || 0);
  const availablePoints = Number(balance?.points || 0);
  // Limit = bacha hua bill aur (products + shipping), dono mein jo kam ho.
  // Mojito ko bhi totalNetAmount mein shipping jaati hai, isliye Fabcoins se shipping bhi pay hoti hai.
  const itemsNet = lines.reduce((sum, l) => sum + Number(l?.cost?.totalAmount?.amount || 0), 0);
  const shippingAmount = Number(shopify.cost.totalShippingAmount?.value?.amount || 0);
  const cartValue = itemsNet + shippingAmount;
  const redeemableAmount = Math.max(
    0,
    Math.round(Math.min(remaining, cartValue > 0 ? cartValue : remaining) * 100) / 100,
  );
  const maxByBill = rate > 0 ? Math.floor((redeemableAmount + 1e-9) / rate) : 0;
  const maxPoints = Math.max(0, Math.min(availablePoints, maxByBill));
  // Button pe dikhne wala amount: field mein sahi number ho to wo, warna maximum
  const typedPoints = Number(String(pointsInput || "").trim());
  const buttonPoints =
    String(pointsInput || "").trim() !== "" && Number.isInteger(typedPoints) && typedPoints > 0
      ? typedPoints
      : maxPoints;
  const buttonAmount = formatRupee(buttonPoints * rate);

  async function loadBalance() {
    setLoading(true);
    const res = await callApi("balance");
    if (res.ok) {
      setBalance(res);
      setLoadError(null);
    } else {
      setBalance(null);
      setLoadError({ code: res.code, message: res.message });
    }
    setLoading(false);
  }

  // 1) Points load
  useEffect(() => {
    if (!hidden && !loadedRef.current) {
      loadedRef.current = true;
      loadBalance();
    }
  }, [hidden]);

  // 2) Page reload ke baad laga hua redeem wapas dikhao
  useEffect(() => {
    if (restoredRef.current || !checkoutToken) return;
    restoredRef.current = true;
    (async () => {
      const saved = await readSaved();
      if (!saved?.redemptionId) return;
      if (saved.checkoutToken !== checkoutToken) {
        await clearSaved(); // purane checkout ka data
        return;
      }
      if (!activeRef.current) {
        seenAppliedRef.current = false;
        missRef.current = 0;
        setActiveBoth(saved);
      }
    })();
  }, [checkoutToken]);

  // 3) Customer ne gift card ka chip (x) se hata diya -> turant points wapas
  useEffect(() => {
    const a = activeRef.current;
    if (!a) return;
    if (isGiftCardApplied(appliedGiftCards, a.giftCardCode)) {
      // Busy ho tab bhi yaad rakho ki card laga hua dikh gaya
      seenAppliedRef.current = true;
      missRef.current = 0;
      return;
    }
    // Card gayab: busy khatam hote hi ye effect dobara chalega (busy dependency)
    if (seenAppliedRef.current && !busyRef.current) {
      removeRedemption({ alreadyRemoved: true });
    }
  }, [appliedGiftCards, active, busy]);

  // 4) Har 20 sec ping
  useEffect(() => {
    if (!active?.redemptionId) return undefined;
    const tick = async () => {
      const a = activeRef.current;
      if (!a || busyRef.current) return;
      if (!isGiftCardApplied(shopify.appliedGiftCards.value, a.giftCardCode)) {
        missRef.current += 1;
        // Pehle dikh chuka tha to turant, warna 2 baar (40 sec) gayab milne pe hatao
        if (seenAppliedRef.current || missRef.current >= 2) {
          await removeRedemption({ alreadyRemoved: true });
        }
        return;
      }
      seenAppliedRef.current = true;
      missRef.current = 0;
      const res = await callApi("ping", { redemptionId: a.redemptionId });
      if (res.ok && res.alive === false) {
        await removeRedemption({
          skipCancel: true,
          message: `Your ${LABEL} session expired and your ${LABEL} were returned. You can apply them again.`,
        });
      }
    };
    tick();
    const id = setInterval(tick, PING_EVERY_MS);
    return () => clearInterval(id);
  }, [active?.redemptionId]);

  // 5) Gift card / Custom kurta cart mein aa gaya -> points hatao
  useEffect(() => {
    if (hidden && activeRef.current && !busyRef.current) {
      removeRedemption({ message: `${LABEL} were removed because they can't be used on this order.` });
    }
  }, [hidden, active]);

  // ---------- OTP resend ka countdown ----------
  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const id = setTimeout(() => setResendIn((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(id);
  }, [resendIn]);

  // ---------- Points field check ----------
  function readPointsOrError() {
    setFieldError("");
    const raw = String(pointsInput || "").trim();
    // Field khali chhoda = jitne lag sakte hain utne (wallet button jaisa)
    const pts = raw === "" ? maxPoints : Number(raw);
    if (!Number.isInteger(pts) || pts <= 0) {
      setFieldError(`Enter a valid number of ${LABEL}.`);
      return null;
    }
    if (pts < minPoints) {
      setFieldError(`Minimum ${formatNum(minPoints)} ${LABEL} can be redeemed.`);
      return null;
    }
    if (pts > maxPoints) {
      setFieldError(`You can redeem up to ${formatNum(maxPoints)} ${LABEL} on this order.`);
      return null;
    }
    return pts;
  }

  // ---------- Pehla button: OTP chahiye to "Send OTP", warna seedha redeem ----------
  async function onApply() {
    if (busyRef.current || activeRef.current) return;
    if (balance?.otpRequired && resendIn > 0) return; // 30 sec ka intezaar
    setNotice(null);
    const pts = readPointsOrError();
    if (pts === null) return;
    if (balance?.otpRequired) {
      await sendOtpFor(pts);
    } else {
      await doRedeem(pts, null);
    }
  }

  // ---------- OTP bhejo (pehli baar ya resend) ----------
  async function sendOtpFor(pts) {
    if (busyRef.current) return;
    let skipOtp = false;
    setBusyBoth(true);
    try {
      const res = await callApi("sendOtp", { points: pts, billAmount: redeemableAmount, checkoutToken });
      if (res.ok && res.alreadyVerified) {
        // OTP abhi-abhi verify hua tha -> naya OTP nahi, seedha redeem
        skipOtp = true;
        return;
      }
      if (!res.ok) {
        if (otpStage) {
          setOtpError(res.message || "Couldn't send OTP. Please try again.");
        } else {
          setNotice({ tone: "critical", text: res.message || "Couldn't send OTP. Please try again." });
        }
        return;
      }
      setOtpStage({ points: pts, maskedPhone: res.maskedPhone, dummy: res.dummy === true });
      setOtpInput("");
      setOtpError("");
      setResendIn(Number(res.resendAfterSec || 30));
    } finally {
      setBusyBoth(false);
    }
    if (skipOtp) await doRedeem(pts, "");
  }

  async function onResendOtp() {
    if (!otpStage || resendIn > 0 || busyRef.current) return;
    await sendOtpFor(otpStage.points);
  }

  function onChangePoints() {
    if (busyRef.current) return;
    setOtpStage(null);
    setOtpInput("");
    setOtpError("");
    // resendIn reset nahi karte: server 30 sec se pehle naya OTP nahi bhejta
  }

  async function onVerifyAndApply() {
    if (!otpStage || busyRef.current) return;
    const code = String(otpInput || "").trim();
    if (!/^\d{4}$/.test(code)) {
      setOtpError("Enter the 4-digit OTP.");
      return;
    }
    await doRedeem(otpStage.points, code);
  }

  // ---------- Redeem (OTP ke saath) ----------
  async function doRedeem(pts, otp) {
    if (busyRef.current || activeRef.current) return;
    setBusyBoth(true);
    try {
      const res = await callApi("redeem", {
        points: pts,
        billAmount: redeemableAmount,
        checkoutToken,
        otp,
        cart: buildCart(),
      });
      if (!res.ok) {
        // OTP galat / expire / lock -> OTP wale screen pe hi message
        if (["OTP_INVALID", "OTP_LOCKED", "OTP_EXPIRED", "OTP_REQUIRED"].includes(res.code) && otpStage) {
          setOtpInput("");
          setOtpError(res.message || "Incorrect OTP.");
          return;
        }
        setOtpStage(null);
        setNotice({
          tone: "critical",
          text:
            res.code === "TIMEOUT"
              ? `We couldn't confirm your ${LABEL}. If any ${LABEL} were deducted, they will be returned within 15 minutes.`
              : res.message || `Couldn't redeem ${LABEL}. Please try again.`,
        });
        await loadBalance();
        return;
      }

      const record = {
        redemptionId: res.redemptionId,
        giftCardCode: res.giftCardCode,
        pointsRedeemed: res.pointsRedeemed,
        amountRedeemed: res.amountRedeemed,
        invoiceNumber: res.invoiceNumber,
        approvalCode: res.approvalCode,
        currentBatchNumber: res.currentBatchNumber,
        transactionDate: res.transactionDate,
        billAmount: res.billAmount,
        amountToPay: res.amountToPay,
        referenceId: res.referenceId,
        billNo: res.billNo,
        totalNetAmount: res.totalNetAmount,
        totalGrossAmount: res.totalGrossAmount,
        checkoutToken,
      };
      await writeSaved(record);

      // Gift card checkout pe lagao (wallet jaisa)
      const applyRes = await shopify.applyGiftCardChange({
        type: "addGiftCard",
        code: record.giftCardCode,
      });
      if (applyRes?.type === "error") {
        await callApi("cancel", { redemptionId: record.redemptionId });
        await clearSaved();
        setOtpStage(null);
        setNotice({
          tone: "critical",
          text: `Couldn't apply your ${LABEL} to this order. Your ${LABEL} will be returned.`,
        });
        await loadBalance();
        return;
      }

      // applyGiftCardChange safal = card laga hua hai
      seenAppliedRef.current = true;
      missRef.current = 0;
      setActiveBoth(record);
      setPointsInput("");
      setOtpStage(null);
      setOtpInput("");
      setOtpError("");
      await setOrderAttributes(record);
    } finally {
      setBusyBoth(false);
    }
  }

  // ---------- Remove ----------
  async function removeRedemption({ alreadyRemoved = false, skipCancel = false, message = "" } = {}) {
    const a = activeRef.current;
    if (!a || busyRef.current) return;
    setBusyBoth(true);
    try {
      if (!alreadyRemoved && isGiftCardApplied(shopify.appliedGiftCards.value, a.giftCardCode)) {
        const r = await shopify.applyGiftCardChange({ type: "removeGiftCard", code: a.giftCardCode });
        if (r?.type === "error") {
          setNotice({ tone: "critical", text: `Couldn't remove your ${LABEL}. Please try again.` });
          return;
        }
      }
      let cancelOk = true;
      if (!skipCancel) {
        const res = await callApi("cancel", { redemptionId: a.redemptionId });
        cancelOk = !!res.ok;
      }
      // Pehle box turant normal karo, phir order notes saaf (isme 1-2 sec lagte hain)
      await clearSaved();
      seenAppliedRef.current = false;
      missRef.current = 0;
      setActiveBoth(null);
      await clearOrderAttributes();

      if (message) {
        setNotice({ tone: "info", text: message });
      } else if (!cancelOk) {
        setNotice({ tone: "warning", text: `${LABEL} removed. They will be back in your account within 15 minutes.` });
      } else {
        setNotice(null);
      }
      await loadBalance();
    } finally {
      setBusyBoth(false);
    }
  }

  // ================== Screen (screenshot jaisa) ==================

  if (hidden) return null;

  // 0 points wale customer (ya jiska loyalty account hi nahi) -> setting Off ho to box mat dikhao.
  // Points lage hue hon to hamesha dikhao (Remove ka button chahiye).
  if (!settings.showZeroPoints && !active) {
    const stillLoading = loading && !balance && !loadError;
    const zeroPoints = balance && Number(balance.points || 0) <= 0;
    const noAccount = loadError?.code === "NOT_MEMBER";
    if (stillLoading || zeroPoints || noAccount) return null;
  }

  let content;

  if (active) {
    content = (
      <s-stack key="applied" gap="base">
        <s-banner tone="success" heading={`${formatNum(active.pointsRedeemed)} ${LABEL} applied`}>
          <s-text>≈ {formatINR(active.amountRedeemed)} applied as a gift card on this order.</s-text>
        </s-banner>
        <s-stack direction="inline">
          <s-button variant="secondary" loading={busy} disabled={busy} onClick={() => removeRedemption()}>
            Remove
          </s-button>
        </s-stack>
      </s-stack>
    );
  } else if (loading && !balance) {
    content = <s-spinner accessibilityLabel={`Loading ${LABEL}`} />;
  } else if (loadError?.code === "NOT_LOGGED_IN") {
    content = <s-text color="subdued">Log in to use your {LABEL}.</s-text>;
  } else if (loadError || !balance) {
    content = (
      <s-stack key="error" gap="base">
        <s-banner tone="critical">{loadError?.message || `Couldn't load your ${LABEL}.`}</s-banner>
        <s-button variant="secondary" inlineSize="fill" loading={loading} onClick={() => loadBalance()}>
          Try again
        </s-button>
      </s-stack>
    );
  } else if (otpStage) {
    content = (
      <s-stack key="otp" gap="base">
        <s-text>
          Redeeming {formatNum(otpStage.points)} {LABEL} (≈ {formatINR(otpStage.points * rate)})
        </s-text>
        <s-text>Enter the OTP sent to {otpStage.maskedPhone}</s-text>
        {SHOW_DEBUG && otpStage.dummy && (
          <s-text color="subdued">Demo mode: OTP is 1234</s-text>
        )}
        <s-text-field
          label="OTP"
          value={otpInput}
          maxLength={4}
          error={otpError || undefined}
          disabled={busy}
          onInput={(e) => {
            const v = String(e.currentTarget?.value ?? e.target?.value ?? "").replace(/\D/g, "").slice(0, 4);
            setOtpInput(v);
            setOtpError("");
          }}
        />
        <s-stack direction="inline">
          <s-button
            variant="primary"
            loading={busy}
            disabled={busy || otpInput.length < 4}
            onClick={onVerifyAndApply}
          >
            {`Verify & Apply ${formatRupee(otpStage.points * rate)}`}
          </s-button>
        </s-stack>
        <s-link onClick={onResendOtp}>
          {resendIn > 0 ? `Resend OTP in ${resendIn}s` : "Resend OTP"}
        </s-link>
        <s-link onClick={onChangePoints}>Change {LABEL}</s-link>
      </s-stack>
    );
  } else {
    content = (
      <s-stack key="form" gap="base">
        <s-text>Total {LABEL}: {formatNum(availablePoints)}</s-text>
        <s-text>
          You can redeem up to {formatNum(maxPoints)} {LABEL} (≈ {formatINR(maxPoints * rate)}) on this order.
        </s-text>
        <s-number-field
          label={`${LABEL} to use (max ${formatNum(maxPoints)})`}
          value={pointsInput}
          min={minPoints}
          max={maxPoints}
          step={1}
          error={fieldError || undefined}
          disabled={busy || maxPoints < minPoints}
          onInput={(e) => {
            setPointsInput(e.currentTarget?.value ?? e.target?.value ?? "");
            setFieldError("");
          }}
        />
        <s-stack direction="inline">
          <s-button
            variant="primary"
            loading={busy}
            disabled={busy || maxPoints < minPoints || (balance?.otpRequired && resendIn > 0)}
            onClick={onApply}
          >
            {balance?.otpRequired
              ? resendIn > 0
                ? `Send OTP (${resendIn}s)`
                : `Send OTP ${buttonAmount}`
              : `Apply ${buttonAmount}`}
          </s-button>
        </s-stack>
      </s-stack>
    );
  }

  return (
    <s-box border="base" borderRadius="base" padding="base">
      <s-stack gap="base">
        <s-heading>{settings.title}</s-heading>
        {content}
        {notice && <s-banner tone={notice.tone}>{notice.text}</s-banner>}
      </s-stack>
    </s-box>
  );
}