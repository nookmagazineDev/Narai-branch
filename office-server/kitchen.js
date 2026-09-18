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
  const rows = await runSql(
    `SELECT item_key, item_code, item_name, unit, request_unit, store_cat, price
       FROM dbo.stock_item
      WHERE (@all = 1 OR status IS NULL OR status <> N'ปิดการใช้งาน')
      ORDER BY item_name;`,
    { all: { type: sql.Bit, value: includeInactive } }
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
   แผนผลิตประจำรอบ
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
   คำสั่งผลิต
========================================================================== */

async function getProductionOrders(body) {
  const from = ymd(body?.dateFrom);
  const to = ymd(body?.dateTo);
  if (!from || !to) throw badRequest('ต้องระบุช่วงวันที่ (dateFrom, dateTo)');

  const rows = await runSql(
    `SELECT o.order_id, o.doc_no, o.produce_date, o.product_key, o.product_code, o.product_name,
            o.order_qty, o.produced_qty, o.unit, o.status, o.source, o.plan_id,
            o.note, o.recorder, o.created_at, o.updated_at,
            CASE WHEN r.recipe_id IS NULL THEN 0 ELSE 1 END AS has_recipe,
            (SELECT COUNT(*) FROM dbo.kitchen_material_issue mi WHERE mi.order_id = o.order_id) AS issue_count
       FROM dbo.kitchen_production_order o
       LEFT JOIN dbo.kitchen_recipe r ON r.product_key = o.product_key
      WHERE o.produce_date BETWEEN CONVERT(DATE, @from, 23) AND CONVERT(DATE, @to, 23)
        AND (@status IS NULL OR o.status = @status)
      ORDER BY o.produce_date DESC, o.doc_no;`,
    {
      from: { type: sql.NVarChar(10), value: from },
      to: { type: sql.NVarChar(10), value: to },
      status: { type: sql.NVarChar(50), value: orNull(body?.status) },
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
    const updated = await runSql(
      `UPDATE dbo.kitchen_production_order
          SET produce_date = CONVERT(DATE, @produce_date, 23),
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

async function updateProductionOrderStatus(body) {
  const orderId = Number(body?.orderId);
  const status = str(body?.status);
  const allowed = ['รอผลิต', 'กำลังผลิต', 'ผลิตเสร็จ', 'ยกเลิก'];
  if (!Number.isFinite(orderId)) throw badRequest('ไม่ระบุคำสั่งผลิต');
  if (!allowed.includes(status)) throw badRequest(`สถานะต้องเป็นหนึ่งใน: ${allowed.join(', ')}`);

  const updated = await runSql(
    `UPDATE dbo.kitchen_production_order
        SET status = @status, updated_at = SYSDATETIME()
      OUTPUT inserted.doc_no
      WHERE order_id = @order_id;`,
    {
      order_id: { type: sql.BigInt, value: orderId },
      status: { type: sql.NVarChar(50), value: status },
    }
  );
  if (updated.length === 0) throw badRequest('ไม่พบคำสั่งผลิตที่ต้องการแก้สถานะ');
  return { message: `เปลี่ยนสถานะ ${updated[0].doc_no} เป็น "${status}" แล้ว` };
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
 * สร้างคำสั่งผลิตของวันหนึ่งจากแผนประจำรอบ
 * เอาทั้งแผนรายวัน และแผนรายสัปดาห์ที่ตรงกับวันในสัปดาห์ของวันนั้น
 */
async function createOrdersFromPlan(body, session) {
  const produceDate = ymd(body?.produceDate) || bangkokNow().date;
  const recorder = recorderOf(body, session);

  // คำนวณวันในสัปดาห์จากสตริงวันที่ตรงๆ ไม่ผ่าน new Date(str) ซึ่งตีความเป็น UTC
  // แล้วเพี้ยนไปหนึ่งวันสำหรับเขตเวลาไทย
  const [y, m, d] = produceDate.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  const plans = await runSql(
    `SELECT plan_id, product_key, product_code, product_name, planned_qty, unit
       FROM dbo.kitchen_production_plan
      WHERE is_active = 1
        AND (cycle = N'daily' OR (cycle = N'weekly' AND weekday = @weekday));`,
    { weekday: { type: sql.TinyInt, value: weekday } }
  );
  if (plans.length === 0) {
    return { created: 0, updated: 0, message: 'ไม่มีแผนผลิตที่ตรงกับวันนี้' };
  }

  return withTransaction(async (run) => {
    let created = 0;
    let skipped = 0;
    for (const p of plans) {
      const existing = await run(
        `SELECT order_id FROM dbo.kitchen_production_order
          WHERE produce_date = CONVERT(DATE, @produce_date, 23)
            AND product_key = @product_key AND source = N'plan';`,
        {
          produce_date: { type: sql.NVarChar(10), value: produceDate },
          product_key: { type: sql.NVarChar(50), value: p.product_key },
        }
      );
      // ใบที่สร้างจากแผนแล้วไม่ทับของเดิม — ครัวอาจแก้จำนวนไปแล้ว การกดปุ่มซ้ำไม่ควรล้างที่แก้ไว้
      if (existing?.recordset?.length) { skipped++; continue; }

      const docNo = await nextDocNo(run, 'dbo.kitchen_production_order', 'PRD', produceDate);
      await run(
        `INSERT INTO dbo.kitchen_production_order
           (doc_no, produce_date, product_key, product_code, product_name,
            order_qty, unit, status, source, plan_id, recorder)
         VALUES (@doc_no, CONVERT(DATE, @produce_date, 23), @product_key, @product_code, @product_name,
                 @order_qty, @unit, N'รอผลิต', N'plan', @plan_id, @recorder);`,
        {
          doc_no: { type: sql.NVarChar(50), value: docNo },
          produce_date: { type: sql.NVarChar(10), value: produceDate },
          product_key: { type: sql.NVarChar(50), value: p.product_key },
          product_code: { type: sql.NVarChar(50), value: p.product_code },
          product_name: { type: sql.NVarChar(255), value: p.product_name },
          order_qty: { type: sql.Decimal(18, 3), value: Number(p.planned_qty) },
          unit: { type: sql.NVarChar(50), value: p.unit },
          plan_id: { type: sql.Int, value: p.plan_id },
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
            mi.item_key, mi.item_code, mi.item_name, mi.qty, mi.unit,
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

/** บันทึกใบเบิกวัตถุดิบหนึ่งใบ (หลายรายการ) */
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
    // UNIQUE (doc_no, item_key) ทำให้วัตถุดิบตัวเดียวกันใส่สองบรรทัดในใบเดียวไม่ได้ — รวมยอดให้
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
  if (items.length === 0) throw badRequest('ไม่มีรายการวัตถุดิบที่จะเบิก');

  return withTransaction(async (run) => {
    const docNo = await nextDocNo(run, 'dbo.kitchen_material_issue', 'MI', issueDate);
    for (const it of items) {
      await run(
        `INSERT INTO dbo.kitchen_material_issue
           (doc_no, issue_date, order_id, item_key, item_code, item_name, qty, unit, note, recorder)
         VALUES (@doc_no, CONVERT(DATE, @issue_date, 23), @order_id, @item_key, @item_code,
                 @item_name, @qty, @unit, @note, @recorder);`,
        {
          doc_no: { type: sql.NVarChar(50), value: docNo },
          issue_date: { type: sql.NVarChar(10), value: issueDate },
          order_id: { type: sql.BigInt, value: Number.isFinite(orderId) && orderId > 0 ? orderId : null },
          item_key: { type: sql.NVarChar(50), value: it.key },
          item_code: { type: sql.NVarChar(50), value: it.code },
          item_name: { type: sql.NVarChar(255), value: it.name },
          qty: { type: sql.Decimal(18, 3), value: it.qty },
          unit: { type: sql.NVarChar(50), value: it.unit },
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
     ),
     lc AS (SELECT item_key, remaining, count_date FROM last_count WHERE rn = 1),
     scope AS (
        SELECT item_key FROM dbo.kitchen_recipe_item
        UNION SELECT product_key FROM dbo.kitchen_recipe
        UNION SELECT item_key FROM dbo.kitchen_material_issue
        UNION SELECT item_key FROM dbo.kitchen_material_receipt
     )
     SELECT i.item_key, i.item_code, i.item_name, i.unit,
            COALESCE(lc.remaining, 0) AS counted_qty,
            lc.count_date,
            COALESCE(mr.qty, 0) + COALESCE(rc.qty, 0) AS received_qty,
            COALESCE(iss.qty, 0) AS issued_qty,
            COALESCE(pr.qty, 0) AS produced_qty,
            COALESCE(lc.remaining, 0) + COALESCE(mr.qty, 0) + COALESCE(rc.qty, 0)
              - COALESCE(iss.qty, 0) + COALESCE(pr.qty, 0) AS balance
       FROM dbo.stock_item i
       JOIN scope s ON s.item_key = i.item_key
       LEFT JOIN lc ON lc.item_key = i.item_key
       OUTER APPLY (
         SELECT SUM(r.qty_received) AS qty FROM dbo.store_receiving r
          WHERE r.item_key = i.item_key AND r.branch = @branch
            AND r.receive_date > COALESCE(lc.count_date, '19000101')
            AND (@as_of IS NULL OR r.receive_date <= CONVERT(DATE, @as_of, 23))
       ) rc
       OUTER APPLY (
         SELECT SUM(m.qty) AS qty FROM dbo.kitchen_material_receipt m
          WHERE m.item_key = i.item_key
            AND m.receive_date > COALESCE(lc.count_date, '19000101')
            AND (@as_of IS NULL OR m.receive_date <= CONVERT(DATE, @as_of, 23))
       ) mr
       OUTER APPLY (
         SELECT SUM(m.qty) AS qty FROM dbo.kitchen_material_issue m
          WHERE m.item_key = i.item_key
            AND m.issue_date > COALESCE(lc.count_date, '19000101')
            AND (@as_of IS NULL OR m.issue_date <= CONVERT(DATE, @as_of, 23))
       ) iss
       OUTER APPLY (
         SELECT SUM(p.qty_produced) AS qty FROM dbo.kitchen_production_run p
          WHERE p.product_key = i.item_key
            AND p.produce_date > COALESCE(lc.count_date, '19000101')
            AND (@as_of IS NULL OR p.produce_date <= CONVERT(DATE, @as_of, 23))
       ) pr
      ORDER BY i.item_name;`,
    {
      branch: { type: sql.NVarChar(50), value: branch },
      as_of: { type: sql.NVarChar(10), value: asOf },
    }
  );
  return { branch, asOf, items: rows };
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

  return withTransaction(async (run) => {
    let productKey = normCode(body?.productKey || body?.productCode);
    let productCode = str(body?.productCode) || productKey;
    let productName = str(body?.productName).slice(0, 255);
    let unit = orNull(body?.unit);

    if (hasOrder) {
      // ผลิตตามคำสั่ง — เอาข้อมูลสินค้าจากใบสั่ง ไม่เชื่อสิ่งที่หน้าเว็บส่งมา
      // ไม่งั้นบันทึกผลิตของสินค้า A ใส่ใบสั่งของสินค้า B ได้โดยไม่มีอะไรทัก
      const found = await run(
        `SELECT product_key, product_code, product_name, unit, order_qty
           FROM dbo.kitchen_production_order WHERE order_id = @order_id;`,
        { order_id: { type: sql.BigInt, value: orderId } }
      );
      const o = found?.recordset?.[0];
      if (!o) throw badRequest('ไม่พบคำสั่งผลิต');
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

    return { message: `บันทึกการผลิต ${productName || productKey} จำนวน ${qtyProduced} แล้ว` };
  });
}

/** ลบบันทึกการผลิตหนึ่งแถว แล้วคิด produced_qty ของใบสั่งใหม่ */
async function deleteProductionRun(body) {
  const runId = Number(body?.runId);
  if (!Number.isFinite(runId)) throw badRequest('ไม่ระบุรายการที่จะลบ');

  return withTransaction(async (run) => {
    const gone = await run(
      `DELETE FROM dbo.kitchen_production_run
        OUTPUT deleted.order_id, deleted.product_name, deleted.qty_produced
        WHERE run_id = @run_id;`,
      { run_id: { type: sql.BigInt, value: runId } }
    );
    const row = gone?.recordset?.[0];
    if (!row) throw badRequest('ไม่พบรายการที่ต้องการลบ');

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
 */
async function getProductionReport(body) {
  const from = ymd(body?.dateFrom);
  const to = ymd(body?.dateTo);
  if (!from || !to) throw badRequest('ต้องระบุช่วงวันที่ (dateFrom, dateTo)');

  const params = {
    from: { type: sql.NVarChar(10), value: from },
    to: { type: sql.NVarChar(10), value: to },
  };

  const runs = await runSql(
    `SELECT p.run_id, p.order_id, o.doc_no AS order_doc_no, o.order_qty,
            p.produce_date, p.product_key, p.product_code, p.product_name,
            p.qty_produced, p.qty_waste, p.unit, p.note, p.recorder, p.recorded_at
       FROM dbo.kitchen_production_run p
       LEFT JOIN dbo.kitchen_production_order o ON o.order_id = p.order_id
      WHERE p.produce_date BETWEEN CONVERT(DATE, @from, 23) AND CONVERT(DATE, @to, 23)
      ORDER BY p.produce_date DESC, p.recorded_at DESC;`,
    params
  );

  const summary = await runSql(
    `SELECT p.product_key, MAX(p.product_code) AS product_code, MAX(p.product_name) AS product_name,
            MAX(p.unit) AS unit,
            SUM(p.qty_produced) AS total_produced,
            SUM(p.qty_waste) AS total_waste,
            COUNT(*) AS run_count
       FROM dbo.kitchen_production_run p
      WHERE p.produce_date BETWEEN CONVERT(DATE, @from, 23) AND CONVERT(DATE, @to, 23)
      GROUP BY p.product_key
      ORDER BY SUM(p.qty_produced) DESC;`,
    params
  );

  return { dateFrom: from, dateTo: to, runs, summary };
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
  getProductionOrders,
  saveProductionOrder,
  updateProductionOrderStatus,
  getBranchDemand,
  createOrdersFromDemand,
  createOrdersFromPlan,
  getOrderMaterials,
  getMaterialIssues,
  saveMaterialIssue,
  getMaterialReceipts,
  saveMaterialReceipt,
  getKitchenBalance,
  saveProductionRun,
  deleteProductionRun,
  getProductionReport,
};

/** action ที่อ่านอย่างเดียว — ปลอดภัยที่จะลองใหม่เมื่อเน็ตสะดุด (ดู READ_ONLY ใน api/schedule.js) */
export const KITCHEN_READ_ONLY = [
  'getKitchenItems',
  'getKitchenRecipes',
  'getKitchenRecipe',
  'getProductionPlans',
  'getProductionOrders',
  'getBranchDemand',
  'getOrderMaterials',
  'getMaterialIssues',
  'getMaterialReceipts',
  'getKitchenBalance',
  'getProductionReport',
];
