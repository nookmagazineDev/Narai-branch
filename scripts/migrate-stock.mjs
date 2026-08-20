#!/usr/bin/env node
/**
 * ย้ายข้อมูลหน้านับสต๊อกจาก Google Sheets เข้า MS SQL Server (ฐานข้อมูล InventoryNarai)
 *
 * ย้าย 6 ชุด — ดูโครงตารางและที่มาของแต่ละคอลัมน์ใน docs/schema-stock.sql
 *   items     ชีท 'item' (ไฟล์ BOM)       -> stock_item + stock_item_branch
 *   itemtotal ชีท 'รายการสินค้า'           -> stock_item_total
 *   counts    ชีท 'ข้อมูลนับสตอค'          -> stock_count
 *   balance   ชีท 'ยอดยกมา'                -> stock_balance
 *   requests  ชีท 'ข้อมูลเบิก'              -> stock_request
 *   category  ชีท 'หมวดจัดเก็บสาขา'        -> stock_storage_category
 *   avghead   ชีท 'ค่าเฉลี่ยยอดใช้ต่อหัว'     -> stock_avg_per_head
 *   percent   ชีท 'เปอร์เซ็นการเบิกของแต่ละสาขา' -> stock_branch_percent
 *   monthend  ชีท 'ปิดรอบสิ้นเดือน'          -> stock_month_end
 *   waste     ชีท waste (gid 1493705916)     -> stock_waste
 *
 * วิธีใช้ (รันจากเครื่องที่ต่อฐานข้อมูลได้ — ปกติคือเครื่อง office-server)
 *   1) สร้างตารางก่อน:  sqlcmd -S localhost -U <user> -P <pass> -i docs/schema-stock.sql
 *      (สคริปต์นี้ใช้ package mssql ถ้ายังไม่เคยลง ให้รัน npm install ที่โฟลเดอร์รีโปก่อน
 *       ไม่งั้นจะขึ้น Error: Cannot find module 'mssql' ตอนเขียนจริง)
 *   2) ตั้ง env:        HR_DB_USER, HR_DB_PASSWORD (login เดียวกับตารางงาน)
 *                      HR_DB_HOST=localhost ถ้ารันบนเครื่องที่ออฟฟิศ
 *                      STOCK_DB_NAME ถ้าใช้ชื่อฐานข้อมูลอื่นที่ไม่ใช่ InventoryNarai
 *   3) ดูก่อนว่าจับคอลัมน์ถูกไหม:
 *        node scripts/migrate-stock.mjs --inspect
 *   4) ลองแบบไม่เขียนจริง:
 *        node scripts/migrate-stock.mjs --dry-run
 *   5) ย้ายจริง:
 *        node scripts/migrate-stock.mjs
 *
 * ตัวเลือก
 *   --dry-run        อ่านชีทและสรุปผลอย่างเดียว ไม่เขียนลงฐานข้อมูล
 *   --inspect        พิมพ์แถวแรกๆ ของทุกชีทออกมาดิบๆ ไว้ตรวจว่าคอลัมน์ตรงกับที่โค้ดคาดไว้ไหม
 *   --only=counts    ย้ายเฉพาะบางชุด (items,itemtotal,counts,balance,requests,category,avghead,percent,monthend,waste)
 *   --months=6       ย้ายประวัติการนับย้อนหลังกี่เดือน (ไม่ใส่ = ทั้งหมด)
 *   --csv            ดึงผ่าน export CSV แทน gviz — ต้องใส่ถ้าชีทมีตัวกรองเปิดค้างไว้
 *   --db=InventoryNarai  ฐานข้อมูลปลายทาง (ค่าเริ่มต้นนี้ หรือตั้ง STOCK_DB_NAME ใน env)
 *   --gid-counts=... ระบุ gid ของแท็บเอง (มีครบทุกชุด: --gid-items, --gid-itemtotal,
 *                    --gid-counts, --gid-balance, --gid-requests, --gid-category)
 *
 * ข้อควรรู้
 * - อ่านชีทผ่าน gviz แบบไม่ต้องล็อกอิน ทั้ง 2 ไฟล์ต้องตั้งลิงก์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" ก่อน
 * - gviz คืนเฉพาะแถวที่ผ่าน "ตัวกรอง" ที่เปิดค้างไว้ในชีท ถ้าจำนวนแถวที่ได้ดูน้อยผิดปกติ
 *   ให้รันใหม่ด้วย --csv (export CSV ไม่สนใจตัวกรอง) — ชีทลงตารางงานเคยเจอปัญหานี้มาแล้ว
 * - รันซ้ำได้ ไม่เกิดข้อมูลซ้ำ: ชุดที่เป็นทะเบียน (items/balance/category) ใช้ MERGE ทับของเดิม
 *   ส่วนชุดที่เป็นประวัติ (counts/requests) ข้ามแถวที่มีอยู่แล้ว
 * - รหัสสินค้าเทียบกันด้วยค่าที่ normalize แล้ว (ตัด 0 นำหน้า + ตัวพิมพ์เล็ก) เหมือน Apps Script
 *   ไม่งั้นชีทที่พิมพ์ '00123' กับ '123' จะกลายเป็นคนละตัว
 */

