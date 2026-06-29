/**
 * Cloudflare Pages Function — API Proxy
 * /functions/api/proxy.js → URL: /api/proxy
 *
 * Makes server-side API calls (no browser CORS restriction).
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
    if (!platform || !apiKey) return json({ success: false, error: 'Missing platform or apiKey' }, 400);
    let result;
    switch (platform) {
      case 'Explodely': result = await explodely(username, apiKey, action, offerId); break;
      case 'JVzoo':     result = await jvzoo(username, apiKey, action, offerId);     break;
      case 'Clickbank': result = await clickbank(apiKey, apiSecret, action, offerId); break;
      case 'Cartpanda': result = await cartpanda(apiKey, action, offerId);            break;
      case 'Digistore': result = await digistore(apiKey, action, offerId);            break;
      default: result = { success: false, error: `Unknown platform: ${platform}` };
    }
    return json(result);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

/* ─── DATE HELPERS ───────────────────────────────────────────────────────────
   Explodely requires DD-mmm-YYYY format (e.g. 29-jun-2026)
──────────────────────────────────────────────────────────────────────────── */
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function exDate(d) {
  return `${String(d.getDate()).padStart(2,'0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}
const now = () => new Date();
function today()    { return exDate(now()); }
function daysAgo(n) { return exDate(new Date(Date.now() - n * 86400000)); }

/* ─── EXPLODELY ──────────────────────────────────────────────────────────────
   Sales API (Beta): https://api.explodely.com/v1/sale
   Auth: ?username=X&apikey=Y  (query params, NOT headers)
   Action GET:  apiaction=getsalebyget
   Date format: DD-mmm-YYYY  e.g.  29-jun-2026

   IPN field reference (same shape returned by Sales API):
     orderid, type, productId, productName, customerName, customerEmail,
     customerPhone, affiliate, amount, vat, saletimedate, saletimestamp,
     zipcode, country, billdesc, custom1-5, obselected, ipadd,
     rebill, mainorderid
──────────────────────────────────────────────────────────────────────────── */
async function explSalesRange(username, apiKey, startdate, enddate) {
  const q = new URLSearchParams({ username, apikey: apiKey, apiaction: 'getsalebyget', startdate, enddate });
  const r = await fetch(`https://api.explodely.com/v1/sale?${q}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CloudflareWorker/1.0',
    },
  });

  const text = await r.text();

  /* Cloudflare bot challenge returns HTML — detect it */
  if (text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')) {
    throw new Error('BOT_CHALLENGE');
  }

  let d;
  try { d = JSON.parse(text); } catch { throw new Error(`Non-JSON response (${r.status})`); }

  if (d?.error === 'invalidapikey')   throw new Error('Invalid API key or username');
  if (d?.error === 'invalid_sellerid') throw new Error('Not a valid Explodely seller account');
  if (d?.error) throw new Error(`Explodely: ${d.error}`);

  /* Response may be an array directly, or { sales: [...] } */
  const arr = Array.isArray(d) ? d : (d?.sales || d?.data || d?.transactions || d?.orders || []);
  return Array.isArray(arr) ? arr : [];
}

function exRevSum(sales) {
  return sales.reduce((acc, s) => {
    const amt = parseFloat(s.amount || 0) || 0;
    const t   = String(s.type || '').toLowerCase();
    return (t === 'refund' || t === 'chargeback') ? acc - amt : acc + amt;
  }, 0);
}

function exCountType(sales, type) {
  return sales.filter(s => String(s.type || '').toLowerCase() === type).length;
}

function exSaleCount(sales) {
  return sales.filter(s => {
    const t = String(s.type || '').toLowerCase();
    return !t || t === 'sale' || t === 'new_sale' || t === 'rebill';
  }).length;
}

