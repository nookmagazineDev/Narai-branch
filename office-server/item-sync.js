// ซิงก์ทะเบียนสินค้า: ชีท 'item' (ไฟล์ BOM) -> dbo.stock_item + dbo.stock_item_branch
//
// ทำไมต้องมี
// ---------------------------------------------------------------------------
// ทะเบียนสินค้าตัวจริงที่ฝ่ายจัดซื้อกรอกคือชีท 'item' ส่วน dbo.stock_item เป็นสำเนาที่
// scripts/migrate-stock.mjs คัดมาตอนย้ายระบบ — เป็นการรันมือครั้งเดียว ไม่มีใครรันซ้ำให้
// ผลคือของที่จัดซื้อเพิ่ม/แก้ชื่อ/แก้ราคาในชีทจะไม่โผล่ในหน้าเว็บเลยจนกว่าจะมีคนนึกได้ว่าต้องรัน
// (หน้านับสต๊อกอ่านชื่อสินค้าจากตารางนี้ตั้งแต่ย้ายมา SQL แล้ว)
//
// ไฟล์นี้ทำให้สำเนานั้นตามชีททันเองเป็นรอบ ๆ — จัดซื้อยังกรอกที่ชีทเหมือนเดิม ไม่ต้องเปลี่ยนวิธีทำงาน
// แต่ทุกหน้าที่อ่าน dbo.stock_item (นับสต๊อก, กรอกรายจ่าย, itemid ตอนส่งใบเบิก, ราคากลาง)
// จะเห็นของใหม่เองภายในไม่เกินหนึ่งรอบซิงก์
//
// อ่านคอลัมน์ตำแหน่งเดียวกับ scripts/migrate-stock.mjs เป๊ะ (A รหัส, B ชื่อ, C ราคา, D หน่วย,
// E สถานะ, J สาขาที่ใช้, K itemid, L หน่วยเบิก, N หมวดสโตร์, O Plan) — สองทางต้องให้ผลตรงกัน
// ไม่งั้นรันสคริปต์ย้ายทับแล้วข้อมูลจะกระโดด
//
// เขียนเฉพาะแถวที่ค่าต่างจากของเดิมจริง ๆ รอบที่ชีทไม่มีการแก้เลยจึงไม่มีคำสั่งเขียนสักคำสั่ง
// (ซิงก์ทุกชั่วโมงกับทะเบียนสองพันกว่ารายการ ถ้าเขียนทับทั้งชุดทุกรอบจะกินทั้ง log และ I/O เปล่า ๆ)

import { sql, stockDb } from './hr-db.js';

const { queryRead, withTransaction } = stockDb;

// ไฟล์ BOM — ชีท 'item' (แท็บเดียวกับที่ api/insert_order.js เคยอ่านตรงเอา itemid)
const SHEET_ID = process.env.ITEM_SHEET_ID || '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw';
const SHEET_GID = process.env.ITEM_SHEET_GID || '302875824';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** ต้องให้ผลตรงกับ normCode() ของ stock.js และ migrate-stock.mjs ไม่งั้นจะกลายเป็นสินค้าคนละตัว */
const normCode = (v) => str(v).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

/** ราคาเทียบกันด้วยข้อความทศนิยม 4 ตำแหน่ง ให้ตรงกับ DECIMAL(18,4) ที่เก็บจริง (ค่าว่าง = '') */
const priceKey = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toFixed(4));

/** แถวดิบของชีททะเบียนสินค้า (ตัดหัวตารางแล้ว) — ส่งออกให้ scripts/check-item.mjs ใช้ตรวจสอบด้วย */
export async function fetchSheetRows() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&headers=0&gid=${encodeURIComponent(SHEET_GID)}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b < 0) {
    throw new Error('อ่านชีททะเบียนสินค้าไม่ได้ — ตรวจว่าตั้งแชร์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง');
  }
  const json = JSON.parse(text.slice(a, b + 1));
  const cols = json.table.cols || [];
  const rows = (json.table.rows || []).map((row) =>
    cols.map((_, i) => {
      const cell = row.c && row.c[i];
      return cell && cell.v !== null && cell.v !== undefined ? cell.v : '';
    })
  );
  // อ่านด้วยตำแหน่งคอลัมน์ ไม่ได้จับจากชื่อหัวตาราง จึงต้องตัดแถวหัวเอง
  // ดูจากช่องในแถวแรกว่าเป็นคำหัวตารางไหม แทนการตัดแถวแรกทิ้งเสมอ (ชีทที่ไม่มีหัวตารางจะเสียข้อมูลไปหนึ่งแถว)
  const first = (rows[0] || []).map((c) => str(c));
  const looksLikeHeader = first.some((c) => /^(รหัส|ชื่อ|สาขา|หน่วย|หมวด|ราคา|สถานะ|item|code|name|branch)/i.test(c));
  return looksLikeHeader ? rows.slice(1) : rows;
}

