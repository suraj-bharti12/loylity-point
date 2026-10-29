// app/routes/webhooks.compliance.jsx
// Shopify ke 3 zaroori GDPR webhooks: customers/data_request, customers/redact, shop/redact
// shopify.app.toml mein: compliance_topics = [...]  uri = "/webhooks/compliance"

import { authenticate } from "../shopify.server";
import {
  gdprCustomerDataRequest,
  gdprCustomerRedact,
  gdprShopRedact,
} from "../lib/points-checkout.server";

export const action = async ({ request }) => {
  // Shopify ka HMAC signature check. Galat ho to ye khud 401 lauta deta hai (aage kuch nahi chalta).
  const { shop, topic, payload } = await authenticate.webhook(request);

  // "CUSTOMERS_DATA_REQUEST" / "customers/data_request" dono ko ek jaisa padho
  const t = String(topic || "").toUpperCase().replace(/[^A-Z]/g, "");

  try {
    if (t === "CUSTOMERSDATAREQUEST") {
      await gdprCustomerDataRequest({ shop, payload });
    } else if (t === "CUSTOMERSREDACT") {
      await gdprCustomerRedact({ shop, payload });
    } else if (t === "SHOPREDACT") {
      await gdprShopRedact({ shop });
    } else {
      console.warn("[gdpr] unknown topic", topic);
    }
  } catch (err) {
    // Shopify ko 200 hi do (warna wo baar-baar bhejta hai); error Render Logs mein dikhega
    console.error(`[gdpr] ${topic} failed for ${shop}:`, err);
  }

  return new Response(null, { status: 200 });
};