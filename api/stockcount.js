import { USAGE_API_BASE, fetchUpstream } from '../lib/upstream.js';
// มูลค่าสต๊อกคงเหลือรายเดือน
//   - ยอดนับ + ยอดปิดรอบสิ้นเดือน + ราคาต่อหน่วย: อ่านจาก SQL Server (InventoryNarai) ผ่าน office-server
//   - รายจ่าย Supplier (หน้ากรอกรายจ่าย): SQL dbo.stock_sup_cost ผ่าน office-server (getSupCostRows)
//     เดิมอ่านชีท "ต้นทุนจากsup" — ย้ายข้อมูลเก่าเข้าตารางแล้ว (office-server/scripts/import-sup-cost.mjs)
//   GET /api/stockcount?branch=<code>&end=<YYYY-MM-DD>
//   -> { status, branch, current:{countDate,total,data}, previous:{countDate,total,data}, supCost }
//   current  = ยอดนับล่าสุด "ภายในเดือนของ end" (และ <= end) — ถ้าเดือนนั้นยังไม่มีการนับ = ว่าง (มูลค่า 0)
//     ยกเว้นเดือนของ end เป็นเดือนที่ผ่านไปแล้ว (ดูย้อนหลัง) + end เป็นวันสิ้นเดือนพอดี + มียอดปิดรอบสิ้นเดือนแล้ว
//     → ใช้ยอดปิดรอบแทน (เลือกไม่ถึงสิ้นเดือน เช่น 1–15 ก.ย. ยังใช้ยอดนับ <= end เพราะยอดปิดรอบคือยอด ณ สิ้นเดือน)
//     เดือนปัจจุบันยังไม่ปิดยอด จึงยังใช้ยอดนับเหมือนเดิม
//   ทั้ง current/previous มี source: 'closing' (ยอดปิดรอบ) | 'count' (ยอดนับ) ให้หน้าเว็บบอกที่มาได้
//   previous = ยอดปิดรอบสิ้นเดือนที่บันทึกไว้อย่างเป็นทางการของเดือนก่อนหน้า
//     ถ้าเดือนนั้นยังไม่มีใครกดปิดยอดเลย fallback ไปใช้ยอดนับสต๊อกล่าสุดในเดือนนั้นแทน
//     กันหน้า dashboard โชว์ 0 เปล่าๆ ระหว่างรอทีมงานกดปิดยอด (ปกติบันทึกกันภายในต้นเดือนถัดไป ไม่เกินวันที่ 5)

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

/**
 * ราคาต่อหน่วยของสินค้าทุกตัว: รหัส (normalize แล้ว) -> ราคา
 *
 * มาจากทะเบียนสินค้า dbo.stock_item คอลัมน์ price (= ราคาช่อง C ของชีท item) แทนชีทราคากลาง '8.2'
 * ที่เคยอ่าน — ชีทนั้นเป็นสำเนาที่คนคัดลอกราคามาอีกที ของใหม่ที่ยังไม่มีใครเติมลงชีทจะถูกคิดเป็น
 * 0 บาท (ขึ้น priced:false ในตาราง) ทั้งที่ทะเบียนมีราคาอยู่แล้ว — เหตุผลเดียวกับที่หน้ากรอกรายจ่าย
 * ย้ายมาอ่านทะเบียนตัวจริงไปก่อนหน้านี้
 *
 * ใช้ทั้งทะเบียน ไม่กรองสาขาและไม่ตัด 'ปิดการใช้งาน' เพราะต้องตีราคา "ของที่นับไปแล้ว" ซึ่งรวมของที่
 * เพิ่งเลิกใช้ระหว่างเดือนด้วย (ชีท 8.2 ที่แทนที่ก็เป็นราคารวมทุกสาขาเหมือนกัน)
 *
 * แคชไว้ในอินสแตนซ์ 10 นาที เพราะหน้า Dashboard เรียก endpoint นี้ทีละหลายสาขาพร้อมกัน แต่ทะเบียน
 * เป็นก้อนเดียวกันทุกสาขาและเปลี่ยนวันละไม่กี่ครั้ง (office-server ซิงก์จากชีทชั่วโมงละครั้ง)
 */
let registryCache = { at: 0, map: null };

/**
 * ทะเบียนสินค้าทั้งชุด: รหัส (normalize แล้ว) -> { name, unit, price, status }
 * ใช้ร่วมกันระหว่างตัวคิดมูลค่าสต๊อก (เอาแค่ราคา) กับโหมด ?prices=1 (เอาชื่อ/หน่วยด้วย)
 */
