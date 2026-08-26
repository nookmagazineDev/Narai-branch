import { fetchSheet, USAGE_API_BASE, fetchUpstream } from '../lib/upstream.js';
// มูลค่าสต๊อกคงเหลือรายเดือน
//   - ยอดนับ + ยอดปิดรอบสิ้นเดือน: อ่านจาก SQL Server (InventoryNarai) ผ่าน office-server
//   - ราคากลาง (ชีท "8.2") และรายจ่าย Supplier (ชีท "ต้นทุนจากsup"): ยังเป็นชีทที่คนกรอกเอง
//   GET /api/stockcount?branch=<code>&end=<YYYY-MM-DD>
//   -> { status, branch, current:{countDate,total,data}, previous:{countDate,total,data}, supCost }
//   current  = ยอดนับล่าสุด "ภายในเดือนของ end" (และ <= end) — ถ้าเดือนนั้นยังไม่มีการนับ = ว่าง (มูลค่า 0)
//   previous = ยอดปิดรอบสิ้นเดือนที่บันทึกไว้อย่างเป็นทางการของเดือนก่อนหน้า
//     ถ้าเดือนนั้นยังไม่มีใครกดปิดยอดเลย fallback ไปใช้ยอดนับสต๊อกล่าสุดในเดือนนั้นแทน
//     กันหน้า dashboard โชว์ 0 เปล่าๆ ระหว่างรอทีมงานกดปิดยอด (ปกติบันทึกกันภายในต้นเดือนถัดไป ไม่เกินวันที่ 5)

const SHEET_ID = '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ';
const PRICE_SHEET = '8.2';     // ชีทราคากลาง [0]รหัส [1]ชื่อ [2]ราคา
// ชีทรายจ่ายจาก Supplier (คนละสเปรดชีต) — [0]วันที่ [1]สาขา [2]รหัส [3]ชื่อ [4]หน่วย [5]จำนวน [6]ราคา/หน่วย [7]มูลค่ารวม
const SUP_SHEET_ID = '1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw';
const SUP_SHEET = 'ต้นทุนจากsup';

/**
 * เรียก action ของหน้านับสต๊อกที่ office-server (ตัวเดียวกับที่ /api/schedule ใช้)
 *
 * ข้อมูลสต๊อกอยู่บน SQL Server ที่ออฟฟิศ ซึ่ง Vercel ต่อตรงไม่ได้ (ไฟร์วอลล์เปิดพอร์ตให้เฉพาะ
 * IP ในไทย) จึงต้องเดินผ่าน office-server เหมือนหน้าตารางงาน
 *
 * _user ที่ส่งไปเป็นตัวแทนของ endpoint นี้เอง ตั้งสาขาเป็น all เพราะ endpoint นี้รับสาขามาทาง
 * query อยู่แล้ว และไม่เคยมีการตรวจสิทธิ์มาก่อนตั้งแต่ยังอ่านจากชีท
 */
async function callOffice(action, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.USAGE_API_TOKEN) headers['x-api-token'] = process.env.USAGE_API_TOKEN;
  const r = await fetchUpstream(`${USAGE_API_BASE}/schedule`, {
    method: 'POST',
    headers,
    timeoutMs: 12000,
    retries: 1,
    deadlineMs: 26000,
    body: JSON.stringify({ action, ...payload, _user: { username: 'stockcount-api', branch: 'all' } }),
  });
  const body = await r.json().catch(() => null);
  if (!body) throw new Error(`เซิร์ฟเวอร์ที่ออฟฟิศตอบกลับมาไม่ใช่ JSON (HTTP ${r.status})`);
  if (body.status !== 'success') throw new Error(body.message || `HTTP ${r.status}`);
  return body.data;
}

// normalize รหัส: ตัด .0 ท้าย + เลข 0 นำหน้า ให้ตรงกันทุกชีท
const normCode = (c) => String(c == null ? '' : c).replace(/\.0+$/, '').replace(/^0+/, '').trim();

