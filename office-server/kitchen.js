// เมนูครัวกลาง — สูตรการผลิต / คำสั่งผลิต / เบิกวัตถุดิบ / วัตถุดิบคงเหลือ / รายงานการผลิต
//
// เรียกจากแอป storefct (nookmagazineDev/narai-storefct) ผ่าน POST /schedule เหมือน action อื่น
// เพราะ Vercel ต่อ SQL Server ตรงไม่ได้ — ไฟร์วอลล์เปิดพอร์ต 1433 ให้เฉพาะ IP ในไทย
//
//   เบราว์เซอร์ -> /api/kitchen_* ของ storefct (Vercel) -> office-server :8787/schedule -> SQL Server
//
// ตารางอยู่ที่ InventoryNarai — สคีมาอยู่ที่ docs/schema-kitchen-sqlserver.sql ของ repo storefct
//
// ครัวกลางคือ "สาขา" หนึ่งในระบบเดิม (รหัสตั้งที่ env KITCHEN_BRANCH) จึงใช้ dbo.stock_item
// ชุดเดียวกับสาขา รับวัตถุดิบผ่านใบเบิกเดิม (store_receiving) และนับสต๊อกลง stock_count
// เหมือนทุกสาขา ที่นี่เก็บเฉพาะสิ่งที่ระบบเดิมไม่มี คือ "สูตร" กับ "การผลิต"

import { sql, stockDb } from './hr-db.js';

const { queryRead, withTransaction } = stockDb;
// คำสั่งเขียนที่ไม่ต้องอ่านผลลัพธ์ — ใช้ตัวเดียวกับการอ่าน (กติกาเดียวกับ stock.js/storework.js)
// ระวัง: queryRead คืน recordset เป็น array ส่วน run ใน withTransaction คืน result object เต็ม
// ต้องอ่าน .recordset เอง — จุดนี้พลาดง่ายมากเพราะหน้าตาเรียกเหมือนกัน
const runSql = queryRead;

const str = (v) => String(v === null || v === undefined ? '' : v).trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const orNull = (v) => (str(v) === '' ? null : str(v));

