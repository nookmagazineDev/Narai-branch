// ร้านที่เบิกของ (แอป ordernaraipizzeria) — ทะเบียนร้าน / ล็อกอินร้าน / รายการสินค้าที่ร้านเบิกได้
// (sql/ordershop-001-shops.sql = ทะเบียนร้าน · sql/ordershop-002-shop-items.sql = สินค้าที่แต่ละร้านเบิกได้)
//
// เรียกจากแอป ordernaraipizzeria (Narai-IT/ordernaraipizzeria) ผ่าน POST /schedule เหมือน action อื่น
//
//   เบราว์เซอร์ -> /api/* ของ ordernaraipizzeria (Vercel) -> office-server :8787/schedule -> SQL Server
//
// ตารางอยู่ที่ InventoryNarai (sql/ordershop-001-shops.sql) — ฐานเดียวกับ stock_item ที่ใช้เป็นทะเบียนสินค้า
// ตัวใบเบิกเองไม่ได้เขียนที่นี่: ordernaraipizzeria ส่งต่อให้ /api/insert_order ของแอปนี้
// ซึ่งเขียนลง myfbdata.orderd (POS) เหมือนปุ่ม "สั่งของ" ของหน้านับสต๊อกทุกอย่าง
//
// ที่นี่แค่ "ตรวจรหัส + เก็บทะเบียน" ส่วนการออก token ที่เซ็นชื่อ และการล็อกร้านไว้กับ outlet ของตัวเอง
// ทำที่ ordernaraipizzeria (lib/token.js) — เหมือนที่ storefct-auth.js ทำกับแอป storefct
//
// ข้อควรรู้: action ชุดนี้ (รวมถึง orderShopSave) เรียกได้จากทุกคนที่เรียก /schedule ได้
// ตัวกันจริงคือ API_TOKEN ของ office-server (.env) ซึ่ง ordernaraipizzeria แนบ x-api-token มาให้ทุกครั้ง

import { sql, stockDb } from './hr-db.js';
import { hashPassword, verifyPassword } from './hr-password.js';

const { queryRead, withTransaction } = stockDb;

const str = (v) => String(v === null || v === undefined ? '' : v).trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const bad = (message) => Object.assign(new Error(message), { badRequest: true });

const CODE_RE = /^[A-Z][A-Z0-9]{2}$/;
const MIN_PASSWORD = 6;

/** normalize รหัสสินค้าให้ตรงกับ item_key — กติกาเดียวกับ stock.js */
const normCode = (c) => str(c).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

/** แถวร้าน -> รูปแบบที่ ordernaraipizzeria ใช้ (ไม่มี password_hash หลุดออกไปเด็ดขาด) */
function shape(row) {
  return {
    shopNo: Number(row.shop_no),
    code: str(row.branch_code),
    name: str(row.shop_name),
    isActive: Boolean(row.is_active),
    hasPassword: Boolean(str(row.password_hash)),
    lastLoginAt: row.last_login_at || null,
  };
}

const SHOP_COLUMNS = `shop_no, branch_code, shop_name, password_hash, is_active,
       CONVERT(NVARCHAR(19), last_login_at, 120) AS last_login_at`;

/** หาร้านจากสิ่งที่ผู้ใช้พิมพ์ — รับได้ทั้งรหัสสาขา (SUM) และรหัสตัวเลข (51) */
async function findShop(input) {
  const v = str(input).toUpperCase();
  if (!v) return null;
  const byNo = /^\d+$/.test(v);
  const rows = await queryRead(
    `SELECT ${SHOP_COLUMNS} FROM dbo.order_shop WHERE ${byNo ? 'shop_no = @no' : 'branch_code = @code'}`,
    byNo ? { no: { type: sql.Int, value: Number(v) } } : { code: { type: sql.NVarChar(3), value: v } }
  );
  return rows[0] || null;
}