import process from 'node:process';

/* โหลด driver ฐานข้อมูลแบบ lazy — โหมด --inspect/--dry-run ไม่แตะฐานข้อมูล
   จึงไม่ควรบังคับให้ npm install ก่อน (เครื่องที่รันสคริปต์นี้บางเครื่องลง package ไม่ได้) */
let withTransaction;
let closePool;
let describeTarget = () => '';
let describeDbError = (err) => err?.message || String(err);

async function loadDb() {
  if (withTransaction) return;
  let m;
  try {
    m = await import('../lib/mssql.js');
  } catch (err) {
    // เครื่องที่ออฟฟิศมี node_modules อยู่ในโฟลเดอร์ office-server แต่สคริปต์นี้อ่านจากโฟลเดอร์รีโป
    // ถ้ายังไม่เคย npm install ที่รีโป จะพังตรงนี้ด้วยข้อความดิบภาษาอังกฤษที่อ่านไม่ออกว่าต้องทำอะไร
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && /mssql/.test(err?.message || '')) {
      throw new Error(
        "ยังไม่ได้ลง package 'mssql' — รัน npm install ที่โฟลเดอร์รีโป (โฟลเดอร์ที่มี package.json) ก่อน\n" +
        '  โหมด --inspect กับ --dry-run ใช้ได้เลยโดยไม่ต้องลง เพราะไม่แตะฐานข้อมูล'
      );
    }
    throw err;
  }
  // ตารางสต๊อกอยู่คนละฐานข้อมูลกับตารางงาน (InventoryNarai กับ narai_hr) แต่เครื่องและ login เดียวกัน
  m.useDatabase(DB_NAME);
  withTransaction = m.withTransaction;
  closePool = m.closePool;
  describeTarget = m.describeTarget;
  describeDbError = m.describeDbError;
}

/* ---- ไอดีชีทต้นทาง (ตรงกับที่ Apps Script เปิดอยู่ทุกวันนี้) ---- */
const STOCK_SS = '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ'; // ไฟล์สต๊อก
const BOM_SS = '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw';   // ไฟล์ BOM (ชีท item, ค่าเฉลี่ยต่อหัว)
const SUP_SS = '1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw';   // ไฟล์ supplier (เปอร์เซ็นการเบิก)

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DRY_RUN = args.includes('--dry-run');
const INSPECT = args.includes('--inspect');
const USE_CSV = args.includes('--csv');
const MONTHS = Number(argVal('months', '0')) || 0;
const DB_NAME = argVal('db', process.env.STOCK_DB_NAME || 'InventoryNarai');
const ONLY = String(argVal('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const wants = (part) => ONLY.length === 0 || ONLY.includes(part);

/* แต่ละชุดข้อมูล: ไฟล์ไหน แท็บชื่ออะไร และคอลัมน์ที่ใช้ (ตำแหน่งตามที่ Apps Script อ่าน) */
const SOURCES = {
  items: { ss: BOM_SS, sheet: 'item', gid: argVal('gid-items', '') },
  itemtotal: { ss: STOCK_SS, sheet: 'รายการสินค้า', gid: argVal('gid-itemtotal', '') },
  counts: { ss: STOCK_SS, sheet: 'ข้อมูลนับสตอค', gid: argVal('gid-counts', '') },
  balance: { ss: STOCK_SS, sheet: 'ยอดยกมา', gid: argVal('gid-balance', '') },
  requests: { ss: STOCK_SS, sheet: 'ข้อมูลเบิก', gid: argVal('gid-requests', '') },
  category: { ss: STOCK_SS, sheet: 'หมวดจัดเก็บสาขา', gid: argVal('gid-category', '') },
  avghead: { ss: BOM_SS, sheet: 'ค่าเฉลี่ยยอดใช้ต่อหัว', gid: argVal('gid-avghead', '1722427042') },
  percent: { ss: SUP_SS, sheet: 'เปอร์เซ็นการเบิกของแต่ละสาขา', gid: argVal('gid-percent', '') },
  monthend: { ss: STOCK_SS, sheet: 'ปิดรอบสิ้นเดือน', gid: argVal('gid-monthend', '') },
  waste: { ss: STOCK_SS, sheet: 'waste', gid: argVal('gid-waste', '1493705916') },
};

const pad = (n) => String(n).padStart(2, '0');
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * รหัสสินค้าให้เทียบกันได้ข้ามชีท — เหมือน normalizeId() ของ Apps Script
 * เพิ่มการตัด '.0' ท้ายให้ด้วย เพราะบางชีทเก็บรหัสเป็นตัวเลข พอ export CSV จะได้ '123.0'
 * ซึ่งเป็นสินค้าตัวเดียวกับ '123' (api/stockcount.js ก็ตัดแบบนี้อยู่แล้ว)
 */
const normCode = (v) => str(v).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
const branchCode = (v) => str(v).toLowerCase();

/**
 * แปลงค่าวันที่จากชีทเป็นข้อความ 'YYYY-MM-DD HH:mm:ss' ที่ SQL รับได้
 * ต้องรองรับหลายรูปแบบเพราะสองช่องทางให้ค่ามาไม่เหมือนกัน
 *   gviz -> '2026-08-20 14:05:00' (แปลงจาก Date(...) ให้แล้วใน fetchRows)
 *   csv  -> '20/08/2026 14:05:00' หรือ '20/08/2026' ตามรูปแบบที่ตั้งแสดงผลไว้
 * ปี พ.ศ. (2569) แปลงกลับเป็น ค.ศ. ให้ด้วย เพราะบางแถวเก่ากรอกมือมาแบบนั้น
 */
function toSqlDateTime(v) {
  const s = str(v);
  if (!s) return null;
  let y, mo, d, h = 0, mi = 0, sec = 0;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    [, y, mo, d, h = 0, mi = 0, sec = 0] = m;
  } else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    [, d, mo, y, h = 0, mi = 0, sec = 0] = m;
  }
  y = Number(y); mo = Number(mo); d = Number(d);
  if (y > 2400) y -= 543; // พ.ศ. -> ค.ศ.
  if (!y || !mo || !d || mo > 12 || d > 31) return null;
  return `${y}-${pad(mo)}-${pad(d)} ${pad(Number(h) || 0)}:${pad(Number(mi) || 0)}:${pad(Number(sec) || 0)}`;
}

