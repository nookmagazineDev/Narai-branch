// มูลค่าสต๊อกคงเหลือรายเดือน — อ่านจาก Google Sheet เดียวกัน 2 ชีท (gviz, ต้องแชร์ "ใครมีลิงก์ก็ดูได้")
//   - ชีท "ข้อมูลนับสตอค" (gid 923363118): ยอดคงเหลือรายสินค้า/สาขา/วันที่นับ
//   - ชีท "8.2": ตารางราคากลาง [0]รหัส [1]ชื่อ [2]ราคา/หน่วย
//   GET /api/stockcount?branch=<code>&end=<YYYY-MM-DD>
//   -> { status, branch, current:{countDate,total,data}, previous:{countDate,total,data} }
//      data = [{itemCode,itemName,unit,qty,unitPrice,value,priced}]
//   current  = ยอดนับล่าสุด "ภายในเดือนของ end" (และ <= end) — ถ้าเดือนนั้นยังไม่มีการนับ = ว่าง (มูลค่า 0)
//   previous = ยอดนับล่าสุด "ภายในเดือนก่อนหน้า"
const SHEET_ID = '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ';
const GID_STOCK = '923363118'; // ชีท "ข้อมูลนับสตอค"
const PRICE_SHEET = '8.2';     // ชีทราคากลาง [0]รหัส [1]ชื่อ [2]ราคา

// normalize รหัส: ตัด .0 ท้าย + เลข 0 นำหน้า ให้ตรงกันทุกชีท
const normCode = (c) => String(c == null ? '' : c).replace(/\.0+$/, '').replace(/^0+/, '').trim();

// "Date(2026,4,31)" -> "2026-05-31" (เดือน gviz เป็น 0-based)
function parseGvizDate(v) {
  const m = String(v == null ? '' : v).match(/Date\((\d+),(\d+),(\d+)/);
  if (!m) return '';
  return `${m[1]}-${String(+m[2] + 1).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
}
// "2026-06" -> "2026-05"
function prevMonth(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  const py = m > 1 ? y : y - 1;
  const pm = m > 1 ? m - 1 : 12;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

async function fetchGviz(url) {
  const r = await fetch(url);
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

  const branchKey = String(req.query.branch || '').toLowerCase().trim();
  const endStr = String(req.query.end || '9999-12-31');
  if (!branchKey) return res.status(400).json({ status: 'error', message: 'ระบุสาขาไม่ครบถ้วน' });

  const curMonth = endStr.slice(0, 7);
  const preMonth = prevMonth(curMonth);
  const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;

  try {
    const [stockJ, priceJ, masterJ] = await Promise.all([
      fetchGviz(`${base}&gid=${GID_STOCK}`),
      fetchGviz(`${base}&sheet=${encodeURIComponent(PRICE_SHEET)}`),
      // ชีทรายการสินค้า (A=รหัส B=ชื่อ) — ใช้เทียบชื่อหารหัส กรณีแถวนับสต๊อกรหัสอ่านไม่ได้
      // (แถวที่บันทึกผ่านเว็บเก็บรหัสเป็นข้อความ ปนกับแถวเก่าที่เป็นตัวเลข ทำให้ gviz คืน null)
      fetchGviz(`${base}&sheet=${encodeURIComponent('รายการสินค้า')}`).catch(() => null),
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

    const current = pick(curMonth, endStr);   // เดือนนี้ (ไม่เกิน end)
    const previous = pick(preMonth, null);      // เดือนที่แล้ว (ทั้งเดือน)
    return res.status(200).json({ status: 'success', branch: branchKey, current, previous });
  } catch (error) {
    console.error('stockcount error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
