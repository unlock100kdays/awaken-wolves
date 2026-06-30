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
    const { platform, apiKey, apiSecret, username, action, offerId, dateRange } = body;
    if (!platform || !apiKey) return json({ success: false, error: 'Missing platform or apiKey' }, 400);
    let result;
    switch (platform) {
      case 'Explodely': result = await explodely(username, apiKey, action); break;
      case 'JVzoo':     result = await jvzoo(username, apiKey, action, offerId, dateRange); break;
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

/* Parse saletimedate → Unix timestamp (seconds).
   Handles multiple formats the API may return:
     ISO:      "2026-06-29"  or  "2026-06-29T14:30:00"
     IPN docs: "14:30:00 29-JUN-2026"  or  "29-JUN-2026 14:30:00"
   Always prefers saletimestamp (Unix) when present and non-zero. */
function saleTs(s) {
  if (s.saletimestamp) {
    const ts = parseInt(s.saletimestamp);
    if (ts > 0) return ts;
  }
  const raw = (s.saletimedate || '').trim();
  if (!raw) return 0;

  /* ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS */
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return Math.floor(new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3])).getTime() / 1000);
  }

  /* IPN format: "HH:MM:SS DD-MMM-YYYY" or "DD-MMM-YYYY HH:MM:SS" */
  const parts = raw.split(/\s+/);
  /* Pick the part that looks like DD-MMM-YYYY (has two dashes, not all digits) */
  const datePart = parts.find(p => /^[0-3]\d-[A-Za-z]{3}-\d{4}$/.test(p));
  if (datePart) {
    const [d, m, y] = datePart.split('-');
    const monthIdx = MNAMES.indexOf(m.toLowerCase());
    if (monthIdx !== -1) {
      return Math.floor(new Date(Date.UTC(+y, monthIdx, +d)).getTime() / 1000);
    }
  }
  return 0;
}