/* ------------------------- อ่านชีท (ยกมาจาก migrate-schedule.mjs) ------------------------- */

async function fetchRowsGviz(spreadsheetId, sheetName, gid) {
  const target = gid ? `&gid=${encodeURIComponent(gid)}` : sheetName ? `&sheet=${encodeURIComponent(sheetName)}` : '';
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&headers=0${target}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) {
    throw new Error(
      `อ่านชีทไม่ได้ (${spreadsheetId} / ${sheetName}) — ตรวจว่าตั้งลิงก์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง`
    );
  }
  const json = JSON.parse(text.slice(start, end + 1));
  const cols = json.table.cols || [];
  return (json.table.rows || []).map((row) =>
    cols.map((_, i) => {
      const cell = row.c && row.c[i];
      if (!cell) return '';
      if (typeof cell.v === 'string') {
        const m = cell.v.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/);
        if (m) {
          const [, y, mo, d, h, mi, s] = m;
          const date = `${y}-${pad(Number(mo) + 1)}-${pad(Number(d))}`;
          return h === undefined ? date : `${date} ${pad(Number(h))}:${pad(Number(mi))}:${pad(Number(s || 0))}`;
        }
      }
      if (cell.v === null || cell.v === undefined) return '';
      return cell.v;
    })
  );
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchRowsCsv(spreadsheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv${gid ? `&gid=${encodeURIComponent(gid)}` : ''}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  if (/^\s*</.test(text)) {
    throw new Error(`ดึง CSV ไม่ได้ (${spreadsheetId} gid=${gid}) — ตรวจการแชร์ลิงก์ของชีท`);
  }
  return parseCsv(text);
}

/**
 * ดึงแถวข้อมูลของชุดหนึ่ง (ตัดหัวตารางออกแล้ว)
 *
 * ทุกชีทที่นี่อ่านด้วย "ตำแหน่งคอลัมน์" เหมือน Apps Script ไม่ได้จับจากชื่อหัวตาราง
 * จึงต้องตัดแถวหัวออกเอง — ดูจากช่องแรกๆ ว่าเป็นคำหัวตารางไหม แทนการตัดแถวแรกทิ้งเสมอ
 * (ถ้าชีทไหนไม่มีหัวตาราง การตัดทิ้งดื้อๆ จะทำให้ข้อมูลจริงหายไปหนึ่งแถวโดยไม่มีอะไรฟ้อง)
 */
async function loadSheet(part) {
  const src = SOURCES[part];
  if (USE_CSV && !src.gid) {
    throw new Error(`--csv ต้องระบุ gid ของแท็บด้วย เช่น --gid-${part}=123456789 (ดูเลขท้าย URL ตอนเปิดแท็บนั้น)`);
  }
  const rows = USE_CSV ? await fetchRowsCsv(src.ss, src.gid) : await fetchRowsGviz(src.ss, src.sheet, src.gid);
  if (rows.length === 0) return rows;
  const first = rows[0].map((c) => str(c));
  const looksLikeHeader = first.some((c) => /^(รหัส|ชื่อ|สาขา|วันที่|เลขที่|หน่วย|จำนวน|ยอด|หมวด|item|code|name|branch)/i.test(c));
  return looksLikeHeader ? rows.slice(1) : rows;
}

