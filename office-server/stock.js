// หน้านับสต๊อก / หน้ารวมสต๊อกทุกสาขา — อ่านจาก SQL Server (ฐานข้อมูล InventoryNarai) แทน Google Sheets
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

// ฐานข้อมูลของสต๊อกคือ InventoryNarai คนละตัวกับ narai_hr ของตารางงาน จึงใช้ stockDb
import { sql, stockDb } from './hr-db.js';
import { branchFor } from './hr-session.js';

const { queryRead, withTransaction } = stockDb;
// คำสั่งเขียนที่ไม่ต้องอ่านผลลัพธ์ — ใช้ตัวเดียวกับการอ่าน (mssql ไม่ได้แยก API อ่าน/เขียน)
const runSql = queryRead;

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

const badRequest = (msg) => Object.assign(new Error(msg), { badRequest: true });
const forbidden = (msg) => Object.assign(new Error(msg), { forbidden: true });

/**
 * รหัสสินค้าที่ normalize แล้ว — ต้องให้ผลตรงกับ normalizeId() ของ Apps Script และ
 * scripts/migrate-stock.mjs เป๊ะ ไม่งั้นของที่บันทึกใหม่จะกลายเป็นคนละตัวกับที่ย้ายมา
 */
const normCode = (v) => str(v).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

/** สาขาที่ถือว่าเป็นสาขาเดียวกันตอนค้นข้อมูลเก่า (zjp กับ sjp ใช้ปนกันมาแต่ไหนแต่ไร) */
const branchAliases = (branch) => {
  const b = str(branch).toLowerCase();
  if (b === 'zjp' || b === 'sjp') return ['zjp', 'sjp'];
  return [b];
};

const two = (n) => String(n).padStart(2, '0');

/**
 * เวลาปัจจุบันเป็นข้อความ 'YYYY-MM-DD HH:mm:ss' ตามเวลาเครื่อง (เครื่องนี้ตั้งเป็นเวลาไทย)
 *
 * ไม่ใช้ SYSDATETIME() ของ SQL เพราะต้องเอาค่าเดียวกันไปใช้ทั้งตารางการนับ ยอดยกมา และใบเบิก
 * ให้เป็นเวลาเดียวกันทั้งใบ (การกดบันทึกหนึ่งครั้ง = เวลาเดียว) และต้องรู้ค่าตั้งแต่ก่อนส่งคำสั่ง
 */
function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

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


/* ============================ บันทึกการนับสต๊อก ============================
   แทน saveStock ของ Apps Script — เขียนลง SQL อย่างเดียว ไม่เขียนชีทอีกแล้ว

   ของเดิมเขียน 3 ชีทต่อการกดหนึ่งครั้ง (ข้อมูลนับสตอค / ข้อมูลเบิก / ยอดยกมา) สาขาหนึ่งลง
   200-300 รายการ จนเคยชนเพดาน 30 วินาทีของ Apps Script แล้วหน้าเว็บตัดทิ้งก่อน ผู้ใช้กดซ้ำ
   จึงได้ข้อมูลซ้ำและเลขที่ใบเบิกซ้อนกัน ที่นี่ทั้งหมดอยู่ใน transaction เดียว — สำเร็จหมดหรือ
   ไม่เกิดอะไรเลย และการกดซ้ำในวินาทีเดียวกันจะถูกกันด้วย unique key (สาขา+สินค้า+เวลา) */
