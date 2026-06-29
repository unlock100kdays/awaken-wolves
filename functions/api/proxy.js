/**
 * Cloudflare Pages Function — API Proxy
 * Path: /functions/api/proxy.js → URL: /api/proxy
 *
 * Server-side proxy — avoids browser CORS restrictions.
 * Body: { platform, apiKey, apiSecret, username, action, offerId }
 * action: "fetchOffers" | "fetchStats"
 */

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
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
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

/** Format a Date as DD-mmm-YYYY (Explodely's required format, e.g. 29-jun-2026) */
function exDate(d) {
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  return `${String(d.getDate()).padStart(2,'0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

function today()     { return exDate(new Date()); }
function yesterday() { return exDate(new Date(Date.now() - 86400000)); }
function daysAgo(n)  { return exDate(new Date(Date.now() - n * 86400000)); }

/** Fetch Explodely sales for a date range, return raw array */
async function explFetchRange(username, apiKey, startdate, enddate) {
  const q = new URLSearchParams({ username, apikey: apiKey, apiaction: 'getsalebyget', startdate, enddate });
  const r = await fetch(`https://api.explodely.com/v1/sale?${q}`);
  if (!r.ok) throw new Error(`Explodely HTTP ${r.status}`);
  const d = await r.json();
  if (d?.error) throw new Error(`Explodely: ${d.error}`);
  /* Response might be array or object with a sales key */
  const arr = Array.isArray(d) ? d : (d?.sales || d?.data || d?.result || d?.orders || []);
  return Array.isArray(arr) ? arr : [];
}

/** Sum net revenue from a sales array (subtract refunds/chargebacks) */
function sumRev(sales) {
  return sales.reduce((acc, s) => {
    const amt = parseFloat(s.amount || s.total || s.revenue || s.sale_amount || s.price || 0) || 0;
    const type = String(s.saletype || s.type || s.status || s.transaction_type || '').toLowerCase();
    if (type === 'refund' || type === 'chargeback' || type === 'reversal') return acc - amt;
    return acc + amt;
  }, 0);
}

/** Count clean sales (not refunds) */
function countSales(sales) {
  return sales.filter(s => {
    const type = String(s.saletype || s.type || s.status || s.transaction_type || '').toLowerCase();
    return !type || type === 'sale' || type === 'new_sale' || type === 'completed' || type === 'success';
  }).length;
}

/** Count refunds */
function countRefunds(sales) {
  return sales.filter(s => {
    const type = String(s.saletype || s.type || s.status || s.transaction_type || '').toLowerCase();
    return type === 'refund';
  }).length;
}

/** Count chargebacks */
function countCBs(sales) {
  return sales.filter(s => {
    const type = String(s.saletype || s.type || s.status || s.transaction_type || '').toLowerCase();
    return type === 'chargeback' || type === 'reversal' || type === 'dispute';
  }).length;
}

