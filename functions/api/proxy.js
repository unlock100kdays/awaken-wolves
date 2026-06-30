/**
 * Cloudflare Pages Function — API Proxy
 * /functions/api/proxy.js → URL: /api/proxy
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
    const { platform, apiKey, apiSecret, username, action, offerId, dateRange, pageOffset, pageLimit } = body;
    if (!platform || !apiKey) return json({ success: false, error: 'Missing platform or apiKey' }, 400);
    let result;
    switch (platform) {
      case 'Explodely': result = await explodely(username, apiKey, action, body.startdate, body.enddate); break;
      case 'JVzoo':     result = await jvzoo(username, apiKey, action, offerId, dateRange, pageOffset, pageLimit); break;
      case 'Clickbank': result = await clickbank(apiKey, apiSecret, action, offerId); break;
      case 'Cartpanda': result = await cartpanda(apiKey, action, offerId); break;
      case 'Digistore': result = await digistore(apiKey, action, offerId); break;
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

/* ─── DATE HELPERS ─────────────────────────────────────────────────────────── */
const MNAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function exDate(d) {
  return `${String(d.getUTCDate()).padStart(2,'0')}-${MNAMES[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
function today()    { return exDate(new Date()); }
function tomorrow() { return exDate(new Date(Date.now() + 86400000)); }
function daysAgo(n) { return exDate(new Date(Date.now() - n * 86400000)); }


/* ─── EXPLODELY ──────────────────────────────────────────────────────────────
   Real endpoint: https://api.explodely.com/v1/sale
   Auth:          ?username=X&apikey=Y  (NOT headers)
   Action GET:    apiaction=getsalebyget
   Date format:   DD-mmm-YYYY  e.g. 30-jun-2026

   IPN fields (same shape returned by Sales API):
     orderid, type, productId, productName, customerName, customerEmail,
     customerPhone, affiliate, amount, vat, saletimedate, saletimestamp,
     zipcode, country, billdesc, obselected, ipadd, rebill, mainorderid
──────────────────────────────────────────────────────────────────────────── */
/* Single range fetch — NO page param (Explodely returns 500 on unknown params) */
async function explFetch(username, apiKey, startdate, enddate) {
  const q = new URLSearchParams({
    username, apikey: apiKey, apiaction: 'getsalebyget', startdate, enddate,
  });
  const r = await fetch(`https://api.explodely.com/v1/sale?${q}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'CloudflareWorker/1.0' },
  });
  const text = await r.text();

  if (text.trimStart().startsWith('<')) throw new Error('BOT_BLOCKED — Explodely is behind bot protection');

  let d;
  try { d = JSON.parse(text); } catch { d = null; }

  if (d?.error === 'invalidapikey')    throw new Error('Invalid API key or username');
  if (d?.error === 'invalid_sellerid') throw new Error('Not a valid Explodely seller account');
  if (d?.error) throw new Error(`Explodely error: ${d.error}`);

  if (!r.ok) {
    const body = text.trim();
    throw new Error(body.length > 10
      ? `Explodely API error (HTTP ${r.status}): ${body.slice(0, 300)}`
      : `Explodely API temporarily blocked (HTTP ${r.status}) — wait 10-15 min and retry`
    );
  }

  if (!d) throw new Error(`Explodely returned non-JSON (HTTP ${r.status}): ${text.slice(0, 200)}`);

  const arr = Array.isArray(d)
    ? d
    : (d?.sales || d?.data || d?.result || d?.transactions || d?.orders
       || Object.values(d).find(v => Array.isArray(v)) || []);

  return Array.isArray(arr) ? arr : [];
}

