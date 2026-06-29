/**
 * Cloudflare Pages Function — API Proxy
 * Path: /functions/api/proxy.js → URL: /api/proxy
 *
 * Receives POST from the frontend with platform + credentials,
 * makes the real server-side API call (no CORS issue), returns data.
 *
 * Body: { platform, apiKey, apiSecret, username, action, offerId }
 * action: "fetchOffers" | "fetchStats"
 */

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request }) {
  try {
    const body = await request.json();
    const { platform, apiKey, apiSecret, username, action, offerId } = body;

    if (!platform || !apiKey) {
      return json({ success: false, error: 'Missing platform or apiKey' }, 400);
    }

    let result;
    switch (platform) {
      case 'Explodely': result = await explodely(username, apiKey, action, offerId); break;
      case 'JVzoo':     result = await jvzoo(username, apiKey, action, offerId);     break;
      case 'Clickbank': result = await clickbank(apiKey, apiSecret, action, offerId); break;
      case 'Cartpanda': result = await cartpanda(apiKey, action, offerId);            break;
      case 'Digistore': result = await digistore(apiKey, action, offerId);            break;
      default:          result = { success: false, error: `Unknown platform: ${platform}` };
    }

    return json(result);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}

/* ─── HELPERS ─── */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

async function apiGet(url, headers = {}) {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON response (${r.status}): ${text.slice(0, 200)}`); }
  if (!r.ok) throw new Error(data?.message || data?.error || `HTTP ${r.status}`);
  return data;
}

async function apiPost(url, params, extraHeaders = {}) {
  const body = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...extraHeaders },
    body,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON response (${r.status}): ${text.slice(0, 200)}`); }
  if (!r.ok) throw new Error(data?.message || data?.error || `HTTP ${r.status}`);
  return data;
}

function parseProductList(raw) {
  /* Handles arrays at multiple common keys */
  const arr = raw?.products || raw?.data?.products || raw?.items || raw?.result || raw?.data || raw;
  if (!Array.isArray(arr)) return [];
  return arr.map(p => ({
    id:   String(p.id || p.product_id || p.productId || p.sku || ''),
    name: String(p.name || p.title || p.product_name || p.productName || p.id || ''),
  })).filter(p => p.name);
}

/* ─── EXPLODELY ───────────────────────────────────────────
   Docs: https://docs.explodely.com/api/introduction
   Auth: ?username=X&apikey=Y&apiaction=Z (GET params)
   Base: https://explodely.com/api/v1/
──────────────────────────────────────────────────────────── */
async function explodely(username, apiKey, action, offerId) {
  const base = 'https://explodely.com/api/v1/';

  if (action === 'fetchOffers') {
    const q = new URLSearchParams({ username, apikey: apiKey, apiaction: 'listproducts' });
    const d = await apiGet(`${base}vendor?${q}`);
    return { success: true, offers: parseProductList(d) };
  }

  if (action === 'fetchStats') {
    // Product stats — try both common endpoint patterns
    const q = new URLSearchParams({ username, apikey: apiKey, apiaction: 'getstats', productid: offerId });
    const d = await apiGet(`${base}vendor?${q}`);
    const aff_q = new URLSearchParams({ username, apikey: apiKey, apiaction: 'listaffiliates', productid: offerId });
    let affData = {};
    try { affData = await apiGet(`${base}vendor?${aff_q}`); } catch { /* optional */ }
    return { success: true, raw: d, affRaw: affData };
  }

  return { success: false, error: 'Unknown action' };
}