/**
 * แถวชีท -> รูปแบบที่จะเขียนลงตาราง (คอลัมน์ตำแหน่งเดียวกับ migrate-stock.mjs)
 * ส่งออกไว้ให้ scripts/check-item.mjs อ่านชีทด้วยตรรกะตัวเดียวกันเป๊ะ — ถ้าตรวจด้วยโค้ดคนละชุด
 * ผลที่ได้จะเชื่อไม่ได้ว่าตรงกับสิ่งที่ตัวซิงก์เห็นจริง
 */
export function parseItems(rows) {
  const byKey = new Map();
  let skipped = 0;
  let duplicates = 0;
  rows.forEach((row, index) => {
    const code = str(row[0]);
    const name = str(row[1]);
    if (!code && !name) return;   // แถวว่างท้ายชีท ไม่นับเป็นอะไรทั้งนั้น
    const key = normCode(code);
    if (!key) { skipped++; return; }
    if (byKey.has(key)) duplicates++;
    byKey.set(key, {
      key,
      code,
      name,
      price: num(row[2]),
      unit: str(row[3]),
      status: str(row[4]),
      // คอลัมน์ J เขียนรวมกันคั่นลูกน้ำ ("CRM,HRS,XHH") — แยกเป็นรายสาขาให้ตรงกับตาราง branch
      branches: String(row[9] ?? '').toLowerCase().split(/[,\s]+/).map((b) => b.trim()).filter(Boolean),
      posItemId: str(row[10]),
      requestUnit: str(row[11]),
      storeCat: str(row[13]),
      // ชีทเคยพิมพ์ผิดเป็น 'ture' — รับทั้งสองแบบเหมือนสคริปต์ย้ายข้อมูล
      planOnly: /^(true|ture)$/i.test(str(row[14])) ? 1 : 0,
      sortOrder: index,
    });
  });
  // รหัสซ้ำในชีทให้แถวหลังชนะ (เหมือน MERGE ที่รันไล่จากบนลงล่าง) — นับไว้รายงานด้วย
  return { items: [...byKey.values()], skipped, duplicates };
}

const MERGE_ITEM = `
  MERGE dbo.stock_item AS t
  USING (SELECT @item_key AS item_key) AS s ON t.item_key = s.item_key
  WHEN MATCHED THEN UPDATE SET
    item_code = @item_code, pos_item_id = @pos_item_id, item_name = @item_name,
    unit = @unit, request_unit = @request_unit, price = @price, status = @status,
    store_cat = @store_cat, plan_only = @plan_only, sort_order = @sort_order,
    updated_at = SYSDATETIME()
  WHEN NOT MATCHED THEN INSERT
    (item_key, item_code, pos_item_id, item_name, unit, request_unit, price, status, store_cat, plan_only, sort_order)
    VALUES (@item_key, @item_code, @pos_item_id, @item_name, @unit, @request_unit, @price, @status, @store_cat, @plan_only, @sort_order);`;

const itemParams = (it) => ({
  item_key: { type: sql.NVarChar(50), value: it.key },
  item_code: { type: sql.NVarChar(50), value: it.code },
  pos_item_id: { type: sql.NVarChar(50), value: it.posItemId || null },
  item_name: { type: sql.NVarChar(255), value: it.name },
  unit: { type: sql.NVarChar(50), value: it.unit || null },
  request_unit: { type: sql.NVarChar(50), value: it.requestUnit || null },
  price: { type: sql.Decimal(18, 4), value: it.price },
  status: { type: sql.NVarChar(50), value: it.status || null },
  store_cat: { type: sql.NVarChar(150), value: it.storeCat || null },
  plan_only: { type: sql.Bit, value: it.planOnly },
  sort_order: { type: sql.Int, value: it.sortOrder },
});

/** สาขาที่ใช้สินค้าตัวนั้น — ลบของเดิมทั้งชุดแล้วใส่ชุดใหม่ ให้สาขาที่ถูกถอดออกหายไปจริง */
function branchStatement(it) {
  const params = { item_key: { type: sql.NVarChar(50), value: it.key } };
  const values = it.branches.map((b, i) => {
    params[`b${i}`] = { type: sql.NVarChar(50), value: b };
    return `(@item_key, @b${i})`;
  });
  return {
    text: `DELETE FROM dbo.stock_item_branch WHERE item_key = @item_key;
           INSERT INTO dbo.stock_item_branch (item_key, branch) VALUES ${values.join(', ')};`,
    params,
  };
}

/**
 * ดึงชีทแล้วอัปเดตตารางให้ตรงกัน — คืนสรุปว่าแตะอะไรไปบ้าง
 *
 * ของที่ถูกลบออกจากชีทจะไม่ถูกลบตาม (เหมือน migrate-stock.mjs) เพราะยังมีประวัติการนับ/ใบเบิก
 * อ้างถึงอยู่ ฝ่ายจัดซื้อเลิกใช้สินค้าตัวไหนให้ตั้งสถานะเป็น 'ปิดการใช้งาน' ซึ่งฝั่งอ่านกรองออกให้แล้ว
 */
