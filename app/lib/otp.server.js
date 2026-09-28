// app/lib/otp.server.js
//
// OTP Gupshup ke TWO_FACTOR_AUTH method se: Gupshup khud OTP banata, bhejta aur verify karta hai.
// Secrets sirf .env mein:
//   GUPSHUP_USERID=...
//   GUPSHUP_PASSWORD=...
// Dono nahi hain to DUMMY mode: SMS nahi jayega, OTP hamesha 1234.

const GUPSHUP_URL = "https://enterprise.smsgupshup.com/GatewayAPI/rest";
// .trim(): Windows .env ke line-end wale chhupe characters (\r) aur spaces hatao
const USERID = String(process.env.GUPSHUP_USERID || "").trim();
const PASSWORD = String(process.env.GUPSHUP_PASSWORD || "").trim();
const IS_DEV = process.env.NODE_ENV !== "production";

// Local test mein error ke saath dikhao ki server kaunsa userid use kar raha hai (aadha chhupa ke)
function credsHint() {
  if (!IS_DEV) return "";
  const u = USERID.length > 7 ? `${USERID.slice(0, 4)}***${USERID.slice(-3)}` : "***";
  return ` | server uid ${u} (${USERID.length} chars), pw ${PASSWORD.length} chars`;
}
const DUMMY = !USERID || !PASSWORD;
const DUMMY_OTP = "1234";
const OTP_LENGTH = 4;
const TIMEOUT_MS = 15 * 1000;

// DLT approved template (ek letter bhi badla to SMS nahi jayega)
const OTP_TEMPLATE =
  "Dear Customer, Your OTP is %code%. Please use this for any of your interactions on Fabindia. OTP is valid for 30 secs. -Fabindia";

if (DUMMY) {
  console.warn("[otp] GUPSHUP_USERID / GUPSHUP_PASSWORD nahi mile -> DUMMY OTP mode (OTP = 1234)");
}

export function isOtpDummy() {
  return DUMMY;
}

// "+91 98705 79335" / "09870579335" / "9870579335" -> "919870579335"
export function normalizeIndianPhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length < 11 || digits.length > 13) return null;
  return digits;
}

export function maskPhone(digits) {
  return `******${String(digits || "").slice(-4)}`;
}

async function callGupshup(params) {
  const body = new URLSearchParams({
    userid: USERID,
    password: PASSWORD,
    method: "TWO_FACTOR_AUTH",
    v: "1.1",
    format: "json",
    ...params,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(GUPSHUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const status = json?.response?.status;
    const details = json?.response?.details || text.slice(0, 200);
    return { ok: status === "success", details };
  } catch (err) {
    return { ok: false, details: err?.name === "AbortError" ? "Gupshup timeout" : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendOtp(phoneDigits) {
  if (DUMMY) {
    console.log(`[otp] DUMMY OTP for ${maskPhone(phoneDigits)}: ${DUMMY_OTP}`);
    return { ok: true, dummy: true };
  }
  const r = await callGupshup({
    phone_no: phoneDigits,
    msg: OTP_TEMPLATE,
    msg_type: "TEXT",
    otpCodeLength: String(OTP_LENGTH),
    otpCodeType: "NUMERIC",
  });
  if (!r.ok) console.error("[otp] send failed:", r.details);
  return { ok: r.ok, dummy: false, details: r.ok ? r.details : `${r.details}${credsHint()}` };
}

export async function verifyOtp(phoneDigits, otp) {
  const code = String(otp || "").trim();
  if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code)) {
    return { ok: false, details: "Invalid OTP format" };
  }
  if (DUMMY) {
    return { ok: code === DUMMY_OTP, details: code === DUMMY_OTP ? "matched" : "mismatch" };
  }
  const r = await callGupshup({ phone_no: phoneDigits, otp_code: code });
  if (!r.ok) console.error("[otp] verify failed:", r.details);
  return r.ok ? r : { ...r, details: `${r.details}${credsHint()}` };
}