/* วันที่เก่าสุดที่จะย้าย (ใช้กับประวัติการนับ) */
const cutoff = (() => {
  if (!MONTHS) return null;
  const d = new Date();
  d.setMonth(d.getMonth() - MONTHS);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00:00`;
})();

/* ------------------------------- ตัวช่วยเขียนลงฐานข้อมูล ------------------------------- */

async function runBatch(label, rows, buildStatement) {
  if (rows.length === 0) {
    console.log(`  ${label}: ไม่มีข้อมูล`);
    return;
  }
  if (DRY_RUN) {
    console.log(`  ${label}: ${rows.length} แถว (dry-run ไม่ได้เขียนลงฐานข้อมูล)`);
    console.log(`    ตัวอย่าง: ${JSON.stringify(rows[0])}`);
    return;
  }
  await loadDb();
  const CHUNK = 200;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await withTransaction(async (run) => {
      for (const row of chunk) {
        const { text, params } = buildStatement(row);
        await run(text, params);
      }
    });
    done += chunk.length;
    process.stdout.write(`\r  ${label}: ${done}/${rows.length} แถว`);
  }
  console.log('');
}

/* --------------------------- ส่วนที่ย้ายแต่ละชุด --------------------------- */

/** ชีท 'item': A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ J=สาขาที่ใช้ K=itemid L=หน่วยเบิก N=หมวดสโตร์ O=Plan */
async function migrateItems() {
  const rows = await loadSheet('items');
  const items = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    const code = str(row[0]);
    const name = str(row[1]);
    if (!code && !name) return;
    const key = normCode(code);
    if (!key) { skipped++; return; }
    const branches = String(row[9] ?? '')
      .toLowerCase()
      .split(/[,\s]+/)
      .map((b) => b.trim())
      .filter(Boolean);
    items.push({
      key,
      code,
      name,
      price: num(row[2]),
      unit: str(row[3]),
      status: str(row[4]),
      branches,
      posItemId: str(row[10]),
      requestUnit: str(row[11]),
      storeCat: str(row[13]),
      planOnly: /^(true|ture)$/i.test(str(row[14])) ? 1 : 0,
      sortOrder: index,
    });
  });
  if (skipped) console.log(`  ข้ามแถวที่ไม่มีรหัสสินค้า ${skipped} แถว`);

  await runBatch('stock_item', items, (it) => ({
    text: `
      MERGE dbo.stock_item AS t
      USING (SELECT @item_key AS item_key) AS s ON t.item_key = s.item_key
      WHEN MATCHED THEN UPDATE SET
        item_code = @item_code, pos_item_id = @pos_item_id, item_name = @item_name,
        unit = @unit, request_unit = @request_unit, price = @price, status = @status,
        store_cat = @store_cat, plan_only = @plan_only, sort_order = @sort_order,
        updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (item_key, item_code, pos_item_id, item_name, unit, request_unit, price, status, store_cat, plan_only, sort_order)
        VALUES (@item_key, @item_code, @pos_item_id, @item_name, @unit, @request_unit, @price, @status, @store_cat, @plan_only, @sort_order);`,
    params: {
      item_key: it.key,
      item_code: it.code,
      pos_item_id: it.posItemId || null,
      item_name: it.name,
      unit: it.unit || null,
      request_unit: it.requestUnit || null,
      price: it.price,
      status: it.status || null,
      store_cat: it.storeCat || null,
      plan_only: it.planOnly,
      sort_order: it.sortOrder,
    },
  }));

  // สาขาที่ใช้สินค้า — ลบของเดิมของสินค้านั้นก่อนแล้วใส่ชุดใหม่
  // (สินค้าที่ถูกถอดออกจากสาขาหนึ่งต้องหายไปจริง ไม่งั้นสาขานั้นจะยังเห็นค้างอยู่ตลอดไป)
  const branchRows = items.filter((it) => it.branches.length > 0);
  await runBatch('stock_item_branch', branchRows, (it) => {
    const params = { item_key: it.key };
    const values = it.branches.map((b, i) => {
      params[`b${i}`] = b;
      return `(@item_key, @b${i})`;
    });
    return {
      text: `DELETE FROM dbo.stock_item_branch WHERE item_key = @item_key;
             INSERT INTO dbo.stock_item_branch (item_key, branch) VALUES ${values.join(', ')};`,
      params,
    };
  });
}

/** ชีท 'รายการสินค้า': A=รหัส B=ชื่อ C=หน่วย D=หมวดสโตร์ E=หมวดจัดเก็บ F=หมวด RD */
async function migrateItemTotal() {
  const rows = await loadSheet('itemtotal');
  const items = [];
  rows.forEach((row, index) => {
    const code = str(row[0]);
    const name = str(row[1]);
    if (!code && !name) return;
    const key = normCode(code);
    if (!key) return;
    items.push({
      key, code, name,
      unit: str(row[2]),
      storeCat: str(row[3]),
      storageCat: str(row[4]),
      rdCat: str(row[5]),
      sortOrder: index,
    });
  });

  await runBatch('stock_item_total', items, (it) => ({
    text: `
      MERGE dbo.stock_item_total AS t
      USING (SELECT @item_key AS item_key) AS s ON t.item_key = s.item_key
      WHEN MATCHED THEN UPDATE SET
        item_code = @item_code, item_name = @item_name, unit = @unit,
        store_cat = @store_cat, storage_cat = @storage_cat, rd_cat = @rd_cat,
        sort_order = @sort_order, updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (item_key, item_code, item_name, unit, store_cat, storage_cat, rd_cat, sort_order)
        VALUES (@item_key, @item_code, @item_name, @unit, @store_cat, @storage_cat, @rd_cat, @sort_order);`,
    params: {
      item_key: it.key,
      item_code: it.code,
      item_name: it.name,
      unit: it.unit || null,
      store_cat: it.storeCat || null,
      storage_cat: it.storageCat || null,
      rd_cat: it.rdCat || null,
      sort_order: it.sortOrder,
    },
  }));
}

/** ชีท 'ข้อมูลนับสตอค': A=วันที่ B=ผู้นับ C=สาขา D=รหัส E=ชื่อ F=หน่วย G=คงเหลือ */
async function migrateCounts() {
  const rows = await loadSheet('counts');
  const counts = [];
  let noDate = 0;
  let noQty = 0;
  const seen = new Set(); // กันแถวซ้ำในชีทเอง (สาขา+สินค้า+เวลาเดียวกัน) ที่จะชน unique key
  for (const row of rows) {
    const countedAt = toSqlDateTime(row[0]);
    const branch = branchCode(row[2]);
    const key = normCode(row[3]);
    const remaining = num(row[6]);
    if (!branch || !key) continue;
    if (!countedAt) { noDate++; continue; }
    if (remaining === null) { noQty++; continue; }
    if (cutoff && countedAt < cutoff) continue;
    const dedupe = `${branch}|${key}|${countedAt}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    counts.push({
      countedAt, branch, key,
      code: str(row[3]),
      name: str(row[4]),
      unit: str(row[5]),
      remaining,
      counter: str(row[1]),
    });
  }
  if (noDate) console.log(`  ข้ามแถวที่อ่านวันที่ไม่ออก ${noDate} แถว`);
  if (noQty) console.log(`  ข้ามแถวที่ไม่มียอดคงเหลือ ${noQty} แถว`);

  // การนับที่เกิดขึ้นแล้วไม่เปลี่ยนย้อนหลัง จึงแค่ "ไม่ใส่ซ้ำ" ไม่ต้องอัปเดตทับ
  await runBatch('stock_count', counts, (c) => ({
    text: `
      IF NOT EXISTS (SELECT 1 FROM dbo.stock_count
                      WHERE branch = @branch AND item_key = @item_key
                        AND counted_at = CONVERT(DATETIME2(0), @counted_at, 120))
      INSERT INTO dbo.stock_count (counted_at, branch, item_key, item_code, item_name, unit, remaining, counter_name)
      VALUES (CONVERT(DATETIME2(0), @counted_at, 120), @branch, @item_key, @item_code, @item_name, @unit, @remaining, @counter_name);`,
    params: {
      counted_at: c.countedAt,
      branch: c.branch,
      item_key: c.key,
      item_code: c.code,
      item_name: c.name || null,
      unit: c.unit || null,
      remaining: c.remaining,
      counter_name: c.counter || null,
    },
  }));
}