/* ─── JVZOO ──────────────────────────────────────────────
   REST API: https://api.jvzoo.com
   Auth: Basic base64(username:apikey)
   Docs: https://api.jvzoo.com
──────────────────────────────────────────────────────────── */
async function jvzoo(username, apiKey, action, offerId) {
  const base = 'https://api.jvzoo.com/v1';
  const auth = 'Basic ' + btoa(`${username}:${apiKey}`);

  if (action === 'fetchOffers') {
    const d = await apiGet(`${base}/products`, { Authorization: auth });
    return { success: true, offers: parseProductList(d) };
  }

  if (action === 'fetchStats') {
    // Fetch product stats + affiliates in parallel
    const [stats, affs] = await Promise.allSettled([
      apiGet(`${base}/products/${offerId}/statistics`, { Authorization: auth }),
      apiGet(`${base}/products/${offerId}/affiliates?limit=10&sort=revenue&order=desc`, { Authorization: auth }),
    ]);
    return {
      success: true,
      raw: stats.status === 'fulfilled' ? stats.value : {},
      affRaw: affs.status === 'fulfilled' ? affs.value : {},
      statsError: stats.status === 'rejected' ? stats.reason.message : null,
    };
  }

  return { success: false, error: 'Unknown action' };
}

/* ─── CLICKBANK ───────────────────────────────────────────
   REST API: https://api.clickbank.com/rest/1.3/
   Auth: Authorization: devKey:clerkKey
──────────────────────────────────────────────────────────── */
async function clickbank(devKey, clerkKey, action, offerId) {
  const base = 'https://api.clickbank.com/rest/1.3';
  const auth = `${devKey}:${clerkKey}`;

  if (action === 'fetchOffers') {
    const d = await apiGet(`${base}/products/list`, { Authorization: auth });
    const arr = d?.productList || d?.products || d || [];
    const offers = Array.isArray(arr)
      ? arr.map(p => ({ id: String(p.site || p.id || ''), name: String(p.title || p.site || '') })).filter(p => p.name)
      : [];
    return { success: true, offers };
  }

  if (action === 'fetchStats') {
    const [snap, affs] = await Promise.allSettled([
      apiGet(`${base}/sales/analytics/snapshot?site=${offerId}&unit=DAY`, { Authorization: auth }),
      apiGet(`${base}/affiliates/list?site=${offerId}&limit=10`, { Authorization: auth }),
    ]);
    return {
      success: true,
      raw: snap.status === 'fulfilled' ? snap.value : {},
      affRaw: affs.status === 'fulfilled' ? affs.value : {},
    };
  }

  return { success: false, error: 'Unknown action' };
}

/* ─── CARTPANDA ───────────────────────────────────────────
   REST API: https://api.cartpanda.com.br/v1/
   Auth: Bearer token
──────────────────────────────────────────────────────────── */
async function cartpanda(apiKey, action, offerId) {
  const base = 'https://api.cartpanda.com.br/v1';
  const auth = `Bearer ${apiKey}`;

  if (action === 'fetchOffers') {
    const d = await apiGet(`${base}/products`, { Authorization: auth });
    return { success: true, offers: parseProductList(d) };
  }

  if (action === 'fetchStats') {
    const d = await apiGet(`${base}/products/${offerId}/stats`, { Authorization: auth });
    return { success: true, raw: d };
  }

  return { success: false, error: 'Unknown action' };
}

/* ─── DIGISTORE24 ─────────────────────────────────────────
   REST API: https://www.digistore24.com/api/call/{key}/
   Auth: API key in URL path
──────────────────────────────────────────────────────────── */
async function digistore(apiKey, action, offerId) {
  const base = `https://www.digistore24.com/api/call/${apiKey}`;

  if (action === 'fetchOffers') {
    const d = await apiGet(`${base}/listProducts/json`);
    const arr = d?.data?.products || d?.products || [];
    const offers = Array.isArray(arr)
      ? arr.map(p => ({ id: String(p.product_id || p.id || ''), name: String(p.name || '') })).filter(p => p.name)
      : [];
    return { success: true, offers };
  }

  if (action === 'fetchStats') {
    const [stats, affs] = await Promise.allSettled([
      apiGet(`${base}/listProductStats/json?product_id=${offerId}`),
      apiGet(`${base}/listTopAffiliates/json?product_id=${offerId}&limit=10`),
    ]);
    return {
      success: true,
      raw: stats.status === 'fulfilled' ? stats.value : {},
      affRaw: affs.status === 'fulfilled' ? affs.value : {},
    };
  }

  return { success: false, error: 'Unknown action' };
}