async function saveStock(body, session) {
  const branch = str(branchFor(session, body.branch));
  if (!branch) throw badRequest('ไม่ระบุสาขา');

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) throw badRequest('ไม่มีรายการที่จะบันทึก');

  const counterName = str(body.counterName) || str(body.username) || str(session?.username);
  const requesterName = str(body.requesterName);
  const requestDate = str(body.requestDate);
  const savedAt = localStamp();

  const counts = [];
  const requests = [];
  for (const it of items) {
    const code = str(it.productId ?? it.itemCode);
    const key = normCode(code);
    if (!key) continue;

    // ช่องคงเหลือที่ "ไม่ได้กรอก" ต่างจากกรอก 0 — ไม่กรอก = ไม่ได้นับ ไม่ต้องบันทึกเป็นการนับ
    const remaining = it.remaining;
    if (remaining !== null && remaining !== undefined && str(remaining) !== '') {
      counts.push({
        key,
        code,
        name: str(it.name),
        unit: str(it.unit),
        remaining: num(remaining),
      });
    }

    const requested = Number(it.requested);
    if (Number.isFinite(requested) && requested > 0) {
      requests.push({
        key,
        code,
        name: str(it.name),
        unit: str(it.unit),
        qty: requested,
      });
    }
  }

  if (counts.length === 0 && requests.length === 0) {
    throw badRequest('ไม่มีรายการที่จะบันทึก (ไม่ได้กรอกยอดคงเหลือหรือจำนวนขอเบิก)');
  }

  const result = await withTransaction(async (run) => {
    let docNo = '';

    if (requests.length > 0) {
      // เลขที่ใบเบิกรูปแบบเดิมทุกตัวอักษร: 3 ตัวแรกของสาขา + ปี 2 หลัก + เดือน + ลำดับ 3 หลัก (CRM2608001)
      // UPDLOCK/HOLDLOCK กันสองสาขา (หรือคนเดียวกดสองครั้ง) จองเลขเดียวกันพร้อมกัน —
      // ของเดิมใช้ LockService ของ Apps Script ทำหน้าที่นี้
      const d = new Date();
      const prefix = `${branch.slice(0, 3).toUpperCase()}${String(d.getFullYear()).slice(-2)}${two(d.getMonth() + 1)}`;
      const r = await run(
        `SELECT ISNULL(MAX(TRY_CONVERT(INT, SUBSTRING(doc_no, @plen + 1, 10))), 0) + 1 AS next_no
           FROM dbo.stock_request WITH (UPDLOCK, HOLDLOCK)
          WHERE branch = @branch AND doc_no LIKE @prefix + '%'`,
        {
          branch: { type: sql.NVarChar(50), value: branch.toLowerCase() },
          prefix: { type: sql.NVarChar(50), value: prefix },
          plen: prefix.length,
        }
      );
      const next = Number(r.recordset?.[0]?.next_no || 1);
      docNo = `${prefix}${String(next).padStart(3, '0')}`;
    }

    // ยิงทีละแถวโดยตั้งใจ — ชุดหนึ่งไม่เกิน 300 แถว บน localhost จึงจบในหลักไม่กี่ร้อยมิลลิวินาที
    // และได้ IF NOT EXISTS กันการกดซ้ำรายแถว ซึ่ง INSERT ก้อนเดียวทำไม่ได้ (ชนคีย์แล้วล้มทั้งชุด)
    for (const c of counts) {
      await run(
        `IF NOT EXISTS (SELECT 1 FROM dbo.stock_count
                         WHERE branch = @branch AND item_key = @item_key
                           AND counted_at = CONVERT(DATETIME2(0), @counted_at, 120))
         INSERT INTO dbo.stock_count (counted_at, branch, item_key, item_code, item_name, unit, remaining, counter_name)
         VALUES (CONVERT(DATETIME2(0), @counted_at, 120), @branch, @item_key, @item_code, @item_name, @unit, @remaining, @counter_name);`,
        {
          counted_at: { type: sql.NVarChar(19), value: savedAt },
          branch: { type: sql.NVarChar(50), value: branch.toLowerCase() },
          item_key: { type: sql.NVarChar(50), value: c.key },
          item_code: { type: sql.NVarChar(50), value: c.code },
          item_name: { type: sql.NVarChar(255), value: c.name || null },
          unit: { type: sql.NVarChar(50), value: c.unit || null },
          remaining: { type: sql.Decimal(18, 3), value: c.remaining },
          counter_name: { type: sql.NVarChar(255), value: counterName || null },
        }
      );

      // ยอดยกมา = ยอดที่เพิ่งนับ (กติกาเดิมของชีท 'ยอดยกมา' ที่ถูกเขียนทับทุกครั้งที่นับ)
      await run(
        `MERGE dbo.stock_balance AS t
         USING (SELECT @branch AS branch, @item_key AS item_key) AS s
           ON t.branch = s.branch AND t.item_key = s.item_key
         WHEN MATCHED THEN UPDATE SET
           item_code = @item_code, item_name = @item_name, balance = @balance,
           updated_at = CONVERT(DATETIME2(0), @updated_at, 120)
         WHEN NOT MATCHED THEN INSERT (branch, item_key, item_code, item_name, balance, updated_at)
           VALUES (@branch, @item_key, @item_code, @item_name, @balance, CONVERT(DATETIME2(0), @updated_at, 120));`,
        {
          branch: { type: sql.NVarChar(50), value: branch.toLowerCase() },
          item_key: { type: sql.NVarChar(50), value: c.key },
          item_code: { type: sql.NVarChar(50), value: c.code },
          item_name: { type: sql.NVarChar(255), value: c.name || null },
          balance: { type: sql.Decimal(18, 3), value: c.remaining },
          updated_at: { type: sql.NVarChar(19), value: savedAt },
        }
      );
    }

    for (const q of requests) {
      await run(
        `IF NOT EXISTS (SELECT 1 FROM dbo.stock_request WHERE doc_no = @doc_no AND item_key = @item_key)
         INSERT INTO dbo.stock_request
           (doc_no, saved_at, branch, item_key, item_code, item_name, unit, qty, request_date, requester)
         VALUES (@doc_no, CONVERT(DATETIME2(0), @saved_at, 120), @branch, @item_key, @item_code,
                 @item_name, @unit, @qty, @request_date, @requester);`,
        {
          doc_no: { type: sql.NVarChar(50), value: docNo },
          saved_at: { type: sql.NVarChar(19), value: savedAt },
          branch: { type: sql.NVarChar(50), value: branch.toLowerCase() },
          item_key: { type: sql.NVarChar(50), value: q.key },
          item_code: { type: sql.NVarChar(50), value: q.code },
          item_name: { type: sql.NVarChar(255), value: q.name || null },
          unit: { type: sql.NVarChar(50), value: q.unit || null },
          qty: { type: sql.Decimal(18, 3), value: q.qty },
          request_date: { type: sql.NVarChar(30), value: requestDate || null },
          requester: { type: sql.NVarChar(255), value: requesterName || null },
        }
      );
    }

    return { docNo };
  });

  return {
    message: 'บันทึกข้อมูลเรียบร้อยแล้ว' + (result.docNo ? ` (เลขที่ใบเบิก: ${result.docNo})` : ''),
    requisitionNo: result.docNo,
    counted: counts.length,
    requested: requests.length,
    savedAt,
  };
}

