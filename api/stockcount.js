import { fetchSheet } from '../lib/upstream.js';
// มูลค่าสต๊อกคงเหลือรายเดือน — อ่านจาก Google Sheet เดียวกัน 2 ชีท (gviz, ต้องแชร์ "ใครมีลิงก์ก็ดูได้")
//   - ชีท "ข้อมูลนับสตอค" (gid 923363118): ยอดคงเหลือรายสินค้า/สาขา/วันที่นับ
//   - ชีท "8.2": ตารางราคากลาง [0]รหัส [1]ชื่อ [2]ราคา/หน่วย
//   GET /api/stockcount?branch=<code>&end=<YYYY-MM-DD>
//   -> { status, branch, current:{countDate,total,data}, previous:{countDate,total,data} }
//      data = [{itemCode,itemName,unit,qty,unitPrice,value,priced}]
//   current  = ยอดนับล่าสุด "ภายในเดือนของ end" (และ <= end) — ถ้าเดือนนั้นยังไม่มีการนับ = ว่าง (มูลค่า 0)
//   previous = ยอดปิดรอบสิ้นเดือนที่บันทึกไว้อย่างเป็นทางการ (ชีท "ปิดรอบสิ้นเดือน") ของเดือนก่อนหน้า
//     ถ้าเดือนนั้นยังไม่มีใครกดปิดยอดเลย (เช่น ต้นเดือนใหม่ ยังไม่ทันบันทึก) fallback ไปใช้ยอดนับสต๊อกล่าสุดในเดือนนั้นแทน
//     กันหน้า dashboard โชว์ 0 เปล่าๆ ระหว่างรอทีมงานกดปิดยอด (ปกติบันทึกกันภายในต้นเดือนถัดไป ไม่เกินวันที่ 5)
const SHEET_ID = '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ';
const GID_STOCK = '923363118'; // ชีท "ข้อมูลนับสตอค"
const PRICE_SHEET = '8.2';     // ชีทราคากลาง [0]รหัส [1]ชื่อ [2]ราคา
const CLOSING_SHEET = 'ปิดรอบสิ้นเดือน'; // A=วันที่ปิดยอด B=สาขา C=รหัส D=ชื่อ E=หน่วย F=ยอดคงเหลือ G=มูลค่า/หน่วย H=มูลค่ารวม
// ชีทรายจ่ายจาก Supplier (คนละสเปรดชีต) — [0]วันที่ [1]สาขา [2]รหัส [3]ชื่อ [4]หน่วย [5]จำนวน [6]ราคา/หน่วย [7]มูลค่ารวม
const SUP_SHEET_ID = '1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw';
const SUP_SHEET = 'ต้นทุนจากsup';

// normalize รหัส: ตัด .0 ท้าย + เลข 0 นำหน้า ให้ตรงกันทุกชีท
const normCode = (c) => String(c == null ? '' : c).replace(/\.0+$/, '').replace(/^0+/, '').trim();