function exBuildAffs(sales) {
  const m = {};
  sales.forEach(s => {
    const t    = String(s.type || '').toLowerCase();
    const name = (s.affiliate || '').trim();
    if (!name) return;
    const amt  = parseFloat(s.amount || 0) || 0;
    if (!m[name]) m[name] = { name, revenue: 0, sales: 0 };
    if (t === 'refund') m[name].revenue -= amt;
    else { m[name].revenue += amt; m[name].sales++; }
  });
  return Object.values(m)
    .filter(a => a.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map((a, i) => ({ rank: i+1, name: a.name, revenue: a.revenue, sales: a.sales, epc: a.sales ? a.revenue/a.sales : 0 }));
}

function exBuildProducts(sales) {
  const m = {};
  sales.forEach(s => {
    const t = String(s.type || '').toLowerCase();
    if (t === 'refund' || t === 'chargeback') return;
    const pid  = s.productId   || 'unknown';
    const name = s.productName || s.productId || 'Unknown Product';
    const amt  = parseFloat(s.amount || 0) || 0;
    if (!m[pid]) m[pid] = { id: pid, name, revenue: 0, orders: 0, vat: 0 };
    m[pid].revenue += amt;
    m[pid].orders++;
    m[pid].vat += parseFloat(s.vat || 0) || 0;
  });
  return Object.values(m).sort((a, b) => b.revenue - a.revenue);
}

function exBuildCountries(sales) {
  const m = {};
  sales.forEach(s => {
    const t = String(s.type || '').toLowerCase();
    if (t === 'refund' || t === 'chargeback') return;
    const c = (s.country || 'Unknown').toUpperCase();
    if (!m[c]) m[c] = { code: c, count: 0, revenue: 0 };
    m[c].count++;
    m[c].revenue += parseFloat(s.amount || 0) || 0;
  });
  return Object.values(m).sort((a, b) => b.count - a.count).slice(0, 8);
}

function exRecentTxns(sales, n = 15) {
  return [...sales]
    .sort((a, b) => Number(b.saletimestamp || 0) - Number(a.saletimestamp || 0))
    .slice(0, n)
    .map(s => ({
      orderId:   s.orderid      || '—',
      type:      s.type         || 'sale',
      product:   s.productName  || s.productId || '—',
      customer:  s.customerName || s.customerEmail || '—',
      email:     s.customerEmail || '—',
      affiliate: s.affiliate    || '',
      amount:    parseFloat(s.amount || 0) || 0,
      vat:       parseFloat(s.vat    || 0) || 0,
      country:   (s.country     || '').toUpperCase(),
      date:      s.saletimedate || '',
      obump:     s.obselected   === 'yes',
      rebill:    s.rebill       === 'yes',
    }));
}

async function explodely(username, apiKey, action) {
  if (action === 'fetchOffers') {
    /* No product-listing endpoint in Explodely API — verify creds with today's sales call */
    try {
      const q = new URLSearchParams({ username, apikey: apiKey, apiaction: 'getsalebyget', startdate: today(), enddate: today() });
      const r = await fetch(`https://api.explodely.com/v1/sale?${q}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'CloudflareWorker/1.0' },
      });
      const text = await r.text();
      if (text.trimStart().startsWith('<')) throw new Error('CHALLENGE');
      const d = JSON.parse(text);
      if (d?.error === 'invalidapikey')    throw new Error('Invalid API key or username — check Explodely account settings');
      if (d?.error === 'invalid_sellerid') throw new Error('Username is not a valid Explodely seller account');
      if (d?.error) throw new Error(`Explodely: ${d.error}`);
    } catch (e) {
      if (e.message !== 'CHALLENGE') throw e; /* rethrow auth errors */
    }
    return {
      success: true, offers: [],
      note: "Explodely has no product listing API — type your offer name below and we'll pull all your sales data"
    };
  }

  if (action === 'fetchStats') {
    const t   = today();
    const y   = daysAgo(1);
    const w7  = daysAgo(7);
    const w30 = daysAgo(30);

    /* Fetch 4 date ranges in parallel */
    const [r0, r1, r2, r3] = await Promise.allSettled([
      explSalesRange(username, apiKey, t,           t),
      explSalesRange(username, apiKey, y,           y),
      explSalesRange(username, apiKey, w7,          t),
      explSalesRange(username, apiKey, '01-jan-2020', t),
    ]);

    /* Surface bot challenge clearly */
    if ([r0,r1,r2,r3].every(r => r.status==='rejected' && r.reason?.message==='BOT_CHALLENGE')) {
      throw new Error('Explodely API requires a browser challenge — cannot be called from a server. Use the Webhook approach instead.');
    }

    const todaySales   = r0.status === 'fulfilled' ? r0.value : [];
    const yestSales    = r1.status === 'fulfilled' ? r1.value : [];
    const week7Sales   = r2.status === 'fulfilled' ? r2.value : [];
    const allTimeSales = r3.status === 'fulfilled' ? r3.value : [];

    const totalOrds  = exSaleCount(allTimeSales);
    const refunds    = exCountType(allTimeSales, 'refund');
    const cbs        = exCountType(allTimeSales, 'chargeback');
    const totalRev   = exRevSum(allTimeSales);
    const refRate    = totalOrds > 0 ? refunds / totalOrds * 100 : 0;
    const cbRate     = totalOrds > 0 ? cbs / totalOrds * 100 : 0;
    const avgOV      = totalOrds > 0 ? totalRev / totalOrds : 0;
    const totalVat   = allTimeSales.reduce((s,x) => s + (parseFloat(x.vat||0)||0), 0);
    const obumpCount = allTimeSales.filter(s => s.obselected === 'yes').length;
    const obumpRate  = totalOrds > 0 ? obumpCount / totalOrds * 100 : 0;
    const rebillRev  = exRevSum(allTimeSales.filter(s => s.rebill === 'yes'));
    const directSales = allTimeSales.filter(s => !(s.affiliate||'').trim());
    const affSales    = allTimeSales.filter(s =>  (s.affiliate||'').trim());
    const directRev   = exRevSum(directSales);
    const affRev      = exRevSum(affSales);

    /* Last sale date */
    const sorted = [...allTimeSales].sort((a,b) => Number(b.saletimestamp||0)-Number(a.saletimestamp||0));
    const lastSaleDate = sorted[0]?.saletimedate || '';

    const affiliates         = exBuildAffs(allTimeSales);
    const topProducts        = exBuildProducts(allTimeSales);
    const topCountries       = exBuildCountries(allTimeSales);
    const recentTransactions = exRecentTxns(allTimeSales, 15);

    return {
      success: true,
      raw: {
        /* Core revenue */
        total_revenue:      totalRev,
        today_revenue:      exRevSum(todaySales),
        yesterday_revenue:  exRevSum(yestSales),
        revenue_7_days:     exRevSum(week7Sales),
        /* Order metrics */
        total_orders:       totalOrds,
        avg_order_value:    avgOV,
        refund_rate:        refRate,
        chargeback_rate:    cbRate,
        total_refunds:      refunds,
        total_chargebacks:  cbs,
        total_vat:          totalVat,
        /* Revenue split */
        direct_revenue:     directRev,
        affiliate_revenue:  affRev,
        rebill_revenue:     rebillRev,
        /* Engagement */
        order_bump_rate:    obumpRate,
        order_bump_count:   obumpCount,
        last_sale_date:     lastSaleDate,
        /* Arrays */
        affiliates,
        top_products:       topProducts,
        top_countries:      topCountries,
        recent_transactions: recentTransactions,
      },
      _counts: {
        todayCount: todaySales.length, yestCount: yestSales.length,
        week7Count: week7Sales.length, allTimeCount: allTimeSales.length,
      },
    };
  }

  return { success: false, error: 'Unknown action' };
}

/* ─── JVZOO ──────────────────────────────────────────────────────────────── */
async function jvzoo(username, apiKey, action, offerId) {
  const base = 'https://api.jvzoo.com/v1';
  const auth = 'Basic ' + btoa(`${username}:${apiKey}`);
  const h    = { Authorization: auth, Accept: 'application/json' };
  if (action === 'fetchOffers') {
    const r = await fetch(`${base}/products`, { headers: h });
    if (!r.ok) throw new Error(`JVzoo HTTP ${r.status}`);
    const d = await r.json();
    const arr = d?.products || d?.data || d?.items || d || [];
    return { success: true, offers: Array.isArray(arr)
      ? arr.map(p => ({ id: String(p.id||''), name: String(p.name||p.title||p.id||'') })).filter(o=>o.name)
      : [] };
  }
  if (action === 'fetchStats') {
    const [s, a] = await Promise.allSettled([
      fetch(`${base}/products/${offerId}/statistics`, { headers: h }).then(r=>r.json()),
      fetch(`${base}/products/${offerId}/affiliates?limit=10&sort=revenue&order=desc`, { headers: h }).then(r=>r.json()),
    ]);
    return { success: true, raw: s.status==='fulfilled'?s.value:{}, affRaw: a.status==='fulfilled'?a.value:{} };
  }
  return { success: false, error: 'Unknown action' };
}

/* ─── CLICKBANK ───────────────────────────────────────────────────────────── */
async function clickbank(devKey, clerkKey, action, offerId) {
  const base = 'https://api.clickbank.com/rest/1.3';
  const auth = `${devKey}:${clerkKey}`;
  const h    = { Authorization: auth, Accept: 'application/json' };
  if (action === 'fetchOffers') {
    const r = await fetch(`${base}/products/list`, { headers: h });
    if (!r.ok) throw new Error(`Clickbank HTTP ${r.status}`);
    const d = await r.json();
    const arr = d?.productList || d?.products || d || [];
    return { success: true, offers: Array.isArray(arr)
      ? arr.map(p=>({ id: String(p.site||p.id||''), name: String(p.title||p.site||'') })).filter(o=>o.name)
      : [] };
  }
  if (action === 'fetchStats') {
    const [s, a] = await Promise.allSettled([
      fetch(`${base}/sales/analytics/snapshot?site=${offerId}&unit=DAY`, { headers: h }).then(r=>r.json()),
      fetch(`${base}/affiliates/list?site=${offerId}&limit=10`, { headers: h }).then(r=>r.json()),
    ]);
    return { success: true, raw: s.status==='fulfilled'?s.value:{}, affRaw: a.status==='fulfilled'?a.value:{} };
  }
  return { success: false, error: 'Unknown action' };
}

/* ─── CARTPANDA ───────────────────────────────────────────────────────────── */
async function cartpanda(apiKey, action, offerId) {
  const base = 'https://api.cartpanda.com.br/v1';
  const h    = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  if (action === 'fetchOffers') {
    const r = await fetch(`${base}/products`, { headers: h });
    if (!r.ok) throw new Error(`Cartpanda HTTP ${r.status}`);
    const d = await r.json();
    const arr = d?.products || d?.data || d || [];
    return { success: true, offers: Array.isArray(arr)
      ? arr.map(p=>({ id: String(p.id||''), name: String(p.name||p.title||'') })).filter(o=>o.name)
      : [] };
  }
  if (action === 'fetchStats') {
    const r = await fetch(`${base}/products/${offerId}/stats`, { headers: h });
    if (!r.ok) throw new Error(`Cartpanda HTTP ${r.status}`);
    return { success: true, raw: await r.json() };
  }
  return { success: false, error: 'Unknown action' };
}

/* ─── DIGISTORE24 ─────────────────────────────────────────────────────────── */
async function digistore(apiKey, action, offerId) {
  const base = `https://www.digistore24.com/api/call/${apiKey}`;
  if (action === 'fetchOffers') {
    const r = await fetch(`${base}/listProducts/json`);
    if (!r.ok) throw new Error(`Digistore HTTP ${r.status}`);
    const d = await r.json();
    const arr = d?.data?.products || d?.products || [];
    return { success: true, offers: Array.isArray(arr)
      ? arr.map(p=>({ id: String(p.product_id||p.id||''), name: String(p.name||'') })).filter(o=>o.name)
      : [] };
  }
  if (action === 'fetchStats') {
    const [s, a] = await Promise.allSettled([
      fetch(`${base}/listProductStats/json?product_id=${offerId}`).then(r=>r.json()),
      fetch(`${base}/listTopAffiliates/json?product_id=${offerId}&limit=10`).then(r=>r.json()),
    ]);
    return { success: true, raw: s.status==='fulfilled'?s.value:{}, affRaw: a.status==='fulfilled'?a.value:{} };
  }
  return { success: false, error: 'Unknown action' };
}