/* ========================= หมวดจัดเก็บของแต่ละสาขา ========================= */
async function updateStorageCategory(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const code = str(body.productId);
  const key = normCode(code);
  if (!branch || !key) throw badRequest('ไม่ระบุสาขาหรือรหัสสินค้า');

  await runSql(
    `MERGE dbo.stock_storage_category AS t
     USING (SELECT @branch AS branch, @item_key AS item_key) AS s
       ON t.branch = s.branch AND t.item_key = s.item_key
     WHEN MATCHED THEN UPDATE SET
       item_code = @item_code, item_name = @item_name, category = @category, updated_at = SYSDATETIME()
     WHEN NOT MATCHED THEN INSERT (branch, item_key, item_code, item_name, category)
       VALUES (@branch, @item_key, @item_code, @item_name, @category);`,
    {
      branch: { type: sql.NVarChar(50), value: branch },
      item_key: { type: sql.NVarChar(50), value: key },
      item_code: { type: sql.NVarChar(50), value: code },
      item_name: { type: sql.NVarChar(255), value: str(body.name) || null },
      category: { type: sql.NVarChar(150), value: str(body.category) || null },
    }
  );
  return { message: 'อัปเดตหมวดจัดเก็บเรียบร้อยแล้ว' };
}

/* ===================== ค่าตั้งเบิกของแต่ละสินค้า (สูตรเบิก) =====================
   หน้านับสต๊อกใช้คำนวณยอดเบิกอัตโนมัติ เลือกวิธีคิดได้ 2 แบบต่อสินค้าต่อสาขา (calc_mode)
     'avg' — ยอดเบิก = ค่าเฉลี่ยต่อหัว x จำนวนหัวที่คาด - คงเหลือ
     'par' — ยอดเบิก = ค่าเติมเต็มสตอค - คงเหลือ (ของที่ยอดใช้ไม่ผูกกับจำนวนลูกค้า) */