/** ชีท 'ยอดยกมา': A=รหัส B=ชื่อ C=สาขา D=ยอดยกมา E=วันที่อัปเดต */
async function migrateBalance() {
  const rows = await loadSheet('balance');
  const byKey = new Map(); // แถวท้ายสุดของสินค้า+สาขาคือค่าล่าสุด (ชีทเดิมเขียนทับแถวเดิมอยู่แล้ว)
  for (const row of rows) {
    const key = normCode(row[0]);
    const branch = branchCode(row[2]);
    const balance = num(row[3]);
    if (!key || !branch || balance === null) continue;
    byKey.set(`${branch}|${key}`, {
      branch, key,
      code: str(row[0]),
      name: str(row[1]),
      balance,
      updatedAt: toSqlDateTime(row[4]),
    });
  }

  await runBatch('stock_balance', [...byKey.values()], (b) => ({
    text: `
      MERGE dbo.stock_balance AS t
      USING (SELECT @branch AS branch, @item_key AS item_key) AS s
        ON t.branch = s.branch AND t.item_key = s.item_key
      WHEN MATCHED THEN UPDATE SET
        item_code = @item_code, item_name = @item_name, balance = @balance,
        updated_at = CONVERT(DATETIME2(0), @updated_at, 120)
      WHEN NOT MATCHED THEN INSERT (branch, item_key, item_code, item_name, balance, updated_at)
        VALUES (@branch, @item_key, @item_code, @item_name, @balance, CONVERT(DATETIME2(0), @updated_at, 120));`,
    params: {
      branch: b.branch,
      item_key: b.key,
      item_code: b.code,
      item_name: b.name || null,
      balance: b.balance,
      updated_at: b.updatedAt,
    },
  }));
}