export async function syncItemsFromSheet() {
  const rows = await fetchSheetRows();
  const { items, skipped, duplicates } = parseItems(rows);
  if (items.length === 0) throw new Error('ชีททะเบียนสินค้าไม่มีข้อมูล — ยกเลิกการซิงก์');

  const [current, currentBranches] = await Promise.all([
    queryRead(
      `SELECT item_key, item_code, pos_item_id, item_name, unit, request_unit,
              price, status, store_cat, plan_only, sort_order
         FROM dbo.stock_item`
    ),
    queryRead('SELECT item_key, branch FROM dbo.stock_item_branch'),
  ]);

  // กันชีทที่เปิด "ตัวกรอง" ค้างไว้ — gviz จะส่งกลับมาเฉพาะแถวที่ผ่านตัวกรอง ซึ่งเคยทำให้ตอนย้าย
  // ข้อมูลตารางงานเห็นแค่ 496 แถวจากหมื่นกว่าแถว ถ้าเชื่อตัวเลขนั้นแล้วเขียนทับ ทะเบียนจะเหลือเศษเดียว
  // (ตรงนี้ไม่ได้ลบของที่หายไปอยู่แล้ว แต่ sort_order ที่เพี้ยนก็สลับลำดับทั้งหน้านับสต๊อกได้)
  if (current.length > 0 && items.length < current.length * 0.6) {
    throw new Error(
      `ชีทส่งข้อมูลมาแค่ ${items.length} รายการ จากที่มีอยู่ ${current.length} รายการ — ` +
      'อาจมีตัวกรองเปิดค้างอยู่ในชีท ยกเลิกการซิงก์ไว้ก่อน'
    );
  }

  const currentByKey = new Map(current.map((r) => [str(r.item_key), r]));
  const branchesByKey = new Map();
  for (const r of currentBranches) {
    const key = str(r.item_key);
    const set = branchesByKey.get(key) || new Set();
    set.add(str(r.branch).toLowerCase());
    branchesByKey.set(key, set);
  }

  const unchangedItem = (it) => {
    const c = currentByKey.get(it.key);
    return Boolean(c)
      && str(c.item_code) === it.code
      && str(c.pos_item_id) === it.posItemId
      && str(c.item_name) === it.name
      && str(c.unit) === it.unit
      && str(c.request_unit) === it.requestUnit
      && priceKey(c.price) === priceKey(it.price)
      && str(c.status) === it.status
      && str(c.store_cat) === it.storeCat
      && (c.plan_only ? 1 : 0) === it.planOnly
      && Number(c.sort_order) === it.sortOrder;
  };

  const unchangedBranches = (it) => {
    const now = branchesByKey.get(it.key);
    if (!now) return false;
    const next = new Set(it.branches);
    return now.size === next.size && [...next].every((b) => now.has(b));
  };

  const changedItems = items.filter((it) => !unchangedItem(it));
  // สินค้าที่ชีทไม่ได้ระบุสาขา (คอลัมน์ J ว่าง) ไม่แตะแถวสาขาเดิม — ช่องที่บังเอิญว่างชั่วคราว
  // ไม่ควรถอนสินค้าออกจากทุกสาขาพร้อมกัน (เหมือน migrate-stock.mjs)
  const changedBranches = items.filter((it) => it.branches.length > 0 && !unchangedBranches(it));

  const added = changedItems.filter((it) => !currentByKey.has(it.key)).length;

  const CHUNK = 100;
  for (let i = 0; i < changedItems.length; i += CHUNK) {
    const chunk = changedItems.slice(i, i + CHUNK);
    await withTransaction(async (run) => {
      for (const it of chunk) await run(MERGE_ITEM, itemParams(it));
    });
  }
  for (let i = 0; i < changedBranches.length; i += CHUNK) {
    const chunk = changedBranches.slice(i, i + CHUNK);
    await withTransaction(async (run) => {
      for (const it of chunk) {
        const { text, params } = branchStatement(it);
        await run(text, params);
      }
    });
  }

  return {
    sheetRows: rows.length,
    total: items.length,
    added,
    updated: changedItems.length - added,
    branchUpdated: changedBranches.length,
    skipped,
    duplicates,
    message: `ซิงก์ทะเบียนสินค้าแล้ว ${items.length} รายการ (เพิ่ม ${added}, แก้ ${changedItems.length - added}, สาขา ${changedBranches.length})`,
  };
}

/**
 * ตัวเรียกสำหรับรอบอัตโนมัติ — ไม่โยน error ออกไป (ซิงก์พลาดหนึ่งรอบไม่ควรทำให้ server ล้ม
 * ข้อมูลเดิมยังใช้งานได้ปกติ แค่ยังไม่ทันของใหม่) แต่พิมพ์ log ไว้ให้ตามหาได้
 */
export async function syncItemsQuietly() {
  try {
    const r = await syncItemsFromSheet();
    // ไม่มีอะไรเปลี่ยนก็ไม่ต้องรก log — รอบส่วนใหญ่จะเป็นแบบนั้น
    if (r.added || r.updated || r.branchUpdated) console.log(r.message);
    return r;
  } catch (e) {
    console.log('ซิงก์ทะเบียนสินค้าไม่สำเร็จ: ' + e.message);
    return null;
  }
}
