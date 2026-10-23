// ร้านที่เบิกของ (แอป ordernaraipizzeria) — ทะเบียนร้าน / ล็อกอินร้าน / รายการสินค้าที่ร้านเบิกได้
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
  const rows = await queryRead(`SELECT ${SHOP_COLUMNS} FROM dbo.order_shop ORDER BY branch_code`);
  return { shops: rows.map(shape) };
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

/**
 * สินค้าที่ร้านเบิกได้ — ทะเบียนเดียวกับหน้านับสต๊อก (dbo.stock_item) ตัดของที่ปิดการใช้งาน
 * ร้านที่มีรายการผูกไว้ใน stock_item_branch เห็นเฉพาะของตัวเอง ร้านใหม่ที่ยังไม่ได้ผูกเห็นทั้งทะเบียน
 * (ดีกว่าเปิดมาเจอหน้าว่างแล้วสั่งอะไรไม่ได้เลย)
 */
async function orderShopItems(body) {
  const branch = str(body.branch).toLowerCase();
  const rows = await queryRead(
    `SELECT i.item_key, i.item_code, i.item_name, i.unit, i.request_unit, i.price,
            i.pos_item_id, i.store_cat, i.plan_only,
            CASE WHEN b.item_key IS NULL THEN 0 ELSE 1 END AS for_branch
       FROM dbo.stock_item i
       LEFT JOIN dbo.stock_item_branch b ON b.item_key = i.item_key AND b.branch = @branch
      WHERE ISNULL(i.status, N'') <> N'ปิดการใช้งาน'
      ORDER BY i.sort_order, i.item_code`,
    { branch: { type: sql.NVarChar(50), value: branch } }
  );
  const mine = rows.filter((r) => r.for_branch);
  const list = mine.length ? mine : rows;
  return {
    scoped: mine.length > 0,
    items: list.map((r) => ({
      key: normCode(r.item_key || r.item_code),
      code: str(r.item_code),
      name: str(r.item_name),
      unit: str(r.unit),
      requestUnit: num(r.request_unit),
      price: num(r.price),
      itemId: Number(r.pos_item_id) || 0,
      storeCat: str(r.store_cat),
      planOnly: Boolean(r.plan_only),
    })),
  };
}

export const ORDER_SHOP_ACTIONS = {
  orderShopLogin,
  orderShopGet,
  orderShopList,
  orderShopSave,
  orderShopItems,
};
