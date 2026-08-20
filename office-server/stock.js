// หน้านับสต๊อก / หน้ารวมสต๊อกทุกสาขา — อ่านจาก SQL Server narai_hr แทน Google Sheets
//
// ตอนนี้ย้ายมาแค่ฝั่ง "อ่าน" (getStockItems, getStockTotal) การบันทึกยังวิ่งไป Apps Script
// ตามเดิม จึงยังไม่เปิดใช้จากหน้าเว็บ — ดูขั้นตอนและลำดับที่เหลือใน docs/stock-sql-migration.md
//
// ทำไมถึงย้ายฝั่งอ่านก่อน: getStockItems ต้องอ่านชีท 'ข้อมูลนับสตอค' ทั้งใบ (25,000+ แถว)
// ทุกครั้งที่เปิดหน้า กินเวลา ~20 วิ จนต้องใส่ cache 90 วินาทีคั่นไว้ และหน้าปิดยอดสิ้นเดือน
// ต้องแยกไปทำ action ของตัวเอง (getClosingItems) เพราะรอไม่ไหว
//
// รูปแบบคำตอบเหมือน Apps Script เดิมทุกฟิลด์ (รวมรูปแบบวันที่ 'dd/MM/yyyy HH:mm')
// หน้าเว็บจึงสลับมาใช้ทางนี้ได้โดยไม่ต้องแก้อะไร

import { sql, queryRead } from './hr-db.js';
import { branchFor } from './hr-session.js';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * รหัสสาขาในชีท 'item' เขียนว่า SJP แต่ผู้ใช้ล็อกอินด้วย zjp
 * ใช้เฉพาะตอนหาว่าสินค้าตัวไหนเป็นของสาขานี้ ส่วนข้อมูลนับ/ยอดยกมา/ใบเบิก
 * เก็บด้วยรหัสที่หน้าเว็บส่งมา (zjp) จึงห้ามแปลง ไม่งั้นจะหาข้อมูลของสาขานั้นไม่เจอเลย
 */
const ITEM_BRANCH_ALIAS = { zjp: 'sjp', zip: 'sjp' };
const itemBranchOf = (branch) => {
  const b = str(branch).toLowerCase();
  return ITEM_BRANCH_ALIAS[b] || b;
};

/**
 * '2026-08-20 14:05' (ที่ได้จาก CONVERT แบบ 120) -> '20/08/2026 14:05'
 *
 * แปลงเป็นข้อความตั้งแต่ใน SQL แล้วค่อยจัดรูปที่นี่ ไม่แปลงผ่าน Date ของ JS
 * เพราะ driver คืนค่า DATETIME2 มาเป็น Date ที่ตีความเป็น UTC — ถ้าเอาไปอ่านด้วย
 * getHours() ตามเวลาเครื่อง เวลาที่โชว์จะเลื่อนไป 7 ชั่วโมงทั้งระบบ
 */
const thaiDateTime = (v) => {
  const s = str(v);
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
};

/* ============================== หน้านับสต๊อก ==============================
   คืนรายการสินค้าของสาขานั้น พร้อมของสามอย่างที่หน้าเว็บใช้:
     - ยอดนับล่าสุด + ยอดนับก่อนหน้า (ยอดยกมาเดือนที่แล้ว) + ประวัติการนับทั้งหมด
     - ยอดยกมาจากตาราง stock_balance (ใช้เมื่อสินค้านั้นยังไม่เคยถูกนับ)
     - ใบเบิกครั้งล่าสุด
   ทั้งหมดดึงด้วยคำสั่งละครั้ง แล้วจับคู่ในหน่วยความจำ — ไม่ยิงทีละสินค้า
   (สาขาหนึ่งมีสินค้า 200-300 ตัว ถ้ายิงทีละตัวจะกลายเป็นพันคำสั่งต่อการเปิดหน้าหนึ่งครั้ง) */
