// Washly's payments: the only place that talks to Yoco. It runs on Supabase (Edge Function "payments"),
// so the Yoco secret key never reaches the app or the customer's phone.
//
// Secrets to set in Supabase -> Edge Functions -> Secrets:
//   YOCO_SECRET_KEY  your Yoco secret key (sk_test_... while testing, sk_live_... for real payments)
//   SITE_URL         https://washlyscarwash.co.za/
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
//
// Turn OFF "Verify JWT" for this function: Yoco's notifications don't carry a login,
// so the function checks logins itself and checks Yoco's signature on every notification.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const YOCO_KEY = (Deno.env.get("YOCO_SECRET_KEY") ?? "").trim();
const SITE = (Deno.env.get("SITE_URL") ?? "https://washlyscarwash.co.za/").replace(/\/?$/, "/");
const YOCO = Deno.env.get("YOCO_API_URL") ?? "https://payments.yoco.com/api";   // only changed for testing
const WEBHOOK_URL = `${SB_URL}/functions/v1/payments`;

const server = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const mode = () => (YOCO_KEY.startsWith("sk_live") ? "live" : "test");
class Problem extends Error {}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  try {
    if (req.headers.get("webhook-id")) return await webhook(req);

    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const asUser = createClient(SB_URL, SB_ANON, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: who } = await asUser.auth.getUser(token);
    if (!who?.user) return json({ error: "Please log in." }, 401);

    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "checkout": return await checkout(asUser, body);
      case "refund": return await refund(asUser, body);
      case "cancel": return await cancel(asUser, body);
      case "setup": return await setup(asUser);
      case "status": return json({ connected: !!YOCO_KEY, mode: YOCO_KEY ? mode() : "none", webhook: await hasWebhook() });
    }
    return json({ error: "Unknown request." }, 400);
  } catch (e) {
    const msg = e instanceof Problem ? e.message : "Something went wrong with the payment. Please try again.";
    if (!(e instanceof Problem)) console.error(e);
    return json({ error: msg }, 400);
  }
});