/** Build top-10 affiliates map from sales array */
function buildAffiliates(sales) {
  const map = {};
  sales.forEach(s => {
    const type = String(s.saletype || s.type || s.status || '').toLowerCase();
    const name = (s.affiliateuser || s.affiliate || s.aff_username || s.aff_user || s.affiliate_name || '').trim();
    if (!name) return;
    const amt = parseFloat(s.amount || s.total || s.revenue || 0) || 0;
    if (!map[name]) map[name] = { name, revenue: 0, sales: 0, commissions: 0 };
    if (type === 'refund') { map[name].revenue -= amt; }
    else { map[name].revenue += amt; map[name].sales++; }
    /* Affiliate commission if available */
    const comm = parseFloat(s.affiliate_commission || s.comm_amount || s.aff_comm || 0) || 0;
    if (comm) map[name].commissions += comm;
  });
  return Object.values(map)
    .filter(a => a.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map((a, i) => ({
      rank: i + 1,
      name: a.name,
      revenue: a.revenue,
      sales: a.sales,
      epc: a.sales > 0 ? a.revenue / a.sales : 0,
    }));
}

/* ─── EXPLODELY ───────────────────────────────────────────────────────────────
   Real API:  https://api.explodely.com/v1/sale
   Auth:      ?username=X&apikey=Y (query params, NOT headers)
   Action:    apiaction=getsalebyget (GET)
   Date fmt:  DD-mmm-YYYY  e.g. 29-jun-2026
   No product listing endpoint exists in their API.
────────────────────────────────────────────────────────────────────────────── */
async function explodely(username, apiKey, action, offerId) {

  if (action === 'fetchOffers') {
    /* Explodely has no product-listing endpoint. Verify credentials by fetching
       today's sales. Return empty offers so the UI prompts manual name entry. */
    try {
      const q = new URLSearchParams({ username, apikey: apiKey, apiaction: 'getsalebyget', startdate: today(), enddate: today() });
      const r = await fetch(`https://api.explodely.com/v1/sale?${q}`);
      const d = await r.json();
      if (d?.error === 'invalidapikey') throw new Error('Invalid API key or username — check your Explodely account settings');
      if (d?.error === 'invalid_sellerid') throw new Error('Username is not a valid Explodely seller account');
      if (d?.error) throw new Error(`Explodely error: ${d.error}`);
    } catch (e) {
      if (e.message.includes('Invalid') || e.message.includes('Explodely error')) throw e;
      /* Network error — still save creds, user can proceed */
    }
    return {
      success: true,
      offers: [],
      note: "Explodely doesn't have a product listing API — enter your offer name manually below"
    };
  }

  if (action === 'fetchStats') {
    /* Fetch sales for 4 date ranges in parallel */
    const t  = today();
    const y  = yesterday();
    const w7 = daysAgo(7);
    const w30 = daysAgo(30);

    const [todayRes, yestRes, week7Res, allTimeRes] = await Promise.allSettled([
      explFetchRange(username, apiKey, t, t),
      explFetchRange(username, apiKey, y, y),
      explFetchRange(username, apiKey, w7, t),
      explFetchRange(username, apiKey, '01-jan-2020', t),
    ]);

    const todaySales   = todayRes.status   === 'fulfilled' ? todayRes.value   : [];
    const yestSales    = yestRes.status    === 'fulfilled' ? yestRes.value    : [];
    const week7Sales   = week7Res.status   === 'fulfilled' ? week7Res.value   : [];
    const allTimeSales = allTimeRes.status === 'fulfilled' ? allTimeRes.value : [];

    const totalRev  = sumRev(allTimeSales);
    const todayRev  = sumRev(todaySales);
    const yestRev   = sumRev(yestSales);
    const week7Rev  = sumRev(week7Sales);
    const totalOrds = countSales(allTimeSales);
    const refunds   = countRefunds(allTimeSales);
    const cbs       = countCBs(allTimeSales);
    const refRate   = totalOrds > 0 ? (refunds / totalOrds * 100) : 0;
    const cbRate    = totalOrds > 0 ? (cbs / totalOrds * 100) : 0;
    const avgOV     = totalOrds > 0 ? totalRev / totalOrds : 0;
    const topAffs   = buildAffiliates(allTimeSales);

    return {
      success: true,
      raw: {
        total_revenue:    totalRev,
        today_revenue:    todayRev,
        yesterday_revenue: yestRev,
        revenue_7_days:   week7Rev,
        total_orders:     totalOrds,
        avg_order_value:  avgOV,
        refund_rate:      refRate,
        chargeback_rate:  cbRate,
        conversion_rate:  0,
        epc:              0,
        affiliates:       topAffs,
      },
      /* Debug info to help diagnose any parsing issues */
      _debug: {
        todayCount: todaySales.length,
        yestCount: yestSales.length,
        week7Count: week7Sales.length,
        allTimeCount: allTimeSales.length,
        sampleSale: allTimeSales[0] || null,
      }
    };
  }

  return { success: false, error: 'Unknown action' };
}

/* ─── JVZOO ──────────────────────────────────────────────────────────────────
   REST API:  https://api.jvzoo.com/v1
   Auth:      Basic base64(username:apikey)
────────────────────────────────────────────────────────────────────────────── */
async function jvzoo(username, apiKey, action, offerId) {
  const base = 'https://api.jvzoo.com/v1';
  const auth = 'Basic ' + btoa(`${username}:${apiKey}`);
  const h    = { Authorization: auth, Accept: 'application/json' };

  if (action === 'fetchOffers') {
    const r = await fetch(`${base}/products`, { headers: h });
    if (!r.ok) throw new Error(`JVzoo HTTP ${r.status}`);
    const d = await r.json();
    const arr = d?.products || d?.data || d?.items || d || [];
    const offers = Array.isArray(arr)
      ? arr.map(p => ({ id: String(p.id || ''), name: String(p.name || p.title || p.id || '') })).filter(o => o.name)
      : [];
    return { success: true, offers };
  }

  if (action === 'fetchStats') {
    const [stats, affs] = await Promise.allSettled([
      fetch(`${base}/products/${offerId}/statistics`, { headers: h }).then(r => r.json()),
      fetch(`${base}/products/${offerId}/affiliates?limit=10&sort=revenue&order=desc`, { headers: h }).then(r => r.json()),
    ]);
    return {
      success: true,
      raw:    stats.status === 'fulfilled' ? stats.value : {},
      affRaw: affs.status  === 'fulfilled' ? affs.value  : {},
    };
  }

  return { success: false, error: 'Unknown action' };
}

/* ─── CLICKBANK ───────────────────────────────────────────────────────────────
   REST API:  https://api.clickbank.com/rest/1.3
   Auth:      Authorization: devKey:clerkKey
────────────────────────────────────────────────────────────────────────────── */
async function clickbank(devKey, clerkKey, action, offerId) {
  const base = 'https://api.clickbank.com/rest/1.3';
  const auth = `${devKey}:${clerkKey}`;
  const h    = { Authorization: auth, Accept: 'application/json' };

  if (action === 'fetchOffers') {
    const r = await fetch(`${base}/products/list`, { headers: h });
    if (!r.ok) throw new Error(`Clickbank HTTP ${r.status}`);
    const d   = await r.json();
    const arr = d?.productList || d?.products || d || [];
    const offers = Array.isArray(arr)
      ? arr.map(p => ({ id: String(p.site || p.id || ''), name: String(p.title || p.site || '') })).filter(o => o.name)
      : [];
    return { success: true, offers };
  }

  if (action === 'fetchStats') {
    const [snap, affs] = await Promise.allSettled([
      fetch(`${base}/sales/analytics/snapshot?site=${offerId}&unit=DAY`, { headers: h }).then(r => r.json()),
      fetch(`${base}/affiliates/list?site=${offerId}&limit=10`, { headers: h }).then(r => r.json()),
    ]);
    return {
      success: true,
      raw:    snap.status === 'fulfilled' ? snap.value : {},
      affRaw: affs.status === 'fulfilled' ? affs.value : {},
    };
  }

  return { success: false, error: 'Unknown action' };
}

/* ─── CARTPANDA ───────────────────────────────────────────────────────────────
   REST API:  https://api.cartpanda.com.br/v1
   Auth:      Bearer token
────────────────────────────────────────────────────────────────────────────── */
async function cartpanda(apiKey, action, offerId) {
  const base = 'https://api.cartpanda.com.br/v1';
  const h    = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  if (action === 'fetchOffers') {
    const r = await fetch(`${base}/products`, { headers: h });
    if (!r.ok) throw new Error(`Cartpanda HTTP ${r.status}`);
    const d   = await r.json();
    const arr = d?.products || d?.data || d || [];
    return {
      success: true,
      offers: Array.isArray(arr)
        ? arr.map(p => ({ id: String(p.id || ''), name: String(p.name || p.title || '') })).filter(o => o.name)
        : [],
    };
  }

  if (action === 'fetchStats') {
    const r = await fetch(`${base}/products/${offerId}/stats`, { headers: h });
    if (!r.ok) throw new Error(`Cartpanda HTTP ${r.status}`);
    return { success: true, raw: await r.json() };
  }

  return { success: false, error: 'Unknown action' };
}

/* ─── DIGISTORE24 ─────────────────────────────────────────────────────────────
   REST API:  https://www.digistore24.com/api/call/{key}/
   Auth:      API key in URL path
────────────────────────────────────────────────────────────────────────────── */
async function digistore(apiKey, action, offerId) {
  const base = `https://www.digistore24.com/api/call/${apiKey}`;

  if (action === 'fetchOffers') {
    const r = await fetch(`${base}/listProducts/json`);
    if (!r.ok) throw new Error(`Digistore HTTP ${r.status}`);
    const d   = await r.json();
    const arr = d?.data?.products || d?.products || [];
    return {
      success: true,
      offers: Array.isArray(arr)
        ? arr.map(p => ({ id: String(p.product_id || p.id || ''), name: String(p.name || '') })).filter(o => o.name)
        : [],
    };
  }

  if (action === 'fetchStats') {
    const [stats, affs] = await Promise.allSettled([
      fetch(`${base}/listProductStats/json?product_id=${offerId}`).then(r => r.json()),
      fetch(`${base}/listTopAffiliates/json?product_id=${offerId}&limit=10`).then(r => r.json()),
    ]);
    return {
      success: true,
      raw:    stats.status === 'fulfilled' ? stats.value : {},
      affRaw: affs.status  === 'fulfilled' ? affs.value  : {},
    };
  }

  return { success: false, error: 'Unknown action' };
}