// normalize เซลล์วันที่ให้เป็น "YYYY-MM-DD" — รองรับทั้ง Date(...), "YYYY-MM-DD", "DD/MM/YYYY"
function cellYmd(c) {
  if (!c) return '';
  const v = c.v;
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/Date\((\d+),(\d+),(\d+)/);
  if (m) return `${m[1]}-${String(+m[2] + 1).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // เผื่อกรณี gviz คืน type date แต่ v ว่าง ใช้ค่า formatted (f) เช่น "09/07/2026"
  const f = String(c.f == null ? '' : c.f).trim();
  m = f.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s.slice(0, 10);
}
// "2026-06" -> "2026-05"
function prevMonth(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  const py = m > 1 ? y : y - 1;
  const pm = m > 1 ? m - 1 : 12;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

// วันที่ 1-5 ของเดือนไหน ถือว่าเป็นยอดปิดของ "เดือนก่อนหน้า" เสมอ (พนักงานมักปิดยอดช้าไม่กี่วัน
// แล้วใช้วันที่ปัจจุบันตอนบันทึกแทนที่จะย้อนวันที่กลับไปเป็นวันสิ้นเดือนจริง) — ไม่มีใครปิดยอด "เดือนนี้" ตั้งแต่วันที่ 1-5 ได้จริงอยู่แล้ว
function closingMonthOf(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  if (d >= 1 && d <= 5) {
    const py = m > 1 ? y : y - 1;
    const pm = m > 1 ? m - 1 : 12;
    return `${py}-${String(pm).padStart(2, '0')}`;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// ยอดปิดรอบสิ้นเดือนอย่างเป็นทางการของสาขา+เดือนเป้าหมาย จากชีท "ปิดรอบสิ้นเดือน"
// รหัสสินค้าซ้ำกันหลายแถว (บันทึกซ้ำ/แก้ไข) เอา "แถวหลังสุด" ใน sheet order เป็นค่าล่าสุดเสมอ (append-only log)
/**
 * ยอดปิดรอบของ "เดือนเป้าหมาย" จากแถวที่ office-server ส่งมา (dbo.stock_month_end)
 * แถวหลังสุดของสินค้าเดียวกันชนะ เพราะ office-server เรียงตามลำดับที่บันทึกมาให้แล้ว
 */
function closingMonthValue(rows, targetMonth) {
  const map = {}; // code -> { itemCode, itemName, unit, qty, unitPrice, value, priced }
  let latestDate = '';
  for (const r of rows || []) {
    const ds = String(r.date || '');
    if (!ds || closingMonthOf(ds) !== targetMonth) continue;
    const code = normCode(r.code || r.productId);
    if (!code) continue;
    const qty = Number(r.qty) || 0;
    const unitPrice = Number(r.unitPrice) || 0;
    const value = r.amount != null ? Number(r.amount) : qty * unitPrice;
    map[code] = {
      itemCode: code, itemName: String(r.name || '-').trim() || '-',
      unit: r.unit || '', qty, unitPrice, value, priced: true, date: ds,
    };
    if (ds > latestDate) latestDate = ds;
  }
  const data = Object.values(map).sort((a, b) => b.value - a.value);
  const total = data.reduce((sum, it) => sum + it.value, 0);
  return { countDate: latestDate, total, data };
}

async function fetchGviz(url) {
  const r = await fetchSheet(url);
  const text = await r.text();
  if (text.startsWith('<')) throw new Error('อ่านชีทไม่ได้ (ต้องตั้งแชร์ "ใครมีลิงก์ก็ดูได้")');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  return JSON.parse(text.substring(a, b + 1));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // โหมดราคาอย่างเดียว (?prices=1) — ใช้ในหน้ากรอกรายจ่าย: คืน code -> {name, price} จากชีท 8.2
  // (รวมไว้ใน endpoint นี้เพราะ Vercel Hobby จำกัด serverless functions ที่ 12 ตัว)
  if (req.query.prices) {
    try {
      const r = await fetchSheet(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(PRICE_SHEET)}`);
      const text = await r.text();
      if (text.startsWith('<')) return res.status(502).json({ status: 'error', message: 'อ่านชีท 8.2 ไม่ได้' });
      const a = text.indexOf('{'), b = text.lastIndexOf('}');
      const j = JSON.parse(text.substring(a, b + 1));
      const data = {};
      for (const rw of (j.table.rows || [])) {
        const c = rw.c || [];
        const code = normCode(c[0] && c[0].v);
        if (!code) continue;
        const price = Number(c[2] && c[2].v);
        const name = c[1] && c[1].v != null ? String(c[1].v).trim() : '';
        if (!Number.isNaN(price)) data[code] = { name, price };
      }
      return res.status(200).json({ status: 'success', data });
    } catch (error) {
      return res.status(500).json({ status: 'error', message: error.message });
    }
  }

  // โหมด "ค่าตั้งเบิก" (?avgperhead=1&branch=xxx) — อ่านจาก SQL (dbo.stock_avg_per_head)
  // ใช้คำนวณยอดเบิกอัตโนมัติในหน้านับสต๊อก คืนสามก้อน
  //   data  = { code: ค่าเฉลี่ยต่อหัว }   (รูปแบบเดิม)
  //   modes = { code: 'par' }            สินค้าที่คิดแบบเติมเต็มสตอค (ไม่มีในนี้ = คิดแบบค่าเฉลี่ย)
  //   par   = { code: ค่าเติมเต็มสตอค }
  // ย้ายจากชีทมาที่ SQL พร้อมกับปุ่มแก้ค่าในหน้านับสต๊อก (saveAvgPerHead) — ต้องอ่านที่เดียวกับที่เขียน
  if (req.query.avgperhead) {
    const brA = String(req.query.branch || '').toLowerCase().trim();
    if (!brA) return res.status(400).json({ status: 'error', message: 'ระบุสาขา' });
    try {
      const d = await callOffice('getAvgPerHead', { branch: brA });
      return res.status(200).json({
        status: 'success', branch: brA, count: d?.count ?? 0,
        data: d?.data || {}, modes: d?.modes || {}, par: d?.par || {},
      });
    } catch (error) {
      return res.status(502).json({ status: 'error', message: error.message });
    }
  }

  // โหมด "เปอร์เซ็นต์การเบิกของแต่ละสาขา" (?getpercentages=1&branch=xxx) — อ่านจาก SQL (dbo.stock_branch_percent)
  // ย้ายมาพร้อมกับ saveBranchPercentagesBulk ด้วยเหตุผลเดียวกับค่าเฉลี่ยต่อหัว
  if (req.query.getpercentages) {
    const brA = String(req.query.branch || '').toLowerCase().trim();
    if (!brA) return res.status(400).json({ status: 'error', message: 'ระบุสาขา' });
    try {
      const d = await callOffice('getBranchPercent', { branch: brA });
      return res.status(200).json({ status: 'success', branch: brA, data: d?.data || [] });
    } catch (error) {
      return res.status(502).json({ status: 'error', message: error.message });
    }
  }

  // โหมด "ยอดยกมาเดือนที่แล้ว" (?closingprev=1&branch=xxx[&end=YYYY-MM-DD]) — ใช้ในหน้านับสต๊อก
  // ยอดปิดรอบสิ้นเดือนของ "เดือนก่อนหน้า" (ยอดปิดบัญชีจริง ไม่ใช่ยอดนับที่บังเอิญนับไว้)
  // อ่านจาก SQL (dbo.stock_month_end) ผ่าน office-server — ย้ายมาพร้อมหน้าปิดยอดสิ้นเดือน
  if (req.query.closingprev) {
    const brC = String(req.query.branch || '').toLowerCase().trim();
    if (!brC) return res.status(400).json({ status: 'error', message: 'ระบุสาขา' });
    try {
      const endC = String(req.query.end || '').slice(0, 10);
      const targetMonth = prevMonth((endC || new Date().toISOString().slice(0, 10)).slice(0, 7));
      // ไม่กรองเดือนที่ฝั่ง SQL เพราะกติกา "วันที่ 1-5 นับเป็นยอดปิดของเดือนก่อน" ต้องดูวันที่ทีละแถว
      const rows = await callOffice('getMonthEndRows', { branch: brC });
      const { data: picked } = closingMonthValue(rows, targetMonth);
      const data = {};
      for (const it of picked) data[it.itemCode] = { qty: it.qty, unitPrice: it.unitPrice, value: it.value, date: it.date };
      return res.status(200).json({ status: 'success', branch: brC, month: targetMonth, count: picked.length, data });
    } catch (error) {
      return res.status(502).json({ status: 'error', message: error.message });
    }
  }

  // โหมด "ยอดรับจากรายจ่าย Supplier" (?supreceived=1&branch=&start=&end=)
  // คืนรูปแบบเดียวกับ /api/orderd -> { code: {total, details:{date:qty}, unit} } เพื่อ merge เป็น "ยอดรับ" ในหน้านับสต๊อก
  if (req.query.supreceived) {
    const brK = String(req.query.branch || '').toLowerCase().trim();
    const st = String(req.query.start || '0000-01-01');
    const en = String(req.query.end || '9999-12-31');
    if (!brK) return res.status(400).json({ status: 'error', message: 'ระบุสาขา' });
    try {
      const r = await fetchSheet(`https://docs.google.com/spreadsheets/d/${SUP_SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(SUP_SHEET)}`);
      const text = await r.text();
      if (text.startsWith('<')) return res.status(200).json({ status: 'success', data: {} });
      const a = text.indexOf('{'), b = text.lastIndexOf('}');
      const j = JSON.parse(text.substring(a, b + 1));
      const map = {};
      for (const rw of (j.table.rows || [])) {
        const c = rw.c || [];
        if (String((c[1] && c[1].v) || '').toLowerCase().trim() !== brK) continue; // [1]สาขา
        const ds = cellYmd(c[0]); // [0]วันที่
        if (!ds || ds < st || ds > en) continue;
        const code = normCode(c[2] && c[2].v); // [2]รหัส
        if (!code) continue;
        const qty = Number(c[5] && c[5].v) || 0; // [5]จำนวน
        const e = map[code] || (map[code] = { total: 0, details: {}, unit: (c[4] && c[4].v) || '' });
        e.total += qty;
        e.details[ds] = (e.details[ds] || 0) + qty;
      }
      for (const k of Object.keys(map)) {
        map[k].total = Number(map[k].total.toFixed(2));
        for (const d of Object.keys(map[k].details)) map[k].details[d] = Number(map[k].details[d].toFixed(2));
      }
      return res.status(200).json({ status: 'success', data: map });
    } catch (error) {
      return res.status(500).json({ status: 'error', message: error.message });
    }
  }

  const branchKey = String(req.query.branch || '').toLowerCase().trim();
  const endStr = String(req.query.end || '9999-12-31');
  const startStr = String(req.query.start || ''); // ช่วงเริ่มของรายจ่าย Supplier (P&L); ว่าง = ไม่จำกัดล่าง
  if (!branchKey) return res.status(400).json({ status: 'error', message: 'ระบุสาขาไม่ครบถ้วน' });

  const curMonth = endStr.slice(0, 7);
  const preMonth = prevMonth(curMonth);
  const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;
  const supBase = `https://docs.google.com/spreadsheets/d/${SUP_SHEET_ID}/gviz/tq?tqx=out:json`;

  try {
    // ยอดนับกับยอดปิดรอบมาจาก SQL (ผ่าน office-server) ส่วนราคากลางกับรายจ่าย Supplier
    // ยังเป็นชีทที่คนกรอกเอง จึงยังอ่านจากชีทเหมือนเดิม
    const [stockRows, priceJ, supJ, closingRows] = await Promise.all([
      // ดึงเฉพาะช่วงที่ใช้จริง: ตั้งแต่ต้นเดือนก่อนหน้า ถึงวันที่เลือก
      callOffice('getStockCountRows', {
        branch: branchKey,
        from: `${preMonth}-01`,
        to: /^\d{4}-\d{2}-\d{2}$/.test(endStr) ? endStr : null,
      }),
      fetchGviz(`${base}&sheet=${encodeURIComponent(PRICE_SHEET)}`),
      // ชีทรายจ่ายจาก Supplier "ต้นทุนจากsup" (คนละไฟล์) — ไม่มี/อ่านไม่ได้ก็คิดเป็น 0
      fetchGviz(`${supBase}&sheet=${encodeURIComponent(SUP_SHEET)}`).catch(() => null),
      // ยอดปิดรอบสิ้นเดือน — ใช้เป็นแหล่งหลักของ "เดือนที่แล้ว" ไม่มีข้อมูลก็ถอยไปใช้ยอดนับแทน
      callOffice('getMonthEndRows', { branch: branchKey }).catch(() => []),
    ]);

    // ราคากลางจากชีท 8.2: รหัส -> ราคา/หน่วย
    const priceMap = {};
    for (const rw of (priceJ.table.rows || [])) {
      const c = rw.c || [];
      const code = normCode(c[0] && c[0].v);
      if (!code) continue;
      const price = Number(c[2] && c[2].v);
      if (!Number.isNaN(price)) priceMap[code] = price;
    }

    // แถวการนับของสาขานี้ — office-server กรองสาขาและเรียงตามเวลาที่นับมาให้แล้ว
    const brRows = (stockRows || []).filter((r) => r.date);

    // รวมทุกวันนับในเดือนนั้น แล้ว "แต่ละสินค้าเอายอดจากวันล่าสุดที่นับ" (ตัดซ้ำ)
    // กรณีนับ 1 เดือนกระจายหลายวัน (เช่น 3 ก.ค. แล้วนับเพิ่ม/แก้ 4 ก.ค.) จะได้ครบทุกสินค้า ไม่ตกหล่น
    const pick = (monthPrefix, maxDate) => {
      const inMonth = brRows.filter((r) => r.date.startsWith(monthPrefix) && (!maxDate || r.date <= maxDate));
      if (!inMonth.length) return { countDate: '', total: 0, data: [] };
      const latestDate = inMonth.reduce((m, r) => (r.date > m ? r.date : m), '');
      const map = {}; // code -> { date(ล่าสุดที่พบสินค้านี้), qty, name, unit }
      for (const r of inMonth) {
        const code = normCode(r.code || r.productId);
        if (!code) continue;
        const nm = String(r.name || '').trim();
        const qty = Number(r.qty) || 0;
        const e = map[code];
        // วันล่าสุดของสินค้านี้ชนะ; ถ้าวันเดียวกันมีหลายครั้ง (นับซ้ำ/แก้) เอาครั้งหลังสุด
        // (office-server เรียงตามเวลาที่นับมาแล้ว แถวที่วนถึงทีหลัง = ล่าสุด)
        if (!e || r.date >= e.date) map[code] = { date: r.date, itemCode: code, itemName: nm || '-', unit: r.unit || '', qty };
      }
      let total = 0;
      const data = Object.values(map).map((it) => {
        const has = Object.prototype.hasOwnProperty.call(priceMap, it.itemCode);
        const unitPrice = has ? priceMap[it.itemCode] : 0;
        const value = it.qty * unitPrice;
        total += value;
        return { itemCode: it.itemCode, itemName: it.itemName, unit: it.unit, qty: it.qty, unitPrice, value, priced: has };
      }).sort((a, b) => b.value - a.value);
      return { countDate: latestDate, total, data };
    };

    const current = pick(curMonth, endStr);   // เดือนนี้ (ไม่เกิน end) — ยังใช้ยอดนับสต๊อกตามเดิม (เดือนนี้ยังไม่ปิดยอด)

    // เดือนที่แล้ว: ใช้ยอดปิดรอบสิ้นเดือนอย่างเป็นทางการก่อนเสมอ ถ้ายังไม่มีข้อมูล (ยังไม่กดปิดยอด) ค่อย fallback ไปยอดนับสต๊อก
    const closingPrev = closingMonthValue(closingRows, preMonth);
    const previous = closingPrev.data.length ? closingPrev : pick(preMonth, null);

    // รายจ่ายจาก Supplier (ชีท "ต้นทุนจากsup") ของสาขานี้ ในช่วง [start, end]
    // คอลัมน์: [0]วันที่ [1]สาขา [2]รหัส [3]ชื่อ [4]หน่วย [5]จำนวน [6]ราคา/หน่วย [7]มูลค่ารวม
    const supItems = [];
    let supTotal = 0;
    for (const rw of (supJ?.table?.rows || [])) {
      const c = rw.c || [];
      if (String(c[1]?.v ?? '').toLowerCase().trim() !== branchKey) continue;
      const ds = cellYmd(c[0]);
      if (startStr && ds && ds < startStr) continue;
      if (endStr && ds && ds > endStr) continue;
      const amount = Number(c[7]?.v) || 0;
      supTotal += amount;
      supItems.push({
        date: ds,
        code: c[2]?.v != null ? String(c[2].v) : '',
        name: c[3]?.v != null ? String(c[3].v) : '',
        unit: c[4]?.v != null ? String(c[4].v) : '',
        qty: Number(c[5]?.v) || 0,
        unitPrice: Number(c[6]?.v) || 0,
        amount,
      });
    }
    const supCost = { total: Math.round(supTotal * 100) / 100, count: supItems.length, items: supItems };

    return res.status(200).json({ status: 'success', branch: branchKey, current, previous, supCost });
  } catch (error) {
    console.error('stockcount error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