/** โหมดคำนวณที่ยอมรับ — ค่าอื่นถือว่าไม่ได้ระบุ แล้วตกเป็น 'avg' ตามพฤติกรรมเดิม */
const calcModeOf = (v) => (str(v).toLowerCase() === 'par' ? 'par' : 'avg');

async function saveAvgPerHead(body, session) {
  // แก้ค่าตั้งเบิกได้เฉพาะ user สิทธิ์ all — ค่านี้เป็นตัวตั้งของสูตร "คำนวณยอดเบิก" ของสาขา
  // (หน้าเว็บซ่อนช่องกรอกให้แล้ว ตรงนี้กันซ้ำอีกชั้นเผื่อเรียก API ตรงๆ เหมือนกติกาสาขาใน branchFor)
  if (!session?.isAll) throw forbidden('แก้ไขค่าเฉลี่ยต่อหัวได้เฉพาะผู้ใช้สิทธิ์ all');

  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const code = str(body.code);
  const key = normCode(code);
  // mode ไม่ส่งมา = 'avg' — คำขอเวอร์ชันเก่าที่รู้จักแต่ค่าเฉลี่ยต่อหัวจึงทำงานเหมือนเดิม
  const mode = calcModeOf(body.mode);
  // ส่ง value มาว่าง = แค่สลับโหมด ไม่แตะตัวเลข (ติ๊กช่องก่อนแล้วค่อยพิมพ์ตัวเลขทีหลังได้)
  const hasValue = body.value !== undefined && body.value !== null && str(body.value) !== '';
  const value = hasValue ? Number(body.value) : null;
  const label = mode === 'par' ? 'ค่าเติมเต็มสตอค' : 'ค่าเฉลี่ยต่อหัว';
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  if (!key) throw badRequest('ไม่ระบุรหัสสินค้า');
  if (hasValue && (!Number.isFinite(value) || value < 0)) throw badRequest(`${label}ไม่ถูกต้อง`);

  // แถวเก่าของสาขานี้อาจถูกบันทึกไว้ใต้ชื่อ sjp หรือ zjp — เก็บให้เหลือชุดเดียวตามที่ส่งมา
  // ไม่งั้นแก้ค่าแล้วยังอ่านเจอค่าเก่าจากอีก alias หนึ่ง
  //
  // แต่ละคำขอแตะตัวเลขของโหมดที่ส่งมาโหมดเดียว อีกโหมดคงค่าเดิมไว้ (@avg_qty/@par_qty เป็น NULL
  // แล้วใช้ ISNULL คร่อม) — สลับโหมดกลับไปกลับมาแล้วค่าที่เคยตั้งไว้ต้องไม่หาย
  await runSql(
    `DELETE FROM dbo.stock_avg_per_head
      WHERE item_key = @item_key AND branch IN (@b0, @b1) AND branch <> @branch;

     MERGE dbo.stock_avg_per_head AS t
     USING (SELECT @branch AS branch, @item_key AS item_key) AS s
       ON t.branch = s.branch AND t.item_key = s.item_key
     WHEN MATCHED THEN UPDATE SET
       item_code = @item_code, item_name = ISNULL(NULLIF(@item_name, N''), t.item_name),
       avg_qty = ISNULL(@avg_qty, t.avg_qty), par_qty = ISNULL(@par_qty, t.par_qty),
       calc_mode = @calc_mode, updated_at = SYSDATETIME()
     WHEN NOT MATCHED THEN INSERT (branch, item_key, item_code, item_name, avg_qty, par_qty, calc_mode)
       VALUES (@branch, @item_key, @item_code, @item_name, ISNULL(@avg_qty, 0), @par_qty, @calc_mode);`,
    {
      branch: { type: sql.NVarChar(50), value: branch },
      b0: { type: sql.NVarChar(50), value: branchAliases(branch)[0] },
      b1: { type: sql.NVarChar(50), value: branchAliases(branch)[1] || branch },
      item_key: { type: sql.NVarChar(50), value: key },
      item_code: { type: sql.NVarChar(50), value: code },
      item_name: { type: sql.NVarChar(255), value: str(body.name) },
      calc_mode: { type: sql.NVarChar(10), value: mode },
      avg_qty: { type: sql.Decimal(18, 4), value: mode === 'avg' ? value : null },
      par_qty: { type: sql.Decimal(18, 4), value: mode === 'par' ? value : null },
    }
  );
  return { message: `บันทึก${label}แล้ว`, branch, code, mode, value };
}