async function explodely(username, apiKey, action, startdate, enddate) {
  /* fetchOffers — Explodely has no product listing endpoint.
     Just verify auth then let the frontend prompt for a name. */
  if (action === 'fetchOffers') {
    try {
      await explFetch(username, apiKey, today(), today());
    } catch (e) {
      if (!e.message.startsWith('BOT_BLOCKED')) throw e;
      /* Bot blocked even cred check — still save, surface on fetchStats */
    }
    return { success: true, offers: [], note: "Credentials saved — enter your offer name to pull sales data" };
  }

  /* fetchExplChunk — single date-range window. The frontend loops this across
     ~60-day windows and aggregates client-side (apiFetchExplodelyStats in
     vsl.html). A single multi-year request times out Explodely's own backend
     (confirmed: >90 days reliably fails, <90 days reliably succeeds), and
     looping all windows server-side exceeds Cloudflare's own per-invocation
     execution limit (~60s) — same constraint that forced JVZoo's chunking. */
  if (action === 'fetchExplChunk') {
    try {
      const sales = await explFetch(username, apiKey, startdate, enddate);
      return { success: true, sales };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  return { success: false, error: 'Unknown action' };
}

/* ─── JVZOO ──────────────────────────────────────────────────────────────── */
/* Auth: Basic — API Key as username, literal "x" as password (per JVZoo docs) */

/* Compute start/end from dateRange param — all UTC */
function jvzooComputeRange(dateRange) {
  const now         = new Date();
  const isoD        = d => d.toISOString().slice(0, 10);
  const todayUTC    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrowUTC = new Date(todayUTC.getTime() + 86400000);

  let rangeStart, rangeEnd, rangeLabel;
  switch (dateRange) {
    case 'today':
      rangeStart  = isoD(todayUTC);
      rangeEnd    = isoD(tomorrowUTC);
      rangeLabel  = 'Today';
      break;
    case 'yesterday':
      rangeStart  = isoD(new Date(todayUTC.getTime() - 86400000));
      rangeEnd    = isoD(todayUTC);
      rangeLabel  = 'Yesterday';
      break;
    case 'last7':
      rangeStart  = isoD(new Date(todayUTC.getTime() - 6 * 86400000));
      rangeEnd    = isoD(tomorrowUTC);
      rangeLabel  = 'Last 7 Days';
      break;
    case 'lastmonth': {
      const lmS   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const lmE   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      rangeStart  = isoD(lmS);
      rangeEnd    = isoD(lmE);
      rangeLabel  = 'Last Month';
      break;
    }
    case 'alltime':
      rangeStart  = '2015-01-01';
      rangeEnd    = isoD(tomorrowUTC);
      rangeLabel  = 'All Time';
      break;
    default: /* thismonth */
      rangeStart  = isoD(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
      rangeEnd    = isoD(tomorrowUTC);
      rangeLabel  = 'This Month';
  }
  return { rangeStart, rangeEnd, rangeLabel };
}

async function jvzoo(username, apiKey, action, offerId, dateRange = 'thismonth', pageOffset = 0, pageLimit = 15) {
  const h = {
    Authorization: 'Basic ' + btoa(`${apiKey}:x`),
    Accept: 'application/json',
  };

  /* Chunked raw-transaction fetch — bounded to stay under Cloudflare's per-request
     subrequest cap. The frontend calls this repeatedly with increasing pageOffset
     and aggregates the accumulated transactions client-side. This is required
     because large ranges (e.g. "Last Month" = 130+ pages) cannot be fetched in a
     single Worker invocation. */
  if (action === 'fetchTxChunk') {
    const { rangeStart, rangeEnd, rangeLabel } = jvzooComputeRange(dateRange);
    pageOffset = Math.max(0, Number(pageOffset) || 0);
    pageLimit  = Math.min(Math.max(1, Number(pageLimit) || 15), 20);

    const all  = [];
    const seen = new Set();

    const fetchPage = async (pageIdx, retries = 2) => {
      try {
        const q = new URLSearchParams({ start_date: rangeStart, end_date: rangeEnd, page_index: String(pageIdx) });
        const r = await fetch(`https://api.jvzoo.com/v3.0/transactions?${q}`, { headers: h });
        if (!r.ok) {
          if (retries > 0) { await new Promise(res => setTimeout(res, 400)); return fetchPage(pageIdx, retries - 1); }
          return null;
        }
        const d = await r.json().catch(() => null);
        if (!d) return null;
        const tx       = Array.isArray(d?.results) ? d.results : [];
        const pag      = d?.meta?.pagination ?? {};
        const hasMore  = pag.has_more ?? false;
        const total    = d?.meta?.total_count ?? null;
        const pageSize = pag.page_size ?? 50;
        const lastPage = total !== null ? Math.ceil(total / pageSize) - 1 : null;
        return { tx, hasMore, lastPage, total };
      } catch (e) {
        if (retries > 0) { await new Promise(res => setTimeout(res, 400)); return fetchPage(pageIdx, retries - 1); }
        return null;
      }
    };

    const addTx = (txList) => {
      for (const t of txList) {
        const key = String(t.transaction_id ?? `${t.sale_date}|${t.amount}`);
        if (!seen.has(key)) { seen.add(key); all.push(t); }
      }
    };

    const first = await fetchPage(pageOffset);
    let lastPage = null, totalCount = null;
    if (first) { addTx(first.tx); lastPage = first.lastPage; totalCount = first.total; }

    const endPage = lastPage !== null ? Math.min(pageOffset + pageLimit - 1, lastPage) : pageOffset;

    if (first?.hasMore && endPage > pageOffset) {
      const CONC = 3;
      for (let p = pageOffset + 1; p <= endPage; p += CONC) {
        const batch = [];
        for (let pp = p; pp <= Math.min(p + CONC - 1, endPage); pp++) batch.push(pp);
        const results = await Promise.allSettled(batch.map(pp => fetchPage(pp)));
        for (const res of results) {
          const v = res.status === 'fulfilled' ? res.value : null;
          if (v) addTx(v.tx);
        }
      }
    }

    const nextOffset = (lastPage !== null && endPage < lastPage) ? endPage + 1 : null;

    return {
      success: true,
      transactions: all,
      meta: {
        total_count: totalCount,
        last_page:   lastPage,
        next_offset: nextOffset,
        range_start: rangeStart,
        range_end:   rangeEnd,
        range_label: rangeLabel,
      },
    };
  }

  if (action === 'fetchStats') {
    const { rangeStart, rangeEnd, rangeLabel } = jvzooComputeRange(dateRange);

    /* Single-range paginated fetch — used only as a fallback / small ranges */
    const all  = [];
    const seen = new Set();

    const fetchPage = async (pageIdx, retries = 2) => {
      try {
        const q = new URLSearchParams({ start_date: rangeStart, end_date: rangeEnd, page_index: String(pageIdx) });
        const r = await fetch(`https://api.jvzoo.com/v3.0/transactions?${q}`, { headers: h });
        if (!r.ok) {
          if (retries > 0) { await new Promise(res => setTimeout(res, 500)); return fetchPage(pageIdx, retries - 1); }
          return null;
        }
        const d = await r.json().catch(() => null);
        if (!d) return null;
        const tx      = Array.isArray(d?.results) ? d.results : [];
        const pag     = d?.meta?.pagination ?? {};
        const hasMore = pag.has_more ?? false;
        const total   = d?.meta?.total_count ?? null;
        const pageSize = pag.page_size ?? 50;
        const lastPage = total !== null ? Math.ceil(total / pageSize) - 1 : null;
        return { tx, hasMore, lastPage };
      } catch (e) {
        if (retries > 0) { await new Promise(res => setTimeout(res, 500)); return fetchPage(pageIdx, retries - 1); }
        return null;
      }
    };

    const addTx = (txList) => {
      for (const t of txList) {
        const key = String(t.transaction_id ?? `${t.sale_date}|${t.amount}`);
        if (!seen.has(key)) { seen.add(key); all.push(t); }
      }
    };

    const first = await fetchPage(0);
    if (first) addTx(first.tx);

    if (first?.hasMore) {
      const MAX   = Math.min(first.lastPage ?? 45, 45); /* stay under subrequest cap */
      const CONC  = 2;
      for (let p = 1; p <= MAX; p += CONC) {
        const batch = [];
        for (let pp = p; pp <= Math.min(p + CONC - 1, MAX); pp++) batch.push(pp);
        const results = await Promise.allSettled(batch.map(pp => fetchPage(pp)));
        let hitEmpty = false;
        for (const res of results) {
          const v = res.status === 'fulfilled' ? res.value : null;
          if (!v || v.tx.length === 0) { hitEmpty = true; continue; }
          addTx(v.tx);
        }
        if (hitEmpty && first.lastPage === null) break;
      }
    }

    /* ── Aggregate stats ── */
    /* netKept = sum of COMPLETED amounts (= JVZoo "Net Earnings")
       refundAmt/cbAmt = only count if original sale was in this period (filter by sale_date)
       gross (JVZoo "Earnings") = netKept + in-period refundAmt + in-period cbAmt */
    let netKept = 0, sellerGross = 0, refundAmt = 0, cbAmt = 0, totalFees = 0;
    let orders = 0, refunds = 0, cbs = 0;
    let lastSaleTs = 0;
    const emails  = new Set();
    const prodMap = {};
    const affMap  = {};
    const recentTx = [];

    const rangeSt = new Date(rangeStart);
    const rangeEn = new Date(rangeEnd);

    all.sort((a, b) => new Date(b.sale_date||0) - new Date(a.sale_date||0));

    for (const tx of all) {
      const amt       = parseFloat(tx.amount ?? 0) || 0;
      const jvzFee    = parseFloat(tx.payouts?.jvzoo_fee ?? 0) || 0;
      const sellerNet = parseFloat(tx.payouts?.seller_earnings ?? 0) || 0;
      const status    = String(tx.status ?? '').toUpperCase();
      const isRef     = status.includes('REFUND');
      const isCB      = status.includes('CHARG') || status.includes('DISPUT') || status.includes('CGBK');
      const isSale    = !isRef && !isCB;

      /* For REFUNDED/CB: only count it if BOTH the original sale_date and the
         refund_date fall inside the queried period. JVZoo's Report Center figure
         appears to require both — sale-only matching overcounts by ~50% because it
         pulls in refunds of this-period sales that were actually processed (and
         thus reported) in a later period. */
      let txDate = null;
      if (tx.sale_date) { const d = new Date(tx.sale_date); if (!isNaN(d)) txDate = d; }
      let refDate = null;
      if (tx.refund?.refund_date) { const d = new Date(tx.refund.refund_date); if (!isNaN(d)) refDate = d; }
      const saleInPeriod = !txDate || (txDate >= rangeSt && txDate < rangeEn);
      const refundInPeriod = !refDate || (refDate >= rangeSt && refDate < rangeEn);
      const inPeriod = saleInPeriod && refundInPeriod;

      let ts = txDate ? Math.floor(txDate.getTime() / 1000) : 0;

      const cust    = tx.customer ?? {};
      const email   = (cust.email ?? '').toLowerCase();
      const custName = [cust.first_name, cust.last_name].filter(Boolean).join(' ');
      const country  = cust.country ?? '';
      const pid      = String(tx.product_id ?? '_unk');
      const pname    = tx.product_name ?? pid;
      const aff      = tx.affiliate ?? {};
      const affId    = String(aff.id ?? '');
      const affName  = aff.display_name ?? '';

      if (email) emails.add(email);

      if (isSale) {
        netKept += amt; sellerGross += sellerNet; orders++; totalFees += jvzFee;
        if (ts > lastSaleTs) lastSaleTs = ts;
      } else if (isRef && inPeriod) { refundAmt += amt; refunds++; }
        else if (isCB  && inPeriod) { cbAmt     += amt; cbs++;     }

      if (!prodMap[pid]) prodMap[pid] = { id:pid, name:pname, revenue:0, orders:0, refunds:0, chargebacks:0 };
      const p = prodMap[pid];
      if      (isRef && inPeriod) { p.revenue -= amt; p.refunds++; }
      else if (isCB  && inPeriod) { p.revenue -= amt; p.chargebacks++; }
      else if (isSale)            { p.revenue += amt; p.orders++; }

      if (affId) {
        if (!affMap[affId]) affMap[affId] = { id:affId, name:affName||affId, sales:0, revenue:0 };
        if (isSale) { affMap[affId].sales++; affMap[affId].revenue += amt; }
      }

      if (recentTx.length < 25 && (isSale || inPeriod)) {
        recentTx.push({
          date: ts ? new Date(ts*1000).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '',
          type: isRef ? 'refund' : isCB ? 'chargeback' : 'sale',
          amount: amt, product: pname !== pid ? pname : '',
          customer: custName || (email ? email.split('@')[0] : ''),
          country, affiliate: affName || affId || '',
        });
      }
    }

    /* JVZoo "Earnings" = gross including refunded/disputed amounts (money that came in)
       JVZoo "Net Earnings" = what the seller kept = COMPLETED amounts only = netKept */
    const gross       = netKept + refundAmt + cbAmt;
    const netEarnings = netKept;
    const totalSales  = orders + refunds + cbs; /* JVZoo "Sales" = all in-period transactions */

    const prods = Object.values(prodMap)
      .sort((a, b) => b.revenue - a.revenue)
      .map(p => ({ ...p,
        aov:        p.orders > 0 ? p.revenue / p.orders : 0,
        refundRate: p.orders > 0 ? p.refunds / p.orders * 100 : 0,
        cbRate:     p.orders > 0 ? p.chargebacks / p.orders * 100 : 0,
      }));
    const affs = Object.values(affMap)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 20).map((a, i) => ({ ...a, rank: i + 1 }));

    const lastSaleDate = lastSaleTs
      ? new Date(lastSaleTs * 1000).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}).toUpperCase()
      : '';

    return {
      success: true,
      raw: {
        /* JVZoo report columns (matches their Report Center table) */
        jvz_sales:           totalSales,
        jvz_earnings:        gross,
        jvz_net_earnings:    netEarnings,
        jvz_asv:             totalSales > 0 ? gross / totalSales : 0,
        jvz_aov:             orders > 0 ? netKept / orders : 0,
        jvz_refund_pct:      totalSales > 0 ? refunds / totalSales * 100 : 0,
        jvz_refund_amt_pct:  gross  > 0 ? refundAmt / gross * 100 : 0,
        jvz_refunds:         refunds,
        jvz_refund_dollars:  refundAmt,
        jvz_disputes:        cbs,
        jvz_disputes_dollars: cbAmt,
        jvz_disputes_pct:    totalSales > 0 ? cbs / totalSales * 100 : 0,
        /* Context */
        date_range:          dateRange,
        range_label:         rangeLabel,
        range_start:         rangeStart,
        range_end:           rangeEnd,
        /* Compat fields for STAT_SPEC tiles */
        total_revenue:       gross,
        net_revenue:         netEarnings,
        total_orders:        orders,
        unique_customers:    emails.size,
        avg_order_value:     orders > 0 ? netKept / orders : 0,
        refund_rate:         totalSales > 0 ? refunds / totalSales * 100 : 0,
        refund_amount:       refundAmt,
        total_refunds:       refunds,
        chargeback_rate:     totalSales > 0 ? cbs / totalSales * 100 : 0,
        chargeback_amount:   cbAmt,
        total_chargebacks:   cbs,
        total_platform_fees: totalFees || undefined,
        seller_net_revenue:  sellerGross || undefined,
        last_sale_date:      lastSaleDate,
        top_products:        prods,
        affiliates:          affs,
        recent_transactions: recentTx,
      },
      _counts: { total: all.length },
    };
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
    return { success: true, offers: Array.isArray(arr) ? arr.map(p=>({id:String(p.site||p.id||''),name:String(p.title||p.site||'')})).filter(o=>o.name) : [] };
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
    return { success: true, offers: Array.isArray(arr) ? arr.map(p=>({id:String(p.id||''),name:String(p.name||p.title||'')})).filter(o=>o.name) : [] };
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
    return { success: true, offers: Array.isArray(arr) ? arr.map(p=>({id:String(p.product_id||p.id||''),name:String(p.name||'')})).filter(o=>o.name) : [] };
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