// "Date(2026,4,31)" -> "2026-05-31" (เดือน gviz เป็น 0-based)
function parseGvizDate(v) {
  const m = String(v == null ? '' : v).match(/Date\((\d+),(\d+),(\d+)/);
  if (!m) return '';
  return `${m[1]}-${String(+m[2] + 1).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
}
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
async function fetchClosingMonthValue(closingJson, branchKey, targetMonth) {
  const map = {}; // code -> { itemCode, itemName, unit, qty, unitPrice, value, priced }
  let latestDate = '';
  for (const rw of (closingJson.table.rows || [])) {
    const c = rw.c || [];
    if (String(c[1]?.v ?? '').toLowerCase().trim() !== branchKey) continue;
    const ds = cellYmd(c[0]);
    if (!ds || closingMonthOf(ds) !== targetMonth) continue;
    const code = normCode(c[2]?.v);
    if (!code) continue;
    const qty = Number(c[5]?.v) || 0;
    const unitPrice = Number(c[6]?.v) || 0;
    const value = c[7]?.v != null ? Number(c[7].v) : qty * unitPrice;
    map[code] = {
      itemCode: code, itemName: c[3]?.v != null ? String(c[3].v).trim() : '-',
      unit: c[4]?.v || '', qty, unitPrice, value, priced: true, date: ds,
    };
    if (ds > latestDate) latestDate = ds;
  }
  const data = Object.values(map).sort((a, b) => b.value - a.value);
  const total = data.reduce((s, it) => s + it.value, 0);
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

  // โหมด "ค่าเฉลี่ยยอดใช้ต่อหัว" (?avgperhead=1&branch=xxx) — จากชีท 'ค่าเฉลี่ยยอดใช้ต่อหัว' ในไฟล์ BOM
  // ใช้คำนวณยอดเบิกอัตโนมัติในหน้านับสต๊อก: คืน { code: avgPerHead } ของสาขานั้น
  if (req.query.avgperhead) {
    const brA = String(req.query.branch || '').toLowerCase().trim();
    if (!brA) return res.status(400).json({ status: 'error', message: 'ระบุสาขา' });
    try {
      const r = await fetchSheet('https://docs.google.com/spreadsheets/d/1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw/gviz/tq?tqx=out:json&gid=1722427042');
      const text = await r.text();
      if (text.startsWith('<')) return res.status(502).json({ status: 'error', message: 'อ่านชีทค่าเฉลี่ยยอดใช้ต่อหัวไม่ได้ (ต้องแชร์ลิงก์)' });
      const a = text.indexOf('{'), b = text.lastIndexOf('}');
      const j = JSON.parse(text.substring(a, b + 1));
      // [0]=สาขา [1]=รหัส [3]=ค่าเฉลี่ยต่อหัว — เว็บใช้ zjp แทน sjp ในบางชีท เผื่อ alias ทั้งสองทาง
      const aliases = new Set([brA]);
      if (brA === 'zjp') aliases.add('sjp');
      if (brA === 'sjp') aliases.add('zjp');
      const data = {};
      for (const rw of (j.table.rows || [])) {
        const c = rw.c || [];
        if (!aliases.has(String((c[0] && c[0].v) || '').toLowerCase().trim())) continue;
        const code = normCode(c[1] && c[1].v);
        if (!code) continue;
        const avg = Number(c[3] && c[3].v);
        if (!Number.isNaN(avg) && avg > 0) data[code] = avg;
      }
      return res.status(200).json({ status: 'success', branch: brA, count: Object.keys(data).length, data });
    } catch (error) {
      return res.status(500).json({ status: 'error', message: error.message });
    }
  }

  // โหมด "เปอร์เซ็นต์การเบิกของแต่ละสาขา" (?getpercentages=1&branch=xxx) — ดึงจากชีท เปอร์เซ็นการเบิกของแต่ละสาขา ในไฟล์ sup
  if (req.query.getpercentages) {
    const brA = String(req.query.branch || '').toLowerCase().trim();
    if (!brA) return res.status(400).json({ status: 'error', message: 'ระบุสาขา' });
    try {
      const r = await fetchSheet(`https://docs.google.com/spreadsheets/d/${SUP_SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent('เปอร์เซ็นการเบิกของแต่ละสาขา')}`);
      const text = await r.text();
      if (text.startsWith('<')) return res.status(502).json({ status: 'error', message: 'อ่านชีทเปอร์เซ็นการเบิกของแต่ละสาขาไม่ได้ (ต้องแชร์ลิงก์)' });
      const a = text.indexOf('{'), b = text.lastIndexOf('}');
      const j = JSON.parse(text.substring(a, b + 1));
      
      const aliases = new Set([brA]);
      if (brA === 'zjp') aliases.add('sjp');
      if (brA === 'sjp') aliases.add('zjp');
      
      const data = [];
      for (const rw of (j.table.rows || [])) {
        const c = rw.c || [];
        const dateVal = cellYmd(c[0]);
        if (!dateVal) continue;
        const branchName = String((c[1] && c[1].v) || '').toLowerCase().trim();
        if (!aliases.has(branchName)) continue;
        const percent = parseFloat(c[2] && c[2].v) || 0;
        // คอลัมน์ D/E (จำนวน259/จำนวน359) — มีเฉพาะสาขาที่มีหัว 2 ราคาและเคยบันทึกแยกไว้ ไม่มีก็เป็น undefined
        const p259 = c[3] && c[3].v !== null && c[3].v !== '' ? parseFloat(c[3].v) : undefined;
        const p359 = c[4] && c[4].v !== null && c[4].v !== '' ? parseFloat(c[4].v) : undefined;
        data.push({ date: dateVal, percent, percent259: p259, percent359: p359 });
      }
      return res.status(200).json({ status: 'success', branch: brA, data });
    } catch (error) {
      return res.status(500).json({ status: 'error', message: error.message });
    }
  }

  // โหมด "ยอดยกมาเดือนที่แล้ว" (?closingprev=1&branch=xxx[&end=YYYY-MM-DD]) — ใช้ในหน้านับสต๊อก
  // ดึงยอดปิดรอบสิ้นเดือนของ "เดือนก่อนหน้า" จากชีท ปิดรอบสิ้นเดือน (ยอดปิดบัญชีจริง ไม่ใช่ยอดนับที่บังเอิญนับไว้)
  // คืน { code: {qty, unitPrice, value, date} } ให้ฝั่งเว็บ merge เข้าตารางได้เลย
  if (req.query.closingprev) {
    const brC = String(req.query.branch || '').toLowerCase().trim();
    if (!brC) return res.status(400).json({ status: 'error', message: 'ระบุสาขา' });
    try {
      const refDate = String(req.query.end || '').match(/^\d{4}-\d{2}-\d{2}$/)
        ? String(req.query.end)
        : new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' }); // 'YYYY-MM-DD' เวลาไทย
      const targetMonth = prevMonth(refDate.slice(0, 7));
      const closingJ = await fetchGviz(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(CLOSING_SHEET)}`);
      const { data: rows } = await fetchClosingMonthValue(closingJ, brC, targetMonth);
      const data = {};
      for (const it of rows) data[it.itemCode] = { qty: it.qty, unitPrice: it.unitPrice, value: it.value, date: it.date };
      return res.status(200).json({ status: 'success', branch: brC, month: targetMonth, count: rows.length, data });
    } catch (error) {
      return res.status(500).json({ status: 'error', message: error.message });
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
    const [stockJ, priceJ, masterJ, supJ, closingJ] = await Promise.all([
      fetchGviz(`${base}&gid=${GID_STOCK}`),
      fetchGviz(`${base}&sheet=${encodeURIComponent(PRICE_SHEET)}`),
      // ชีทรายการสินค้า (A=รหัส B=ชื่อ) — ใช้เทียบชื่อหารหัส กรณีแถวนับสต๊อกรหัสอ่านไม่ได้
      // (แถวที่บันทึกผ่านเว็บเก็บรหัสเป็นข้อความ ปนกับแถวเก่าที่เป็นตัวเลข ทำให้ gviz คืน null)
      fetchGviz(`${base}&sheet=${encodeURIComponent('รายการสินค้า')}`).catch(() => null),
      // ชีทรายจ่ายจาก Supplier "ต้นทุนจากsup" (คนละไฟล์) — ไม่มี/อ่านไม่ได้ก็คิดเป็น 0
      fetchGviz(`${supBase}&sheet=${encodeURIComponent(SUP_SHEET)}`).catch(() => null),
      // ชีท "ปิดรอบสิ้นเดือน" — ใช้เป็นแหล่งข้อมูลหลักของ "เดือนที่แล้ว" (อ่านไม่ได้ก็ fallback เป็น null กลับไปใช้ยอดนับสต๊อกแทน)
      fetchGviz(`${base}&sheet=${encodeURIComponent(CLOSING_SHEET)}`).catch(() => null),
    ]);

    // name (trim) -> code จากชีทรายการสินค้า
    const codeByName = {};
    if (masterJ) for (const rw of (masterJ.table.rows || [])) {
      const c = rw.c || [];
      const code = normCode(c[0] && c[0].v);
      const nm = c[1] && c[1].v != null ? String(c[1].v).trim() : '';
      if (code && nm && !codeByName[nm]) codeByName[nm] = code;
    }

    // ราคากลางจากชีท 8.2: รหัส -> ราคา/หน่วย
    const priceMap = {};
    for (const rw of (priceJ.table.rows || [])) {
      const c = rw.c || [];
      const code = normCode(c[0] && c[0].v);
      if (!code) continue;
      const price = Number(c[2] && c[2].v);
      if (!Number.isNaN(price)) priceMap[code] = price;
    }

    // แถวสต๊อกของสาขานี้ (พร้อมวันที่)
    const brRows = (stockJ.table.rows || [])
      .map((rw) => (rw.c || []).map((c) => (c ? c.v : null)))
      .filter((rw) => String(rw[2] || '').toLowerCase().trim() === branchKey)
      .map((rw) => ({ ds: parseGvizDate(rw[0]), rw }))
      .filter((x) => x.ds);

    // รวมทุกวันนับในเดือนนั้น แล้ว "แต่ละสินค้าเอายอดจากวันล่าสุดที่นับ" (ตัดซ้ำ)
    // กรณีนับ 1 เดือนกระจายหลายวัน (เช่น 3 ก.ค. แล้วนับเพิ่ม/แก้ 4 ก.ค.) จะได้ครบทุกสินค้า ไม่ตกหล่น
    const pick = (monthPrefix, maxDate) => {
      const inMonth = brRows.filter(({ ds }) => ds.startsWith(monthPrefix) && (!maxDate || ds <= maxDate));
      if (!inMonth.length) return { countDate: '', total: 0, data: [] };
      const latestDate = inMonth.reduce((m, { ds }) => (ds > m ? ds : m), '');
      const map = {}; // code -> { date(ล่าสุดที่พบสินค้านี้), qty, name, unit }
      for (const { ds, rw } of inMonth) {
        // รหัสจากคอลัมน์ D; ถ้าอ่านไม่ได้ (gviz คืน null เพราะชนิดข้อมูลปน) เทียบจากชื่อสินค้าแทน
        const nm = rw[4] != null ? String(rw[4]).trim() : '';
        const code = normCode(rw[3]) || codeByName[nm] || '';
        if (!code) continue;
        const qty = Number(rw[6]) || 0;
        const e = map[code];
        // วันล่าสุดของสินค้านี้ชนะ; ถ้าวันเดียวกันมีหลายแถว (นับซ้ำ/แก้) เอา "แถวหลังสุด" ในชีท
        // (brRows เรียงตามลำดับแถวในชีท → แถวที่วนถึงทีหลัง = ล่าสุด)
        if (!e || ds >= e.date) map[code] = { date: ds, itemCode: code, itemName: nm || '-', unit: rw[5] || '', qty };
        // ds < e.date (นับก่อนหน้า) = ข้าม เพราะมียอดวันล่าสุดของสินค้านี้แล้ว
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
    const closingPrev = closingJ ? await fetchClosingMonthValue(closingJ, branchKey, preMonth) : { data: [] };
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