async function itemRegistryMap() {
  if (registryCache.map && Date.now() - registryCache.at < 10 * 60 * 1000) return registryCache.map;
  const rows = await callOffice('getItemRegistry', {});
  const map = {};
  for (const it of (rows || [])) {
    const code = normCode(it.key || it.code);
    if (!code) continue;
    map[code] = {
      name: String(it.name || '').trim(),
      unit: String(it.unit || '').trim(),
      price: Number(it.price) || 0,
      status: String(it.status || '').trim(),
    };
  }
  registryCache = { at: Date.now(), map };
  return map;
}

async function itemPriceMap() {
  const reg = await itemRegistryMap();
  const map = {};
  for (const code of Object.keys(reg)) map[code] = reg[code].price;
  return map;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // โหมดรายการสินค้า+ราคา (?prices=1&branch=xxx) — ใช้ในหน้ากรอกรายจ่าย
  // คืน code -> {name, unit, price} จากทะเบียนสินค้าใน SQL (InventoryNarai.dbo.stock_item)
  // ผ่าน office-server เหมือนข้อมูลสต๊อกอื่นๆ (Vercel ต่อ SQL ที่ออฟฟิศตรงไม่ได้)
  //
  // เดิมอ่านชีท 8.2 ตรงๆ ซึ่งเป็นสำเนาที่คนคัดลอกมาอีกที ของใหม่ที่เพิ่มในทะเบียนแล้วแต่ยังไม่มี
  // ใครเติมลงชีทจึงไม่โผล่ในหน้ากรอกรายจ่ายเลย (เช่น ผัก 11090152, 11090153)
  // (รวมไว้ใน endpoint นี้เพราะ Vercel Hobby จำกัด serverless functions ที่ 12 ตัว)
  if (req.query.prices) {
    const brP = String(req.query.branch || '').toLowerCase().trim();
    // รายการสินค้าแยกตามสาขา จึงต้องรู้สาขาก่อน — ไม่มีสาขาแปลว่าหน้าเว็บยังโหลดไม่เสร็จ
    if (!brP) return res.status(400).json({ status: 'error', message: 'ระบุสาขา' });
    // &codes=11000265,11100006,... — รหัสที่ "ต้องได้ชื่อ/ราคาเสมอ" แม้คอลัมน์ J ของชีท item
    // ไม่ได้ระบุสาขานี้ไว้ (รายการคงที่ของหน้ากรอกรายจ่าย เช่น น้ำมัน/ซอส/แก๊ส ที่ทุกสาขาต้องกรอก
    // แต่บางสาขาไม่ได้ถูกใส่ไว้ในทะเบียนแยกสาขา เพราะไม่ได้นับสต๊อกของพวกนี้)
    //
    // เดิมหน้ากรอกรายจ่ายอ่านชีทราคากลาง 8.2 ซึ่งเป็นราคารวมทุกสาขา พอย้ายมาอ่านทะเบียนที่กรอง
    // ตามสาขา รายการคงที่ทั้งใบของสาขาที่ไม่ได้ถูกระบุไว้เลยขึ้น "(ไม่พบในทะเบียนของสาขานี้)" ทั้งแถบ
    // ราคาในทะเบียนมีค่าเดียวต่อสินค้า (stock_item.price ไม่ได้แยกรายสาขา) การถอยมาอ่านทั้งทะเบียน
    // จึงได้ชื่อ/หน่วย/ราคาชุดเดียวกับที่สาขาที่ถูกระบุไว้เห็น ไม่ใช่ราคาของสาขาอื่น
    const wanted = String(req.query.codes || '')
      .split(',')
      .map((c) => normCode(c))
      .filter(Boolean);
    try {
      const data = await callOffice('getItemPrices', { branch: brP });
      const out = { ...(data || {}) };
      const offBranch = [];
      const missing = wanted.filter((c) => !out[c]);
      if (missing.length) {
        try {
          const reg = await itemRegistryMap();
          for (const code of missing) {
            const it = reg[code];
            if (!it) continue;   // ไม่มีในทะเบียนเลย = ปล่อยให้หน้าเว็บฟ้องว่าหาไม่เจอตามเดิม
            // offBranch = หน้าเว็บเอาไปบอกผู้ใช้ว่าแถวนี้ใช้ราคากลางจากทะเบียนรวม
            out[code] = { name: it.name, unit: it.unit, price: it.price, offBranch: true };
            offBranch.push(code);
          }
        } catch {
          // ทะเบียนรวมอ่านไม่ได้ก็ยังคืนของสาขาไปก่อน ดีกว่าพังทั้งหน้า
        }
      }
      return res.status(200).json({ status: 'success', branch: brP, data: out, offBranch });
    } catch (error) {
      return res.status(502).json({ status: 'error', message: error.message });
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
      const rows = await callOffice('getSupCostRows', { branch: brK, from: st, to: en });
      const map = {};
      for (const rw of (rows || [])) {
        const ds = rw.date;
        if (!ds) continue;
        const code = normCode(rw.code);
        if (!code) continue;
        const qty = Number(rw.qty) || 0;
        if (!(qty > 0)) continue; // แถวที่แก้เป็น 0 = ยกเลิกรายจ่าย ไม่ใช่ของที่รับเข้า
        const e = map[code] || (map[code] = { total: 0, details: {}, unit: rw.unit || '' });
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

  try {
    // ยอดนับ ยอดปิดรอบ ราคาต่อหน่วย และรายจ่าย Supplier มาจาก SQL (ผ่าน office-server) ทั้งหมด
    const [stockRows, priceMap, supRows, closingRows] = await Promise.all([
      // ดึงเฉพาะช่วงที่ใช้จริง: ตั้งแต่ต้นเดือนก่อนหน้า ถึงวันที่เลือก
      callOffice('getStockCountRows', {
        branch: branchKey,
        from: `${preMonth}-01`,
        to: /^\d{4}-\d{2}-\d{2}$/.test(endStr) ? endStr : null,
      }),
      itemPriceMap(),
      // รายจ่ายจาก Supplier ในช่วง [start, end] — อ่านไม่ได้ก็คิดเป็น 0 เหมือนตอนอ่านชีท
      callOffice('getSupCostRows', {
        branch: branchKey,
        from: /^\d{4}-\d{2}-\d{2}$/.test(startStr) ? startStr : null,
        to: /^\d{4}-\d{2}-\d{2}$/.test(endStr) ? endStr : null,
      }).catch(() => []),
      // ยอดปิดรอบสิ้นเดือน — ใช้เป็นแหล่งหลักของ "เดือนที่แล้ว" ไม่มีข้อมูลก็ถอยไปใช้ยอดนับแทน
      callOffice('getMonthEndRows', { branch: branchKey }).catch(() => []),
    ]);

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

    // เดือนของ end: ถ้าเป็นเดือนที่ผ่านไปแล้ว (เทียบเดือนปัจจุบันตามเวลาไทย) และเลือกถึงวันสิ้นเดือนพอดี
    // และมียอดปิดรอบสิ้นเดือนแล้ว ใช้ยอดปิดรอบ — ยอดปิดรอบคือยอด ณ สิ้นเดือน ถ้าเลือกไม่ถึงสิ้นเดือนจึงไม่ตรงช่วง
    // ส่วนเดือนปัจจุบัน (ยังไม่ปิดยอด) เลือกไม่ถึงสิ้นเดือน หรือเดือนเก่าที่ยังไม่มีใครกดปิดยอด ใช้ยอดนับสต๊อก (ไม่เกิน end) ตามเดิม
    const thisMonth = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
    const [ey, em] = curMonth.split('-').map(Number);
    const monthEnd = `${curMonth}-${String(new Date(Date.UTC(ey, em, 0)).getUTCDate()).padStart(2, '0')}`;
    const closingCur = curMonth < thisMonth && endStr === monthEnd ? closingMonthValue(closingRows, curMonth) : null;
    const current = closingCur?.data.length
      ? { ...closingCur, source: 'closing' }
      : { ...pick(curMonth, endStr), source: 'count' };

    // เดือนที่แล้ว: ใช้ยอดปิดรอบสิ้นเดือนอย่างเป็นทางการก่อนเสมอ ถ้ายังไม่มีข้อมูล (ยังไม่กดปิดยอด) ค่อย fallback ไปยอดนับสต๊อก
    const closingPrev = closingMonthValue(closingRows, preMonth);
    const previous = closingPrev.data.length
      ? { ...closingPrev, source: 'closing' }
      : { ...pick(preMonth, null), source: 'count' };

    // รายจ่ายจาก Supplier ของสาขานี้ ในช่วง [start, end] — office-server กรองสาขา/ช่วงวันที่มาให้แล้ว
    // แถวที่แก้เป็น 0 (ยกเลิกรายจ่าย) ไม่ต้องแสดงในรายการ
    const supItems = [];
    let supTotal = 0;
    for (const rw of (supRows || [])) {
      if (!(Number(rw.qty) > 0)) continue;
      const amount = Number(rw.amount) || 0;
      supTotal += amount;
      supItems.push({
        date: rw.date,
        code: rw.code,
        name: rw.name,
        unit: rw.unit,
        qty: Number(rw.qty) || 0,
        unitPrice: Number(rw.unitPrice) || 0,
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
