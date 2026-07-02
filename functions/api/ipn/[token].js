/**
 * Cloudflare Pages Function — IPN / Postback Receiver
 * Route: /api/ipn/:token
 *
 * POST → Explodely, ClickBank, classic JVZoo IPN (form/JSON body)
 * GET  → two cases:
 *   (a) Has sale params in query string → JVZoo S2S Postback (store the sale)
 *   (b) No sale params → frontend poll (return stored notifications)
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

  /* ── POST: Explodely / ClickBank / classic JVZoo IPN ── */
  if (request.method === 'POST') {
    if (!kv) return new Response('OK', { status: 200 });

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

    return await storePostback(kv, token, data);
  }

  /* ── GET: JVZoo S2S postback OR frontend poll ── */
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const qp = Object.fromEntries(url.searchParams);

    // JVZoo S2S sends GET with sale data as query params
    // Detect by presence of any sale-related field
    const isSalePostback = !!(
      qp.tid || qp.transaction_id || qp.ctransactionid ||
      qp.orderid || qp.camount || qp.amount || qp.sale_amount ||
      qp.cjvzipn || qp.ctransaction || qp.cprodtitle
    );

    if (isSalePostback) {
      if (!kv) return new Response('OK', { status: 200 });
      return await storePostback(kv, token, qp);
    }

    // No sale params → frontend poll: return stored notifications
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

async function storePostback(kv, token, data) {
  const txnId = data.ctransactionid || data.transaction_id
              || data.tid || data.orderid || data.jvzooref
              || data.ref || data.receipt || data.cbreceipt
              || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const normalized = {
    received_at: Date.now(),
    platform: guessPlatform(data),
    type: guessType(data),
    amount: parseFloat(
      data.camount || data.ctransamount ||   // JVZoo IPN
      data.amount  || data.sale_amount  ||   // generic / Explodely
      data.order_total || data.affiliate_earnings || 0
    ) || 0,
    product: data.cprodtitle || data.productname || data.product_name
           || data.product   || data.item_name  || data.cbitems || '',
    txn_id: txnId,
    raw: data,
  };

  // Ignore JVZoo test pings
  if (normalized.type === 'test') return new Response('OK', { status: 200 });

  await kv.put(`${token}:${txnId}`, JSON.stringify(normalized), {
    expirationTtl: 365 * 24 * 3600,
  });

  return new Response('OK', { status: 200 });
}

function guessPlatform(d) {
  if (d.cjvzipn || d.jvzipn || d.ctransaffiliate !== undefined || d.ctransactionid || d.cprodtitle) return 'JVZoo';
  if (d.cbreceipt || d.receipt || d.cbitems) return 'ClickBank';
  if (d.saletimestamp || (d.productId !== undefined && !d.ctransactionid)) return 'Explodely';
  return 'Unknown';
}

function guessType(d) {
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