function checkPassword(pw) {
  if (String(pw ?? '').length < MIN_PASSWORD) throw bad(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`);
}

/**
 * ล็อกอินร้าน — body: { shop: 'SUM' | '51', password }
 * รหัสร้าน/รหัสผ่านผิดตอบข้อความเดียวกันเสมอ ไม่บอกว่ารหัสร้านนี้มีอยู่จริงหรือไม่
 */
async function orderShopLogin(body) {
  const password = String(body.password ?? '');
  if (!str(body.shop) || !password) throw bad('กรุณากรอกรหัสร้านและรหัสผ่าน');
  const invalid = bad('รหัสร้านหรือรหัสผ่านไม่ถูกต้อง');

  const row = await findShop(body.shop);
  if (!row || !str(row.password_hash)) throw invalid;
  const { ok, needsRehash } = await verifyPassword(password, row.password_hash);
  if (!ok) throw invalid;
  if (!row.is_active) throw bad('ร้านนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแลระบบ');

  const hash = needsRehash ? await hashPassword(password) : null;
  await withTransaction((run) => run(
    `UPDATE dbo.order_shop
        SET last_login_at = SYSDATETIME(), password_hash = COALESCE(@hash, password_hash)
      WHERE shop_no = @no`,
    { no: { type: sql.Int, value: row.shop_no }, hash: { type: sql.NVarChar(255), value: hash } }
  ));
  return { shop: shape(row) };
}

/** ร้านปัจจุบัน (ใช้ต่ออายุ token) — ไม่มี/ปิดใช้งาน = shop: null */
async function orderShopGet(body) {
  const row = await findShop(body.shopNo);
  if (!row || !row.is_active) return { shop: null };
  return { shop: shape(row) };
}

async function orderShopList() {
  const rows = await queryRead(
    `SELECT ${SHOP_COLUMNS},
            (SELECT COUNT(*) FROM dbo.order_shop_item s WHERE s.shop_no = order_shop.shop_no) AS item_count
       FROM dbo.order_shop ORDER BY branch_code`
  );
  return { shops: rows.map((r) => ({ ...shape(r), itemCount: Number(r.item_count) || 0 })) };
}

/**
 * เพิ่ม/แก้ร้าน — body: { shopNo, code, name, isActive, password?, isNew, originalShopNo? }
 * originalShopNo = รหัสตัวเลขเดิมตอนแก้ (เปลี่ยนรหัสตัวเลขได้) · password ส่งมา = ตั้ง/รีเซ็ตรหัส
 */
async function orderShopSave(body) {
  const shopNo = Number(body.shopNo);
  if (!Number.isInteger(shopNo) || shopNo <= 0 || shopNo > 999999) throw bad('รหัสตัวเลขต้องเป็นจำนวนเต็มบวก');
  const code = str(body.code).toUpperCase();
  if (!CODE_RE.test(code)) throw bad('รหัสสาขาต้องเป็นภาษาอังกฤษ 3 ตัว (ตัวแรกเป็นตัวอักษร เช่น SUM, P90)');
  const name = str(body.name).slice(0, 150);
  if (!name) throw bad('กรุณาใส่ชื่ออธิบายร้าน');
  const isActive = body.isActive === undefined ? true : Boolean(body.isActive);
  const password = body.password === undefined || body.password === null ? '' : String(body.password);
  const originalNo = body.isNew ? shopNo : Number(body.originalShopNo ?? shopNo);

  if (body.isNew && !password) throw bad('ร้านใหม่ต้องตั้งรหัสผ่าน');
  if (password) checkPassword(password);

  // เช็คซ้ำก่อนเขียน ข้อความจะได้บอกว่าซ้ำกับร้านไหน (ไม่ใช่ error ดิบของ UNIQUE constraint)
  const clash = await queryRead(
    `SELECT shop_no, branch_code, shop_name FROM dbo.order_shop
      WHERE (shop_no = @no OR branch_code = @code) AND shop_no <> @orig`,
    {
      no: { type: sql.Int, value: shopNo },
      code: { type: sql.NVarChar(3), value: code },
      orig: { type: sql.Int, value: body.isNew ? -1 : originalNo },
    }
  );
  if (clash.length) {
    const c = clash[0];
    throw bad(`รหัสซ้ำกับร้าน ${c.shop_no} · ${c.branch_code} ${c.shop_name}`);
  }

  const hash = password ? await hashPassword(password) : null;
  const params = {
    no: { type: sql.Int, value: shopNo },
    orig: { type: sql.Int, value: originalNo },
    code: { type: sql.NVarChar(3), value: code },
    name: { type: sql.NVarChar(150), value: name },
    active: { type: sql.Bit, value: isActive },
    hash: { type: sql.NVarChar(255), value: hash },
  };

  await withTransaction(async (run) => {
    if (body.isNew) {
      await run(
        `INSERT dbo.order_shop (shop_no, branch_code, shop_name, password_hash, is_active)
         VALUES (@no, @code, @name, @hash, @active)`,
        params
      );
      return;
    }
    const updated = await run(
      `UPDATE dbo.order_shop
          SET shop_no = @no, branch_code = @code, shop_name = @name, is_active = @active,
              password_hash = COALESCE(@hash, password_hash), updated_at = SYSDATETIME()
        OUTPUT inserted.shop_no
        WHERE shop_no = @orig`,
      params
    );
    if (!updated.recordset?.length) throw bad(`ไม่พบร้านรหัส ${originalNo}`);
  });

  const row = await findShop(String(shopNo));
  return { shop: shape(row), message: `บันทึกร้าน ${code} แล้ว` };
}

const ITEM_COLUMNS = `i.item_key, i.item_code, i.item_name, i.unit, i.request_unit, i.price,
       i.pos_item_id, i.store_cat, i.plan_only`;
const ACTIVE_ITEM = `ISNULL(i.status, N'') <> N'ปิดการใช้งาน'`;

function shapeItem(r) {
  return {
    key: normCode(r.item_key || r.item_code),
    code: str(r.item_code),
    name: str(r.item_name),
    unit: str(r.unit),
    requestUnit: num(r.request_unit),
    price: num(r.price),
    itemId: Number(r.pos_item_id) || 0,
    storeCat: str(r.store_cat),
    planOnly: Boolean(r.plan_only),
  };
}

const shopNoParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad('ไม่ระบุรหัสร้าน');
  return { type: sql.Int, value: n };
};

/**
 * สินค้าที่ร้านเบิกได้ — เฉพาะที่ผู้ดูแลตั้งไว้ใน dbo.order_shop_item (ตัดของที่ปิดการใช้งานในทะเบียน)
 * ร้านที่ยังไม่ได้ตั้งรายการ = ได้รายการว่าง (configured: false) หน้าเว็บจะบอกให้ติดต่อผู้ดูแล
 * ใช้ทั้งตอนแสดงหน้าเบิกของและตอนตรวจใบเบิกก่อนส่ง ร้านจึงส่งของนอกรายการไม่ได้แม้ยิง API ตรง
 */
async function orderShopItems(body) {
  const rows = await queryRead(
    `SELECT ${ITEM_COLUMNS}
       FROM dbo.order_shop_item s
       JOIN dbo.stock_item i ON i.item_key = s.item_key
      WHERE s.shop_no = @no AND ${ACTIVE_ITEM}
      ORDER BY i.sort_order, i.item_code`,
    { no: shopNoParam(body.shopNo) }
  );
  return { configured: rows.length > 0, items: rows.map(shapeItem) };
}

/**
 * หน้าตั้งรายการของผู้ดูแล — ทะเบียนทั้งหมด พร้อมธงว่าร้านนี้เลือกไว้หรือยัง
 * และธงว่าสินค้าผูกกับสาขานี้ในสต๊อกสาขา (stock_item_branch) ไว้ใช้ปุ่ม "เลือกตามสต๊อกสาขา"
 */
async function orderShopGetItems(body) {
  const no = shopNoParam(body.shopNo);
  const shop = await findShop(String(no.value));
  if (!shop) throw bad(`ไม่พบร้านรหัส ${no.value}`);
  const rows = await queryRead(
    `SELECT ${ITEM_COLUMNS},
            CASE WHEN s.item_key IS NULL THEN 0 ELSE 1 END AS selected,
            CASE WHEN b.item_key IS NULL THEN 0 ELSE 1 END AS in_branch
       FROM dbo.stock_item i
       LEFT JOIN dbo.order_shop_item s ON s.item_key = i.item_key AND s.shop_no = @no
       LEFT JOIN dbo.stock_item_branch b ON b.item_key = i.item_key AND b.branch = @branch
      WHERE ${ACTIVE_ITEM}
      ORDER BY i.sort_order, i.item_code`,
    { no, branch: { type: sql.NVarChar(50), value: str(shop.branch_code).toLowerCase() } }
  );
  return {
    shop: shape(shop),
    items: rows.map((r) => ({ ...shapeItem(r), selected: Boolean(r.selected), inBranch: Boolean(r.in_branch) })),
  };
}

/**
 * ตั้งรายการที่ร้านเบิกได้ใหม่ทั้งชุด — body: { shopNo, codes: ['100101', ...] }
 * รับรหัสได้ทั้งแบบมี/ไม่มี 0 นำหน้า (มาจาก Excel บ่อย) รหัสที่ไม่อยู่ในทะเบียนคืนกลับเป็น unknown ไม่บันทึก
 */
async function orderShopSetItems(body) {
  const no = shopNoParam(body.shopNo);
  const codes = Array.isArray(body.codes) ? body.codes : [];
  if (codes.length > 5000) throw bad('รายการเกิน 5,000 รายการ');
  const wanted = [...new Set(codes.map(normCode).filter(Boolean))];

  const registry = await queryRead(`SELECT i.item_key, i.item_code FROM dbo.stock_item i WHERE ${ACTIVE_ITEM}`);
  const keyOf = new Map();
  for (const r of registry) {
    keyOf.set(normCode(r.item_key), str(r.item_key));
    keyOf.set(normCode(r.item_code), str(r.item_key));
  }
  const keys = [...new Set(wanted.map((c) => keyOf.get(c)).filter(Boolean))];
  const unknown = wanted.filter((c) => !keyOf.has(c));

  const shop = await findShop(String(no.value));
  if (!shop) throw bad(`ไม่พบร้านรหัส ${no.value}`);

  await withTransaction(async (run) => {
    await run(`DELETE dbo.order_shop_item WHERE shop_no = @no`, { no });
    // ทีละ 500 แถว — INSERT ... VALUES รับได้ไม่เกิน 1000 แถวต่อคำสั่ง และพารามิเตอร์ไม่เกิน 2100 ตัว
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const params = { no };
      const values = chunk.map((k, j) => {
        params[`k${j}`] = { type: sql.NVarChar(50), value: k };
        return `(@no, @k${j})`;
      });
      await run(`INSERT dbo.order_shop_item (shop_no, item_key) VALUES ${values.join(', ')}`, params);
    }
  });

  return {
    count: keys.length,
    unknown,
    message: `บันทึกรายการที่ร้าน ${shop.branch_code} เบิกได้ ${keys.length} รายการ`,
  };
}

export const ORDER_SHOP_ACTIONS = {
  orderShopLogin,
  orderShopGet,
  orderShopList,
  orderShopSave,
  orderShopItems,
  orderShopGetItems,
  orderShopSetItems,
};