/**
 * ค่าตั้งเบิกของสาขา
 *
 * data ยังเป็น { รหัสสินค้า: ค่าเฉลี่ยต่อหัว } รูปแบบเดิมทุกประการ ส่วนโหมด par ต่อท้ายมาเป็น
 * modes/par แยกก้อน — หน้าเว็บเวอร์ชันเก่าที่ยังไม่รู้จักโหมด par จึงอ่าน data ก้อนเดิมทำงานได้ปกติ
 * (สำคัญตอน deploy: เครื่องออฟฟิศกับหน้าเว็บอัปเดตไม่พร้อมกันได้ ไม่ล็อกลำดับ)
 *
 * แถวโหมด par ที่ไม่เคยตั้งค่าเฉลี่ย (avg_qty = 0) ต้องติดมาด้วย ไม่งั้นหน้าเว็บจะไม่รู้ว่า
 * สินค้าตัวนั้นถูกติ๊กเป็นโหมด par ไว้ — เงื่อนไข WHERE จึงยอมทั้งสองแบบ
 */
async function getAvgPerHead(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  const alias = branchAliases(branch);
  const rows = await queryRead(
    `SELECT item_key, avg_qty, par_qty, calc_mode FROM dbo.stock_avg_per_head
      WHERE branch IN (@b0, @b1) AND (avg_qty > 0 OR calc_mode = N'par')`,
    {
      b0: { type: sql.NVarChar(50), value: alias[0] },
      b1: { type: sql.NVarChar(50), value: alias[1] || alias[0] },
    }
  );
  const data = {};   // { item_key: ค่าเฉลี่ยต่อหัว } — เฉพาะที่มีค่าจริง เหมือนเดิม
  const modes = {};  // { item_key: 'par' } — ใส่เฉพาะโหมด par, ไม่มีในนี้ = โหมด avg
  const par = {};    // { item_key: ค่าเติมเต็มสตอค }
  for (const r of rows) {
    const avg = Number(r.avg_qty);
    if (avg > 0) data[r.item_key] = avg;
    if (calcModeOf(r.calc_mode) === 'par') modes[r.item_key] = 'par';
    if (r.par_qty !== null && r.par_qty !== undefined) par[r.item_key] = Number(r.par_qty);
  }
  return { branch, count: rows.length, data, modes, par };
}

/* =================== เปอร์เซ็นต์การเบิกของแต่ละสาขา ===================
   หนึ่งแถวต่อวันต่อสาขา ค่าที่ส่งมาเป็น 0 หรือติดลบ = สั่งลบวันนั้นทิ้ง (กติกาเดิม) */