/** ชีท 'ข้อมูลเบิก': A=เลขที่ใบเบิก B=เวลาบันทึก C=รหัส D=ชื่อ E=หน่วย F=จำนวน G=วันที่เบิก H=ผู้เบิก I=สาขา */
async function migrateRequests() {
  const rows = await loadSheet('requests');
  const list = [];
  const seen = new Set();
  let noBranch = 0;
  for (const row of rows) {
    const docNo = str(row[0]);
    const key = normCode(row[2]);
    const qty = num(row[5]);
    if (!docNo || !key || qty === null) continue;
    // แถวเก่าบางแถวไม่มีสาขา — เดาจาก 3 ตัวแรกของเลขที่ใบเบิก (CRM-2605-0001 -> crm) เหมือน Apps Script
    let branch = branchCode(row[8]);
    if (!branch) {
      branch = docNo.slice(0, 3).toLowerCase();
      noBranch++;
    }
    if (!branch) continue;
    // unique key ของตารางคือ (เลขที่ใบเบิก, สินค้า) — ในชีทมีซ้ำได้ถ้าคีย์สินค้าเดิมสองบรรทัด
    const dedupe = `${docNo}|${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    list.push({
      docNo, branch, key,
      code: str(row[2]),
      name: str(row[3]),
      unit: str(row[4]),
      qty,
      savedAt: toSqlDateTime(row[1]),
      requestDate: str(row[6]),
      requester: str(row[7]),
    });
  }
  if (noBranch) console.log(`  เดาสาขาจากเลขที่ใบเบิก ${noBranch} แถว (ชีทไม่ได้กรอกสาขาไว้)`);

  await runBatch('stock_request', list, (r) => ({
    text: `
      IF NOT EXISTS (SELECT 1 FROM dbo.stock_request WHERE doc_no = @doc_no AND item_key = @item_key)
      INSERT INTO dbo.stock_request (doc_no, saved_at, branch, item_key, item_code, item_name, unit, qty, request_date, requester)
      VALUES (@doc_no, CONVERT(DATETIME2(0), @saved_at, 120), @branch, @item_key, @item_code, @item_name, @unit, @qty, @request_date, @requester);`,
    params: {
      doc_no: r.docNo,
      saved_at: r.savedAt,
      branch: r.branch,
      item_key: r.key,
      item_code: r.code,
      item_name: r.name || null,
      unit: r.unit || null,
      qty: r.qty,
      request_date: r.requestDate || null,
      requester: r.requester || null,
    },
  }));
}

/** ชีท 'หมวดจัดเก็บสาขา': A=รหัส B=ชื่อ C=สาขา D=หมวดจัดเก็บ */
async function migrateCategory() {
  const rows = await loadSheet('category');
  const byKey = new Map();
  rows.forEach((row, index) => {
    const key = normCode(row[0]);
    const branch = branchCode(row[2]);
    if (!key || !branch) return;
    const id = `${branch}|${key}`;
    const prev = byKey.get(id);
    byKey.set(id, {
      branch, key,
      code: str(row[0]),
      name: str(row[1]),
      category: str(row[3]),
      // หมวดที่ใช้จริง = แถวท้ายสุด (หน้าเว็บอ่านแบบเขียนทับไปเรื่อยๆ)
      // แต่ลำดับแถวเก็บของ "แถวแรก" ไว้ เพราะหน้ารวมสต๊อกใช้หมวดของแถวที่เจอก่อน
      sheetRow: prev ? prev.sheetRow : index,
    });
  });

  await runBatch('stock_storage_category', [...byKey.values()], (c) => ({
    text: `
      MERGE dbo.stock_storage_category AS t
      USING (SELECT @branch AS branch, @item_key AS item_key) AS s
        ON t.branch = s.branch AND t.item_key = s.item_key
      WHEN MATCHED THEN UPDATE SET
        item_code = @item_code, item_name = @item_name, category = @category,
        sheet_row = @sheet_row, updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT (branch, item_key, item_code, item_name, category, sheet_row)
        VALUES (@branch, @item_key, @item_code, @item_name, @category, @sheet_row);`,
    params: {
      branch: c.branch,
      item_key: c.key,
      item_code: c.code,
      item_name: c.name || null,
      category: c.category || null,
      sheet_row: c.sheetRow,
    },
  }));
}

/** ชีท 'ค่าเฉลี่ยยอดใช้ต่อหัว' (ไฟล์ BOM): A=สาขา B=รหัส C=ชื่อ D=ค่าเฉลี่ยต่อหัว */
async function migrateAvgPerHead() {
  const rows = await loadSheet('avghead');
  const byKey = new Map();
  for (const row of rows) {
    const branch = branchCode(row[0]);
    const key = normCode(row[1]);
    const value = num(row[3]);
    if (!branch || !key || value === null || value <= 0) continue;
    byKey.set(`${branch}|${key}`, { branch, key, code: str(row[1]), name: str(row[2]), value });
  }

  await runBatch('stock_avg_per_head', [...byKey.values()], (a) => ({
    text: `
      MERGE dbo.stock_avg_per_head AS t
      USING (SELECT @branch AS branch, @item_key AS item_key) AS s
        ON t.branch = s.branch AND t.item_key = s.item_key
      WHEN MATCHED THEN UPDATE SET
        item_code = @item_code, item_name = @item_name, avg_qty = @avg_qty, updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT (branch, item_key, item_code, item_name, avg_qty)
        VALUES (@branch, @item_key, @item_code, @item_name, @avg_qty);`,
    params: {
      branch: a.branch,
      item_key: a.key,
      item_code: a.code,
      item_name: a.name || null,
      avg_qty: a.value,
    },
  }));
}

/** ชีท 'เปอร์เซ็นการเบิกของแต่ละสาขา' (ไฟล์ supplier): A=วันที่ B=สาขา C=เปอร์เซ็น D=จำนวน259 E=จำนวน359 */
async function migrateBranchPercent() {
  const rows = await loadSheet('percent');
  const byKey = new Map();
  let noDate = 0;
  for (const row of rows) {
    const stamp = toSqlDateTime(row[0]);
    const branch = branchCode(row[1]);
    if (!branch) continue;
    if (!stamp) { noDate++; continue; }
    const date = stamp.slice(0, 10);
    const percent = num(row[2]);
    if (percent === null || percent <= 0) continue;
    // แถวท้ายสุดของวัน+สาขาเดียวกันคือค่าที่ใช้จริง (ชีทเดิมเขียนทับแถวเดิมอยู่แล้ว)
    byKey.set(`${branch}|${date}`, {
      branch, date, percent,
      p259: num(row[3]),
      p359: num(row[4]),
    });
  }
  if (noDate) console.log(`  ข้ามแถวที่อ่านวันที่ไม่ออก ${noDate} แถว`);

  await runBatch('stock_branch_percent', [...byKey.values()], (p) => ({
    text: `
      MERGE dbo.stock_branch_percent AS t
      USING (SELECT CONVERT(DATE, @percent_date, 120) AS percent_date, @branch AS branch) AS s
        ON t.percent_date = s.percent_date AND t.branch = s.branch
      WHEN MATCHED THEN UPDATE SET
        percent_value = @percent_value, qty_259 = @qty_259, qty_359 = @qty_359, updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT (percent_date, branch, percent_value, qty_259, qty_359)
        VALUES (s.percent_date, @branch, @percent_value, @qty_259, @qty_359);`,
    params: {
      percent_date: p.date,
      branch: p.branch,
      percent_value: p.percent,
      qty_259: p.p259,
      qty_359: p.p359,
    },
  }));
}

/** ชีท 'ปิดรอบสิ้นเดือน': A=วันที่ปิดยอด B=สาขา C=รหัส D=ชื่อ E=หน่วย F=ยอด G=มูลค่า/หน่วย H=มูลค่ารวม I=ผู้บันทึก J=เวลาบันทึก */
async function migrateMonthEnd() {
  const rows = await loadSheet('monthend');
  const list = [];
  const seen = new Set();
  let noDate = 0;
  for (const row of rows) {
    const stamp = toSqlDateTime(row[0]);
    const branch = branchCode(row[1]);
    const key = normCode(row[2]);
    const qty = num(row[5]);
    if (!branch || !key || qty === null) continue;
    if (!stamp) { noDate++; continue; }
    const savedAt = toSqlDateTime(row[9]) || stamp;
    // ชีทเป็น log ต่อท้าย บันทึกซ้ำวันเดิมได้ — คีย์กันซ้ำจึงต้องรวมเวลาที่บันทึกด้วย
    const dedupe = `${branch}|${key}|${stamp.slice(0, 10)}|${savedAt}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    list.push({
      date: stamp.slice(0, 10), branch, key,
      code: str(row[2]),
      name: str(row[3]),
      unit: str(row[4]),
      qty,
      unitPrice: num(row[6]) ?? 0,
      amount: num(row[7]) ?? 0,
      recorder: str(row[8]),
      savedAt,
    });
  }
  if (noDate) console.log(`  ข้ามแถวที่อ่านวันที่ไม่ออก ${noDate} แถว`);

  await runBatch('stock_month_end', list, (m) => ({
    text: `
      IF NOT EXISTS (SELECT 1 FROM dbo.stock_month_end
                      WHERE branch = @branch AND item_key = @item_key
                        AND closing_date = CONVERT(DATE, @closing_date, 120)
                        AND saved_at = CONVERT(DATETIME2(0), @saved_at, 120))
      INSERT INTO dbo.stock_month_end
        (closing_date, branch, item_key, item_code, item_name, unit, qty, unit_price, amount, recorder, saved_at)
      VALUES (CONVERT(DATE, @closing_date, 120), @branch, @item_key, @item_code, @item_name, @unit,
              @qty, @unit_price, @amount, @recorder, CONVERT(DATETIME2(0), @saved_at, 120));`,
    params: {
      closing_date: m.date,
      branch: m.branch,
      item_key: m.key,
      item_code: m.code,
      item_name: m.name || null,
      unit: m.unit || null,
      qty: m.qty,
      unit_price: m.unitPrice,
      amount: m.amount,
      recorder: m.recorder || null,
      saved_at: m.savedAt,
    },
  }));
}