/** วันที่ 'YYYY-MM-DD' หรือ null */
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : null);

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** normalize รหัสสินค้าให้ตรงกับ item_key — กติกาเดียวกับ stock.js และฝั่ง storefct */
const normCode = (code) => String(code === null || code === undefined ? '' : code)
  .replace(/^'/, '').trim().replace(/\.0+$/, '').replace(/^0+/, '').trim();

/** วันที่/เวลาไทยตอนนี้ — เครื่องนี้ตั้งโซนเวลาไทยอยู่แล้ว แต่ระบุให้ชัดกันเครื่องถูกย้าย */
function bangkokNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

/**
 * รหัสสาขาของครัวกลาง — ตั้งที่ env KITCHEN_BRANCH ของ office-server
 *
 * ไม่ฝังค่าไว้ในโค้ด เพราะรหัสสาขาเป็นของระบบ POS ซึ่งเราไม่ได้เป็นคนตั้ง และถ้าวันหนึ่ง
 * มีครัวกลางแห่งที่สอง การแก้ env ง่ายกว่าการไล่แก้โค้ด
 */
const kitchenBranch = () => str(process.env.KITCHEN_BRANCH) || 'kitchen';

/**
 * รหัสสาขาที่ติ๊กไว้ใน "สาขาที่ใช้" ของ QC/RD > วัตถุดิบ (naraipizzeria) = วัตถุดิบของครัวกลาง
 * dbo.stock_item_branch เก็บรหัสสาขาตัวพิมพ์เล็ก · ครัวกลางใน QC/RD คือ FCT
 * รวม KITCHEN_BRANCH ไว้ด้วย เผื่อสองค่านี้ตั้งตรงกันอยู่แล้วหรือวันหนึ่งเปลี่ยนรหัส (ตั้งทับได้ที่ env KITCHEN_ITEM_BRANCH)
 */
const kitchenItemBranches = () => [...new Set([
  (str(process.env.KITCHEN_ITEM_BRANCH) || 'fct').toLowerCase(),
  kitchenBranch().toLowerCase(),
])];
const itemBranchParams = () => {
  const [b1, b2 = b1] = kitchenItemBranches();
  return {
    item_branch1: { type: sql.NVarChar(50), value: b1 },
    item_branch2: { type: sql.NVarChar(50), value: b2 },
  };
};

/**
 * เลขที่เอกสารถัดไปของวันนั้น เช่น PRD-20260917-003
 *
 * นับต่อจากเลขสูงสุดของวันเดียวกัน ไม่ได้ใช้ SEQUENCE เพราะอยากให้เลขรีเซ็ตทุกวันและอ่านออก
 * ว่าเป็นของวันไหนโดยไม่ต้องเปิดตาราง ถ้าสองคนกดพร้อมกันจนได้เลขชนกัน UNIQUE ที่ doc_no
 * จะเป็นคนปัด แล้วฝั่งเรียกเห็น error ชัดเจน ดีกว่าปล่อยให้ได้เลขซ้ำเงียบๆ
 *
 * @param {(text: string, params?: object) => Promise<any>} run ตัวรันใน transaction (คืน result object)
 */
async function nextDocNo(run, table, prefix, dateStr) {
  const head = `${prefix}-${dateStr.replace(/-/g, '')}-`;
  const res = await run(
    `SELECT MAX(doc_no) AS last_no FROM ${table} WHERE doc_no LIKE @head + N'%';`,
    { head: { type: sql.NVarChar(30), value: head } }
  );
  const last = str(res?.recordset?.[0]?.last_no);
  const seq = last ? Number(last.slice(head.length)) : 0;
  return `${head}${String((Number.isFinite(seq) ? seq : 0) + 1).padStart(3, '0')}`;
}

/** ชื่อคนที่กดบันทึก — storefct ยังไม่มีล็อกอิน จึงยอมรับชื่อที่หน้าเว็บส่งมา */
const recorderOf = (body, session) =>
  str(body?.recorder) || str(session?.name) || str(session?.username) || 'ครัวกลาง';

/**
 * มีคอลัมน์ kitchen_production_order.recipe_snapshot แล้วหรือยัง (sql/kitchen-006-order-recipe-snapshot.sql)
 * ฐานที่ยังไม่ได้รันไฟล์นั้น SELECT คอลัมน์นี้แล้วทั้ง query พัง — เช็คก่อนแล้วค่อยใส่คอลัมน์ลง SQL
 * จำเฉพาะตอนที่มีแล้ว (ยังไม่มี = เช็คใหม่ทุกครั้ง รันไฟล์ SQL แล้วใช้ได้เลยไม่ต้องรอรีสตาร์ต)
 */
let recipeSnapshotReady = false;
async function hasRecipeSnapshot() {
  if (recipeSnapshotReady) return true;
  const rows = await runSql(
    `SELECT COL_LENGTH(N'dbo.kitchen_production_order', N'recipe_snapshot') AS len;`
  );
  recipeSnapshotReady = rows?.[0]?.len !== null && rows?.[0]?.len !== undefined;
  return recipeSnapshotReady;
}

/** มีตารางประวัติการแก้ยอดผลิตแล้วหรือยัง (sql/kitchen-007-production-run-edit.sql) — จำเฉพาะตอนที่มีแล้ว */
let runEditReady = false;
async function hasRunEditTable() {
  if (runEditReady) return true;
  const rows = await runSql(`SELECT OBJECT_ID(N'dbo.kitchen_production_run_edit', N'U') AS id;`);
  runEditReady = rows?.[0]?.id !== null && rows?.[0]?.id !== undefined;
  return runEditReady;
}

/** มีตารางประวัติการเลื่อนวัน/ยกเลิกคำสั่งผลิตแล้วหรือยัง (sql/kitchen-008-order-event.sql) — จำเฉพาะตอนที่มีแล้ว */
let orderEventReady = false;
async function hasOrderEventTable() {
  if (orderEventReady) return true;
  const rows = await runSql(`SELECT OBJECT_ID(N'dbo.kitchen_production_order_event', N'U') AS id;`);
  orderEventReady = rows?.[0]?.id !== null && rows?.[0]?.id !== undefined;
  return orderEventReady;
}

/** มีตาราง/คอลัมน์ของเหลือจากการผลิตแล้วหรือยัง (sql/kitchen-009-leftover.sql) — จำเฉพาะตอนที่มีแล้ว */
let leftoverReady = false;
async function hasLeftoverTables() {
  if (leftoverReady) return true;
  const rows = await runSql(
    `SELECT OBJECT_ID(N'dbo.kitchen_menu_leftover', N'U') AS t,
            COL_LENGTH(N'dbo.kitchen_material_receipt', N'receipt_kind') AS c;`
  );
  const r = rows?.[0] || {};
  leftoverReady = r.t !== null && r.t !== undefined && r.c !== null && r.c !== undefined;
  return leftoverReady;
}
/** มีคอลัมน์ต้นทุนของของเหลือ (kitchen_material_receipt.unit_price · sql/kitchen-010) แล้วหรือยัง */
let receiptPriceReady = false;
async function hasReceiptPrice() {
  if (receiptPriceReady) return true;
  const rows = await runSql(`SELECT COL_LENGTH(N'dbo.kitchen_material_receipt', N'unit_price') AS c;`);
  receiptPriceReady = rows?.[0]?.c !== null && rows?.[0]?.c !== undefined;
  return receiptPriceReady;
}
/** มีคอลัมน์ไอเทมในประวัติคำสั่ง (แก้ยอดของเหลือ · sql/kitchen-011) แล้วหรือยัง */
let leftoverEditReady = false;
async function hasLeftoverEdit() {
  if (leftoverEditReady) return true;
  const rows = await runSql(`SELECT COL_LENGTH(N'dbo.kitchen_production_order_event', N'item_key') AS c;`);
  leftoverEditReady = rows?.[0]?.c !== null && rows?.[0]?.c !== undefined;
  return leftoverEditReady;
}

/**
 * ต้นทุนต่อหน่วยของคำสั่งผลิต = ต้นทุนวัตถุดิบจริง (ใบเบิก × ราคาตอนเบิก) ÷ ยอดผลิตได้ทั้งคำสั่ง · คิดไม่ได้ = null
 * ใช้ตั้งราคาของเหลือ (ไอเทม LO-) — saveProductionRun / saveOrderLeftover
 */
async function orderCostPerUnit(run, orderId) {
  const c = (await run(
    `SELECT (SELECT SUM(mi.qty * mi.unit_price) FROM dbo.kitchen_material_issue mi
              WHERE mi.order_id = @order_id AND mi.unit_price IS NOT NULL) AS cost,
            (SELECT SUM(p.qty_produced) FROM dbo.kitchen_production_run p WHERE p.order_id = @order_id) AS produced;`,
    { order_id: { type: sql.BigInt, value: orderId } }
  ))?.recordset?.[0];
  return Number(c?.cost) > 0 && Number(c?.produced) > 0 ? Number(c.cost) / Number(c.produced) : null;
}
const sameUnit = (a, b) => str(a).replace(/\s+/g, '') === str(b).replace(/\s+/g, '');
/** ราคาของของเหลือ — เฉพาะไอเทม LO- ที่หน่วยตรงกับหน่วยผลผลิต (วัตถุดิบของฝ่ายจัดซื้อไม่ถูกแก้ราคา) */
const leftoverPrice = (costPerUnit, item, productUnit) => (costPerUnit !== null && /^LO-/i.test(str(item.item_code))
  && sameUnit(item.unit, productUnit) ? Math.round(costPerUnit * 10000) / 10000 : null);

const leftoverMissing = () => badRequest('ยังไม่มีตารางของเหลือจากการผลิต — รัน update-office-server.bat ที่เครื่องออฟฟิศก่อน');


/* ==========================================================================
   รายการสินค้า/วัตถุดิบ — ใช้เติมช่องเลือกของทุกหน้า
========================================================================== */

/**
 * รายการสินค้าทั้งหมดที่เลือกได้ อ่านจาก dbo.stock_item ชุดเดียวกับที่สาขาใช้
 *
 * ส่งทั้งก้อนกลับไปให้หน้าเว็บค้นเอง ไม่ได้ทำ search ฝั่ง SQL เพราะรายการมีหลักพันต้นๆ
 * โหลดครั้งเดียวแล้วพิมพ์ค้นในเบราว์เซอร์ลื่นกว่ายิงทุกตัวอักษรข้ามอินเทอร์เน็ตมาที่ออฟฟิศ
 */
async function getKitchenItems(body) {
  const includeInactive = body?.includeInactive === true;
  // is_kitchen = ติ๊กสาขา FCT ไว้ใน QC/RD > วัตถุดิบ — หน้าเว็บใช้เรียงวัตถุดิบของครัวขึ้นก่อน
  const rows = await runSql(
    `SELECT i.item_key, i.item_code, i.item_name, i.unit, i.request_unit, i.store_cat, i.price,
            CASE WHEN EXISTS (SELECT 1 FROM dbo.stock_item_branch b
                               WHERE b.item_key = i.item_key AND b.branch IN (@item_branch1, @item_branch2))
                 THEN 1 ELSE 0 END AS is_kitchen
       FROM dbo.stock_item i
      WHERE (@all = 1 OR i.status IS NULL OR i.status <> N'ปิดการใช้งาน')
      ORDER BY i.item_name;`,
    { all: { type: sql.Bit, value: includeInactive }, ...itemBranchParams() }
  );
  return { items: rows };
}


/* ==========================================================================
   สูตรการผลิต
========================================================================== */

/** รายการสูตรทั้งหมด พร้อมจำนวนวัตถุดิบในแต่ละสูตร (หน้ารายการไม่ต้องดึงบรรทัดมาทั้งหมด) */
async function getKitchenRecipes(body) {
  const includeInactive = body?.includeInactive === true;
  const rows = await runSql(
    `SELECT r.recipe_id, r.product_key, r.product_code, r.product_name,
            r.yield_qty, r.yield_unit, r.is_active, r.note, r.updated_by, r.updated_at,
            (SELECT COUNT(*) FROM dbo.kitchen_recipe_item i WHERE i.recipe_id = r.recipe_id) AS item_count
       FROM dbo.kitchen_recipe r
      WHERE (@all = 1 OR r.is_active = 1)
      ORDER BY r.product_name;`,
    { all: { type: sql.Bit, value: includeInactive } }
  );
  return { recipes: rows };
}

/** สูตรเดียวพร้อมบรรทัดวัตถุดิบ — ใช้ตอนเปิดแก้ไข */
async function getKitchenRecipe(body) {
  const recipeId = Number(body?.recipeId);
  const productKey = normCode(body?.productKey);
  if (!Number.isFinite(recipeId) && !productKey) throw badRequest('ต้องระบุ recipeId หรือ productKey');

  const head = await runSql(
    `SELECT TOP 1 recipe_id, product_key, product_code, product_name, yield_qty, yield_unit,
            is_active, note, updated_by, updated_at
       FROM dbo.kitchen_recipe
      WHERE (@recipe_id IS NOT NULL AND recipe_id = @recipe_id)
         OR (@recipe_id IS NULL AND product_key = @product_key);`,
    {
      recipe_id: { type: sql.Int, value: Number.isFinite(recipeId) ? recipeId : null },
      product_key: { type: sql.NVarChar(50), value: productKey },
    }
  );
  if (head.length === 0) return { recipe: null, items: [] };

  const items = await runSql(
    `SELECT item_key, item_code, item_name, qty, unit, sort_order, note
       FROM dbo.kitchen_recipe_item
      WHERE recipe_id = @recipe_id
      ORDER BY sort_order, item_name;`,
    { recipe_id: { type: sql.Int, value: head[0].recipe_id } }
  );
  return { recipe: head[0], items };
}

/**
 * บันทึกสูตร — สร้างใหม่หรือแก้ของเดิม
 * บรรทัดวัตถุดิบถูกเขียนทับทั้งชุด (ลบแล้วใส่ใหม่) เพราะหน้าเว็บส่งสูตรมาทั้งใบเสมอ
 * การไล่ diff ทีละบรรทัดไม่ได้อะไรเพิ่ม นอกจากโอกาสพลาด
 */
async function saveKitchenRecipe(body, session) {
  const productKey = normCode(body?.productKey || body?.productCode);
  if (!productKey) throw badRequest('ไม่ระบุสินค้าที่ผลิต');

  const yieldQty = num(body?.yieldQty);
  if (yieldQty <= 0) throw badRequest('จำนวนที่ผลิตได้ต่อสูตร ต้องมากกว่า 0');

  const rawItems = Array.isArray(body?.items) ? body.items : [];
  const items = [];
  const seen = new Set();
  for (const it of rawItems) {
    const key = normCode(it?.itemKey || it?.code);
    const qty = num(it?.qty);
    if (!key || qty <= 0) continue;
    // วัตถุดิบตัวเดียวกันใส่สองบรรทัดจะชน PK — รวมยอดให้เลย ดีกว่าโยน error ใส่หน้าคนกรอก
    if (seen.has(key)) {
      const prev = items.find((x) => x.key === key);
      prev.qty += qty;
      continue;
    }
    seen.add(key);
    items.push({
      key,
      code: str(it?.code || it?.itemCode) || key,
      name: str(it?.name || it?.itemName).slice(0, 255),
      qty,
      unit: orNull(it?.unit),
      note: orNull(it?.note),
      sort: items.length,
    });
  }
  if (items.length === 0) throw badRequest('สูตรต้องมีวัตถุดิบอย่างน้อยหนึ่งรายการ');

  const updatedBy = recorderOf(body, session);

  return withTransaction(async (run) => {
    const res = await run(
      `MERGE dbo.kitchen_recipe AS t
       USING (SELECT @product_key AS product_key) AS s ON t.product_key = s.product_key
       WHEN MATCHED THEN UPDATE SET
         product_code = @product_code, product_name = @product_name,
         yield_qty = @yield_qty, yield_unit = @yield_unit,
         is_active = @is_active, note = @note,
         updated_by = @updated_by, updated_at = SYSDATETIME()
       WHEN NOT MATCHED THEN INSERT
         (product_key, product_code, product_name, yield_qty, yield_unit, is_active, note, updated_by)
         VALUES (@product_key, @product_code, @product_name, @yield_qty, @yield_unit,
                 @is_active, @note, @updated_by)
       OUTPUT inserted.recipe_id;`,
      {
        product_key: { type: sql.NVarChar(50), value: productKey },
        product_code: { type: sql.NVarChar(50), value: str(body?.productCode) || productKey },
        product_name: { type: sql.NVarChar(255), value: str(body?.productName).slice(0, 255) },
        yield_qty: { type: sql.Decimal(18, 3), value: yieldQty },
        yield_unit: { type: sql.NVarChar(50), value: orNull(body?.yieldUnit) },
        is_active: { type: sql.Bit, value: body?.isActive === false ? false : true },
        note: { type: sql.NVarChar(500), value: orNull(body?.note) },
        updated_by: { type: sql.NVarChar(255), value: updatedBy },
      }
    );
    const recipeId = res?.recordset?.[0]?.recipe_id;
    if (!recipeId) throw new Error('บันทึกสูตรไม่สำเร็จ — ไม่ได้รหัสสูตรกลับมา');

    await run(`DELETE FROM dbo.kitchen_recipe_item WHERE recipe_id = @recipe_id;`,
      { recipe_id: { type: sql.Int, value: recipeId } });

    for (const it of items) {
      await run(
        `INSERT INTO dbo.kitchen_recipe_item
           (recipe_id, item_key, item_code, item_name, qty, unit, sort_order, note)
         VALUES (@recipe_id, @item_key, @item_code, @item_name, @qty, @unit, @sort_order, @note);`,
        {
          recipe_id: { type: sql.Int, value: recipeId },
          item_key: { type: sql.NVarChar(50), value: it.key },
          item_code: { type: sql.NVarChar(50), value: it.code },
          item_name: { type: sql.NVarChar(255), value: it.name },
          qty: { type: sql.Decimal(18, 3), value: it.qty },
          unit: { type: sql.NVarChar(50), value: it.unit },
          sort_order: { type: sql.Int, value: it.sort },
          note: { type: sql.NVarChar(255), value: it.note },
        }
      );
    }

    return {
      recipeId,
      count: items.length,
      message: `บันทึกสูตร "${str(body?.productName) || productKey}" แล้ว (${items.length} วัตถุดิบ)`,
    };
  });
}

/**
 * ลบสูตร — บรรทัดวัตถุดิบหายตามด้วย ON DELETE CASCADE
 * ถ้าเคยมีคำสั่งผลิตที่อ้างสูตรนี้ ใบเก่าไม่หายไปไหน เพราะคำสั่งผลิตเก็บชื่อ/รหัสสินค้าไว้เอง
 * ไม่ได้ผูก FK กับสูตร (ตั้งใจให้เป็นแบบนี้ ประวัติต้องอ่านได้แม้สูตรถูกเลิกใช้)
 */
async function deleteKitchenRecipe(body) {
  const recipeId = Number(body?.recipeId);
  if (!Number.isFinite(recipeId)) throw badRequest('ไม่ระบุสูตรที่จะลบ');

  // อ่านชื่อก่อนแล้วค่อยลบ ไม่ใช้ OUTPUT เหมือน action ลบตัวอื่น เพราะตารางนี้มี FK แบบ
  // ON DELETE CASCADE ผูกอยู่ ซึ่ง SQL Server จำกัดการใช้ OUTPUT ไว้หลายกรณี
  const found = await runSql(
    `SELECT product_name FROM dbo.kitchen_recipe WHERE recipe_id = @recipe_id;`,
    { recipe_id: { type: sql.Int, value: recipeId } }
  );
  if (found.length === 0) throw badRequest('ไม่พบสูตรที่ต้องการลบ');

  await runSql(
    `DELETE FROM dbo.kitchen_recipe WHERE recipe_id = @recipe_id;`,
    { recipe_id: { type: sql.Int, value: recipeId } }
  );
  return { message: `ลบสูตร "${found[0].product_name}" แล้ว` };
}


/* ==========================================================================
   แผนผลิตประจำรอบ (เลิกใช้จากหน้าเว็บแล้ว — แทนด้วยแผนผลิตรายวันข้างล่าง)
   เก็บ action ไว้ให้ storefct รุ่นก่อนหน้ายังทำงานได้ถ้าต้องย้อนกลับ
========================================================================== */

async function getProductionPlans(body) {
  const includeInactive = body?.includeInactive === true;
  const rows = await runSql(
    `SELECT plan_id, product_key, product_code, product_name, cycle, weekday,
            planned_qty, unit, is_active, note, updated_at
       FROM dbo.kitchen_production_plan
      WHERE (@all = 1 OR is_active = 1)
      ORDER BY cycle, weekday, product_name;`,
    { all: { type: sql.Bit, value: includeInactive } }
  );
  return { plans: rows };
}

async function saveProductionPlan(body) {
  const productKey = normCode(body?.productKey || body?.productCode);
  if (!productKey) throw badRequest('ไม่ระบุสินค้าที่จะวางแผนผลิต');

  const plannedQty = num(body?.plannedQty);
  if (plannedQty <= 0) throw badRequest('จำนวนที่วางแผนผลิต ต้องมากกว่า 0');

  const cycle = str(body?.cycle) === 'daily' ? 'daily' : 'weekly';
  // รอบรายวันไม่ผูกกับวันไหนในสัปดาห์ ต้องเป็น NULL ให้ตรงกับ CHECK ในสคีมา
  const weekday = cycle === 'daily' ? null : Number(body?.weekday);
  if (cycle === 'weekly' && !(Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) {
    throw badRequest('รอบรายสัปดาห์ต้องเลือกวันในสัปดาห์');
  }

  await runSql(
    `MERGE dbo.kitchen_production_plan AS t
     USING (SELECT @product_key AS product_key, @cycle AS cycle, @weekday AS weekday) AS s
       ON t.product_key = s.product_key AND t.cycle = s.cycle
      AND (t.weekday = s.weekday OR (t.weekday IS NULL AND s.weekday IS NULL))
     WHEN MATCHED THEN UPDATE SET
       product_code = @product_code, product_name = @product_name,
       planned_qty = @planned_qty, unit = @unit, is_active = @is_active,
       note = @note, updated_at = SYSDATETIME()
     WHEN NOT MATCHED THEN INSERT
       (product_key, product_code, product_name, cycle, weekday, planned_qty, unit, is_active, note)
       VALUES (@product_key, @product_code, @product_name, @cycle, @weekday,
               @planned_qty, @unit, @is_active, @note);`,
    {
      product_key: { type: sql.NVarChar(50), value: productKey },
      product_code: { type: sql.NVarChar(50), value: str(body?.productCode) || productKey },
      product_name: { type: sql.NVarChar(255), value: str(body?.productName).slice(0, 255) },
      cycle: { type: sql.NVarChar(20), value: cycle },
      weekday: { type: sql.TinyInt, value: weekday },
      planned_qty: { type: sql.Decimal(18, 3), value: plannedQty },
      unit: { type: sql.NVarChar(50), value: orNull(body?.unit) },
      is_active: { type: sql.Bit, value: body?.isActive === false ? false : true },
      note: { type: sql.NVarChar(500), value: orNull(body?.note) },
    }
  );
  return { message: `บันทึกแผนผลิต "${str(body?.productName) || productKey}" แล้ว` };
}

async function deleteProductionPlan(body) {
  const planId = Number(body?.planId);
  if (!Number.isFinite(planId)) throw badRequest('ไม่ระบุแผนที่จะลบ');
  const gone = await runSql(
    `DELETE FROM dbo.kitchen_production_plan OUTPUT deleted.product_name WHERE plan_id = @plan_id;`,
    { plan_id: { type: sql.Int, value: planId } }
  );
  if (gone.length === 0) throw badRequest('ไม่พบแผนที่ต้องการลบ');
  return { message: `ลบแผนผลิต "${gone[0].product_name}" แล้ว` };
}


/* ==========================================================================
   แผนผลิตรายวัน — เมนู "แพลนผลิต" (ปฏิทิน) ของ storefct
   ตาราง dbo.kitchen_production_plan_day (office-server/sql/kitchen-002-plan-by-date.sql)

   แผนผูกกับคำสั่งผลิตด้วย (plan_date = produce_date, product_key, source = 'plan')
   ซึ่ง UX_kitchen_order_day_auto รับรองว่ามีได้ใบเดียว — ไม่ต้องมีคอลัมน์ผูกตรง
   แผนที่ออกคำสั่งไปแล้ว (ใบยังไม่ถูกยกเลิก) ลบไม่ได้ · แก้จำนวนได้จนกว่าคำสั่งจะ "ผลิตเสร็จ"
   แก้แล้วจำนวนสั่งของคำสั่งผลิตเปลี่ยนตาม (transaction เดียวกัน) ดู saveDatedPlans
========================================================================== */

// ยังไม่ได้รัน sql/kitchen-002 = ตารางยังไม่มี (SQL Server error 208)
// ยังไม่ได้รัน sql/kitchen-004 = ยังไม่มีคอลัมน์ plan_day_id ที่คำสั่งผลิต (error 207) — บอกวิธีแก้แทนข้อความดิบ
const planDayMissing = (err) => {
  if (err?.number === 208 || /Invalid object name '(dbo\.)?kitchen_production_plan_day'/i.test(String(err?.message))) {
    return badRequest('ยังไม่มีตารางแผนผลิตรายวัน — รัน update-office-server.bat ที่เครื่องออฟฟิศก่อน');
  }
  if (/Invalid column name 'plan_day_id'/i.test(String(err?.message))) {
    return badRequest('ฐานข้อมูลยังไม่รองรับแผนหลายงานต่อเมนูต่อวัน — รัน update-office-server.bat ที่เครื่องออฟฟิศก่อน');
  }
  return err;
};

/**
 * ใบสั่งผลิตที่ออกจากแผนแถวนั้น และยังไม่ถูกยกเลิก
 * ผูกด้วย plan_day_id (sql/kitchen-004) — เมนูเดิมวันเดิมมีได้หลายแผน แต่ละแผนมีคำสั่งของตัวเอง
 */
const ACTIVE_PLAN_ORDER = `EXISTS (
  SELECT 1 FROM dbo.kitchen_production_order o
   WHERE o.plan_day_id = d.plan_day_id AND o.status <> N'ยกเลิก')`;

async function getDatedPlans(body) {
  const from = ymd(body?.dateFrom);
  const to = ymd(body?.dateTo);
  if (!from || !to) throw badRequest('ต้องระบุช่วงวันที่ (dateFrom, dateTo)');
  try {
    const rows = await runSql(
      `SELECT d.plan_day_id AS plan_id, CONVERT(NVARCHAR(10), d.plan_date, 23) AS plan_date,
              d.product_key, d.product_code, d.product_name, d.planned_qty, d.unit, d.note,
              d.recorder, d.created_at, d.updated_at,
              o.order_id, o.doc_no AS order_doc_no, o.status AS order_status
         FROM dbo.kitchen_production_plan_day d
         LEFT JOIN dbo.kitchen_production_order o
           ON o.plan_day_id = d.plan_day_id
        WHERE d.plan_date BETWEEN CONVERT(DATE, @from, 23) AND CONVERT(DATE, @to, 23)
           -- carryActive: แผนก่อนช่วงที่คำสั่งยัง "กำลังผลิต" — ปฏิทินแสดงซ้ำทุกวันจนถึงวันนี้ (ค้างจาก …)
           OR (@carry = 1 AND d.plan_date < CONVERT(DATE, @from, 23) AND o.status = N'กำลังผลิต')
        ORDER BY d.plan_date, d.product_code, d.plan_day_id;`,
      {
        from: { type: sql.NVarChar(10), value: from },
        to: { type: sql.NVarChar(10), value: to },
        carry: { type: sql.Bit, value: body?.carryActive ? 1 : 0 },
      }
    );
    return { plans: rows };
  } catch (err) {
    throw planDayMissing(err);
  }
}

/**
 * ตั้งแผนเมนูหนึ่งตัวให้หลายวันทีเดียว (หรือแก้แผนเดียวด้วย planId)
 * เพิ่มเป็นงานใหม่เสมอ — วันที่มีเมนูนี้อยู่แล้ว (สั่งผลิตไปแล้วหรือยังก็ตาม) ได้อีกแถวแยกกัน ไม่แทนที่ของเดิม
 */
async function saveDatedPlans(body, session) {
  const planId = Number(body?.planId);
  const isEdit = Number.isFinite(planId) && planId > 0;
  const plannedQty = num(body?.plannedQty);
  if (plannedQty <= 0) throw badRequest('จำนวนที่วางแผนผลิต ต้องมากกว่า 0');
  const recorder = recorderOf(body, session);

  if (isEdit) {
    // แผนที่สั่งผลิตแล้วแก้ได้จนกว่าคำสั่งจะผลิตเสร็จ — จำนวนสั่งของคำสั่งผลิตเปลี่ยนตามในคราวเดียว
    // (วัตถุดิบที่เบิกไปแล้วไม่เปลี่ยน เบิกเพิ่มที่ดินสอของหน้าสถานะการผลิต)
    try {
      return await withTransaction(async (run) => {
        const params = {
          plan_id: { type: sql.Int, value: planId },
          planned_qty: { type: sql.Decimal(18, 3), value: plannedQty },
          unit: { type: sql.NVarChar(50), value: orNull(body?.unit) },
          note: { type: sql.NVarChar(500), value: orNull(body?.note) },
          recorder: { type: sql.NVarChar(255), value: recorder },
        };
        const updated = (await run(
          `UPDATE d SET planned_qty = @planned_qty, unit = @unit, note = @note,
                  recorder = @recorder, updated_at = SYSDATETIME()
            OUTPUT inserted.product_name
             FROM dbo.kitchen_production_plan_day d
            WHERE d.plan_day_id = @plan_id
              AND NOT EXISTS (
                SELECT 1 FROM dbo.kitchen_production_order o
                 WHERE o.plan_day_id = d.plan_day_id AND o.status = N'ผลิตเสร็จ');`,
          params
        )).recordset || [];
        if (updated.length === 0) throw badRequest('ไม่พบแผนนี้ หรือคำสั่งผลิตของแผนผลิตเสร็จแล้ว (แก้ไม่ได้)');
        const orders = (await run(
          `UPDATE dbo.kitchen_production_order
              SET order_qty = @planned_qty, unit = @unit, updated_at = SYSDATETIME()
            OUTPUT inserted.doc_no
            WHERE plan_day_id = @plan_id AND status NOT IN (N'ยกเลิก', N'ผลิตเสร็จ');`,
          params
        )).recordset || [];
        const name = updated[0].product_name;
        return {
          saved: 1,
          skipped: 0,
          orderDocNo: orders[0]?.doc_no || null,
          message: orders.length
            ? `แก้แผน "${name}" แล้ว และปรับจำนวนในคำสั่งผลิต ${orders.map((o) => o.doc_no).join(', ')} ตาม`
            : `แก้แผน "${name}" แล้ว`,
        };
      });
    } catch (err) {
      throw planDayMissing(err);
    }
  }

  const productKey = normCode(body?.productKey || body?.productCode);
  if (!productKey) throw badRequest('ไม่ระบุเมนูที่จะวางแผนผลิต');
  const dates = [...new Set((Array.isArray(body?.dates) ? body.dates : []).map(ymd).filter(Boolean))].sort();
  if (dates.length === 0) throw badRequest('เลือกวันที่ที่จะวางแผนก่อน');
  // กันพลาดกดเลือกทั้งปี — หน้าเว็บเลือกได้ทีละเดือนกว่า ๆ อยู่แล้ว
  if (dates.length > 93) throw badRequest('ตั้งแผนได้ครั้งละไม่เกิน 93 วัน');
  const productName = str(body?.productName).slice(0, 255);

  try {
    return await withTransaction(async (run) => {
      let saved = 0;
      for (const date of dates) {
        await run(
          `INSERT INTO dbo.kitchen_production_plan_day
             (plan_date, product_key, product_code, product_name, planned_qty, unit, note, recorder)
           VALUES (CONVERT(DATE, @plan_date, 23), @product_key, @product_code, @product_name,
                   @planned_qty, @unit, @note, @recorder);`,
          {
            plan_date: { type: sql.NVarChar(10), value: date },
            product_key: { type: sql.NVarChar(50), value: productKey },
            product_code: { type: sql.NVarChar(50), value: str(body?.productCode) || productKey },
            product_name: { type: sql.NVarChar(255), value: productName },
            planned_qty: { type: sql.Decimal(18, 3), value: plannedQty },
            unit: { type: sql.NVarChar(50), value: orNull(body?.unit) },
            note: { type: sql.NVarChar(500), value: orNull(body?.note) },
            recorder: { type: sql.NVarChar(255), value: recorder },
          }
        );
        saved++;
      }
      return {
        saved,
        skipped: 0,
        skippedDates: [],
        message: `บันทึกแผน "${productName || productKey}" ${saved} วัน`,
      };
    });
  } catch (err) {
    throw planDayMissing(err);
  }
}

async function deleteDatedPlan(body) {
  const planId = Number(body?.planId);
  if (!Number.isFinite(planId)) throw badRequest('ไม่ระบุแผนที่จะลบ');
  try {
    const gone = await runSql(
      `DELETE d OUTPUT deleted.product_name
         FROM dbo.kitchen_production_plan_day d
        WHERE d.plan_day_id = @plan_id AND NOT ${ACTIVE_PLAN_ORDER};`,
      { plan_id: { type: sql.Int, value: planId } }
    );
    if (gone.length === 0) throw badRequest('ไม่พบแผนนี้ หรือสั่งผลิตไปแล้ว (ยกเลิกคำสั่งผลิตก่อนถ้าต้องการลบแผน)');
    return { message: `ลบแผน "${gone[0].product_name}" แล้ว` };
  } catch (err) {
    throw planDayMissing(err);
  }
}


/* ==========================================================================
   คำสั่งผลิต
========================================================================== */

async function getProductionOrders(body) {
  const from = ymd(body?.dateFrom);
  const to = ymd(body?.dateTo);
  if (!from || !to) throw badRequest('ต้องระบุช่วงวันที่ (dateFrom, dateTo)');

  // สูตร ณ วันผลิต (ถ้าเก็บไว้แล้ว) — ฟอร์มบันทึกผลใช้สูตรนี้แทนสูตรปัจจุบันของ QC/RD
  const snapCols = (await hasRecipeSnapshot()) ? 'o.recipe_snapshot, o.recipe_snapshot_at,' : '';
  // การเลื่อนวันล่าสุด / การยกเลิกล่าสุด — หน้าเว็บโชว์ "เลื่อนจาก …" ใต้วันที่ และเหตุผลใต้สถานะยกเลิก
  const eventReady = await hasOrderEventTable();
  const eventCols = eventReady
    ? `mv.old_date AS moved_from, mv.reason AS move_reason, mv.created_at AS moved_at,
            cx.reason AS cancel_reason, cx.created_at AS cancelled_at, cx.recorder AS cancelled_by,`
    : '';
  const eventJoins = eventReady
    ? `OUTER APPLY (SELECT TOP 1 CONVERT(NVARCHAR(10), e.old_date, 23) AS old_date, e.reason, e.created_at
                        FROM dbo.kitchen_production_order_event e
                       WHERE e.order_id = o.order_id AND e.action = N'move'
                       ORDER BY e.created_at DESC, e.event_id DESC) mv
       OUTER APPLY (SELECT TOP 1 e.reason, e.created_at, e.recorder
                        FROM dbo.kitchen_production_order_event e
                       WHERE e.order_id = o.order_id AND e.action = N'cancel'
                       ORDER BY e.created_at DESC, e.event_id DESC) cx`
    : '';
  const rows = await runSql(
    `SELECT o.order_id, o.doc_no, o.produce_date, o.product_key, o.product_code, o.product_name,
            o.order_qty, o.produced_qty, o.unit, o.status, o.source, o.plan_id,
            o.note, o.recorder, o.created_at, o.updated_at, ${snapCols} ${eventCols}
            CASE WHEN r.recipe_id IS NULL THEN 0 ELSE 1 END AS has_recipe,
            c.issue_count, c.no_price_count, c.material_cost
       FROM dbo.kitchen_production_order o
       LEFT JOIN dbo.kitchen_recipe r ON r.product_key = o.product_key
       -- ต้นทุนวัตถุดิบจริงของคำสั่ง = ใบเบิกทุกใบ (qty รวมของสูญเสียแล้ว) × unit_price ที่เก็บไว้ตอนเบิก
       -- คิดแบบเดียวกับ getProductionReport · NULL = ยังไม่มีใบเบิก หรือไม่มีราคาเลยสักบรรทัด
       OUTER APPLY (
         SELECT COUNT(*) AS issue_count,
                SUM(CASE WHEN mi.unit_price IS NULL THEN 1 ELSE 0 END) AS no_price_count,
                CAST(SUM(mi.qty * mi.unit_price) AS DECIMAL(18,2)) AS material_cost
           FROM dbo.kitchen_material_issue mi
          WHERE mi.order_id = o.order_id
       ) c
       ${eventJoins}
      WHERE (o.produce_date BETWEEN CONVERT(DATE, @from, 23) AND CONVERT(DATE, @to, 23)
             -- includeActive: งานที่ยังไม่เสร็จ (รอผลิต/กำลังผลิต) ขึ้นเสมอ แม้วันผลิตอยู่นอกช่วง — หน้าสถานะการผลิต
             OR (@active = 1 AND o.status IN (N'รอผลิต', N'กำลังผลิต')))
        AND (@status IS NULL OR o.status = @status)
      ORDER BY o.produce_date DESC, o.doc_no;`,
    {
      from: { type: sql.NVarChar(10), value: from },
      to: { type: sql.NVarChar(10), value: to },
      status: { type: sql.NVarChar(50), value: orNull(body?.status) },
      active: { type: sql.Bit, value: body?.includeActive ? 1 : 0 },
    }
  );
  return { orders: rows };
}

/** สร้าง/แก้คำสั่งผลิตที่ครัวกลางกรอกเอง */
async function saveProductionOrder(body, session) {
  const orderId = Number(body?.orderId);
  const isEdit = Number.isFinite(orderId) && orderId > 0;

  const produceDate = ymd(body?.produceDate) || bangkokNow().date;
  const productKey = normCode(body?.productKey || body?.productCode);
  const orderQty = num(body?.orderQty);
  if (!productKey) throw badRequest('ไม่ระบุสินค้าที่จะผลิต');
  if (orderQty <= 0) throw badRequest('จำนวนสั่งผลิต ต้องมากกว่า 0');

  const recorder = recorderOf(body, session);

  if (isEdit) {
    // เปลี่ยนสินค้าของคำสั่ง = สูตรที่เก็บไว้เป็นของสินค้าเดิม ล้างทิ้ง ให้เก็บใหม่ตอนเริ่มทำงานรอบหน้า
    // (ค่าทางขวาของ SET อ่านจากแถวเดิมก่อนแก้ จึงเทียบ product_key เดิมกับใหม่ได้ในคำสั่งเดียว)
    const resetSnap = (await hasRecipeSnapshot())
      ? `recipe_snapshot = CASE WHEN product_key = @product_key THEN recipe_snapshot END,
              recipe_snapshot_at = CASE WHEN product_key = @product_key THEN recipe_snapshot_at END,`
      : '';
    const updated = await runSql(
      `UPDATE dbo.kitchen_production_order
          SET ${resetSnap}
              produce_date = CONVERT(DATE, @produce_date, 23),
              product_key = @product_key, product_code = @product_code, product_name = @product_name,
              order_qty = @order_qty, unit = @unit, note = @note, updated_at = SYSDATETIME()
        OUTPUT inserted.order_id, inserted.doc_no
        WHERE order_id = @order_id AND status <> N'ยกเลิก';`,
      {
        order_id: { type: sql.BigInt, value: orderId },
        produce_date: { type: sql.NVarChar(10), value: produceDate },
        product_key: { type: sql.NVarChar(50), value: productKey },
        product_code: { type: sql.NVarChar(50), value: str(body?.productCode) || productKey },
        product_name: { type: sql.NVarChar(255), value: str(body?.productName).slice(0, 255) },
        order_qty: { type: sql.Decimal(18, 3), value: orderQty },
        unit: { type: sql.NVarChar(50), value: orNull(body?.unit) },
        note: { type: sql.NVarChar(500), value: orNull(body?.note) },
      }
    );
    if (updated.length === 0) throw badRequest('ไม่พบคำสั่งผลิตที่ต้องการแก้ (หรือถูกยกเลิกไปแล้ว)');
    return { orderId, docNo: updated[0].doc_no, message: `แก้คำสั่งผลิต ${updated[0].doc_no} แล้ว` };
  }

  return withTransaction(async (run) => {
    const docNo = await nextDocNo(run, 'dbo.kitchen_production_order', 'PRD', produceDate);
    const res = await run(
      `INSERT INTO dbo.kitchen_production_order
         (doc_no, produce_date, product_key, product_code, product_name,
          order_qty, unit, status, source, note, recorder)
       OUTPUT inserted.order_id
       VALUES (@doc_no, CONVERT(DATE, @produce_date, 23), @product_key, @product_code, @product_name,
               @order_qty, @unit, N'รอผลิต', N'manual', @note, @recorder);`,
      {
        doc_no: { type: sql.NVarChar(50), value: docNo },
        produce_date: { type: sql.NVarChar(10), value: produceDate },
        product_key: { type: sql.NVarChar(50), value: productKey },
        product_code: { type: sql.NVarChar(50), value: str(body?.productCode) || productKey },
        product_name: { type: sql.NVarChar(255), value: str(body?.productName).slice(0, 255) },
        order_qty: { type: sql.Decimal(18, 3), value: orderQty },
        unit: { type: sql.NVarChar(50), value: orNull(body?.unit) },
        note: { type: sql.NVarChar(500), value: orNull(body?.note) },
        recorder: { type: sql.NVarChar(255), value: recorder },
      }
    );
    return {
      orderId: res?.recordset?.[0]?.order_id,
      docNo,
      message: `สร้างคำสั่งผลิต ${docNo} แล้ว`,
    };
  });
}

/** ขนาดสูงสุดของสูตรที่รับเก็บ — สูตรจริงไม่กี่สิบบรรทัด ไม่กี่ KB กันหน้าเว็บส่งก้อนใหญ่ผิดปกติมา */
const SNAPSHOT_MAX_CHARS = 200000;

/**
 * เก็บสูตร QC/RD ของวันที่ผลิตไว้กับคำสั่งผลิต — เขียนครั้งเดียว คำสั่งที่เก็บไว้แล้วไม่ทับ
 *
 * office-server อ่าน QC/RD ไม่ได้ (สูตรอยู่ที่ฝั่ง storefct) หน้าเว็บจึงเป็นคนส่งสูตรที่ใช้ผลิตมา
 * ตอนเริ่มทำงานกับคำสั่ง (สั่งผลิต / เบิกวัตถุดิบ / บันทึกผล) แล้วรายงานการผลิตคิด "ตามสูตร"
 * จากสูตรนี้แทนสูตรปัจจุบัน — แก้สูตรใน QC/RD ทีหลัง ตัวเลขของการผลิตที่ผ่านไปแล้วไม่ขยับตาม
 *
 * ฐานที่ยังไม่ได้รัน sql/kitchen-006 ตอบ saved:false แทนการโยน error — ไม่ให้การบันทึกผลิตล้มเพราะเรื่องนี้
 */
async function saveOrderRecipeSnapshot(body) {
  const orderId = Number(body?.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) throw badRequest('ไม่ระบุคำสั่งผลิต');
  const snap = body?.snapshot;
  if (!snap || typeof snap !== 'object' || !snap.menu || !Array.isArray(snap.lines)) {
    throw badRequest('สูตรที่ส่งมาไม่ถูกรูปแบบ (ต้องมี menu และ lines)');
  }
  const text = JSON.stringify({ menu: snap.menu, lines: snap.lines });
  if (text.length > SNAPSHOT_MAX_CHARS) throw badRequest('สูตรที่ส่งมาใหญ่เกินไป');

  if (!(await hasRecipeSnapshot())) {
    return {
      saved: false,
      missing: true,
      message: 'ยังไม่มีคอลัมน์เก็บสูตร — รัน update-office-server.bat ที่เครื่องออฟฟิศก่อน',
    };
  }

  const updated = await runSql(
    `UPDATE dbo.kitchen_production_order
        SET recipe_snapshot = @snapshot, recipe_snapshot_at = SYSDATETIME()
      OUTPUT inserted.doc_no
      WHERE order_id = @order_id AND recipe_snapshot IS NULL;`,
    {
      order_id: { type: sql.BigInt, value: orderId },
      snapshot: { type: sql.NVarChar(sql.MAX), value: text },
    }
  );
  return updated.length > 0
    ? { saved: true, message: `เก็บสูตรของ ${updated[0].doc_no} แล้ว` }
    : { saved: false, message: 'คำสั่งนี้เก็บสูตรไว้แล้ว (หรือไม่พบคำสั่ง) — ไม่ทับของเดิม' };
}

/**
 * เปลี่ยนสถานะคำสั่งผลิต — reason (ไม่บังคับฝั่งนี้ หน้าเว็บบังคับตอนยกเลิก) เก็บลงประวัติ
 * มีตาราง kitchen_production_order_event = เก็บทุกครั้งที่สถานะเปลี่ยนจริง ('cancel' เมื่อเป็นยกเลิก ที่เหลือ 'status')
 */
async function updateProductionOrderStatus(body, session) {
  const orderId = Number(body?.orderId);
  const status = str(body?.status);
  const allowed = ['รอผลิต', 'กำลังผลิต', 'ผลิตเสร็จ', 'ยกเลิก'];
  if (!Number.isFinite(orderId)) throw badRequest('ไม่ระบุคำสั่งผลิต');
  if (!allowed.includes(status)) throw badRequest(`สถานะต้องเป็นหนึ่งใน: ${allowed.join(', ')}`);
  const logEvent = await hasOrderEventTable();
  const recorder = recorderOf(body, session);

  return withTransaction(async (run) => {
    const updated = await run(
      `UPDATE dbo.kitchen_production_order
          SET status = @status, updated_at = SYSDATETIME()
        OUTPUT inserted.doc_no, deleted.status AS old_status
        WHERE order_id = @order_id;`,
      {
        order_id: { type: sql.BigInt, value: orderId },
        status: { type: sql.NVarChar(50), value: status },
      }
    );
    const row = updated?.recordset?.[0];
    if (!row) throw badRequest('ไม่พบคำสั่งผลิตที่ต้องการแก้สถานะ');
    if (logEvent && row.old_status !== status) {
      await run(
        `INSERT INTO dbo.kitchen_production_order_event (order_id, action, old_status, new_status, reason, recorder)
         VALUES (@order_id, @action, @old_status, @new_status, @reason, @recorder);`,
        {
          order_id: { type: sql.BigInt, value: orderId },
          action: { type: sql.NVarChar(10), value: status === 'ยกเลิก' ? 'cancel' : 'status' },
          old_status: { type: sql.NVarChar(50), value: row.old_status },
          new_status: { type: sql.NVarChar(50), value: status },
          reason: { type: sql.NVarChar(500), value: orNull(body?.reason) && str(body.reason).slice(0, 500) },
          recorder: { type: sql.NVarChar(255), value: recorder },
        }
      );
    }
    return { message: `เปลี่ยนสถานะ ${row.doc_no} เป็น "${status}" แล้ว` };
  });
}

/**
 * เลื่อนวันผลิตของคำสั่ง (เช่น วัตถุดิบไม่ครบ) — เลขที่ใบไม่เปลี่ยน · ใบเบิกที่เบิกไปแล้วไม่เปลี่ยน
 * movePlan = ย้ายแผนในปฏิทินแพลนผลิต (plan_day_id ที่ผูกไว้) ไปวันใหม่ด้วย ไม่งั้นปฏิทินยังโชว์งานที่วันเดิม
 * ต้องมีตาราง kitchen_production_order_event — เลื่อนวันแล้วต้องตามรอยได้ว่าเดิมวันไหน เพราะอะไร
 */
async function rescheduleProductionOrder(body, session) {
  const orderId = Number(body?.orderId);
  const produceDate = ymd(body?.produceDate);
  if (!Number.isFinite(orderId) || orderId <= 0) throw badRequest('ไม่ระบุคำสั่งผลิต');
  if (!produceDate) throw badRequest('ระบุวันผลิตใหม่ (YYYY-MM-DD)');
  if (!(await hasOrderEventTable())) {
    throw badRequest('ยังไม่มีตารางเก็บประวัติการเลื่อนวัน — รัน update-office-server.bat ที่เครื่องออฟฟิศก่อน');
  }
  const movePlan = body?.movePlan !== false;
  const recorder = recorderOf(body, session);

  try {
    return await withTransaction(async (run) => {
      const found = await run(
        `SELECT order_id, doc_no, status, plan_day_id, CONVERT(NVARCHAR(10), produce_date, 23) AS produce_date
           FROM dbo.kitchen_production_order WITH (UPDLOCK, ROWLOCK)
          WHERE order_id = @order_id;`,
        { order_id: { type: sql.BigInt, value: orderId } }
      );
      const o = found?.recordset?.[0];
      if (!o) throw badRequest('ไม่พบคำสั่งผลิต');
      if (o.status === 'ผลิตเสร็จ' || o.status === 'ยกเลิก') {
        throw badRequest(`คำสั่ง ${o.doc_no} ${o.status}แล้ว เลื่อนวันไม่ได้`);
      }
      if (o.produce_date === produceDate) return { changed: false, message: 'วันผลิตเท่าเดิม ไม่ได้เลื่อน' };

      const params = {
        order_id: { type: sql.BigInt, value: orderId },
        new_date: { type: sql.NVarChar(10), value: produceDate },
      };
      await run(
        `UPDATE dbo.kitchen_production_order
            SET produce_date = CONVERT(DATE, @new_date, 23), updated_at = SYSDATETIME()
          WHERE order_id = @order_id;`,
        params
      );
      let planMoved = false;
      if (movePlan && o.plan_day_id) {
        const moved = await run(
          `UPDATE dbo.kitchen_production_plan_day
              SET plan_date = CONVERT(DATE, @new_date, 23), updated_at = SYSDATETIME()
            WHERE plan_day_id = @plan_day_id;`,
          { ...params, plan_day_id: { type: sql.Int, value: o.plan_day_id } }
        );
        planMoved = (moved?.rowsAffected?.[0] || 0) > 0;
      }
      await run(
        `INSERT INTO dbo.kitchen_production_order_event
           (order_id, action, old_date, new_date, old_status, new_status, plan_moved, reason, recorder)
         VALUES (@order_id, N'move', CONVERT(DATE, @old_date, 23), CONVERT(DATE, @new_date, 23),
                 @status, @status, @plan_moved, @reason, @recorder);`,
        {
          ...params,
          old_date: { type: sql.NVarChar(10), value: o.produce_date },
          status: { type: sql.NVarChar(50), value: o.status },
          plan_moved: { type: sql.Bit, value: planMoved },
          reason: { type: sql.NVarChar(500), value: orNull(body?.reason) && str(body.reason).slice(0, 500) },
          recorder: { type: sql.NVarChar(255), value: recorder },
        }
      );
      return {
        changed: true,
        planMoved,
        message: `เลื่อน ${o.doc_no} จาก ${o.produce_date} ไป ${produceDate} แล้ว${planMoved ? ' (ย้ายแผนในปฏิทินด้วย)' : ''}`,
      };
    });
  } catch (err) {
    // UX_kitchen_order_day_auto: คำสั่งจากยอดสาขามีได้ใบเดียวต่อสินค้าต่อวัน
    if (err?.number === 2601 || err?.number === 2627) {
      throw badRequest('วันนั้นมีคำสั่งผลิตจากยอดสาขาของสินค้านี้อยู่แล้ว — แก้จำนวนที่ใบนั้นแทน หรือเลือกวันอื่น');
    }
    throw err;
  }
}

/**
 * ยอดที่สาขาเบิกรวมกันของวันส่งหนึ่ง เฉพาะสินค้าที่ครัวกลางมีสูตรผลิต
 *
 * อ่านจาก store_fulfillment (ใบเบิกที่โกดังจัด) ไม่ใช่ยอดขาย — สิ่งที่ครัวกลางต้องผลิตคือ
 * สิ่งที่สาขาขอมา ส่วนที่โกดังจัดไปแล้วเท่าไหร่เป็นอีกเรื่อง จึงรวมทั้ง req_qty (ขอ) และ
 * del_qty (จัดจริง) กลับไปให้หน้าเว็บเลือกใช้เอง
 */
async function getBranchDemand(body) {
  const delDate = ymd(body?.delDate);
  if (!delDate) throw badRequest('ต้องระบุวันที่ส่งของ (delDate)');

  const rows = await runSql(
    `SELECT f.item_key AS product_key,
            MAX(f.item_code) AS product_code,
            MAX(f.item_name) AS product_name,
            SUM(f.req_qty)   AS requested_qty,
            SUM(f.del_qty)   AS delivered_qty,
            COUNT(DISTINCT f.branch) AS branch_count,
            r.yield_unit AS unit
       FROM dbo.store_fulfillment f
       JOIN dbo.kitchen_recipe r ON r.product_key = f.item_key AND r.is_active = 1
      WHERE f.del_date = CONVERT(DATE, @del_date, 23)
      GROUP BY f.item_key, r.yield_unit
      HAVING SUM(f.req_qty) > 0
      ORDER BY MAX(f.item_name);`,
    { del_date: { type: sql.NVarChar(10), value: delDate } }
  );
  return { delDate, demand: rows };
}

/**
 * สร้างคำสั่งผลิตจากยอดที่สาขาเบิกรวมกัน
 * กดซ้ำได้ — UNIQUE (produce_date, product_key, source) กันใบซ้ำอยู่แล้ว จึงใช้ MERGE
 * อัปเดตจำนวนแทนการสร้างใบใหม่ (ยอดเบิกของวันนั้นยังขยับได้จนกว่าจะปิดรอบ)
 */
async function createOrdersFromDemand(body, session) {
  const produceDate = ymd(body?.produceDate) || bangkokNow().date;
  const rows = Array.isArray(body?.items) ? body.items : [];
  if (rows.length === 0) throw badRequest('ไม่มีรายการที่จะสร้างคำสั่งผลิต');
  const recorder = recorderOf(body, session);

  return withTransaction(async (run) => {
    let created = 0;
    let updated = 0;
    for (const it of rows) {
      const productKey = normCode(it?.productKey || it?.productCode);
      const qty = num(it?.orderQty ?? it?.requestedQty);
      if (!productKey || qty <= 0) continue;

      const existing = await run(
        `SELECT order_id, doc_no FROM dbo.kitchen_production_order
          WHERE produce_date = CONVERT(DATE, @produce_date, 23)
            AND product_key = @product_key AND source = N'demand';`,
        {
          produce_date: { type: sql.NVarChar(10), value: produceDate },
          product_key: { type: sql.NVarChar(50), value: productKey },
        }
      );

      if (existing?.recordset?.length) {
        await run(
          `UPDATE dbo.kitchen_production_order
              SET order_qty = @order_qty, updated_at = SYSDATETIME()
            WHERE order_id = @order_id AND status <> N'ยกเลิก';`,
          {
            order_id: { type: sql.BigInt, value: existing.recordset[0].order_id },
            order_qty: { type: sql.Decimal(18, 3), value: qty },
          }
        );
        updated++;
        continue;
      }

      const docNo = await nextDocNo(run, 'dbo.kitchen_production_order', 'PRD', produceDate);
      await run(
        `INSERT INTO dbo.kitchen_production_order
           (doc_no, produce_date, product_key, product_code, product_name,
            order_qty, unit, status, source, note, recorder)
         VALUES (@doc_no, CONVERT(DATE, @produce_date, 23), @product_key, @product_code, @product_name,
                 @order_qty, @unit, N'รอผลิต', N'demand', @note, @recorder);`,
        {
          doc_no: { type: sql.NVarChar(50), value: docNo },
          produce_date: { type: sql.NVarChar(10), value: produceDate },
          product_key: { type: sql.NVarChar(50), value: productKey },
          product_code: { type: sql.NVarChar(50), value: str(it?.productCode) || productKey },
          product_name: { type: sql.NVarChar(255), value: str(it?.productName).slice(0, 255) },
          order_qty: { type: sql.Decimal(18, 3), value: qty },
          unit: { type: sql.NVarChar(50), value: orNull(it?.unit) },
          note: { type: sql.NVarChar(500), value: orNull(it?.note) },
          recorder: { type: sql.NVarChar(255), value: recorder },
        }
      );
      created++;
    }
    return {
      created,
      updated,
      message: `สร้างคำสั่งผลิตจากยอดสาขา ${created} ใบ · ปรับจำนวน ${updated} ใบ`,
    };
  });
}

/**
 * สร้างคำสั่งผลิตของวันหนึ่งจากแผนผลิตรายวัน (kitchen_production_plan_day) ของวันนั้น
 *
 * เมนูที่มีคำสั่งตามแผนอยู่แล้วไม่ทับ — ครัวอาจแก้จำนวนไปแล้ว กดซ้ำจึงปลอดภัย
 * ใบเดิมที่ถูกยกเลิกยังกินที่ใน UX_kitchen_order_day_auto อยู่ จึงนำกลับมาใช้ด้วยจำนวนตามแผน
 * แทนการออกใบใหม่ (ออกใบใหม่ไม่ได้ ชน index)
 *
 * แผนประจำรอบเดิม (kitchen_production_plan) ไม่ถูกใช้แล้ว — หน้าเว็บเปลี่ยนเป็นปฏิทินรายวัน
 */
async function createOrdersFromPlan(body, session) {
  const produceDate = ymd(body?.produceDate) || bangkokNow().date;
  const recorder = recorderOf(body, session);

  let plans;
  try {
    plans = await runSql(
      `SELECT plan_day_id, product_key, product_code, product_name, planned_qty, unit, note
         FROM dbo.kitchen_production_plan_day
        WHERE plan_date = CONVERT(DATE, @produce_date, 23);`,
      { produce_date: { type: sql.NVarChar(10), value: produceDate } }
    );
  } catch (err) {
    throw planDayMissing(err);
  }
  if (plans.length === 0) {
    return { created: 0, skipped: 0, message: 'ไม่มีแผนผลิตในวันนี้' };
  }

  return ordersFromPlanRows(plans, produceDate, recorder).catch((err) => { throw planDayMissing(err); });
}

/**
 * สร้างคำสั่งผลิตจากแผนรายการเดียว (ปุ่มสั่งผลิตในแถวแผนของหน้าแพลนผลิต)
 *
 * แยกเป็น action ใหม่ ไม่ใช่เติม planId ให้ createOrdersFromPlan — office-server รุ่นเก่าที่ยังไม่อัปเดต
 * จะมองข้าม planId แล้วสร้างคำสั่งให้ทุกแผนของวันนั้น ส่วน action ใหม่ รุ่นเก่าตอบ "ไม่รู้จัก" เฉย ๆ
 */
async function createOrderFromPlanDay(body, session) {
  const planId = Number(body?.planId);
  if (!Number.isFinite(planId) || planId <= 0) throw badRequest('ไม่ระบุแผนผลิต');
  const recorder = recorderOf(body, session);

  let plans;
  try {
    plans = await runSql(
      `SELECT plan_day_id, CONVERT(NVARCHAR(10), plan_date, 23) AS plan_date,
              product_key, product_code, product_name, planned_qty, unit, note
         FROM dbo.kitchen_production_plan_day
        WHERE plan_day_id = @plan_id;`,
      { plan_id: { type: sql.BigInt, value: planId } }
    );
  } catch (err) {
    throw planDayMissing(err);
  }
  if (plans.length === 0) throw badRequest('ไม่พบแผนผลิตนี้แล้ว (อาจถูกลบไป)');

  return ordersFromPlanRows(plans, plans[0].plan_date, recorder).catch((err) => { throw planDayMissing(err); });
}

/**
 * แถวแผนของวันเดียวกัน → คำสั่งผลิต source = 'plan' ผูกด้วย plan_day_id หนึ่งแผนต่อหนึ่งใบ
 * (มีใบที่ยังไม่ยกเลิกอยู่แล้ว = ข้าม, ใบที่ยกเลิก = เปิดใหม่) เมนูเดิมวันเดิมหลายแผน = หลายใบ
 */
function ordersFromPlanRows(plans, produceDate, recorder) {
  return withTransaction(async (run) => {
    let created = 0;
    let skipped = 0;
    for (const p of plans) {
      const existing = await run(
        `SELECT order_id, status FROM dbo.kitchen_production_order
          WHERE plan_day_id = @plan_day_id;`,
        { plan_day_id: { type: sql.Int, value: p.plan_day_id } }
      );
      const found = existing?.recordset?.[0];
      if (found && found.status !== 'ยกเลิก') { skipped++; continue; }

      if (found) {
        await run(
          `UPDATE dbo.kitchen_production_order
              SET status = N'รอผลิต', order_qty = @order_qty, unit = @unit, note = @note,
                  recorder = @recorder, updated_at = SYSDATETIME()
            WHERE order_id = @order_id;`,
          {
            order_id: { type: sql.BigInt, value: found.order_id },
            order_qty: { type: sql.Decimal(18, 3), value: Number(p.planned_qty) },
            unit: { type: sql.NVarChar(50), value: p.unit },
            note: { type: sql.NVarChar(500), value: p.note },
            recorder: { type: sql.NVarChar(255), value: recorder },
          }
        );
        created++;
        continue;
      }

      const docNo = await nextDocNo(run, 'dbo.kitchen_production_order', 'PRD', produceDate);
      await run(
        `INSERT INTO dbo.kitchen_production_order
           (doc_no, produce_date, product_key, product_code, product_name,
            order_qty, unit, status, source, plan_day_id, note, recorder)
         VALUES (@doc_no, CONVERT(DATE, @produce_date, 23), @product_key, @product_code, @product_name,
                 @order_qty, @unit, N'รอผลิต', N'plan', @plan_day_id, @note, @recorder);`,
        {
          plan_day_id: { type: sql.Int, value: p.plan_day_id },
          doc_no: { type: sql.NVarChar(50), value: docNo },
          produce_date: { type: sql.NVarChar(10), value: produceDate },
          product_key: { type: sql.NVarChar(50), value: p.product_key },
          product_code: { type: sql.NVarChar(50), value: p.product_code },
          product_name: { type: sql.NVarChar(255), value: p.product_name },
          order_qty: { type: sql.Decimal(18, 3), value: Number(p.planned_qty) },
          unit: { type: sql.NVarChar(50), value: p.unit },
          note: { type: sql.NVarChar(500), value: p.note },
          recorder: { type: sql.NVarChar(255), value: recorder },
        }
      );
      created++;
    }
    return {
      created,
      skipped,
      message: `สร้างคำสั่งผลิตจากแผน ${created} ใบ` + (skipped ? ` · มีอยู่แล้ว ${skipped} ใบ` : ''),
    };
  });
}


/* ==========================================================================
   เบิกวัตถุดิบ
========================================================================== */

/**
 * วัตถุดิบที่ต้องใช้ตามสูตร สำหรับคำสั่งผลิตใบหนึ่ง
 * คิดตามสัดส่วน: ใช้ = qty ในสูตร × (จำนวนสั่งผลิต ÷ yield_qty)
 * ใช้เติมหน้าเบิกวัตถุดิบให้อัตโนมัติ ครัวแก้ตัวเลขทับได้ก่อนกดบันทึก
 */
async function getOrderMaterials(body) {
  const orderId = Number(body?.orderId);
  if (!Number.isFinite(orderId)) throw badRequest('ไม่ระบุคำสั่งผลิต');

  const head = await runSql(
    `SELECT o.order_id, o.doc_no, o.produce_date, o.product_key, o.product_name,
            o.order_qty, o.unit, r.recipe_id, r.yield_qty, r.yield_unit
       FROM dbo.kitchen_production_order o
       LEFT JOIN dbo.kitchen_recipe r ON r.product_key = o.product_key AND r.is_active = 1
      WHERE o.order_id = @order_id;`,
    { order_id: { type: sql.BigInt, value: orderId } }
  );
  if (head.length === 0) throw badRequest('ไม่พบคำสั่งผลิต');

  const order = head[0];
  if (!order.recipe_id) {
    return { order, materials: [], message: 'สินค้านี้ยังไม่มีสูตรการผลิต' };
  }

  const factor = Number(order.order_qty) / Number(order.yield_qty);
  const items = await runSql(
    `SELECT item_key, item_code, item_name, qty, unit, sort_order
       FROM dbo.kitchen_recipe_item WHERE recipe_id = @recipe_id ORDER BY sort_order, item_name;`,
    { recipe_id: { type: sql.Int, value: order.recipe_id } }
  );

  const materials = items.map((it) => ({
    itemKey: it.item_key,
    itemCode: it.item_code,
    itemName: it.item_name,
    unit: it.unit,
    recipeQty: Number(it.qty),
    // ปัดสามตำแหน่งให้ตรงกับความละเอียดของคอลัมน์ DECIMAL(18,3) ที่จะเก็บลงไป
    requiredQty: Math.round(Number(it.qty) * factor * 1000) / 1000,
  }));
  return { order, factor, materials };
}

async function getMaterialIssues(body) {
  const from = ymd(body?.dateFrom);
  const to = ymd(body?.dateTo);
  if (!from || !to) throw badRequest('ต้องระบุช่วงวันที่ (dateFrom, dateTo)');

  const rows = await runSql(
    `SELECT mi.issue_id, mi.doc_no, mi.issue_date, mi.order_id, o.doc_no AS order_doc_no,
            o.product_name AS order_product_name,
            mi.item_key, mi.item_code, mi.item_name, mi.qty, mi.unit, mi.unit_price, mi.loss_qty,
            mi.note, mi.recorder, mi.recorded_at
       FROM dbo.kitchen_material_issue mi
       LEFT JOIN dbo.kitchen_production_order o ON o.order_id = mi.order_id
      WHERE mi.issue_date BETWEEN CONVERT(DATE, @from, 23) AND CONVERT(DATE, @to, 23)
      ORDER BY mi.issue_date DESC, mi.doc_no, mi.item_name;`,
    {
      from: { type: sql.NVarChar(10), value: from },
      to: { type: sql.NVarChar(10), value: to },
    }
  );
  return { issues: rows };
}

/**
 * บันทึกใบเบิกวัตถุดิบหนึ่งใบ (หลายรายการ)
 *
 * lossQty = ส่วนของ qty ที่เป็นของสูญเสีย (หน่วยสต๊อก) ไม่ได้บวกเพิ่มจาก qty
 * unit_price เติมที่นี่จาก stock_item.price ณ ตอนเบิก ไม่รับจากหน้าเว็บ — ต้นทุนในรายงาน
 * คิดจากราคานี้ ราคาในชีทเปลี่ยนทีหลังก็ไม่ย้อนไปเปลี่ยนต้นทุนของที่ผลิตไปแล้ว
 */
async function saveMaterialIssue(body, session) {
  const issueDate = ymd(body?.issueDate) || bangkokNow().date;
  const orderId = Number(body?.orderId);
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  const recorder = recorderOf(body, session);

  const items = [];
  const seen = new Map();
  for (const it of rawItems) {
    const key = normCode(it?.itemKey || it?.code);
    const qty = num(it?.qty);
    if (!key || qty <= 0) continue;
    // ติดลบไม่ได้ และเกินยอดเบิกไม่ได้ (ของเสียเป็นส่วนหนึ่งของที่เบิก)
    const lossQty = Math.min(Math.max(num(it?.lossQty), 0), qty);
    // UNIQUE (doc_no, item_key) ทำให้วัตถุดิบตัวเดียวกันใส่สองบรรทัดในใบเดียวไม่ได้ — รวมยอดให้
    if (seen.has(key)) {
      const cur = seen.get(key);
      cur.qty += qty;
      cur.lossQty += lossQty;
      continue;
    }
    const row = {
      key,
      code: str(it?.code || it?.itemCode) || key,
      name: str(it?.name || it?.itemName).slice(0, 255),
      qty,
      lossQty,
      unit: orNull(it?.unit),
      note: orNull(it?.note),
    };
    seen.set(key, row);
    items.push(row);
  }
  if (items.length === 0) throw badRequest('ไม่มีรายการวัตถุดิบที่จะเบิก');

  return withTransaction(async (run) => {
    const docNo = await nextDocNo(run, 'dbo.kitchen_material_issue', 'MI', issueDate);
    for (const it of items) {
      await run(
        `INSERT INTO dbo.kitchen_material_issue
           (doc_no, issue_date, order_id, item_key, item_code, item_name, qty, unit,
            unit_price, loss_qty, note, recorder)
         VALUES (@doc_no, CONVERT(DATE, @issue_date, 23), @order_id, @item_key, @item_code,
                 @item_name, @qty, @unit,
                 (SELECT CASE WHEN price > 0 THEN price END FROM dbo.stock_item WHERE item_key = @item_key),
                 @loss_qty, @note, @recorder);`,
        {
          doc_no: { type: sql.NVarChar(50), value: docNo },
          issue_date: { type: sql.NVarChar(10), value: issueDate },
          order_id: { type: sql.BigInt, value: Number.isFinite(orderId) && orderId > 0 ? orderId : null },
          item_key: { type: sql.NVarChar(50), value: it.key },
          item_code: { type: sql.NVarChar(50), value: it.code },
          item_name: { type: sql.NVarChar(255), value: it.name },
          qty: { type: sql.Decimal(18, 3), value: it.qty },
          unit: { type: sql.NVarChar(50), value: it.unit },
          loss_qty: { type: sql.Decimal(18, 3), value: it.lossQty > 0 ? it.lossQty : null },
          note: { type: sql.NVarChar(500), value: it.note },
          recorder: { type: sql.NVarChar(255), value: recorder },
        }
      );
    }
    return { docNo, count: items.length, message: `บันทึกใบเบิกวัตถุดิบ ${docNo} แล้ว (${items.length} รายการ)` };
  });
}


/**
 * บันทึกรับวัตถุดิบเข้าครัวหนึ่งใบ (หลายรายการ)
 *
 * ครัวกลางไม่ใช่ outlet ในระบบ POS จึงไม่มีใบเบิกของตัวเองให้ไหลเข้า store_receiving
 * แบบที่สาขาทำ ทางรับของของครัวจึงเป็นตารางนี้ — คนกรอกเองตอนของมาถึง
 */
async function saveMaterialReceipt(body, session) {
  const receiveDate = ymd(body?.receiveDate) || bangkokNow().date;
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  const recorder = recorderOf(body, session);

  const items = [];
  const seen = new Map();
  for (const it of rawItems) {
    const key = normCode(it?.itemKey || it?.code);
    const qty = num(it?.qty);
    if (!key || qty <= 0) continue;
    // UNIQUE (doc_no, item_key) ทำให้ของตัวเดียวกันใส่สองบรรทัดในใบเดียวไม่ได้ — รวมยอดให้
    if (seen.has(key)) { seen.get(key).qty += qty; continue; }
    const row = {
      key,
      code: str(it?.code || it?.itemCode) || key,
      name: str(it?.name || it?.itemName).slice(0, 255),
      qty,
      unit: orNull(it?.unit),
      note: orNull(it?.note),
    };
    seen.set(key, row);
    items.push(row);
  }
  if (items.length === 0) throw badRequest('ไม่มีรายการวัตถุดิบที่รับเข้า');

  const sourceName = str(body?.sourceName) || 'โกดัง';

  return withTransaction(async (run) => {
    const docNo = await nextDocNo(run, 'dbo.kitchen_material_receipt', 'MR', receiveDate);
    for (const it of items) {
      await run(
        `INSERT INTO dbo.kitchen_material_receipt
           (doc_no, receive_date, item_key, item_code, item_name, qty, unit, source_name, note, recorder)
         VALUES (@doc_no, CONVERT(DATE, @receive_date, 23), @item_key, @item_code,
                 @item_name, @qty, @unit, @source_name, @note, @recorder);`,
        {
          doc_no: { type: sql.NVarChar(50), value: docNo },
          receive_date: { type: sql.NVarChar(10), value: receiveDate },
          item_key: { type: sql.NVarChar(50), value: it.key },
          item_code: { type: sql.NVarChar(50), value: it.code },
          item_name: { type: sql.NVarChar(255), value: it.name },
          qty: { type: sql.Decimal(18, 3), value: it.qty },
          unit: { type: sql.NVarChar(50), value: it.unit },
          source_name: { type: sql.NVarChar(255), value: sourceName },
          note: { type: sql.NVarChar(500), value: it.note },
          recorder: { type: sql.NVarChar(255), value: recorder },
        }
      );
    }
    return { docNo, count: items.length, message: `บันทึกรับวัตถุดิบ ${docNo} แล้ว (${items.length} รายการ)` };
  });
}

async function getMaterialReceipts(body) {
  const from = ymd(body?.dateFrom);
  const to = ymd(body?.dateTo);
  if (!from || !to) throw badRequest('ต้องระบุช่วงวันที่ (dateFrom, dateTo)');

  const rows = await runSql(
    `SELECT receipt_id, doc_no, receive_date, item_key, item_code, item_name,
            qty, unit, source_name, note, recorder, recorded_at
       FROM dbo.kitchen_material_receipt
      WHERE receive_date BETWEEN CONVERT(DATE, @from, 23) AND CONVERT(DATE, @to, 23)
      ORDER BY receive_date DESC, doc_no, item_name;`,
    {
      from: { type: sql.NVarChar(10), value: from },
      to: { type: sql.NVarChar(10), value: to },
    }
  );
  return { receipts: rows };
}


/* ==========================================================================
   วัตถุดิบคงเหลือ
========================================================================== */

/**
 * คงเหลือของครัวกลาง คำนวณสดจากเหตุการณ์ ไม่ได้เก็บเป็นตัวเลขนิ่ง
 *
 *   คงเหลือ = ยอดนับล่าสุด + รับเข้าหลังวันนับ - เบิกไปใช้หลังวันนับ + ผลิตได้หลังวันนับ
 *
 * "รับเข้า" มาจากสองทางรวมกัน: kitchen_material_receipt (ครัวกรอกเองตอนของมาถึง ซึ่งเป็นทาง
 * ปกติ เพราะครัวกลางไม่ใช่ outlet ในระบบ POS) และ store_receiving ของสาขาที่ชื่อตรงกับ
 * KITCHEN_BRANCH (เผื่อวันหนึ่งครัวถูกเพิ่มเป็นสาขาจริง จะได้ไม่ต้องย้ายข้อมูล)
 *
 * ตัวตั้งคือการนับจริง การนับรอบใหม่จึงล้างความคลาดเคลื่อนสะสมให้เอง
 * สินค้าที่ไม่เคยถูกนับเลยจะนับรวมทุกอย่างตั้งแต่ต้น (COALESCE เป็น 1900-01-01)
 *
 * เส้นแบ่งคือ "หลังวันที่นับ" ไม่ใช่ "หลังเวลาที่นับ" เพราะใบรับของกับใบเบิกวัตถุดิบเก็บแค่
 * วันที่ ไม่มีเวลา เทียบละเอียดกว่านี้ไม่ได้ ผลคือรายการที่เกิดในวันเดียวกับที่นับจะไม่ถูกรวม
 * ซึ่งถูกต้องถ้านับตอนปิดร้าน — เป็นกติกาที่หน้าสต๊อกสาขาใช้อยู่เหมือนกัน
 */
async function getKitchenBalance(body) {
  const branch = str(body?.branch) || kitchenBranch();
  const asOf = ymd(body?.asOf);

  const rows = await runSql(
    `WITH last_count AS (
        SELECT c.item_key, c.remaining, CAST(c.counted_at AS DATE) AS count_date,
               ROW_NUMBER() OVER (PARTITION BY c.item_key ORDER BY c.counted_at DESC) AS rn
          FROM dbo.stock_count c
         WHERE c.branch = @branch
           -- ดูย้อนหลัง: ยอดนับที่ใหม่กว่าวันที่ดูไม่ใช่ตัวตั้ง (เดิมไม่กรอง คงเหลือย้อนหลังจึงเอายอดนับอนาคตมาใช้)
           AND (@as_of IS NULL OR CAST(c.counted_at AS DATE) <= CONVERT(DATE, @as_of, 23))
     ),
     lc AS (SELECT item_key, remaining, count_date FROM last_count WHERE rn = 1),
     scope AS (
        SELECT item_key FROM dbo.kitchen_recipe_item
        UNION SELECT product_key FROM dbo.kitchen_recipe
        UNION SELECT item_key FROM dbo.kitchen_material_issue
        UNION SELECT item_key FROM dbo.kitchen_material_receipt
        -- วัตถุดิบที่เคยนับที่สาขาครัว (นำเข้ายอดนับจาก Excel / แก้ยอด) = วัตถุดิบของครัวด้วย แม้ยังไม่อยู่ในสูตรหรือใบเบิก
        UNION SELECT item_key FROM dbo.stock_count WHERE branch = @branch
        -- วัตถุดิบที่ติ๊กสาขา FCT ไว้ใน QC/RD > วัตถุดิบ (naraipizzeria) = รายการของครัว แม้ยังไม่เคยนับ/เบิก
        UNION SELECT item_key FROM dbo.stock_item_branch WHERE branch IN (@item_branch1, @item_branch2)
     ),
     -- ชื่อ/หน่วยจากยอดนับล่าสุดของครัว — ใช้แทนเมื่อรหัสยังไม่มีใน stock_item (นำเข้าจากไฟล์นับของครัว)
     kc AS (
        SELECT item_key, item_code, item_name, unit,
               ROW_NUMBER() OVER (PARTITION BY item_key ORDER BY counted_at DESC) AS rn
          FROM dbo.stock_count
         WHERE branch = @branch
     )
     SELECT s.item_key,
            COALESCE(i.item_code, kc.item_code) AS item_code,
            COALESCE(i.item_name, kc.item_name) AS item_name,
            COALESCE(i.unit, kc.unit) AS unit,
            CASE WHEN i.item_key IS NULL THEN 0 ELSE 1 END AS in_registry,
            CASE WHEN EXISTS (SELECT 1 FROM dbo.stock_item_branch b
                               WHERE b.item_key = s.item_key AND b.branch IN (@item_branch1, @item_branch2))
                 THEN 1 ELSE 0 END AS is_kitchen,
            COALESCE(lc.remaining, 0) AS counted_qty,
            lc.count_date,
            COALESCE(mr.qty, 0) + COALESCE(rc.qty, 0) AS received_qty,
            COALESCE(iss.qty, 0) AS issued_qty,
            COALESCE(pr.qty, 0) AS produced_qty,
            COALESCE(lc.remaining, 0) + COALESCE(mr.qty, 0) + COALESCE(rc.qty, 0)
              - COALESCE(iss.qty, 0) + COALESCE(pr.qty, 0) AS balance
       FROM scope s
       LEFT JOIN dbo.stock_item i ON i.item_key = s.item_key
       LEFT JOIN kc ON kc.item_key = s.item_key AND kc.rn = 1
       LEFT JOIN lc ON lc.item_key = s.item_key
       OUTER APPLY (
         SELECT SUM(r.qty_received) AS qty FROM dbo.store_receiving r
          WHERE r.item_key = s.item_key AND r.branch = @branch
            AND r.receive_date > COALESCE(lc.count_date, '19000101')
            AND (@as_of IS NULL OR r.receive_date <= CONVERT(DATE, @as_of, 23))
       ) rc
       OUTER APPLY (
         SELECT SUM(m.qty) AS qty FROM dbo.kitchen_material_receipt m
          WHERE m.item_key = s.item_key
            AND m.receive_date > COALESCE(lc.count_date, '19000101')
            AND (@as_of IS NULL OR m.receive_date <= CONVERT(DATE, @as_of, 23))
       ) mr
       OUTER APPLY (
         SELECT SUM(m.qty) AS qty FROM dbo.kitchen_material_issue m
          WHERE m.item_key = s.item_key
            AND m.issue_date > COALESCE(lc.count_date, '19000101')
            AND (@as_of IS NULL OR m.issue_date <= CONVERT(DATE, @as_of, 23))
       ) iss
       OUTER APPLY (
         SELECT SUM(p.qty_produced) AS qty FROM dbo.kitchen_production_run p
          WHERE p.product_key = s.item_key
            AND p.produce_date > COALESCE(lc.count_date, '19000101')
            AND (@as_of IS NULL OR p.produce_date <= CONVERT(DATE, @as_of, 23))
       ) pr
      -- ไม่มีในทะเบียนสินค้าและไม่เคยนับที่ครัว (เช่นรหัสเมนูในสูตรเก่า) = ไม่ใช่วัตถุดิบที่แสดงได้ ตัดออกเหมือนเดิม
      WHERE i.item_key IS NOT NULL OR kc.item_key IS NOT NULL
      ORDER BY COALESCE(i.item_name, kc.item_name);`,
    {
      branch: { type: sql.NVarChar(50), value: branch },
      as_of: { type: sql.NVarChar(10), value: asOf },
      ...itemBranchParams(),
    }
  );
  return { branch, asOf, itemBranches: kitchenItemBranches(), items: rows };
}

/**
 * สต๊อกการ์ดของวัตถุดิบหนึ่งตัว — ยอดยกมา + ทุกความเคลื่อนไหวในช่วงวันที่ (หน้าวัตถุดิบคงเหลือของ storefct)
 *
 * ยอดยกมา = คงเหลือ ณ สิ้นวันก่อน dateFrom กติกาเดียวกับ getKitchenBalance ทุกอย่าง
 * (ยอดนับล่าสุดที่ไม่เกินวันนั้น + รับเข้า − เบิกใช้ + ผลิตได้ หลังวันนับ)
 * หน้าเว็บเดินยอดรายวันต่อเอง: วันที่มียอดนับ → คงเหลือสิ้นวัน = ยอดนับล่าสุดของวันนั้น
 * (รายการวันเดียวกับวันนับไม่ถูกรวม — ตรงกับ getKitchenBalance) ไม่งั้น + เข้า − ออก
 */
async function getKitchenStockCard(body) {
  const itemKey = normCode(body?.itemKey || body?.itemCode);
  const from = ymd(body?.dateFrom);
  const to = ymd(body?.dateTo);
  if (!itemKey) throw badRequest('ไม่ระบุวัตถุดิบ');
  if (!from || !to || from > to) throw badRequest('ช่วงวันที่ไม่ถูกต้อง');
  const branch = kitchenBranch();
  const params = {
    item_key: { type: sql.NVarChar(50), value: itemKey },
    branch: { type: sql.NVarChar(50), value: branch },
    from: { type: sql.NVarChar(10), value: from },
    to: { type: sql.NVarChar(10), value: to },
  };

  const opening = await runSql(
    `DECLARE @open DATE = DATEADD(DAY, -1, CONVERT(DATE, @from, 23));
     WITH lc AS (
       SELECT TOP 1 c.remaining, CAST(c.counted_at AS DATE) AS count_date
         FROM dbo.stock_count c
        WHERE c.branch = @branch AND c.item_key = @item_key AND CAST(c.counted_at AS DATE) <= @open
        ORDER BY c.counted_at DESC
     )
     SELECT CONVERT(NVARCHAR(10), @open, 23) AS open_date,
            (SELECT remaining FROM lc) AS counted_qty,
            (SELECT CONVERT(NVARCHAR(10), count_date, 23) FROM lc) AS count_date,
            COALESCE((SELECT remaining FROM lc), 0)
            + COALESCE((SELECT SUM(m.qty) FROM dbo.kitchen_material_receipt m
                         WHERE m.item_key = @item_key AND m.receive_date <= @open
                           AND m.receive_date > COALESCE((SELECT count_date FROM lc), '19000101')), 0)
            + COALESCE((SELECT SUM(r.qty_received) FROM dbo.store_receiving r
                         WHERE r.item_key = @item_key AND r.branch = @branch AND r.receive_date <= @open
                           AND r.receive_date > COALESCE((SELECT count_date FROM lc), '19000101')), 0)
            - COALESCE((SELECT SUM(m.qty) FROM dbo.kitchen_material_issue m
                         WHERE m.item_key = @item_key AND m.issue_date <= @open
                           AND m.issue_date > COALESCE((SELECT count_date FROM lc), '19000101')), 0)
            + COALESCE((SELECT SUM(p.qty_produced) FROM dbo.kitchen_production_run p
                         WHERE p.product_key = @item_key AND p.produce_date <= @open
                           AND p.produce_date > COALESCE((SELECT count_date FROM lc), '19000101')), 0) AS balance;`,
    params
  );

  const range = (col) => `${col} BETWEEN CONVERT(DATE, @from, 23) AND CONVERT(DATE, @to, 23)`;
  const events = await runSql(
    `SELECT 'count' AS kind, CONVERT(NVARCHAR(10), CAST(c.counted_at AS DATE), 23) AS date,
            CONVERT(NVARCHAR(19), c.counted_at, 120) AS at, N'' AS doc_no, c.counter_name AS ref,
            c.remaining AS qty, NULL AS loss_qty
       FROM dbo.stock_count c
      WHERE c.branch = @branch AND c.item_key = @item_key AND ${range('CAST(c.counted_at AS DATE)')}
     UNION ALL
     SELECT 'receipt', CONVERT(NVARCHAR(10), m.receive_date, 23), CONVERT(NVARCHAR(19), m.recorded_at, 120),
            m.doc_no, COALESCE(m.source_name, N''), m.qty, NULL
       FROM dbo.kitchen_material_receipt m
      WHERE m.item_key = @item_key AND ${range('m.receive_date')}
     UNION ALL
     SELECT 'store', CONVERT(NVARCHAR(10), r.receive_date, 23), CONVERT(NVARCHAR(19), r.recorded_at, 120),
            r.doc_no, N'ใบเบิกคลังกลาง', r.qty_received, NULL
       FROM dbo.store_receiving r
      WHERE r.item_key = @item_key AND r.branch = @branch AND ${range('r.receive_date')}
     UNION ALL
     SELECT 'issue', CONVERT(NVARCHAR(10), m.issue_date, 23), CONVERT(NVARCHAR(19), m.recorded_at, 120),
            m.doc_no, COALESCE(o.doc_no, N''), m.qty, m.loss_qty
       FROM dbo.kitchen_material_issue m
       LEFT JOIN dbo.kitchen_production_order o ON o.order_id = m.order_id
      WHERE m.item_key = @item_key AND ${range('m.issue_date')}
     UNION ALL
     SELECT 'produce', CONVERT(NVARCHAR(10), p.produce_date, 23), CONVERT(NVARCHAR(19), p.recorded_at, 120),
            COALESCE(o.doc_no, N''), N'', p.qty_produced, p.qty_waste
       FROM dbo.kitchen_production_run p
       LEFT JOIN dbo.kitchen_production_order o ON o.order_id = p.order_id
      WHERE p.product_key = @item_key AND ${range('p.produce_date')}
     ORDER BY date, at;`,
    params
  );

  return { itemKey, branch, dateFrom: from, dateTo: to, opening: opening[0] || null, events };
}

/**
 * ประวัติยอดนับของวัตถุดิบหนึ่งตัวในสาขาครัว — ทั้งที่แก้จากหน้าวัตถุดิบคงเหลือของ storefct
 * (saveKitchenCount) และที่นับจากหน้านับสต๊อกของสาขา เรียงใหม่สุดก่อน
 * ไม่มีใครลบหรือทับแถวเก่า ประวัติจึงครบทุกครั้งที่บันทึก
 */
async function getKitchenCountHistory(body) {
  const itemKey = normCode(body?.itemKey || body?.itemCode);
  if (!itemKey) throw badRequest('ไม่ระบุวัตถุดิบ');
  const limit = Math.min(Math.max(Number(body?.limit) || 30, 1), 200);
  const rows = await runSql(
    `SELECT TOP (@limit) c.count_id,
            CONVERT(NVARCHAR(19), c.counted_at, 120) AS counted_at,
            c.remaining, c.unit, c.counter_name,
            CONVERT(NVARCHAR(19), c.created_at, 120) AS created_at
       FROM dbo.stock_count c
      WHERE c.branch = @branch AND c.item_key = @item_key
      ORDER BY c.counted_at DESC, c.count_id DESC;`,
    {
      limit: { type: sql.Int, value: limit },
      branch: { type: sql.NVarChar(50), value: kitchenBranch().toLowerCase() },
      item_key: { type: sql.NVarChar(50), value: itemKey },
    }
  );
  return { itemKey, branch: kitchenBranch().toLowerCase(), history: rows };
}

/**
 * ยอดยกมา dbo.stock_balance ของสาขาครัว = ยอดนับนี้ — เฉพาะเมื่อเป็นยอดล่าสุดของสินค้านั้นจริง ย้อนวันไม่ไปทับยอดใหม่กว่า
 * กติกาเดียวกับหน้านับสต๊อกของสาขา (stock.js)
 */
async function syncKitchenStockBalance(run, { branch, itemKey, itemCode, itemName, remaining, countedAt }) {
  await run(
    `IF NOT EXISTS (SELECT 1 FROM dbo.stock_count
                     WHERE branch = @branch AND item_key = @item_key
                       AND counted_at > CONVERT(DATETIME2(0), @counted_at, 120))
     MERGE dbo.stock_balance AS t
     USING (SELECT @branch AS branch, @item_key AS item_key) AS s
       ON t.branch = s.branch AND t.item_key = s.item_key
     WHEN MATCHED THEN UPDATE SET
       item_code = @item_code, item_name = @item_name, balance = @balance,
       updated_at = CONVERT(DATETIME2(0), @counted_at, 120)
     WHEN NOT MATCHED THEN INSERT (branch, item_key, item_code, item_name, balance, updated_at)
       VALUES (@branch, @item_key, @item_code, @item_name, @balance, CONVERT(DATETIME2(0), @counted_at, 120));`,
    {
      branch: { type: sql.NVarChar(50), value: branch },
      item_key: { type: sql.NVarChar(50), value: itemKey },
      item_code: { type: sql.NVarChar(50), value: itemCode },
      item_name: { type: sql.NVarChar(255), value: itemName },
      balance: { type: sql.Decimal(18, 3), value: remaining },
      counted_at: { type: sql.NVarChar(19), value: countedAt },
    }
  );
}

/**
 * แก้ยอดคงเหลือของวัตถุดิบหนึ่งตัว = บันทึกเป็น "ยอดนับ" ของสาขาครัว (KITCHEN_BRANCH)
 *
 * คงเหลือคำนวณสดจากยอดนับล่าสุด (getKitchenBalance) การแก้จึงคือการเพิ่มยอดนับใหม่ ไม่ใช่ทับตัวเลข
 * ลง dbo.stock_count + ยอดยกมา dbo.stock_balance กติกาเดียวกับหน้านับสต๊อกของสาขา (stock.js)
 * หน้านับสต๊อกของ Narai-branch สาขาครัวจึงเห็นยอดนี้ด้วย และมีประวัติว่าใครแก้เมื่อไหร่
 *
 * countDate = ยอด ณ สิ้นวันไหน — วันนี้ = เวลาตอนกด · วันก่อน = 23:59:59 ของวันนั้น
 * เส้นแบ่งของคงเหลือเป็น "หลังวันที่นับ" (ใบรับ/ใบเบิกไม่มีเวลา) รายการวันเดียวกับวันนับจึงไม่ถูกรวม
 * ยอดยกมาอัปเดตเฉพาะเมื่อยอดนี้เป็นยอดล่าสุดของสินค้านั้นจริง ย้อนวันไม่ไปทับยอดใหม่กว่า
 */
async function saveKitchenCount(body, session) {
  const itemKey = normCode(body?.itemKey || body?.itemCode);
  if (!itemKey) throw badRequest('ไม่ระบุวัตถุดิบ');
  const raw = body?.remaining;
  const remaining = num(raw);
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(Number(raw)) || remaining < 0) {
    throw badRequest('ยอดคงเหลือต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
  }
  const now = bangkokNow();
  const countDate = ymd(body?.countDate) || now.date;
  if (countDate > now.date) throw badRequest('ย้อนได้อย่างเดียว ตั้งยอดของวันข้างหน้าไม่ได้');
  const countedAt = countDate === now.date ? `${now.date} ${now.time}` : `${countDate} 23:59:59`;
  const branch = kitchenBranch().toLowerCase();
  const recorder = recorderOf(body, session);

  return withTransaction(async (run) => {
    const item = await run(
      `SELECT item_code, item_name, unit FROM dbo.stock_item WHERE item_key = @item_key;`,
      { item_key: { type: sql.NVarChar(50), value: itemKey } }
    );
    const it = item?.recordset?.[0] || {};
    const itemCode = str(it.item_code) || str(body?.itemCode) || itemKey;
    const itemName = str(it.item_name) || str(body?.itemName) || null;
    const unit = str(it.unit) || str(body?.unit) || null;

    const ins = await run(
      `DECLARE @inserted INT = 0;
       IF NOT EXISTS (SELECT 1 FROM dbo.stock_count
                       WHERE branch = @branch AND item_key = @item_key
                         AND counted_at = CONVERT(DATETIME2(0), @counted_at, 120))
       BEGIN
         INSERT INTO dbo.stock_count (counted_at, branch, item_key, item_code, item_name, unit, remaining, counter_name)
         VALUES (CONVERT(DATETIME2(0), @counted_at, 120), @branch, @item_key, @item_code, @item_name, @unit, @remaining, @counter_name);
         SET @inserted = 1;
       END
       SELECT @inserted AS inserted;`,
      {
        counted_at: { type: sql.NVarChar(19), value: countedAt },
        branch: { type: sql.NVarChar(50), value: branch },
        item_key: { type: sql.NVarChar(50), value: itemKey },
        item_code: { type: sql.NVarChar(50), value: itemCode },
        item_name: { type: sql.NVarChar(255), value: itemName },
        unit: { type: sql.NVarChar(50), value: unit },
        remaining: { type: sql.Decimal(18, 3), value: remaining },
        counter_name: { type: sql.NVarChar(255), value: recorder },
      }
    );
    if (!Number(ins?.recordset?.[0]?.inserted)) {
      throw badRequest('มียอดนับของวัตถุดิบนี้ในเวลาเดียวกันอยู่แล้ว (อาจกดซ้ำ) — รีเฟรชแล้วตรวจยอดอีกครั้ง');
    }

    await syncKitchenStockBalance(run, { branch, itemKey, itemCode, itemName, remaining, countedAt });

    return {
      itemKey, branch, countedAt, remaining,
      message: `บันทึกยอดคงเหลือ "${itemName || itemCode}" = ${remaining} ${unit || ''} (ยอด ณ ${countDate === now.date ? 'ตอนนี้' : `สิ้นวัน ${countDate}`})`.trim(),
    };
  });
}


/**
 * นำเข้ายอดนับของครัวทีละหลายรายการ (ไฟล์ Excel ยอดคงเหลือสิ้นเดือน — หน้าวัตถุดิบคงเหลือของ storefct)
 *
 * items: [{ itemCode, remaining }] · countDate = ยอด ณ สิ้นวันไหน (กติกาเดียวกับ saveKitchenCount)
 * ทั้งหมดอยู่ใน transaction เดียว — พลาดตัวไหน ไม่มีอะไรถูกบันทึก
 * นำเข้าไฟล์เดิมซ้ำวันเดิม = ทับยอดนับเวลาเดียวกัน (ไม่เกิดแถวซ้ำ)
 * รหัสที่ไม่มีใน stock_item นำเข้าด้วยชื่อ/หน่วยจากไฟล์ (แจ้งกลับใน unregistered) — ไม่มีชื่อด้วยถึงข้าม (skipped)
 * วัตถุดิบที่นับแล้วจะขึ้นในหน้าวัตถุดิบคงเหลือ (getKitchenBalance นับ stock_count ของสาขาครัวเป็น scope)
 */
async function saveKitchenCounts(body, session) {
  const now = bangkokNow();
  const countDate = ymd(body?.countDate);
  if (!countDate) throw badRequest('ระบุวันที่ของยอดนับ');
  if (countDate > now.date) throw badRequest('ย้อนได้อย่างเดียว ตั้งยอดของวันข้างหน้าไม่ได้');
  const countedAt = countDate === now.date ? `${now.date} ${now.time}` : `${countDate} 23:59:59`;

  const seen = new Map();
  for (const it of Array.isArray(body?.items) ? body.items : []) {
    const itemKey = normCode(it?.itemKey || it?.itemCode);
    const raw = it?.remaining;
    if (!itemKey) continue;
    if (raw === '' || raw === null || raw === undefined || !Number.isFinite(Number(raw)) || Number(raw) < 0) {
      throw badRequest(`ยอดของรหัส ${str(it?.itemCode) || itemKey} ต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป`);
    }
    seen.set(itemKey, {
      itemKey, code: str(it?.itemCode), remaining: num(raw),
      name: str(it?.itemName).slice(0, 255), unit: str(it?.unit).slice(0, 50),
    }); // รหัสซ้ำในไฟล์ = ใช้แถวหลังสุด
  }
  const list = [...seen.values()];
  if (list.length === 0) throw badRequest('ไม่มีรายการให้นำเข้า');
  if (list.length > 3000) throw badRequest('นำเข้าได้ครั้งละไม่เกิน 3000 รายการ');

  const branch = kitchenBranch().toLowerCase();
  const recorder = recorderOf(body, session);

  return withTransaction(async (run) => {
    let saved = 0;
    let replaced = 0;
    const skipped = [];
    const unregistered = [];
    for (const it of list) {
      const item = await run(
        `SELECT item_code, item_name, unit FROM dbo.stock_item WHERE item_key = @item_key;`,
        { item_key: { type: sql.NVarChar(50), value: it.itemKey } }
      );
      // รหัสที่ยังไม่มีใน stock_item = วัตถุดิบเฉพาะของครัว ยังนำเข้าได้ ใช้ชื่อ/หน่วยจากไฟล์
      // (getKitchenBalance แสดงด้วยชื่อจากยอดนับ) — ไม่มีชื่อในไฟล์เลยถึงข้าม
      const row = item?.recordset?.[0];
      if (!row && !it.name) { skipped.push(it.code || it.itemKey); continue; }
      if (!row) unregistered.push(it.code || it.itemKey);
      const itemCode = str(row?.item_code) || it.code || it.itemKey;
      const itemName = str(row?.item_name) || it.name || null;
      const unit = str(row?.unit) || it.unit || null;

      const res = await run(
        `DECLARE @replaced INT = 0;
         IF EXISTS (SELECT 1 FROM dbo.stock_count
                     WHERE branch = @branch AND item_key = @item_key
                       AND counted_at = CONVERT(DATETIME2(0), @counted_at, 120))
         BEGIN
           UPDATE dbo.stock_count SET remaining = @remaining, counter_name = @counter_name,
                  item_code = @item_code, item_name = @item_name, unit = @unit
            WHERE branch = @branch AND item_key = @item_key
              AND counted_at = CONVERT(DATETIME2(0), @counted_at, 120);
           SET @replaced = 1;
         END
         ELSE
           INSERT INTO dbo.stock_count (counted_at, branch, item_key, item_code, item_name, unit, remaining, counter_name)
           VALUES (CONVERT(DATETIME2(0), @counted_at, 120), @branch, @item_key, @item_code, @item_name, @unit, @remaining, @counter_name);
         SELECT @replaced AS replaced;`,
        {
          counted_at: { type: sql.NVarChar(19), value: countedAt },
          branch: { type: sql.NVarChar(50), value: branch },
          item_key: { type: sql.NVarChar(50), value: it.itemKey },
          item_code: { type: sql.NVarChar(50), value: itemCode },
          item_name: { type: sql.NVarChar(255), value: itemName },
          unit: { type: sql.NVarChar(50), value: unit },
          remaining: { type: sql.Decimal(18, 3), value: it.remaining },
          counter_name: { type: sql.NVarChar(255), value: recorder },
        }
      );
      if (Number(res?.recordset?.[0]?.replaced)) replaced++;
      await syncKitchenStockBalance(run, { branch, itemKey: it.itemKey, itemCode, itemName, remaining: it.remaining, countedAt });
      saved++;
    }
    return {
      branch, countedAt, saved, replaced, skipped, unregistered,
      message: `นำเข้ายอดนับ ณ ${countDate === now.date ? 'ตอนนี้' : `สิ้นวัน ${countDate}`} แล้ว ${saved} รายการ`
        + (replaced ? ` (ทับยอดเดิมของเวลาเดียวกัน ${replaced})` : '')
        + (unregistered.length ? ` · ${unregistered.length} รายการยังไม่มีในทะเบียนสินค้า (ใช้ชื่อจากไฟล์)` : '')
        + (skipped.length ? ` · ข้าม ${skipped.length} รหัสที่ไม่มีในทะเบียนสินค้า` : ''),
    };
  });
}

/* ==========================================================================
   บันทึกการผลิต + รายงาน
========================================================================== */

/**
 * บันทึกว่าผลิตได้จริงเท่าไหร่
 * อัปเดต produced_qty ของคำสั่งผลิตให้ตรงกับผลรวมของ run ทั้งหมด (คำนวณใหม่ ไม่บวกสะสม
 * เพราะถ้าเคยมีการลบ run ทิ้ง การบวกสะสมจะค้างยอดเก่าไว้ตลอดกาล)
 * และเลื่อนสถานะเป็น "ผลิตเสร็จ" ให้อัตโนมัติเมื่อผลิตครบตามสั่ง
 */
async function saveProductionRun(body, session) {
  const orderId = Number(body?.orderId);
  const hasOrder = Number.isFinite(orderId) && orderId > 0;
  const qtyProduced = num(body?.qtyProduced);
  const qtyWaste = num(body?.qtyWaste);
  if (qtyProduced <= 0) throw badRequest('จำนวนที่ผลิตได้ ต้องมากกว่า 0');
  if (qtyWaste < 0) throw badRequest('จำนวนของเสีย ติดลบไม่ได้');

  const recorder = recorderOf(body, session);
  const produceDate = ymd(body?.produceDate) || bangkokNow().date;
  // ของเหลือจากการผลิตรอบนี้ (เช่น เศษลูกชิ้น) — เข้าสต๊อกครัวเป็นใบรับเข้าใน transaction เดียวกัน
  const leftovers = (Array.isArray(body?.leftovers) ? body.leftovers : [])
    .map((l) => ({ key: normCode(l?.itemKey || l?.itemCode), qty: num(l?.qty) }))
    .filter((l) => l.key && l.qty > 0);
  if (leftovers.length > 0 && !(await hasLeftoverTables())) throw leftoverMissing();
  const priceCol = leftovers.length > 0 && (await hasReceiptPrice());

  return withTransaction(async (run) => {
    let orderDocNo = '';
    let productKey = normCode(body?.productKey || body?.productCode);
    let productCode = str(body?.productCode) || productKey;
    let productName = str(body?.productName).slice(0, 255);
    let unit = orNull(body?.unit);

    if (hasOrder) {
      // ผลิตตามคำสั่ง — เอาข้อมูลสินค้าจากใบสั่ง ไม่เชื่อสิ่งที่หน้าเว็บส่งมา
      // ไม่งั้นบันทึกผลิตของสินค้า A ใส่ใบสั่งของสินค้า B ได้โดยไม่มีอะไรทัก
      const found = await run(
        `SELECT doc_no, product_key, product_code, product_name, unit, order_qty
           FROM dbo.kitchen_production_order WHERE order_id = @order_id;`,
        { order_id: { type: sql.BigInt, value: orderId } }
      );
      const o = found?.recordset?.[0];
      if (!o) throw badRequest('ไม่พบคำสั่งผลิต');
      orderDocNo = o.doc_no;
      productKey = o.product_key;
      productCode = o.product_code;
      productName = o.product_name;
      unit = unit || o.unit;
    }
    if (!productKey) throw badRequest('ไม่ระบุสินค้าที่ผลิต');

    await run(
      `INSERT INTO dbo.kitchen_production_run
         (order_id, produce_date, product_key, product_code, product_name,
          qty_produced, qty_waste, unit, note, recorder, recorded_at)
       VALUES (@order_id, CONVERT(DATE, @produce_date, 23), @product_key, @product_code, @product_name,
               @qty_produced, @qty_waste, @unit, @note, @recorder, SYSDATETIME());`,
      {
        order_id: { type: sql.BigInt, value: hasOrder ? orderId : null },
        produce_date: { type: sql.NVarChar(10), value: produceDate },
        product_key: { type: sql.NVarChar(50), value: productKey },
        product_code: { type: sql.NVarChar(50), value: productCode },
        product_name: { type: sql.NVarChar(255), value: productName },
        qty_produced: { type: sql.Decimal(18, 3), value: qtyProduced },
        qty_waste: { type: sql.Decimal(18, 3), value: qtyWaste },
        unit: { type: sql.NVarChar(50), value: unit },
        note: { type: sql.NVarChar(500), value: orNull(body?.note) },
        recorder: { type: sql.NVarChar(255), value: recorder },
      }
    );

    if (hasOrder) {
      await run(
        `UPDATE o
            SET produced_qty = t.total,
                status = CASE WHEN o.status = N'ยกเลิก' THEN o.status
                              WHEN t.total >= o.order_qty THEN N'ผลิตเสร็จ'
                              ELSE N'กำลังผลิต' END,
                updated_at = SYSDATETIME()
           FROM dbo.kitchen_production_order o
          CROSS APPLY (
            SELECT COALESCE(SUM(qty_produced), 0) AS total
              FROM dbo.kitchen_production_run WHERE order_id = o.order_id
          ) t
          WHERE o.order_id = @order_id;`,
        { order_id: { type: sql.BigInt, value: orderId } }
      );
    }

    let leftoverDoc = '';
    if (leftovers.length > 0) {
      leftoverDoc = await nextDocNo(run, 'dbo.kitchen_material_receipt', 'MR', produceDate);
      // ต้นทุนต่อหน่วยของการผลิตครั้งนี้ = ต้นทุนวัตถุดิบจริงของคำสั่ง (ใบเบิก × ราคาตอนเบิก) ÷ ยอดผลิตได้ทั้งคำสั่ง
      // ใช้เป็นราคาของของเหลือ (ไอเทม LO- ที่หน่วยตรงกับผลผลิต) → stock_item.price เปลี่ยนตามการผลิตล่าสุดทุกครั้ง
      const costPerUnit = hasOrder ? await orderCostPerUnit(run, orderId) : null;
      const merged = new Map();
      for (const l of leftovers) merged.set(l.key, (merged.get(l.key) || 0) + l.qty);
      for (const [key, qty] of merged) {
        const it = (await run(
          `SELECT item_key, item_code, item_name, unit FROM dbo.stock_item WHERE item_key = @k;`,
          { k: { type: sql.NVarChar(50), value: key } }
        ))?.recordset?.[0];
        if (!it) throw badRequest(`ไม่พบไอเทมของเหลือรหัส ${key} ในทะเบียนสินค้า`);
        const price = leftoverPrice(costPerUnit, it, unit);
        if (price !== null) {
          await run(`UPDATE dbo.stock_item SET price = @p, updated_at = SYSDATETIME() WHERE item_key = @k;`,
            { p: { type: sql.Decimal(18, 4), value: price }, k: { type: sql.NVarChar(50), value: it.item_key } });
        }
        await run(
          `INSERT INTO dbo.kitchen_material_receipt
             (doc_no, receive_date, item_key, item_code, item_name, qty, unit, source_name, note, recorder, order_id, receipt_kind
              ${priceCol ? ', unit_price' : ''})
           VALUES (@doc_no, CONVERT(DATE, @d, 23), @item_key, @item_code, @item_name, @qty, @unit,
                   @source_name, NULL, @recorder, @order_id, N'leftover' ${priceCol ? ', @unit_price' : ''});`,
          {
            ...(priceCol ? { unit_price: { type: sql.Decimal(18, 4), value: price } } : {}),
            doc_no: { type: sql.NVarChar(50), value: leftoverDoc },
            d: { type: sql.NVarChar(10), value: produceDate },
            item_key: { type: sql.NVarChar(50), value: it.item_key },
            item_code: { type: sql.NVarChar(50), value: it.item_code },
            item_name: { type: sql.NVarChar(255), value: it.item_name },
            qty: { type: sql.Decimal(18, 3), value: qty },
            unit: { type: sql.NVarChar(50), value: it.unit },
            source_name: { type: sql.NVarChar(255), value: `ของเหลือจาก ${orderDocNo || productName || productKey}`.slice(0, 255) },
            recorder: { type: sql.NVarChar(255), value: recorder },
            order_id: { type: sql.BigInt, value: hasOrder ? orderId : null },
          }
        );
      }
    }

    return {
      leftoverDoc,
      message: `บันทึกการผลิต ${productName || productKey} จำนวน ${qtyProduced} แล้ว`
        + (leftoverDoc ? ` · ของเหลือเข้าสต๊อกครัว ${leftoverDoc}` : ''),
    };
  });
}

/**
 * คิด produced_qty ของใบสั่งใหม่หลังแก้ยอด — สถานะ "ผลิตเสร็จ" / "ยกเลิก" ที่ตั้งไว้แล้วไม่เปลี่ยน
 * (ปิดงานได้แม้ผลิตได้น้อยกว่าที่สั่ง แก้ยอดทีหลังต้องไม่เปิดงานกลับมาเอง) ที่เหลือเลื่อนตามยอดเหมือน saveProductionRun
 */
const RECOMPUTE_ORDER_KEEP_CLOSED = `
  UPDATE o
     SET produced_qty = t.total,
         status = CASE WHEN o.status IN (N'ยกเลิก', N'ผลิตเสร็จ') THEN o.status
                       WHEN t.total >= o.order_qty THEN N'ผลิตเสร็จ'
                       WHEN t.total > 0 THEN N'กำลังผลิต'
                       ELSE N'รอผลิต' END,
         updated_at = SYSDATETIME()
    FROM dbo.kitchen_production_order o
   CROSS APPLY (
     SELECT COALESCE(SUM(qty_produced), 0) AS total
       FROM dbo.kitchen_production_run WHERE order_id = o.order_id
   ) t
   WHERE o.order_id = @order_id;`;

/**
 * แก้ยอดผลิตได้ / ของเสีย ของบันทึกการผลิตหนึ่งแถว (หน้าสถานะการผลิต) แล้วเก็บประวัติไว้ทุกครั้ง
 * ต้องมีตาราง kitchen_production_run_edit ก่อน — ไม่มีที่เก็บประวัติ = ไม่ให้แก้ (แก้แล้วไม่มีร่องรอยไม่ได้)
 */
async function updateProductionRun(body, session) {
  const runId = Number(body?.runId);
  if (!Number.isFinite(runId) || runId <= 0) throw badRequest('ไม่ระบุรายการที่จะแก้');
  const qtyProduced = num(body?.qtyProduced);
  const qtyWaste = num(body?.qtyWaste);
  if (qtyProduced <= 0) throw badRequest('ยอดผลิตได้ต้องมากกว่า 0 — ถ้าไม่ได้ผลิตจริงให้ลบรายการนี้แทน');
  if (qtyWaste < 0) throw badRequest('ของเสียติดลบไม่ได้');
  if (!(await hasRunEditTable())) {
    throw badRequest('ยังไม่มีตารางเก็บประวัติการแก้ยอด — รัน update-office-server.bat ที่เครื่องออฟฟิศก่อน');
  }
  const recorder = recorderOf(body, session);

  return withTransaction(async (run) => {
    const found = await run(
      `SELECT run_id, order_id, product_name, qty_produced, qty_waste
         FROM dbo.kitchen_production_run WITH (UPDLOCK, ROWLOCK)
        WHERE run_id = @run_id;`,
      { run_id: { type: sql.BigInt, value: runId } }
    );
    const old = found?.recordset?.[0];
    if (!old) throw badRequest('ไม่พบรายการที่ต้องการแก้');
    if (Number(old.qty_produced) === qtyProduced && Number(old.qty_waste) === qtyWaste) {
      return { changed: false, message: 'ยอดเท่าเดิม ไม่ได้แก้อะไร' };
    }

    await run(
      `UPDATE dbo.kitchen_production_run
          SET qty_produced = @qty_produced, qty_waste = @qty_waste
        WHERE run_id = @run_id;
       INSERT INTO dbo.kitchen_production_run_edit
         (run_id, order_id, action, old_qty_produced, new_qty_produced, old_qty_waste, new_qty_waste, reason, recorder)
       VALUES (@run_id, @order_id, N'edit', @old_produced, @qty_produced, @old_waste, @qty_waste, @reason, @recorder);`,
      {
        run_id: { type: sql.BigInt, value: runId },
        order_id: { type: sql.BigInt, value: old.order_id ?? null },
        qty_produced: { type: sql.Decimal(18, 3), value: qtyProduced },
        qty_waste: { type: sql.Decimal(18, 3), value: qtyWaste },
        old_produced: { type: sql.Decimal(18, 3), value: old.qty_produced },
        old_waste: { type: sql.Decimal(18, 3), value: old.qty_waste },
        reason: { type: sql.NVarChar(500), value: orNull(body?.reason) && str(body.reason).slice(0, 500) },
        recorder: { type: sql.NVarChar(255), value: recorder },
      }
    );
    if (old.order_id) {
      await run(RECOMPUTE_ORDER_KEEP_CLOSED, { order_id: { type: sql.BigInt, value: old.order_id } });
    }
    return {
      changed: true,
      message: `แก้ยอด ${old.product_name}: ผลิตได้ ${Number(old.qty_produced)} → ${qtyProduced} · ของเสีย ${Number(old.qty_waste)} → ${qtyWaste}`,
    };
  });
}

/**
 * บันทึกการผลิตทั้งหมดของคำสั่งหนึ่ง + ประวัติการแก้ยอด + ประวัติเลื่อนวัน/ยกเลิก/เปลี่ยนสถานะ (ใหม่สุดก่อน)
 * ใช้ทั้งป๊อปอัพแก้ยอดและป๊อปอัพประวัติของหน้าสถานะการผลิต
 */
async function getProductionRunHistory(body) {
  const orderId = Number(body?.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) throw badRequest('ไม่ระบุคำสั่งผลิต');
  const params = { order_id: { type: sql.BigInt, value: orderId } };
  const runs = await runSql(
    `SELECT run_id, order_id, produce_date, product_name, qty_produced, qty_waste, unit, note, recorder, recorded_at
       FROM dbo.kitchen_production_run
      WHERE order_id = @order_id
      ORDER BY recorded_at, run_id;`,
    params
  );
  const ready = await hasRunEditTable();
  const edits = ready
    ? await runSql(
      `SELECT edit_id, run_id, action, old_qty_produced, new_qty_produced, old_qty_waste, new_qty_waste,
              reason, recorder, edited_at
         FROM dbo.kitchen_production_run_edit
        WHERE order_id = @order_id
        ORDER BY edited_at DESC, edit_id DESC;`,
      params
    )
    : [];
  // ประวัติของตัวคำสั่ง (เลื่อนวัน / ยกเลิก / เปลี่ยนสถานะ) — หน้าประวัติของ storefct รวมกับข้างบนเป็นไทม์ไลน์เดียว
  const eventsReady = await hasOrderEventTable();
  const leftoverEdit = eventsReady && (await hasLeftoverEdit());
  const events = eventsReady
    ? await runSql(
      `SELECT event_id, action, CONVERT(NVARCHAR(10), old_date, 23) AS old_date, CONVERT(NVARCHAR(10), new_date, 23) AS new_date,
              old_status, new_status, plan_moved, reason, recorder, created_at
              ${leftoverEdit ? ', item_key, item_name, old_qty, new_qty' : ''}
         FROM dbo.kitchen_production_order_event
        WHERE order_id = @order_id
        ORDER BY created_at DESC, event_id DESC;`,
      params
    )
    : [];
  // ของเหลือของคำสั่งนี้ (ใบรับเข้า leftover) + ไอเทมที่ผูกกับเมนูของคำสั่ง (ไอเทมที่ยังไม่ได้บันทึกก็ขึ้นให้เพิ่มได้)
  let leftovers = [];
  let leftoverItems = [];
  const lReady = await hasLeftoverTables();
  if (lReady) {
    const priceCol = await hasReceiptPrice();
    leftovers = await runSql(
      `SELECT receipt_id, doc_no, CONVERT(NVARCHAR(10), receive_date, 23) AS receive_date, item_key, item_code, item_name,
              qty, unit, recorder, recorded_at ${priceCol ? ', unit_price' : ''}
         FROM dbo.kitchen_material_receipt
        WHERE order_id = @order_id AND receipt_kind = N'leftover'
        ORDER BY recorded_at, receipt_id;`,
      params
    );
    leftoverItems = await runSql(
      `SELECT l.item_key, COALESCE(i.item_code, l.item_key) AS item_code, COALESCE(i.item_name, l.item_key) AS item_name, i.unit
         FROM dbo.kitchen_production_order o
         JOIN dbo.kitchen_menu_leftover l ON l.product_key = o.product_key
         LEFT JOIN dbo.stock_item i ON i.item_key = l.item_key
        WHERE o.order_id = @order_id
        ORDER BY l.sort_order, i.item_name;`,
      params
    );
  }
  return {
    runs, edits, historyReady: ready, events, eventsReady,
    leftovers, leftoverItems, leftoverReady: lReady, leftoverEditReady: leftoverEdit,
  };
}

/**
 * ตั้งยอดของเหลือของคำสั่ง (ไอเทมหนึ่งตัว) ใหม่ — ป๊อปอัพแก้ยอดผลิตของ storefct · แก้ยอดที่บันทึกแล้ว หรือเพิ่มที่ลืมบันทึก
 * แทนที่ใบรับเข้า leftover เดิมของคำสั่ง+ไอเทมนั้นด้วยแถวเดียวยอดใหม่ (เลขที่ใบ/วันที่เดิม) · 0 = ลบทิ้ง
 * ราคาคิดใหม่จากต้นทุนของคำสั่ง (ไอเทม LO- หน่วยตรงผลผลิต) · เก็บประวัติ action 'leftover' (ยอดเดิม → ใหม่ · เหตุผล)
 * ของเหลือที่ถูกใช้ไปแล้วแล้วลดยอด = คงเหลือติดลบได้ (เหมือนเบิกเกิน) ให้หน้าคงเหลือเตือนเอง
 */
async function saveOrderLeftover(body, session) {
  const orderId = Number(body?.orderId);
  const key = normCode(body?.itemKey || body?.itemCode);
  const qty = Math.round(num(body?.qty) * 1000) / 1000;
  if (!Number.isFinite(orderId) || orderId <= 0) throw badRequest('ไม่ระบุคำสั่งผลิต');
  if (!key) throw badRequest('ไม่ระบุไอเทมของเหลือ');
  if (qty < 0) throw badRequest('ยอดติดลบไม่ได้');
  if (!(await hasLeftoverTables())) throw leftoverMissing();
  if (!(await hasOrderEventTable()) || !(await hasLeftoverEdit())) {
    throw badRequest('ยังไม่มีที่เก็บประวัติการแก้ของเหลือ — รัน update-office-server.bat ที่เครื่องออฟฟิศก่อน');
  }
  const priceCol = await hasReceiptPrice();
  const recorder = recorderOf(body, session);

  return withTransaction(async (run) => {
    const o = (await run(
      `SELECT order_id, doc_no, unit, CONVERT(NVARCHAR(10), produce_date, 23) AS produce_date
         FROM dbo.kitchen_production_order WHERE order_id = @order_id;`,
      { order_id: { type: sql.BigInt, value: orderId } }
    ))?.recordset?.[0];
    if (!o) throw badRequest('ไม่พบคำสั่งผลิต');
    const it = (await run(`SELECT item_key, item_code, item_name, unit FROM dbo.stock_item WHERE item_key = @k;`,
      { k: { type: sql.NVarChar(50), value: key } }))?.recordset?.[0];
    if (!it) throw badRequest(`ไม่พบไอเทมรหัส ${key} ในทะเบียนสินค้า`);
    const params = { order_id: { type: sql.BigInt, value: orderId }, k: { type: sql.NVarChar(50), value: it.item_key } };
    const rows = (await run(
      `SELECT receipt_id, doc_no, CONVERT(NVARCHAR(10), receive_date, 23) AS receive_date, qty
         FROM dbo.kitchen_material_receipt WITH (UPDLOCK, HOLDLOCK)
        WHERE order_id = @order_id AND item_key = @k AND receipt_kind = N'leftover'
        ORDER BY receive_date, receipt_id;`,
      params
    ))?.recordset || [];
    const oldQty = Math.round(rows.reduce((n, r) => n + Number(r.qty), 0) * 1000) / 1000;
    if (oldQty === qty) return { changed: false, message: 'ยอดเท่าเดิม ไม่ได้แก้อะไร' };

    await run(
      `DELETE FROM dbo.kitchen_material_receipt
        WHERE order_id = @order_id AND item_key = @k AND receipt_kind = N'leftover';`,
      params
    );
    let docNo = rows[0]?.doc_no || '';
    if (qty > 0) {
      const date = rows[0]?.receive_date || o.produce_date || bangkokNow().date;
      if (!docNo) docNo = await nextDocNo(run, 'dbo.kitchen_material_receipt', 'MR', date);
      const price = leftoverPrice(await orderCostPerUnit(run, orderId), it, o.unit);
      if (price !== null) {
        await run(`UPDATE dbo.stock_item SET price = @p, updated_at = SYSDATETIME() WHERE item_key = @k;`,
          { p: { type: sql.Decimal(18, 4), value: price }, k: { type: sql.NVarChar(50), value: it.item_key } });
      }
      await run(
        `INSERT INTO dbo.kitchen_material_receipt
           (doc_no, receive_date, item_key, item_code, item_name, qty, unit, source_name, note, recorder, order_id, receipt_kind
            ${priceCol ? ', unit_price' : ''})
         VALUES (@doc_no, CONVERT(DATE, @d, 23), @k, @code, @name, @qty, @unit, @source_name, NULL, @recorder, @order_id, N'leftover'
                 ${priceCol ? ', @unit_price' : ''});`,
        {
          ...params,
          ...(priceCol ? { unit_price: { type: sql.Decimal(18, 4), value: price } } : {}),
          doc_no: { type: sql.NVarChar(50), value: docNo },
          d: { type: sql.NVarChar(10), value: date },
          code: { type: sql.NVarChar(50), value: it.item_code },
          name: { type: sql.NVarChar(255), value: it.item_name },
          qty: { type: sql.Decimal(18, 3), value: qty },
          unit: { type: sql.NVarChar(50), value: it.unit },
          source_name: { type: sql.NVarChar(255), value: `ของเหลือจาก ${o.doc_no}`.slice(0, 255) },
          recorder: { type: sql.NVarChar(255), value: recorder },
        }
      );
    }
    await run(
      `INSERT INTO dbo.kitchen_production_order_event
         (order_id, action, item_key, item_name, old_qty, new_qty, reason, recorder)
       VALUES (@order_id, N'leftover', @k, @name, @old_qty, @new_qty, @reason, @recorder);`,
      {
        ...params,
        name: { type: sql.NVarChar(255), value: it.item_name },
        old_qty: { type: sql.Decimal(18, 3), value: oldQty },
        new_qty: { type: sql.Decimal(18, 3), value: qty },
        reason: { type: sql.NVarChar(500), value: orNull(body?.reason) && str(body.reason).slice(0, 500) },
        recorder: { type: sql.NVarChar(255), value: recorder },
      }
    );
    return {
      changed: true,
      docNo: qty > 0 ? docNo : '',
      message: `ของเหลือ ${it.item_name}: ${oldQty} → ${qty} ${it.unit || ''}`.trim(),
    };
  });
}

/** ลบบันทึกการผลิตหนึ่งแถว แล้วคิด produced_qty ของใบสั่งใหม่ (มีตารางประวัติ = เก็บไว้ว่าใครลบ) */
async function deleteProductionRun(body, session) {
  const runId = Number(body?.runId);
  if (!Number.isFinite(runId)) throw badRequest('ไม่ระบุรายการที่จะลบ');
  const logDelete = await hasRunEditTable();
  const recorder = recorderOf(body, session);

  return withTransaction(async (run) => {
    const gone = await run(
      `DELETE FROM dbo.kitchen_production_run
        OUTPUT deleted.order_id, deleted.product_name, deleted.qty_produced, deleted.qty_waste
        WHERE run_id = @run_id;`,
      { run_id: { type: sql.BigInt, value: runId } }
    );
    const row = gone?.recordset?.[0];
    if (!row) throw badRequest('ไม่พบรายการที่ต้องการลบ');

    if (logDelete) {
      await run(
        `INSERT INTO dbo.kitchen_production_run_edit
           (run_id, order_id, action, old_qty_produced, old_qty_waste, reason, recorder)
         VALUES (@run_id, @order_id, N'delete', @old_produced, @old_waste, @reason, @recorder);`,
        {
          run_id: { type: sql.BigInt, value: runId },
          order_id: { type: sql.BigInt, value: row.order_id ?? null },
          old_produced: { type: sql.Decimal(18, 3), value: row.qty_produced },
          old_waste: { type: sql.Decimal(18, 3), value: row.qty_waste },
          reason: { type: sql.NVarChar(500), value: orNull(body?.reason) && str(body.reason).slice(0, 500) },
          recorder: { type: sql.NVarChar(255), value: recorder },
        }
      );
    }

    if (row.order_id) {
      await run(
        `UPDATE o
            SET produced_qty = t.total,
                status = CASE WHEN o.status = N'ยกเลิก' THEN o.status
                              WHEN t.total >= o.order_qty THEN N'ผลิตเสร็จ'
                              WHEN t.total > 0 THEN N'กำลังผลิต'
                              ELSE N'รอผลิต' END,
                updated_at = SYSDATETIME()
           FROM dbo.kitchen_production_order o
          CROSS APPLY (
            SELECT COALESCE(SUM(qty_produced), 0) AS total
              FROM dbo.kitchen_production_run WHERE order_id = o.order_id
          ) t
          WHERE o.order_id = @order_id;`,
        { order_id: { type: sql.BigInt, value: row.order_id } }
      );
    }
    return { message: `ลบบันทึกการผลิต ${row.product_name} (${row.qty_produced}) แล้ว` };
  });
}

/**
 * รายงานการผลิต — รายการดิบของช่วงวันที่ พร้อมยอดรวมต่อสินค้า
 * ส่งกลับทั้งสองชุดในครั้งเดียว เพราะหน้าเดียวใช้ทั้งคู่ และรวมฝั่ง SQL เร็วกว่าให้เบราว์เซอร์รวมเอง
 *
 * ต้นทุนวัตถุดิบ: รวมใบเบิกทุกใบของคำสั่งผลิต (qty × unit_price ที่เก็บไว้ตอนเบิก รวมของสูญเสีย)
 * แล้วแบ่งให้แต่ละครั้งที่บันทึกผลิตตามสัดส่วนจำนวนที่ผลิตได้ — ครั้งไหนของคำสั่งเดียวกัน
 * ก็ได้ต้นทุนต่อหน่วยเท่ากัน และรวมทุกครั้งแล้วเท่ากับต้นทุนของคำสั่งพอดี
 * ไม่ได้เก็บต้นทุนไว้ที่ตารางบันทึกการผลิต เพราะเบิกเพิ่มหลังบันทึกผลิตได้ ต้องคิดตอนเปิดรายงาน
 *   cost          ต้นทุนวัตถุดิบของครั้งนั้น (ใช้ + สูญเสีย) · NULL = คำสั่งไม่มีใบเบิก หรือไม่มีราคาเลยสักบรรทัด
 *   loss_cost     ส่วนที่มาจากของสูญเสีย
 *   no_price_count  บรรทัดใบเบิกของคำสั่งที่ไม่มีราคา (ไม่ได้รวมในต้นทุน — ต้นทุนต่ำกว่าจริง)
 */
async function getProductionReport(body) {
  const from = ymd(body?.dateFrom);
  const to = ymd(body?.dateTo);
  if (!from || !to) throw badRequest('ต้องระบุช่วงวันที่ (dateFrom, dateTo)');

  // สูตร ณ วันผลิตของคำสั่ง — หน้าเว็บคิด "ตามสูตร" จากตัวนี้ · NULL = คำสั่งรุ่นก่อนเก็บสูตร
  const snapCols = (await hasRecipeSnapshot()) ? 'o.recipe_snapshot,' : '';

  const params = {
    from: { type: sql.NVarChar(10), value: from },
    to: { type: sql.NVarChar(10), value: to },
  };

  // ใช้ร่วมกันทั้งรายการดิบและยอดรวม ให้สองตารางคิดต้นทุนแบบเดียวกันเสมอ
  const costedRuns = `
    SELECT p.run_id, p.order_id, o.doc_no AS order_doc_no, o.order_qty, ${snapCols}
           p.produce_date, p.product_key, p.product_code, p.product_name,
           p.qty_produced, p.qty_waste, p.unit, p.note, p.recorder, p.recorded_at,
           c.issue_lines, c.no_price_count,
           CAST(c.cost * p.qty_produced / NULLIF(t.total_produced, 0) AS DECIMAL(18,2)) AS cost,
           CAST(c.loss_cost * p.qty_produced / NULLIF(t.total_produced, 0) AS DECIMAL(18,2)) AS loss_cost
      FROM dbo.kitchen_production_run p
      LEFT JOIN dbo.kitchen_production_order o ON o.order_id = p.order_id
      OUTER APPLY (
        SELECT COUNT(*) AS issue_lines,
               SUM(CASE WHEN mi.unit_price IS NULL THEN 1 ELSE 0 END) AS no_price_count,
               CAST(SUM(mi.qty * mi.unit_price) AS DECIMAL(18,4)) AS cost,
               CAST(SUM(COALESCE(mi.loss_qty, 0) * mi.unit_price) AS DECIMAL(18,4)) AS loss_cost
          FROM dbo.kitchen_material_issue mi
         WHERE mi.order_id = p.order_id
      ) c
      OUTER APPLY (
        SELECT SUM(r.qty_produced) AS total_produced
          FROM dbo.kitchen_production_run r
         WHERE r.order_id = p.order_id
      ) t
     WHERE p.produce_date BETWEEN CONVERT(DATE, @from, 23) AND CONVERT(DATE, @to, 23)`;

  const runs = await runSql(
    `${costedRuns}
      ORDER BY p.produce_date DESC, p.recorded_at DESC;`,
    params
  );

  // costed_qty = จำนวนที่ผลิตเฉพาะครั้งที่มีต้นทุน — ตัวหารของต้นทุนเฉลี่ยต่อหน่วย
  // (ครั้งที่ไม่มีใบเบิกไม่ได้ต้นทุนเป็น 0 จริง ถ้าเอามาหารด้วยจะดึงค่าเฉลี่ยต่ำลงผิด ๆ)
  const summary = await runSql(
    `WITH r AS (${costedRuns})
     SELECT r.product_key, MAX(r.product_code) AS product_code, MAX(r.product_name) AS product_name,
            MAX(r.unit) AS unit,
            SUM(r.qty_produced) AS total_produced,
            SUM(r.qty_waste) AS total_waste,
            COUNT(*) AS run_count,
            SUM(r.cost) AS total_cost,
            SUM(r.loss_cost) AS total_loss_cost,
            SUM(CASE WHEN r.cost IS NOT NULL THEN r.qty_produced END) AS costed_qty,
            SUM(CASE WHEN r.cost IS NULL THEN 1 ELSE 0 END) AS uncosted_runs,
            SUM(CASE WHEN r.no_price_count > 0 THEN 1 ELSE 0 END) AS partial_runs
       FROM r
      GROUP BY r.product_key
      ORDER BY SUM(r.qty_produced) DESC;`,
    params
  );

  return { dateFrom: from, dateTo: to, runs, summary };
}



/* ==========================================================================
   เปิด/ปิดเมนูในหน้าครัวกลาง — หน้า "เมนูครัวกลาง" ของ storefct
   ตาราง dbo.kitchen_menu_setting (office-server/sql/kitchen-005-menu-setting.sql)
   เก็บเฉพาะเมนูที่เคยกดเปิด/ปิด · ไม่มีแถว = แสดงตามปกติ
========================================================================== */

const menuSettingMissing = (err) => (
  err?.number === 208 || /Invalid object name '(dbo\.)?kitchen_menu_setting'/i.test(String(err?.message))
    ? badRequest('ยังไม่มีตารางตั้งค่าเมนูครัว — รัน update-office-server.bat ที่เครื่องออฟฟิศก่อน')
    : err);

async function getKitchenMenuSettings() {
  try {
    const rows = await runSql(
      `SELECT product_key, product_name, is_hidden, recorder, updated_at
         FROM dbo.kitchen_menu_setting
        WHERE is_hidden = 1;`
    );
    return { hidden: rows.map((r) => r.product_key), settings: rows };
  } catch (err) {
    // ยังไม่ได้รัน sql/kitchen-005 = ยังไม่มีเมนูที่ถูกปิด หน้าอื่นใช้ได้ตามเดิม
    if (menuSettingMissing(err) !== err) return { hidden: [], settings: [], missingTable: true };
    throw err;
  }
}

/** ปิด/เปิดเมนูทีละหลายตัวได้ — items: [{ productKey, productName, hidden }] */
async function setKitchenMenuHidden(body, session) {
  const list = (Array.isArray(body?.items) ? body.items : [body])
    .map((it) => ({ key: normCode(it?.productKey || it?.productCode), name: str(it?.productName).slice(0, 255), hidden: Boolean(it?.hidden) }))
    .filter((it) => it.key);
  if (list.length === 0) throw badRequest('ไม่ระบุเมนู');
  if (list.length > 2000) throw badRequest('ตั้งค่าได้ครั้งละไม่เกิน 2000 เมนู');
  const recorder = recorderOf(body, session);
  try {
    return await withTransaction(async (run) => {
      for (const it of list) {
        await run(
          `MERGE dbo.kitchen_menu_setting AS t
           USING (SELECT @product_key AS product_key) AS s ON t.product_key = s.product_key
           WHEN MATCHED THEN UPDATE SET is_hidden = @is_hidden, product_name = COALESCE(@product_name, t.product_name),
                                        recorder = @recorder, updated_at = SYSDATETIME()
           WHEN NOT MATCHED THEN INSERT (product_key, product_name, is_hidden, recorder)
                                 VALUES (@product_key, @product_name, @is_hidden, @recorder);`,
          {
            product_key: { type: sql.NVarChar(50), value: it.key },
            product_name: { type: sql.NVarChar(255), value: orNull(it.name) },
            is_hidden: { type: sql.Bit, value: it.hidden },
            recorder: { type: sql.NVarChar(255), value: recorder },
          }
        );
      }
      const off = list.filter((it) => it.hidden).length;
      return {
        saved: list.length,
        message: list.length === 1
          ? `${list[0].hidden ? 'ปิด' : 'เปิด'}เมนู "${list[0].name || list[0].key}" แล้ว`
          : `บันทึกแล้ว ${list.length} เมนู (ปิด ${off} · เปิด ${list.length - off})`,
      };
    });
  } catch (err) {
    throw menuSettingMissing(err);
  }
}

/* ==========================================================================
   ของเหลือจากการผลิต — หน้าเมนูครัวกลาง (ผูก/สร้างไอเทม) + ฟอร์มผลิต (ใช้ / บันทึกของเหลือ)
   ตาราง sql/kitchen-009-leftover.sql
========================================================================== */

/** การผูกของเหลือทั้งหมด (เมนู → ไอเทม) พร้อมชื่อ/หน่วยจากทะเบียนสินค้า */
async function getLeftoverLinks() {
  if (!(await hasLeftoverTables())) return { links: [], ready: false };
  const links = await runSql(
    `SELECT l.product_key, l.product_name, l.item_key, l.sort_order,
            COALESCE(i.item_code, l.item_key) AS item_code, COALESCE(i.item_name, l.item_key) AS item_name,
            i.unit, i.price
       FROM dbo.kitchen_menu_leftover l
       LEFT JOIN dbo.stock_item i ON i.item_key = l.item_key
      ORDER BY l.product_key, l.sort_order, i.item_name;`
  );
  return { links, ready: true };
}

/** ตั้งไอเทมของเหลือของเมนูหนึ่ง — แทนที่ชุดเดิมทั้งชุด (ส่ง itemKeys ว่าง = เลิกผูกทั้งหมด) */
async function saveMenuLeftovers(body, session) {
  const productKey = normCode(body?.productKey || body?.productCode);
  if (!productKey) throw badRequest('ไม่ระบุเมนู');
  if (!(await hasLeftoverTables())) throw leftoverMissing();
  const keys = [...new Set((Array.isArray(body?.itemKeys) ? body.itemKeys : []).map(normCode).filter(Boolean))];
  const recorder = recorderOf(body, session);
  return withTransaction(async (run) => {
    await run(`DELETE FROM dbo.kitchen_menu_leftover WHERE product_key = @p;`,
      { p: { type: sql.NVarChar(50), value: productKey } });
    for (const [idx, key] of keys.entries()) {
      const ok = (await run(`SELECT 1 AS ok FROM dbo.stock_item WHERE item_key = @k;`,
        { k: { type: sql.NVarChar(50), value: key } }))?.recordset?.[0];
      if (!ok) throw badRequest(`ไม่พบรหัส ${key} ในทะเบียนสินค้า`);
      await run(
        `INSERT INTO dbo.kitchen_menu_leftover (product_key, product_name, item_key, sort_order, recorder)
         VALUES (@p, @n, @k, @s, @r);`,
        {
          p: { type: sql.NVarChar(50), value: productKey },
          n: { type: sql.NVarChar(255), value: orNull(body?.productName) && str(body.productName).slice(0, 255) },
          k: { type: sql.NVarChar(50), value: key },
          s: { type: sql.Int, value: idx },
          r: { type: sql.NVarChar(255), value: recorder },
        }
      );
    }
    return { count: keys.length, message: keys.length ? `ผูกของเหลือ ${keys.length} รายการกับเมนูแล้ว` : 'เลิกผูกของเหลือของเมนูนี้แล้ว' };
  });
}

/**
 * สร้างไอเทมของเหลือใหม่ใน dbo.stock_item — รหัส LO-0001, LO-0002 … (ไม่ชนรหัสตัวเลขของฝ่ายจัดซื้อ)
 * ติ๊กสาขาครัว (KITCHEN_ITEM_BRANCH) ให้เลย → ขึ้นในวัตถุดิบคงเหลือของครัว ไม่ขึ้นในหน้านับสต๊อกของสาขาอื่น
 * ไม่มี pos_item_id = สั่งผ่านใบเบิกสาขาไม่ได้ (ตั้งใจ — เป็นของที่ครัวผลิตเอง)
 * ราคา (stock_item.price) เริ่มว่าง แล้วเปลี่ยนเป็นต้นทุนต่อหน่วยของการผลิตล่าสุดทุกครั้งที่บันทึกของเหลือ
 * ซิงก์ทะเบียนจากชีท (item-sync) ไม่ลบ/ไม่ทับรหัสที่ไม่มีในชีท จึงไม่หาย
 */
async function createLeftoverItem(body) {
  const name = str(body?.name).slice(0, 255);
  const unit = orNull(body?.unit);
  // ราคาไม่รับจากหน้าเว็บ — ตั้งเองจากต้นทุนการผลิตทุกครั้งที่บันทึกของเหลือ (saveProductionRun)
  const price = null;
  if (!name) throw badRequest('ใส่ชื่อไอเทม');
  if (!unit) throw badRequest('ใส่หน่วย');
  const branch = kitchenItemBranches()[0];
  return withTransaction(async (run) => {
    const dup = (await run(
      `SELECT TOP 1 item_code FROM dbo.stock_item WHERE item_name = @n AND (status IS NULL OR status <> N'ปิดการใช้งาน');`,
      { n: { type: sql.NVarChar(255), value: name } }
    ))?.recordset?.[0];
    if (dup) throw badRequest(`มีไอเทมชื่อ "${name}" อยู่แล้ว (รหัส ${dup.item_code}) — เลือกไอเทมนั้นแทน`);
    const last = (await run(
      `SELECT MAX(TRY_CONVERT(INT, SUBSTRING(item_code, 4, 10))) AS n
         FROM dbo.stock_item WITH (UPDLOCK, HOLDLOCK)
        WHERE item_code LIKE N'LO-%';`
    ))?.recordset?.[0]?.n;
    const code = `LO-${String((Number(last) || 0) + 1).padStart(4, '0')}`;
    const key = normCode(code).toLowerCase();
    await run(
      `INSERT INTO dbo.stock_item (item_key, item_code, item_name, unit, price, status, store_cat, plan_only, sort_order)
       VALUES (@k, @c, @n, @u, @p, NULL, N'ของเหลือครัวกลาง', 0, 999999);
       INSERT INTO dbo.stock_item_branch (item_key, branch) VALUES (@k, @b);`,
      {
        k: { type: sql.NVarChar(50), value: key },
        c: { type: sql.NVarChar(50), value: code },
        n: { type: sql.NVarChar(255), value: name },
        u: { type: sql.NVarChar(50), value: unit },
        p: { type: sql.Decimal(18, 4), value: price },
        b: { type: sql.NVarChar(50), value: branch },
      }
    );
    return {
      item: { item_key: key, item_code: code, item_name: name, unit, price },
      message: `สร้างไอเทม ${code} ${name} แล้ว`,
    };
  });
}

/**
 * แก้ชื่อ / หน่วย (/ ราคา) ของไอเทมของเหลือ — เฉพาะรหัส LO- ที่สร้างจากหน้าเมนูครัวกลาง
 * วัตถุดิบอื่นในทะเบียนเป็นของฝ่ายจัดซื้อ/QC/RD แก้จากที่นี่ไม่ได้
 * ใบรับเข้า/ใบเบิกเก่าเก็บชื่อ ณ ตอนบันทึกไว้แล้ว ไม่เปลี่ยนตาม (เหมือนวัตถุดิบอื่น)
 */
async function updateLeftoverItem(body) {
  const key = normCode(body?.itemKey || body?.itemCode);
  const name = str(body?.name).slice(0, 255);
  const unit = orNull(body?.unit);
  const hasPrice = body?.price !== undefined && body?.price !== null && str(body.price) !== '';
  const price = hasPrice && num(body.price) > 0 ? num(body.price) : null;
  if (!key) throw badRequest('ไม่ระบุไอเทม');
  if (!name) throw badRequest('ใส่ชื่อไอเทม');
  if (!unit) throw badRequest('ใส่หน่วย');
  return withTransaction(async (run) => {
    const it = (await run(
      `SELECT item_key, item_code, item_name, unit FROM dbo.stock_item WITH (UPDLOCK) WHERE item_key = @k;`,
      { k: { type: sql.NVarChar(50), value: key } }
    ))?.recordset?.[0];
    if (!it) throw badRequest('ไม่พบไอเทมในทะเบียนสินค้า');
    if (!/^LO-/i.test(str(it.item_code))) {
      throw badRequest(`${it.item_code} ไม่ใช่ไอเทมของเหลือ (รหัส LO-) — แก้ที่ QC/RD > วัตถุดิบ`);
    }
    const dup = (await run(
      `SELECT TOP 1 item_code FROM dbo.stock_item
        WHERE item_name = @n AND item_key <> @k AND (status IS NULL OR status <> N'ปิดการใช้งาน');`,
      { n: { type: sql.NVarChar(255), value: name }, k: { type: sql.NVarChar(50), value: key } }
    ))?.recordset?.[0];
    if (dup) throw badRequest(`มีไอเทมชื่อ "${name}" อยู่แล้ว (รหัส ${dup.item_code})`);
    await run(
      `UPDATE dbo.stock_item
          SET item_name = @n, unit = @u, ${hasPrice ? 'price = @p,' : ''} updated_at = SYSDATETIME()
        WHERE item_key = @k;`,
      {
        k: { type: sql.NVarChar(50), value: key },
        n: { type: sql.NVarChar(255), value: name },
        u: { type: sql.NVarChar(50), value: unit },
        ...(hasPrice ? { p: { type: sql.Decimal(18, 4), value: price } } : {}),
      }
    );
    return {
      item: { item_key: it.item_key, item_code: it.item_code, item_name: name, unit, ...(hasPrice ? { price } : {}) },
      message: `แก้ไอเทม ${it.item_code} แล้ว`,
    };
  });
}

/**
 * ของเหลือที่ใช้กับเมนูนี้ได้ + คงเหลือในครัวตอนนี้ (กติกาเดียวกับ getKitchenBalance) + ที่มาล่าสุด
 * ฟอร์มผลิตใช้ขึ้นกรอบ "มีของเหลือจากครั้งก่อน" และช่องบันทึกของเหลือตอนปิดงาน
 */
async function getMenuLeftovers(body) {
  const productKey = normCode(body?.productKey || body?.productCode);
  if (!productKey) throw badRequest('ไม่ระบุเมนู');
  if (!(await hasLeftoverTables())) return { items: [], ready: false };
  const links = await runSql(
    `SELECT l.item_key, COALESCE(i.item_code, l.item_key) AS item_code, COALESCE(i.item_name, l.item_key) AS item_name,
            i.unit, i.price,
            src.doc_no AS last_doc_no, src.receive_date AS last_date, o.doc_no AS last_order_doc_no
       FROM dbo.kitchen_menu_leftover l
       LEFT JOIN dbo.stock_item i ON i.item_key = l.item_key
       OUTER APPLY (SELECT TOP 1 m.doc_no, CONVERT(NVARCHAR(10), m.receive_date, 23) AS receive_date, m.order_id
                      FROM dbo.kitchen_material_receipt m
                     WHERE m.item_key = l.item_key AND m.receipt_kind = N'leftover'
                     ORDER BY m.receive_date DESC, m.receipt_id DESC) src
       LEFT JOIN dbo.kitchen_production_order o ON o.order_id = src.order_id
      WHERE l.product_key = @p
      ORDER BY l.sort_order, i.item_name;`,
    { p: { type: sql.NVarChar(50), value: productKey } }
  );
  if (links.length === 0) return { items: [], ready: true };
  const bal = await getKitchenBalance({});
  const byKey = new Map((bal.items || []).map((r) => [r.item_key, Number(r.balance) || 0]));
  return { items: links.map((l) => ({ ...l, balance: byKey.get(l.item_key) ?? 0 })), ready: true };
}

export const KITCHEN_ACTIONS = {
  getKitchenItems,
  getKitchenRecipes,
  getKitchenRecipe,
  saveKitchenRecipe,
  deleteKitchenRecipe,
  getProductionPlans,
  saveProductionPlan,
  deleteProductionPlan,
  getDatedPlans,
  saveDatedPlans,
  deleteDatedPlan,
  getProductionOrders,
  saveProductionOrder,
  saveOrderRecipeSnapshot,
  updateProductionOrderStatus,
  rescheduleProductionOrder,
  getBranchDemand,
  createOrdersFromDemand,
  createOrdersFromPlan,
  createOrderFromPlanDay,
  getOrderMaterials,
  getMaterialIssues,
  saveMaterialIssue,
  getMaterialReceipts,
  saveMaterialReceipt,
  getKitchenBalance,
  getKitchenCountHistory,
  getKitchenStockCard,
  saveKitchenCount,
  saveKitchenCounts,
  saveProductionRun,
  updateProductionRun,
  getProductionRunHistory,
  deleteProductionRun,
  getProductionReport,
  getKitchenMenuSettings,
  setKitchenMenuHidden,
  getLeftoverLinks,
  saveMenuLeftovers,
  createLeftoverItem,
  updateLeftoverItem,
  saveOrderLeftover,
  getMenuLeftovers,
};

/** action ที่อ่านอย่างเดียว — ปลอดภัยที่จะลองใหม่เมื่อเน็ตสะดุด (ดู READ_ONLY ใน api/schedule.js) */
export const KITCHEN_READ_ONLY = [
  'getKitchenItems',
  'getKitchenRecipes',
  'getKitchenRecipe',
  'getProductionPlans',
  'getDatedPlans',
  'getProductionOrders',
  'getBranchDemand',
  'getOrderMaterials',
  'getMaterialIssues',
  'getMaterialReceipts',
  'getKitchenBalance',
  'getKitchenCountHistory',
  'getKitchenStockCard',
  'getProductionReport',
  'getProductionRunHistory',
  'getLeftoverLinks',
  'getMenuLeftovers',
];
