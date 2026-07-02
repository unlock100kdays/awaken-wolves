/**
 * Cloudflare Pages Function — IPN / Postback Receiver
 * Route: /api/ipn/:token  (Cloudflare dynamic segment)
 *
 * GET  → return stored notifications for this token (frontend polls every 5 min)
 * POST → receive IPN/postback from JVZoo, Explodely, ClickBank, etc. and store in KV
 *
 * KV SETUP (one-time, ~1 minute):
 *   1. Cloudflare Dashboard → Workers & Pages → KV → Create namespace "bizops_ipn"
 *   2. Pages → awaken-wolves → Settings → Functions → KV namespace bindings
 *   3. Add: Variable name = IPN_KV, Namespace = bizops_ipn
 *   4. Redeploy (push any change to main)
 *
 * Without KV, POST returns 200 OK (won't crash platforms) but data isn't stored.
 * GET returns { success: true, notifications: [], kv_missing: true } so the
 * frontend knows to skip the update silently.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest({ request, params, env }) {
  const token = params.token;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!token || token.length < 10) {
    return json({ error: 'Invalid token' }, 400);
  }

  const kv = env.IPN_KV ?? null;

  /* ── POST: receive IPN/postback ── */
  if (request.method === 'POST') {
    if (!kv) return new Response('OK', { status: 200 }); // KV not set up yet — silently accept

    let data = {};
    const ct = request.headers.get('content-type') || '';
    try {
      if (ct.includes('application/json')) {
        data = await request.json();
      } else {
        const text = await request.text();
        data = Object.fromEntries(new URLSearchParams(text));
      }
    } catch { /* ignore parse errors */ }

    const txnId = data.ctransactionid   // JVZoo
                || data.transaction_id
                || data.orderid || data.jvzooref || data.ref
                || data.receipt || data.cbreceipt || data.tid
                || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const normalized = {
      received_at: Date.now(),
      platform: guessPlatform(data),
      type: guessType(data),
      // JVZoo affiliate commission → camount / ctransamount; fallback to generic fields
      amount: parseFloat(
        data.camount || data.ctransamount ||          // JVZoo
        data.amount || data.sale_amount ||
        data.order_total || data.affiliate_earnings || 0
      ) || 0,
      // JVZoo product title → cprodtitle
      product: data.cprodtitle || data.productname || data.product_name || data.item_name || data.cbitems || '',
      txn_id: txnId,
      raw: data,
    };

    // Ignore JVZoo test pings — they confirm connectivity but aren't real sales
    if (normalized.type === 'test') return new Response('OK', { status: 200 });

    // Store with 1-year TTL; key = token:txnId (colon-separated prefix for listing)
    await kv.put(`${token}:${txnId}`, JSON.stringify(normalized), {
      expirationTtl: 365 * 24 * 3600,
    });

    return new Response('OK', { status: 200 });
  }

  /* ── GET: retrieve stored notifications ── */
  if (request.method === 'GET') {
    if (!kv) {
      return json({ success: true, notifications: [], kv_missing: true });
    }

    const list = await kv.list({ prefix: `${token}:`, limit: 200 });
    const notifications = (
      await Promise.all(list.keys.map(k => kv.get(k.name, 'json')))
    ).filter(Boolean);

    notifications.sort((a, b) => b.received_at - a.received_at);

    return json({ success: true, notifications });
  }

  return new Response('Method not allowed', { status: 405 });
}

function guessPlatform(d) {
  // JVZoo sends cjvzipn or ctransaffiliate
  if (d.cjvzipn || d.jvzipn || d.ctransaffiliate !== undefined || d.ctransactionid) return 'JVZoo';
  if (d.cbreceipt || d.receipt || d.cbitems) return 'ClickBank';
  if (d.saletimestamp || (d.productId !== undefined && !d.ctransactionid)) return 'Explodely';
  return 'Unknown';
}

function guessType(d) {
  // JVZoo uses ctransaction = "SALE", "REFUND", "TEST"
  const raw = (d.ctransaction || d.type || d.ctype || d.ipntype || d.refundtype || '').toString().toLowerCase();
  if (raw === 'test') return 'test';
  if (raw === '2' || raw === 'refund' || raw.includes('refund')) return 'refund';
  if (raw === '3' || raw.includes('chargeback') || raw.includes('dispute')) return 'chargeback';
  return 'sale';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