async function saveBranchPercentagesBulk(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (updates.length === 0) return { message: 'ไม่มีรายการที่ต้องบันทึก', saved: 0, deleted: 0 };

  let saved = 0;
  let deleted = 0;
  await withTransaction(async (run) => {
    for (const u of updates) {
      const date = str(u.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

      // สาขาที่มีหัว 2 ราคาส่ง percent259/percent359 มาแยก แล้วรวมเป็นยอดรวมให้เอง
      const split = u.percent259 !== undefined || u.percent359 !== undefined;
      const p259 = split ? (Number(u.percent259) || 0) : null;
      const p359 = split ? (Number(u.percent359) || 0) : null;
      const percent = split ? p259 + p359 : (Number(u.percent) || 0);

      const params = {
        percent_date: { type: sql.NVarChar(10), value: date },
        branch: { type: sql.NVarChar(50), value: branch },
      };
      if (percent <= 0) {
        await run(
          `DELETE FROM dbo.stock_branch_percent
            WHERE percent_date = CONVERT(DATE, @percent_date, 120) AND branch = @branch`,
          params
        );
        deleted++;
        continue;
      }
      await run(
        `MERGE dbo.stock_branch_percent AS t
         USING (SELECT CONVERT(DATE, @percent_date, 120) AS percent_date, @branch AS branch) AS s
           ON t.percent_date = s.percent_date AND t.branch = s.branch
         WHEN MATCHED THEN UPDATE SET
           percent_value = @percent_value, qty_259 = @qty_259, qty_359 = @qty_359, updated_at = SYSDATETIME()
         WHEN NOT MATCHED THEN INSERT (percent_date, branch, percent_value, qty_259, qty_359)
           VALUES (s.percent_date, @branch, @percent_value, @qty_259, @qty_359);`,
        {
          ...params,
          percent_value: { type: sql.Decimal(9, 4), value: percent },
          qty_259: { type: sql.Decimal(18, 3), value: p259 },
          qty_359: { type: sql.Decimal(18, 3), value: p359 },
        }
      );
      saved++;
    }
  });

  return { message: 'บันทึกเปอร์เซ็นต์เรียบร้อยแล้ว', saved, deleted };
}

/** เปอร์เซ็นต์การเบิกของสาขา — รูปแบบเดียวกับที่ /api/stockcount?getpercentages=1 เคยคืน */
async function getBranchPercent(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  const alias = branchAliases(branch);
  const rows = await queryRead(
    `SELECT CONVERT(NVARCHAR(10), percent_date, 23) AS date_text, percent_value, qty_259, qty_359
       FROM dbo.stock_branch_percent
      WHERE branch IN (@b0, @b1)
      ORDER BY percent_date`,
    {
      b0: { type: sql.NVarChar(50), value: alias[0] },
      b1: { type: sql.NVarChar(50), value: alias[1] || alias[0] },
    }
  );
  return {
    branch,
    data: rows.map((r) => ({
      date: r.date_text,
      percent: Number(r.percent_value ?? 0),
      // ไม่ใส่คีย์เลยเมื่อไม่มีค่า — ฝั่งเว็บแยก "ไม่เคยกรอก" กับ "กรอกเป็น 0" ด้วย undefined
      ...(r.qty_259 === null || r.qty_259 === undefined ? {} : { percent259: Number(r.qty_259) }),
      ...(r.qty_359 === null || r.qty_359 === undefined ? {} : { percent359: Number(r.qty_359) }),
    })),
  };
}


/* ====================== รายการสินค้าแบบเบา (ปิดยอดสิ้นเดือน) ======================
   หน้าปิดยอดใช้แค่ รหัส/ชื่อ/หน่วย/ราคา จึงไม่ต้องแตะตารางการนับที่มีเป็นแสนแถว */
async function getClosingItems(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  if (!branch) return [];
  const rows = await queryRead(
    `SELECT i.item_code, i.item_name, i.unit, i.price
       FROM dbo.stock_item i
       JOIN dbo.stock_item_branch b ON b.item_key = i.item_key
      WHERE b.branch = @itemBranch AND ISNULL(i.status, N'') <> N'ปิดการใช้งาน'
      ORDER BY i.sort_order, i.item_code`,
    { itemBranch: { type: sql.NVarChar(50), value: itemBranchOf(branch) } }
  );
  return rows.map((r) => ({
    productId: r.item_code,
    name: r.item_name || '',
    unit: str(r.unit),
    price: r.price === null || r.price === undefined ? '' : Number(r.price),
  }));
}

/* ============================ ปิดยอดสิ้นเดือน ============================ */
async function saveMonthEndClosing(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const date = str(body.date);
  const recorder = str(body.recorder) || str(session?.username) || 'Unknown';
  const items = Array.isArray(body.items) ? body.items : [];
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('ไม่ระบุวันที่ปิดยอด');
  if (items.length === 0) throw badRequest('ไม่มีรายการที่กรอกยอดคงเหลือ');

  const rows = [];
  let total = 0;
  for (const it of items) {
    const qty = Number(it.qty);
    if (!Number.isFinite(qty) || qty < 0) continue;
    const code = str(it.productId);
    const key = normCode(code);
    if (!key) continue;
    const unitPrice = Number(it.price) || 0;
    const amount = Math.round(qty * unitPrice * 100) / 100;
    total += amount;
    rows.push({ key, code, name: str(it.name), unit: str(it.unit), qty, unitPrice, amount });
  }
  if (rows.length === 0) throw badRequest('ไม่มีรายการที่กรอกยอดคงเหลือถูกต้อง');

  const savedAt = localStamp();
  await withTransaction(async (run) => {
    for (const r of rows) {
      await run(
        `INSERT INTO dbo.stock_month_end
           (closing_date, branch, item_key, item_code, item_name, unit, qty, unit_price, amount, recorder, saved_at)
         VALUES (CONVERT(DATE, @closing_date, 120), @branch, @item_key, @item_code, @item_name, @unit,
                 @qty, @unit_price, @amount, @recorder, CONVERT(DATETIME2(0), @saved_at, 120));`,
        {
          closing_date: { type: sql.NVarChar(10), value: date },
          branch: { type: sql.NVarChar(50), value: branch },
          item_key: { type: sql.NVarChar(50), value: r.key },
          item_code: { type: sql.NVarChar(50), value: r.code },
          item_name: { type: sql.NVarChar(255), value: r.name || null },
          unit: { type: sql.NVarChar(50), value: r.unit || null },
          qty: { type: sql.Decimal(18, 3), value: r.qty },
          unit_price: { type: sql.Decimal(18, 4), value: r.unitPrice },
          amount: { type: sql.Decimal(18, 2), value: r.amount },
          recorder: { type: sql.NVarChar(255), value: recorder },
          saved_at: { type: sql.NVarChar(19), value: savedAt },
        }
      );
    }
  });

  return {
    message: `บันทึกยอดปิดสิ้นเดือนแล้ว ${rows.length} รายการ`,
    count: rows.length,
    total: Number(total.toFixed(2)),
  };
}

/**
 * ยอดปิดสิ้นเดือนของสาขา — คืน "ค่าล่าสุดที่เคยบันทึก" ของทุกสินค้า พร้อมประวัติทุกครั้งที่บันทึก
 * (ไม่กรองตามวันที่ที่หน้าเว็บเลือกอยู่ ให้เห็นตัวเลขอ้างอิงล่าสุดเสมอ — กติกาเดิม)
 */
async function getMonthEndClosing(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  if (!branch) return {};
  const rows = await queryRead(
    `SELECT item_key, CONVERT(NVARCHAR(10), closing_date, 23) AS date_text,
            qty, unit_price, amount, recorder,
            CONVERT(NVARCHAR(19), saved_at, 120) AS saved_text
       FROM dbo.stock_month_end
      WHERE branch = @branch
      ORDER BY item_key, closing_id`,
    { branch: { type: sql.NVarChar(50), value: branch } }
  );

  const out = {};
  for (const r of rows) {
    const entry = out[r.item_key] || (out[r.item_key] = { qty: 0, price: 0, amount: 0, date: '', history: [] });
    // แถวที่บันทึกทีหลังทับค่าปัจจุบันเสมอ (เรียงมาตาม closing_id แล้ว)
    entry.qty = Number(r.qty);
    entry.price = Number(r.unit_price);
    entry.amount = Number(r.amount);
    entry.date = r.date_text;
    entry.history.push({
      date: r.date_text,
      qty: Number(r.qty),
      price: Number(r.unit_price),
      amount: Number(r.amount),
      recorder: str(r.recorder),
      time: thaiDateTime(r.saved_text),
    });
  }
  return out;
}

/** แถวปิดยอดดิบๆ ของสาขา — ใช้จาก /api/stockcount ตอนคิดมูลค่าสต๊อกเดือนก่อน */
async function getMonthEndRows(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  if (!branch) return [];
  const month = str(body.month); // 'YYYY-MM' — ไม่ส่งมา = เอาทั้งหมด
  const rows = await queryRead(
    `SELECT CONVERT(NVARCHAR(10), closing_date, 23) AS date_text, item_key, item_code, item_name, unit,
            qty, unit_price, amount
       FROM dbo.stock_month_end
      WHERE branch = @branch
        AND (@month IS NULL OR CONVERT(NVARCHAR(7), closing_date, 23) = @month)
      ORDER BY closing_id`,
    {
      branch: { type: sql.NVarChar(50), value: branch },
      month: { type: sql.NVarChar(7), value: /^\d{4}-\d{2}$/.test(month) ? month : null },
    }
  );
  return rows.map((r) => ({
    date: r.date_text,
    code: r.item_key,
    productId: r.item_code,
    name: r.item_name || '',
    unit: str(r.unit),
    qty: Number(r.qty),
    unitPrice: Number(r.unit_price),
    amount: Number(r.amount),
  }));
}

/**
 * แถวการนับดิบๆ ของสาขา — ใช้จาก /api/stockcount ตอนคิดมูลค่าสต๊อก
 * จำกัดช่วงด้วย from/to ('YYYY-MM-DD') เพราะการ์ดมูลค่าสต๊อกดูแค่เดือนปัจจุบันกับเดือนก่อน
 */
async function getStockCountRows(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  if (!branch) return [];
  const from = str(body.from);
  const to = str(body.to);
  const rows = await queryRead(
    `SELECT CONVERT(NVARCHAR(10), counted_at, 23) AS date_text, item_key, item_code, item_name, unit, remaining
       FROM dbo.stock_count
      WHERE branch = @branch
        AND (@from IS NULL OR counted_at >= CONVERT(DATETIME2(0), @from + ' 00:00:00', 120))
        AND (@to IS NULL OR counted_at <= CONVERT(DATETIME2(0), @to + ' 23:59:59', 120))
      ORDER BY counted_at, count_id`,
    {
      branch: { type: sql.NVarChar(50), value: branch },
      from: { type: sql.NVarChar(10), value: /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null },
      to: { type: sql.NVarChar(10), value: /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : null },
    }
  );
  return rows.map((r) => ({
    date: r.date_text,
    code: r.item_key,
    productId: r.item_code,
    name: r.item_name || '',
    unit: str(r.unit),
    qty: Number(r.remaining),
  }));
}

/* ============================== ของเสีย ============================== */
async function saveWaste(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const recorder = str(body.recorder) || str(session?.username) || 'Unknown';
  const items = Array.isArray(body.items) ? body.items : [];
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  if (items.length === 0) throw badRequest('ไม่มีรายการที่กรอกจำนวนที่เสีย');

  // วันที่ของเสียเลือกได้จากหน้าเว็บ (บันทึกย้อนหลังได้) แยกจากเวลาที่คีย์จริง
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str(body.date)) ? str(body.date) : localStamp().slice(0, 10);
  const keyedAt = localStamp();

  const rows = [];
  for (const it of items) {
    const qty = Number(it.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const code = str(it.productId);
    const key = normCode(code);
    if (!key) continue;
    rows.push({ key, code, name: str(it.name), unit: str(it.unit), qty });
  }
  if (rows.length === 0) throw badRequest('ไม่มีรายการที่กรอกจำนวนที่เสียถูกต้อง');

  await withTransaction(async (run) => {
    for (const r of rows) {
      await run(
        `INSERT INTO dbo.stock_waste (waste_date, branch, item_key, item_code, item_name, unit, qty, recorder, keyed_at)
         VALUES (CONVERT(DATE, @waste_date, 120), @branch, @item_key, @item_code, @item_name, @unit, @qty,
                 @recorder, CONVERT(DATETIME2(0), @keyed_at, 120));`,
        {
          waste_date: { type: sql.NVarChar(10), value: date },
          branch: { type: sql.NVarChar(50), value: branch },
          item_key: { type: sql.NVarChar(50), value: r.key },
          item_code: { type: sql.NVarChar(50), value: r.code },
          item_name: { type: sql.NVarChar(255), value: r.name || null },
          unit: { type: sql.NVarChar(50), value: r.unit || null },
          qty: { type: sql.Decimal(18, 3), value: r.qty },
          recorder: { type: sql.NVarChar(255), value: recorder },
          keyed_at: { type: sql.NVarChar(19), value: keyedAt },
        }
      );
    }
  });

  return { message: `บันทึกของเสียแล้ว ${rows.length} รายการ`, count: rows.length };
}

export const STOCK_ACTIONS = {
  getStockItems,
  getStockTotal,
  stockStatus,
  saveStock,
  updateStorageCategory,
  saveAvgPerHead,
  getAvgPerHead,
  saveBranchPercentagesBulk,
  getBranchPercent,
  getClosingItems,
  saveMonthEndClosing,
  getMonthEndClosing,
  getMonthEndRows,
  getStockCountRows,
  saveWaste,
};