/** ชีท waste: A=วันที่ของเสีย B=สาขา C=รหัส D=ชื่อ E=หน่วย F=จำนวนที่เสีย G=ผู้บันทึก H=เวลาที่คีย์ */
async function migrateWaste() {
  const rows = await loadSheet('waste');
  const list = [];
  const seen = new Set();
  for (const row of rows) {
    const stamp = toSqlDateTime(row[0]);
    const branch = branchCode(row[1]);
    const key = normCode(row[2]);
    const qty = num(row[5]);
    if (!branch || !key || !stamp || qty === null || qty <= 0) continue;
    const keyedAt = toSqlDateTime(row[7]) || stamp;
    const dedupe = `${branch}|${key}|${stamp.slice(0, 10)}|${keyedAt}|${qty}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    list.push({
      date: stamp.slice(0, 10), branch, key,
      code: str(row[2]), name: str(row[3]), unit: str(row[4]), qty,
      recorder: str(row[6]), keyedAt,
    });
  }

  await runBatch('stock_waste', list, (w) => ({
    text: `
      IF NOT EXISTS (SELECT 1 FROM dbo.stock_waste
                      WHERE branch = @branch AND item_key = @item_key
                        AND waste_date = CONVERT(DATE, @waste_date, 120)
                        AND keyed_at = CONVERT(DATETIME2(0), @keyed_at, 120) AND qty = @qty)
      INSERT INTO dbo.stock_waste (waste_date, branch, item_key, item_code, item_name, unit, qty, recorder, keyed_at)
      VALUES (CONVERT(DATE, @waste_date, 120), @branch, @item_key, @item_code, @item_name, @unit, @qty,
              @recorder, CONVERT(DATETIME2(0), @keyed_at, 120));`,
    params: {
      waste_date: w.date,
      branch: w.branch,
      item_key: w.key,
      item_code: w.code,
      item_name: w.name || null,
      unit: w.unit || null,
      qty: w.qty,
      recorder: w.recorder || null,
      keyed_at: w.keyedAt,
    },
  }));
}

/* -------------------------------- โหมดตรวจชีท -------------------------------- */

async function inspectSheets() {
  for (const part of Object.keys(SOURCES)) {
    if (!wants(part)) continue;
    const src = SOURCES[part];
    console.log(`\n=== ${part} — ${src.sheet} (${src.ss.slice(0, 12)}…) ===`);
    try {
      const rows = await loadSheet(part);
      console.log(`  แถวข้อมูล ${rows.length} แถว`);
      rows.slice(0, 3).forEach((row, i) => {
        console.log(`  [${i}] ${JSON.stringify(row.slice(0, 15))}`);
      });
    } catch (err) {
      console.log(`  อ่านไม่ได้: ${err.message}`);
    }
  }
}

/* ---------------------------------- main ---------------------------------- */

const PARTS = [
  ['items', migrateItems],
  ['itemtotal', migrateItemTotal],
  ['counts', migrateCounts],
  ['balance', migrateBalance],
  ['requests', migrateRequests],
  ['category', migrateCategory],
  ['avghead', migrateAvgPerHead],
  ['percent', migrateBranchPercent],
  ['monthend', migrateMonthEnd],
  ['waste', migrateWaste],
];

async function main() {
  if (INSPECT) {
    await inspectSheets();
    return;
  }

  console.log(DRY_RUN ? 'โหมดทดลอง (ไม่เขียนลงฐานข้อมูล)' : `เริ่มย้ายข้อมูลเข้าฐานข้อมูล ${DB_NAME}`);
  if (MONTHS) console.log(`ประวัติการนับ: ย้อนหลัง ${MONTHS} เดือน (ตั้งแต่ ${cutoff})`);
  if (USE_CSV) console.log('ช่องทางอ่านชีท: export CSV');

  for (const [part, run] of PARTS) {
    if (!wants(part)) continue;
    console.log(`\n[${part}] ${SOURCES[part].sheet}`);
    await run();
  }

  if (!DRY_RUN && closePool) await closePool();
  console.log(`\nเสร็จแล้ว${DRY_RUN ? '' : ` (${describeTarget()})`}`);
}

main().catch(async (err) => {
  console.error('\nล้มเหลว:', describeDbError(err));
  if (closePool) await closePool().catch(() => {});
  process.exitCode = 1;
});