async function getStockItems(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  if (!branch) return [];
  const itemBranch = itemBranchOf(branch);

  const branchParam = { branch: { type: sql.NVarChar(50), value: branch } };

  const [items, counts, balances, requests, categories] = await Promise.all([
    queryRead(
      `SELECT i.item_key, i.item_code, i.pos_item_id, i.item_name, i.unit, i.price,
              i.status, i.store_cat, i.plan_only
         FROM dbo.stock_item i
         JOIN dbo.stock_item_branch b ON b.item_key = i.item_key
        WHERE b.branch = @itemBranch
          AND ISNULL(i.status, N'') <> N'ปิดการใช้งาน'
        ORDER BY i.sort_order, i.item_code`,
      { itemBranch: { type: sql.NVarChar(50), value: itemBranch } }
    ),
    // ประวัติการนับทั้งหมดของสาขานี้ เรียงเก่า -> ใหม่ (หน้าเว็บใช้ทั้งชุด ไม่ได้ใช้แค่ค่าล่าสุด)
    queryRead(
      `SELECT item_key, remaining, counter_name,
              CONVERT(NVARCHAR(19), counted_at, 120) AS counted_text
         FROM dbo.stock_count
        WHERE branch = @branch
        ORDER BY item_key, counted_at, count_id`,
      branchParam
    ),
    queryRead(
      `SELECT item_key, balance, CONVERT(NVARCHAR(19), updated_at, 120) AS updated_text
         FROM dbo.stock_balance
        WHERE branch = @branch`,
      branchParam
    ),
    // ใบเบิกครั้งล่าสุดต่อสินค้า — แถวที่ใหม่ที่สุดคือแถวที่ต่อท้ายทีหลัง จึงใช้ request_id ตัดสิน
    // (เวลาบันทึกในชีทเก่าบางแถวว่าง ถ้าเรียงด้วยเวลาอย่างเดียวแถวเหล่านั้นจะจมหายไป)
    queryRead(
      `SELECT r.item_key, r.qty, r.requester,
              CONVERT(NVARCHAR(19), r.saved_at, 120) AS saved_text
         FROM dbo.stock_request r
         JOIN (SELECT item_key, MAX(request_id) AS request_id
                 FROM dbo.stock_request
                WHERE branch = @branch
                GROUP BY item_key) last_one
           ON last_one.request_id = r.request_id`,
      branchParam
    ),
    queryRead(
      `SELECT item_key, category FROM dbo.stock_storage_category WHERE branch = @branch`,
      branchParam
    ),
  ]);

  const historyByItem = new Map();
  for (const c of counts) {
    const list = historyByItem.get(c.item_key) || [];
    list.push({
      remaining: Number(c.remaining),
      date: thaiDateTime(c.counted_text),
      counter: str(c.counter_name),
    });
    historyByItem.set(c.item_key, list);
  }

  const balanceByItem = new Map(balances.map((b) => [b.item_key, b]));
  const requestByItem = new Map(requests.map((r) => [r.item_key, r]));
  const categoryByItem = new Map(categories.map((c) => [c.item_key, str(c.category)]));

  return items.map((it) => {
    const history = historyByItem.get(it.item_key) || [];
    const last = history.length > 0 ? history[history.length - 1] : null;
    const prevCount = history.length > 1 ? history[history.length - 2] : null;
    const bal = balanceByItem.get(it.item_key) || null;
    const req = requestByItem.get(it.item_key) || null;

    // ยอดยกมา = ยอดนับ "ครั้งก่อนหน้า" ถ้ามี ไม่มีค่อยใช้ยอดยกมาที่บันทึกไว้
    // (ลำดับเดียวกับ Apps Script เดิม สลับกันแล้วตัวเลขในหน้าจะเปลี่ยนทันที)
    const previous = prevCount || (bal ? { remaining: Number(bal.balance), date: thaiDateTime(bal.updated_text) } : null);

    return {
      productId: it.item_code,
      itemId: str(it.pos_item_id),
      name: it.item_name || '',
      unit: str(it.unit),
      price: it.price === null || it.price === undefined ? '' : Number(it.price),
      status: str(it.status),
      storeCat: str(it.store_cat),
      planOnly: Boolean(it.plan_only),
      storageCat: categoryByItem.get(it.item_key) ?? '',
      rdCat: '', // ชีท item ไม่มีคอลัมน์นี้ — Apps Script ก็คืนค่าว่างมาตลอด
      previousBalance: previous ? previous.remaining : '',
      previousBalanceDate: previous ? previous.date : '',
      lastStock: last ? last.remaining : '',
      lastStockDate: last ? last.date : '',
      lastStockCounter: last ? last.counter : '',
      stockHistory: history,
      lastRequest: req ? Number(req.qty) : '',
      lastRequestDate: req ? thaiDateTime(req.saved_text) : '',
      lastRequester: req ? str(req.requester) : '',
    };
  });
}

/* ========================= หน้ารวมสต๊อกทุกสาขา =========================
   ยอดคงเหลือรวมของสินค้าแต่ละตัว = ผลรวมของทุกสาขา โดยสาขาไหนเคยนับแล้วใช้ยอดนับล่าสุด
   สาขาที่ยังไม่เคยนับใช้ยอดยกมาแทน (กติกาเดิมของ Apps Script ทั้งดุ้น)
   endDate = ดูย้อนหลังว่า ณ วันนั้นเหลือเท่าไหร่ (ไม่ส่งมา = ล่าสุด) */