/* Format a saletimedate value for display — strips time, normalises to DD-MMM-YYYY */
function fmtSaleDate(raw) {
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}-${MNAMES[+iso[2]-1].toUpperCase()}-${iso[1]}`;
  return raw.replace(/^\d\d:\d\d:\d\d /, '').replace(/ \d\d:\d\d:\d\d$/, '');
}

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

  if (!r.ok) {
    const body = text.trim();
    throw new Error(body.length > 10
      ? `Explodely API error (HTTP ${r.status}): ${body.slice(0, 300)}`
      : `Explodely API temporarily blocked (HTTP ${r.status}) — wait 10-15 min and retry`
    );
  }

  let d;
  try { d = JSON.parse(text); }
  catch { throw new Error(`Explodely returned non-JSON (HTTP ${r.status}): ${text.slice(0, 200)}`); }

  if (d?.error === 'invalidapikey')    throw new Error('Invalid API key or username');
  if (d?.error === 'invalid_sellerid') throw new Error('Not a valid Explodely seller account');
  if (d?.error) throw new Error(`Explodely error: ${d.error}`);

  const arr = Array.isArray(d)
    ? d
    : (d?.sales || d?.data || d?.result || d?.transactions || d?.orders
       || Object.values(d).find(v => Array.isArray(v)) || []);

  return Array.isArray(arr) ? arr : [];
}

async function explodely(username, apiKey, action) {
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

  if (action === 'fetchStats') {
    /* Single clean request — 01-jan-2024 to tomorrow.
       No extra params, no pagination, no year splitting — exactly the same
       call structure that was working before. */
    let all = [];
    try {
      all = await explFetch(username, apiKey, '01-jan-2024', tomorrow());
    } catch (e) {
      return { success: false, error: e.message };
    }

    if (all.length === 0) {
      return { success: false, error: 'Explodely returned 0 sales for 2024–today. Check credentials.' };
    }

    const perYearCounts = {};

    /* UTC midnight boundaries for filtering */
    const utcMidnight = (daysBack) => {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      return Math.floor(d.getTime() / 1000) - daysBack * 86400;
    };
    const midToday = utcMidnight(0);
    const midYest  = utcMidnight(1);
    const mid7     = utcMidnight(7);
    const mid30    = utcMidnight(30);

    const filter = (min, max) => all.filter(s => {
      const ts = saleTs(s);
      return ts >= min && (max == null || ts < max);
    });

    const todaySales  = filter(midToday, null);
    const yestSales   = filter(midYest,  midToday);
    const week7Sales  = filter(mid7,     null);
    const week30Sales = filter(mid30,    null);
    /* All-time = everything fetched (up to 2 years) */
    const allSales    = all;

    function rev(arr) {
      return arr.reduce((sum, s) => {
        const amt = parseFloat(s.amount || 0) || 0;
        const t   = String(s.type || '').toLowerCase();
        return (t === 'refund' || t === 'chargeback') ? sum - amt : sum + amt;
      }, 0);
    }
    function salesOnly(arr) { return arr.filter(s => { const t = String(s.type||'').toLowerCase(); return !t||t==='sale'||t==='rebill'||t==='new_sale'; }); }
    function refundsOnly(arr) { return arr.filter(s => String(s.type||'').toLowerCase()==='refund'); }
    function cbOnly(arr) { return arr.filter(s => String(s.type||'').toLowerCase()==='chargeback'); }

    const totalOrds  = salesOnly(allSales).length;
    const totalRefs  = refundsOnly(allSales).length;
    const totalCBs   = cbOnly(allSales).length;
    const totalRev   = rev(allSales);
    const refRate    = totalOrds > 0 ? totalRefs / totalOrds * 100 : 0;
    const cbRate     = totalOrds > 0 ? totalCBs  / totalOrds * 100 : 0;
    const avgOV      = totalOrds > 0 ? totalRev  / totalOrds : 0;
    const totalVat   = allSales.reduce((s, x) => s + (parseFloat(x.vat||0)||0), 0);
    const obumps     = allSales.filter(s => s.obselected === 'yes').length;
    const obumpRate  = totalOrds > 0 ? obumps / totalOrds * 100 : 0;
    const directRev  = rev(allSales.filter(s => !(s.affiliate||'').trim()));
    const affRev     = rev(allSales.filter(s =>  (s.affiliate||'').trim()));
    const rebillRev  = rev(allSales.filter(s => s.rebill === 'yes'));

    /* Last sale (most recent timestamp) */
    const sorted     = [...allSales].sort((a,b) => saleTs(b) - saleTs(a));
    const lastSale   = sorted[0]?.saletimedate || '';

    /* Unique customers */
    const uniqueEmails = new Set(allSales.map(s => (s.customerEmail||'').toLowerCase().trim()).filter(Boolean));
    const uniqueCustomers = uniqueEmails.size;
    const customerLtv = uniqueCustomers > 0 ? totalRev / uniqueCustomers : 0;

    /* Refund & chargeback dollar amounts */
    const refundAmount = refundsOnly(allSales).reduce((s,x) => s + (parseFloat(x.amount||0)||0), 0);
    const cbAmount     = cbOnly(allSales).reduce((s,x) => s + (parseFloat(x.amount||0)||0), 0);
    const netRevenue   = totalRev - totalVat;

    /* Top affiliates */
    const affMap = {};
    allSales.forEach(s => {
      const name = (s.affiliate || '').trim(); if (!name) return;
      const amt  = parseFloat(s.amount||0)||0;
      const t    = String(s.type||'').toLowerCase();
      if (!affMap[name]) affMap[name] = { name, revenue: 0, sales: 0 };
      if (t === 'refund') affMap[name].revenue -= amt;
      else { affMap[name].revenue += amt; affMap[name].sales++; }
    });
    const affiliates = Object.values(affMap)
      .filter(a => a.revenue > 0).sort((a,b) => b.revenue - a.revenue).slice(0,10)
      .map((a,i) => ({ rank:i+1, name:a.name, revenue:a.revenue, sales:a.sales, epc: a.sales?a.revenue/a.sales:0 }));

    /* Top countries */
    const ctryMap = {};
    salesOnly(allSales).forEach(s => {
      const c = (s.country||'Unknown').toUpperCase();
      if (!ctryMap[c]) ctryMap[c] = { code:c, count:0, revenue:0 };
      ctryMap[c].count++; ctryMap[c].revenue += parseFloat(s.amount||0)||0;
    });
    const topCountries = Object.values(ctryMap).sort((a,b)=>b.count-a.count).slice(0,8);

    /* Products / Funnels — net revenue per product with full metrics */
    const prodMap = {};
    allSales.forEach(s => {
      const pid   = s.productId   || '_unknown';
      const pname = s.productName || s.productId || 'Unknown';
      const t     = String(s.type || '').toLowerCase();
      const amt   = parseFloat(s.amount || 0) || 0;
      const ts    = saleTs(s);

      if (!prodMap[pid]) prodMap[pid] = {
        id: pid, name: pname,
        revenue: 0, orders: 0,
        refunds: 0, refundAmount: 0,
        chargebacks: 0, cbAmount: 0,
        today: 0, week7: 0, week30: 0,
      };
      const p = prodMap[pid];

      if (t === 'refund') {
        p.revenue      -= amt;
        p.refunds++;
        p.refundAmount += amt;
      } else if (t === 'chargeback') {
        p.revenue      -= amt;
        p.chargebacks++;
        p.cbAmount     += amt;
      } else {
        p.revenue += amt;
        p.orders++;
        if (ts >= midToday) p.today  += amt;
        if (ts >= mid7)     p.week7  += amt;
        if (ts >= mid30)    p.week30 += amt;
      }
    });
    const topProducts = Object.values(prodMap)
      .filter(p => p.orders > 0)
      .sort((a, b) => b.revenue - a.revenue)
      .map(p => ({
        ...p,
        aov:        p.orders > 0 ? p.revenue / p.orders : 0,
        refundRate: p.orders > 0 ? p.refunds / p.orders * 100 : 0,
        cbRate:     p.orders > 0 ? p.chargebacks / p.orders * 100 : 0,
      }));

    /* Recent 20 transactions */
    const recentTxns = sorted.slice(0,20).map(s => ({
      orderId:   s.orderid      || '—',
      type:      String(s.type  || 'sale').toLowerCase(),
      product:   s.productName  || s.productId || '—',
      customer:  s.customerName || s.customerEmail || '—',
      affiliate: s.affiliate    || '',
      amount:    parseFloat(s.amount||0)||0,
      vat:       parseFloat(s.vat||0)||0,
      country:   (s.country||'').toUpperCase(),
      date:      s.saletimedate || '',
      obump:     s.obselected   === 'yes',
      rebill:    s.rebill       === 'yes',
    }));

    /* Format last sale date neatly */
    const lastSaleFmt = fmtSaleDate(sorted[0]?.saletimedate || '');

    return {
      success: true,
      raw: {
        total_revenue:      totalRev,
        net_revenue:        netRevenue,
        today_revenue:      rev(todaySales),
        yesterday_revenue:  rev(yestSales),
        revenue_7_days:     rev(week7Sales),
        revenue_30_days:    rev(week30Sales),
        total_orders:       totalOrds,
        unique_customers:   uniqueCustomers,
        avg_order_value:    avgOV,
        customer_ltv:       customerLtv,
        refund_rate:        refRate,
        chargeback_rate:    cbRate,
        total_refunds:      totalRefs,
        refund_amount:      refundAmount,
        total_chargebacks:  totalCBs,
        chargeback_amount:  cbAmount,
        total_vat:          totalVat,
        direct_revenue:     directRev,
        affiliate_revenue:  affRev,
        rebill_revenue:     rebillRev,
        order_bump_rate:    obumpRate,
        order_bump_count:   obumps,
        last_sale_date:     lastSaleFmt,
        affiliates,
        top_products:       topProducts,
        top_countries:      topCountries,
        recent_transactions: recentTxns,
      },
      _sample: all[0] || null,
      _counts: { total: all.length, today: todaySales.length, week7: week7Sales.length, perYear: perYearCounts },
    };
  }

  return { success: false, error: 'Unknown action' };
}

/* ─── JVZOO ──────────────────────────────────────────────────────────────── */
/* Auth: Basic — API Key as username, literal "x" as password (per JVZoo docs) */
async function jvzoo(username, apiKey, action, offerId, dateRange = 'thismonth') {
  const h = {
    Authorization: 'Basic ' + btoa(`${apiKey}:x`),
    Accept: 'application/json',
  };

  if (action === 'fetchStats') {
    /* Compute start/end from dateRange param — all UTC */
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
      default: /* thismonth */
        rangeStart  = isoD(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
        rangeEnd    = isoD(tomorrowUTC);
        rangeLabel  = 'This Month';
    }

    /* Single-range paginated fetch — no monthly chunks needed */
    const all  = [];
    const seen = new Set();

    const fetchPage = async (pageIdx) => {
      try {
        const q = new URLSearchParams({ start_date: rangeStart, end_date: rangeEnd, page_index: String(pageIdx) });
        const r = await fetch(`https://api.jvzoo.com/v3.0/transactions?${q}`, { headers: h });
        if (!r.ok) return null;
        const d = await r.json().catch(() => null);
        if (!d) return null;
        const tx      = Array.isArray(d?.results) ? d.results : [];
        const pag     = d?.meta?.pagination ?? {};
        const hasMore = pag.has_more ?? false;
        const total   = d?.meta?.total_count ?? null;
        const pageSize = pag.page_size ?? 50;
        const lastPage = total !== null ? Math.ceil(total / pageSize) - 1 : null;
        return { tx, hasMore, lastPage };
      } catch { return null; }
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
      const MAX   = first.lastPage ?? 500;
      const CONC  = 3;
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
    let gross = 0, sellerGross = 0, refundAmt = 0, cbAmt = 0, totalFees = 0;
    let orders = 0, refunds = 0, cbs = 0;
    let lastSaleTs = 0;
    const emails  = new Set();
    const prodMap = {};
    const affMap  = {};
    const recentTx = [];

    all.sort((a, b) => new Date(b.sale_date||0) - new Date(a.sale_date||0));

    for (const tx of all) {
      const amt       = parseFloat(tx.amount ?? 0) || 0;
      const jvzFee    = parseFloat(tx.payouts?.jvzoo_fee ?? 0) || 0;
      const sellerNet = parseFloat(tx.payouts?.seller_earnings ?? 0) || 0;
      const status    = String(tx.status ?? '').toUpperCase();
      const isRef     = status.includes('REFUND');
      const isCB      = status.includes('CHARG') || status.includes('DISPUT') || status.includes('CGBK');
      const isSale    = !isRef && !isCB;

      let ts = 0;
      if (tx.sale_date) { const d = new Date(tx.sale_date); if (!isNaN(d)) ts = Math.floor(d.getTime() / 1000); }

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
        gross += amt; sellerGross += sellerNet; orders++; totalFees += jvzFee;
        if (ts > lastSaleTs) lastSaleTs = ts;
      } else if (isRef) { refundAmt += amt; refunds++; }
        else if (isCB)  { cbAmt     += amt; cbs++;     }

      if (!prodMap[pid]) prodMap[pid] = { id:pid, name:pname, revenue:0, orders:0, refunds:0, chargebacks:0 };
      const p = prodMap[pid];
      if      (isRef) { p.revenue -= amt; p.refunds++; }
      else if (isCB)  { p.revenue -= amt; p.chargebacks++; }
      else            { p.revenue += amt; p.orders++; }

      if (affId) {
        if (!affMap[affId]) affMap[affId] = { id:affId, name:affName||affId, sales:0, revenue:0 };
        if (isSale) { affMap[affId].sales++; affMap[affId].revenue += amt; }
      }

      if (recentTx.length < 25) {
        recentTx.push({
          date: ts ? new Date(ts*1000).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '',
          type: isRef ? 'refund' : isCB ? 'chargeback' : 'sale',
          amount: amt, product: pname !== pid ? pname : '',
          customer: custName || (email ? email.split('@')[0] : ''),
          country, affiliate: affName || affId || '',
        });
      }
    }

    const netEarnings = gross - refundAmt - cbAmt;
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
        jvz_sales:           orders,
        jvz_earnings:        gross,
        jvz_net_earnings:    netEarnings,
        jvz_asv:             orders > 0 ? gross / orders : 0,
        jvz_aov:             orders > 0 ? gross / orders : 0,
        jvz_refund_pct:      orders > 0 ? refunds / orders * 100 : 0,
        jvz_refund_amt_pct:  gross  > 0 ? refundAmt / gross * 100 : 0,
        jvz_refunds:         refunds,
        jvz_refund_dollars:  refundAmt,
        jvz_disputes:        cbs,
        jvz_disputes_dollars: cbAmt,
        jvz_disputes_pct:    orders > 0 ? cbs / orders * 100 : 0,
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
        avg_order_value:     orders > 0 ? gross / orders : 0,
        refund_rate:         orders > 0 ? refunds / orders * 100 : 0,
        refund_amount:       refundAmt,
        total_refunds:       refunds,
        chargeback_rate:     orders > 0 ? cbs / orders * 100 : 0,
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