async function yoco(path: string, body: unknown, idem?: string) {
  const res = await fetch(`${YOCO}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${YOCO_KEY}`, "Content-Type": "application/json", ...(idem ? { "Idempotency-Key": idem } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// 1. Customer taps "Pay now": record the payment, open Yoco's payment page.
async function checkout(asUser: SupabaseClient, body: { booking_ids?: unknown[] }) {
  if (!YOCO_KEY) throw new Problem("Card payments aren't switched on yet. Please choose to pay on the day, or contact us.");
  const ids = (body.booking_ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new Problem("Nothing to pay for.");
  const { data: pay, error } = await asUser.rpc("start_payment", { p_booking_ids: ids });
  if (error) throw new Problem(error.message);
  const cents = Math.round(Number(pay.amount) * 100);
  const back = `${SITE}#/paid/${pay.id}`;
  const r = await yoco("/checkouts", {
    amount: cents,
    currency: "ZAR",
    successUrl: back,
    cancelUrl: `${back}/cancelled`,
    failureUrl: `${back}/failed`,
    metadata: { paymentId: pay.id, bookings: ids.join(",") },
  }, `washlys-${pay.id}`);
  if (!r.ok || !r.data?.redirectUrl || !r.data?.id) {
    await server.rpc("payment_failed", { p_ref: pay.id, p_note: `Yoco said ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}` });
    throw new Problem("We couldn't open the card payment page. Please try again in a minute.");
  }
  const { error: e2 } = await server.rpc("attach_checkout", { p_payment: pay.id, p_checkout: r.data.id, p_mode: mode() });
  if (e2) throw e2;
  return json({ redirectUrl: r.data.redirectUrl, paymentId: pay.id });
}

// 2. Yoco tells us a payment or refund went through. The signature proves it came from Yoco.
async function webhook(req: Request) {
  const raw = await req.text();
  const id = req.headers.get("webhook-id") ?? "";
  const ts = req.headers.get("webhook-timestamp") ?? "";
  const sigs = (req.headers.get("webhook-signature") ?? "").split(" ");
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return json({ error: "stale" }, 400);
  const { data: hooks } = await server.from("yoco_webhooks").select("secret");
  if (!(await validSignature(hooks ?? [], `${id}.${ts}.${raw}`, sigs))) return json({ error: "bad signature" }, 401);

  const ev = JSON.parse(raw);
  const p = ev.payload ?? {};
  const checkoutId = p.metadata?.checkoutId ?? p.checkoutId ?? "";
  if (!checkoutId) return json({ ignored: true });
  let res;
  if (ev.type === "payment.succeeded") {
    res = await server.rpc("payment_succeeded", { p_checkout: checkoutId, p_yoco_payment: p.id ?? "", p_cents: Number.isFinite(p.amount) ? p.amount : null });
    if (res.data === "refund") {   // paid after the booking was released: send the money straight back
      const { data: pay } = await server.from("payments").select("id").eq("checkout_id", checkoutId).single();
      if (pay?.id) await autoRefund(pay.id);
    }
  }
  else if (ev.type === "payment.failed") res = await server.rpc("payment_failed", { p_ref: checkoutId, p_note: "Card payment didn't go through" });
  else if (ev.type === "refund.succeeded") res = await server.rpc("refund_succeeded", { p_checkout: checkoutId });
  else if (ev.type === "refund.failed") res = await server.rpc("refund_failed", { p_checkout: checkoutId, p_note: "Yoco couldn't process the refund" });
  if (res?.error) { console.error(res.error); return json({ error: "retry" }, 500); }  // Yoco retries later
  return json({ ok: true });
}

export async function validSignature(hooks: { secret: string }[], signed: string, sigs: string[]) {
  const given = sigs.map((s) => s.split(",")[1]).filter(Boolean);
  for (const h of hooks) {
    const raw = Uint8Array.from(atob(h.secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)));
    const expected = btoa(String.fromCharCode(...mac));
    if (given.some((g) => g.length === expected.length && timingSafe(g, expected))) return true;
  }
  return false;
}
function timingSafe(a: string, b: string) { let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

// 3a. Customer (or admin) cancels a wash: cancel it, then refund the card payment automatically when Yoco allows it.
async function cancel(asUser: SupabaseClient, body: { booking_id?: number }) {
  const { data: b, error } = await asUser.rpc("cancel_booking", { p_id: Number(body.booking_id) });
  if (error) throw new Problem(error.message);
  let refund = b.pay_status === "refund_due" ? "due" : "none";
  let amount = Number(b.refund_due) || 0;
  if (refund === "due" && b.payment_id && YOCO_KEY) {
    const r = await autoRefund(b.payment_id);
    if (r) { refund = r.status; amount = r.amount; }
  }
  return json({ refund, amount, credit: Number(b.credited) || 0 });
}
async function autoRefund(paymentId: string): Promise<{ status: string; amount: number } | null> {
  const { data: pay } = await server.rpc("auto_refund_check", { p_payment: paymentId });
  if (!pay?.id) return null;   // not refundable in one go (part of a package, or a test payment): stays "refund due"
  const r = await yoco(`/checkouts/${encodeURIComponent(pay.checkout_id)}/refund`, { metadata: { paymentId: pay.id } }, `washlys-refund-${pay.id}`);
  if (!r.ok) {
    await server.rpc("refund_failed", { p_checkout: pay.checkout_id, p_note: `${r.status} ${r.data?.message ?? ""}` });
    return null;
  }
  if (String(r.data?.status ?? "").toLowerCase() === "succeeded") await server.rpc("refund_succeeded", { p_checkout: pay.checkout_id });
  return { status: "refunding", amount: Number(pay.amount) };
}

// 3b. Admin taps "Refund to card": full refund of that card payment (Yoco refunds whole payments).
async function refund(asUser: SupabaseClient, body: { payment_id?: string }) {
  if (!YOCO_KEY) throw new Problem("Yoco isn't connected.");
  const { data: pay, error } = await asUser.rpc("refund_check", { p_payment: body.payment_id });
  if (error) throw new Problem(error.message);
  if (pay.mode !== "live") {
    await server.rpc("refund_failed", { p_checkout: pay.checkout_id, p_note: "test payments can't be refunded" });
    throw new Problem("Test payments can't be refunded. Refunds work once you use your live Yoco key.");
  }
  const r = await yoco(`/checkouts/${encodeURIComponent(pay.checkout_id)}/refund`, { metadata: { paymentId: pay.id } }, `washlys-refund-${pay.id}`);
  if (!r.ok) {
    await server.rpc("refund_failed", { p_checkout: pay.checkout_id, p_note: `${r.status} ${r.data?.message ?? ""}` });
    throw new Problem(`Yoco couldn't refund this payment${r.data?.message ? `: ${r.data.message}` : "."}`);
  }
  if (String(r.data?.status ?? "").toLowerCase() === "succeeded") await server.rpc("refund_succeeded", { p_checkout: pay.checkout_id });
  return json({ ok: true, status: r.data?.status ?? "pending" });
}

// 4. Admin taps "Connect Yoco" once: register this function with Yoco to receive payment notifications.
async function hasWebhook() {
  const { count } = await server.from("yoco_webhooks").select("*", { count: "exact", head: true }).eq("url", WEBHOOK_URL);
  return (count ?? 0) > 0;
}
async function setup(asUser: SupabaseClient) {
  const { data: isAdmin } = await asUser.rpc("is_admin");
  if (!isAdmin) throw new Problem("Only the admin can connect Yoco.");
  if (!YOCO_KEY) throw new Problem("Add your Yoco secret key in Supabase (Edge Functions → Secrets → YOCO_SECRET_KEY) first.");
  const r = await yoco("/webhooks", { name: "washlys-app", url: WEBHOOK_URL });
  if (!r.ok || !r.data?.secret) throw new Problem(`Yoco didn't accept the connection (${r.status}${r.data?.message ? ": " + r.data.message : ""}). Check the secret key.`);
  const { error } = await server.from("yoco_webhooks").upsert({ webhook_id: r.data.id ?? crypto.randomUUID(), url: WEBHOOK_URL, secret: r.data.secret, mode: mode() });
  if (error) throw error;
  const { error: e2 } = await server.from("settings").update({ cards_on: true }).eq("id", 1);   // card payment now shows in the app
  if (e2) throw e2;
  return json({ ok: true, mode: mode() });
}