async function getStockTotal(body) {
  const endDate = str(body.endDate);
  // เทียบถึงสิ้นวันของวันที่เลือก ไม่ใช่เที่ยงคืนต้นวัน ไม่งั้นการนับของวันนั้นเองจะหลุดออกไปทั้งวัน
  const endText = /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? `${endDate} 23:59:59` : null;
  const endParam = { endText: { type: sql.NVarChar(19), value: endText } };

  const [items, counts, balances, categories] = await Promise.all([
    queryRead(
      `SELECT item_key, item_code, item_name, unit, store_cat, storage_cat, rd_cat
         FROM dbo.stock_item_total
        ORDER BY sort_order, item_code`
    ),
    // ยอดนับล่าสุดของแต่ละสินค้าในแต่ละสาขา (ภายในวันที่กำหนด)
    queryRead(
      `SELECT c.item_key, c.branch, c.remaining,
              CONVERT(NVARCHAR(19), c.counted_at, 120) AS counted_text
         FROM dbo.stock_count c
         JOIN (SELECT item_key, branch, MAX(counted_at) AS counted_at
                 FROM dbo.stock_count
                WHERE @endText IS NULL OR counted_at <= CONVERT(DATETIME2(0), @endText, 120)
                GROUP BY item_key, branch) last_one
           ON last_one.item_key = c.item_key
          AND last_one.branch = c.branch
          AND last_one.counted_at = c.counted_at`,
      endParam
    ),
    queryRead(
      `SELECT item_key, branch, balance, CONVERT(NVARCHAR(19), updated_at, 120) AS updated_text
         FROM dbo.stock_balance`
    ),
    // หมวดจัดเก็บของหน้ารวมใช้ "แถวแรกที่เจอในชีท" เป็นตัวแทนของสินค้านั้น เพราะแต่ละสาขาตั้งไม่เหมือนกัน
    queryRead(
      `SELECT s.item_key, s.category
         FROM dbo.stock_storage_category s
         JOIN (SELECT item_key, MIN(ISNULL(sheet_row, 2147483647)) AS sheet_row
                 FROM dbo.stock_storage_category
                GROUP BY item_key) first_one
           ON first_one.item_key = s.item_key
          AND ISNULL(s.sheet_row, 2147483647) = first_one.sheet_row`
    ),
  ]);

  const countsByItem = new Map();
  for (const c of counts) {
    const list = countsByItem.get(c.item_key) || [];
    list.push(c);
    countsByItem.set(c.item_key, list);
  }
  const balancesByItem = new Map();
  for (const b of balances) {
    const list = balancesByItem.get(b.item_key) || [];
    list.push(b);
    balancesByItem.set(b.item_key, list);
  }
  const categoryByItem = new Map();
  for (const c of categories) {
    if (!categoryByItem.has(c.item_key)) categoryByItem.set(c.item_key, str(c.category));
  }

  return items.map((it) => {
    const branchDetails = [];
    const counted = new Set();
    let total = 0;
    let hasAny = false;
    let lastText = '';

    for (const c of countsByItem.get(it.item_key) || []) {
      total += num(c.remaining);
      counted.add(c.branch);
      hasAny = true;
      if (c.counted_text > lastText) lastText = c.counted_text;
      branchDetails.push({
        branch: c.branch,
        remaining: num(c.remaining),
        date: thaiDateTime(c.counted_text),
        type: 'นับล่าสุด',
      });
    }

    for (const b of balancesByItem.get(it.item_key) || []) {
      if (counted.has(b.branch)) continue; // สาขาไหนนับแล้วใช้ยอดนับ ไม่บวกยอดยกมาซ้ำ
      total += num(b.balance);
      hasAny = true;
      if (b.updated_text && b.updated_text > lastText) lastText = b.updated_text;
      branchDetails.push({
        branch: b.branch,
        remaining: num(b.balance),
        date: thaiDateTime(b.updated_text),
        type: 'ยอดยกมา',
      });
    }

    return {
      productId: it.item_code,
      name: it.item_name || '',
      unit: str(it.unit),
      storeCat: str(it.store_cat),
      storageCat: categoryByItem.get(it.item_key) ?? str(it.storage_cat),
      rdCat: str(it.rd_cat),
      totalRemaining: hasAny ? Number(total.toFixed(2)) : '',
      lastDate: thaiDateTime(lastText),
      branchDetails,
    };
  });
}

/* ตัวเทียบว่าย้ายข้อมูลมาครบหรือยัง — เรียกก่อนเปิดใช้จริงเพื่อดูว่าตารางไหนยังว่าง
   (ไม่ได้เอาไว้ให้หน้าเว็บเรียก ใช้ตอนติดตั้งกับ office-server/scripts/test-stock.mjs) */
async function stockStatus() {
  const rows = await queryRead(`
    SELECT N'stock_item' AS table_name, COUNT(*) AS rows_count FROM dbo.stock_item
    UNION ALL SELECT N'stock_item_branch', COUNT(*) FROM dbo.stock_item_branch
    UNION ALL SELECT N'stock_item_total', COUNT(*) FROM dbo.stock_item_total
    UNION ALL SELECT N'stock_count', COUNT(*) FROM dbo.stock_count
    UNION ALL SELECT N'stock_balance', COUNT(*) FROM dbo.stock_balance
    UNION ALL SELECT N'stock_request', COUNT(*) FROM dbo.stock_request
    UNION ALL SELECT N'stock_storage_category', COUNT(*) FROM dbo.stock_storage_category`);
  const tables = {};
  for (const r of rows) tables[r.table_name] = Number(r.rows_count);
  const latest = await queryRead(
    `SELECT TOP 1 CONVERT(NVARCHAR(19), counted_at, 120) AS counted_text, branch
       FROM dbo.stock_count ORDER BY counted_at DESC`
  );
  return {
    tables,
    latestCount: latest.length ? { date: thaiDateTime(latest[0].counted_text), branch: latest[0].branch } : null,
  };
}

export const STOCK_ACTIONS = {
  getStockItems,
  getStockTotal,
  stockStatus,
};
