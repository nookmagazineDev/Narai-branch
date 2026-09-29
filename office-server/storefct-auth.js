// ผู้ใช้ของแอป storefct (สโตร์ + ครัวกลาง) — ล็อกอิน / สิทธิ์รายหน้า / จัดการผู้ใช้
//
// เรียกจากแอป storefct (nookmagazineDev/narai-storefct) ผ่าน POST /schedule เหมือน action อื่น
//
//   เบราว์เซอร์ -> /api/auth/* ของ storefct (Vercel) -> office-server :8787/schedule -> SQL Server
//
// บัญชีแยกจากผู้ใช้เว็บสาขา (dbo.hr_user) โดยตั้งใจ — คนโกดัง/ครัวไม่ใช่ผู้ใช้สาขา และสิทธิ์คนละแบบ
// ตารางอยู่ที่ InventoryNarai (sql/storefct-001-users.sql)
//
// ที่นี่แค่ "ตรวจรหัส + เก็บสิทธิ์" ส่วนการออก token ที่เซ็นชื่อ และการตรวจสิทธิ์ของทุกคำขอ
// ทำที่ storefct (lib/auth.js) — รายชื่อหน้าที่ถูกต้องก็อยู่ฝั่งนั้น (lib/pages.js) ที่นี่เก็บตามที่ส่งมา
//
// ข้อควรรู้: action ชุดนี้ (รวมถึง storefctSaveUser) เรียกได้จากทุกคนที่เรียก /schedule ได้
// ตัวกันจริงคือ API_TOKEN ของ office-server (.env) ซึ่ง storefct แนบ x-api-token มาให้ทุกครั้ง

import { sql, stockDb } from './hr-db.js';
import { hashPassword, verifyPassword } from './hr-password.js';

const { queryRead, withTransaction } = stockDb;

const str = (v) => String(v === null || v === undefined ? '' : v).trim();
const bad = (message) => Object.assign(new Error(message), { badRequest: true });

const USERNAME_RE = /^[A-Za-z0-9._-]{2,50}$/;
const PAGE_RE = /^[a-z0-9-]{1,50}$/;
const MIN_PASSWORD = 6;

const nv = (value, len = 100) => ({ type: sql.NVarChar(len), value });

/** แถวผู้ใช้ + สิทธิ์ -> รูปแบบที่ storefct ใช้ (ไม่มี password_hash หลุดออกไปเด็ดขาด) */
function shape(row, pageRows) {
  return {
    username: row.username,
    name: row.display_name || '',
    isAdmin: Boolean(row.is_admin),
    isActive: Boolean(row.is_active),
    lastLoginAt: row.last_login_at || null,
    pages: pageRows
      .filter((p) => p.username === row.username)
      .map((p) => ({ key: p.page_key, edit: Boolean(p.can_edit) })),
  };
}

async function loadUsers(username = null) {
  const where = username ? 'WHERE username = @username' : '';
  const params = username ? { username: nv(username) } : {};
  const users = await queryRead(
    `SELECT username, password_hash, display_name, is_admin, is_active, last_login_at
       FROM dbo.storefct_user ${where} ORDER BY is_admin DESC, username`,
    params
  );
  const pages = await queryRead(
    `SELECT username, page_key, can_edit FROM dbo.storefct_user_page ${where}`,
    params
  );
  return { users, pages };
}

function checkPassword(pw) {
  if (String(pw ?? '').length < MIN_PASSWORD) throw bad(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`);
}

async function setPassword(username, plain) {
  const hash = await hashPassword(plain);
  await withTransaction((run) => run(
    `UPDATE dbo.storefct_user SET password_hash = @hash, updated_at = SYSDATETIME() WHERE username = @username`,
    { username: nv(username), hash: nv(hash, 255) }
  ));
}

/**
 * ล็อกอิน — คืนผู้ใช้พร้อมสิทธิ์
 *
 * บัญชีที่ password_hash ยังว่าง (บัญชี admin ที่ sql/storefct-001-users.sql สร้างให้) =
 * รหัสแรกที่กรอกกลายเป็นรหัสของบัญชีนั้น — ไม่ต้องฝังรหัสไว้ใน repo หรือให้ใครพิมพ์ลง .env
 * ชื่อผู้ใช้/รหัสผิดตอบข้อความเดียวกันเสมอ ไม่บอกว่าชื่อนี้มีอยู่จริงหรือไม่
 */
async function storefctLogin(body) {
  const username = str(body.username);
  const password = String(body.password ?? '');
  if (!username || !password) throw bad('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');
  const invalid = bad('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');

  const { users, pages } = await loadUsers(username);
  const row = users[0];
  if (!row) throw invalid;
  if (!row.is_active) throw bad('บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแลระบบ');

  let firstPassword = false;
  if (!str(row.password_hash)) {
    checkPassword(password);
    await setPassword(row.username, password);
    firstPassword = true;
  } else {
    const { ok, needsRehash } = await verifyPassword(password, row.password_hash);
    if (!ok) throw invalid;
    if (needsRehash) await setPassword(row.username, password);
  }

  await withTransaction((run) => run(
    `UPDATE dbo.storefct_user SET last_login_at = SYSDATETIME() WHERE username = @username`,
    { username: nv(row.username) }
  ));
  return { user: shape(row, pages), firstPassword };
}

/** ผู้ใช้ปัจจุบัน (ใช้ต่ออายุสิทธิ์ใน token) — ไม่มี/ปิดบัญชี = user: null */
async function storefctGetUser(body) {
  const username = str(body.username);
  if (!username) return { user: null };
  const { users, pages } = await loadUsers(username);
  const row = users[0];
  if (!row || !row.is_active) return { user: null };
  return { user: shape(row, pages) };
}

async function storefctListUsers() {
  const { users, pages } = await loadUsers();
  return { users: users.map((u) => ({ ...shape(u, pages), hasPassword: Boolean(str(u.password_hash)) })) };
}

/**
 * เพิ่ม/แก้ผู้ใช้ — สิทธิ์รายหน้าเขียนทับทั้งชุด
 * body: { username, name, isAdmin, isActive, pages: [{ key, edit }], password?, isNew }
 * password ส่งมา = ตั้ง/รีเซ็ตรหัส · ผู้ใช้ใหม่ต้องมีรหัสเสมอ
 */
async function storefctSaveUser(body) {
  const username = str(body.username);
  if (!USERNAME_RE.test(username)) throw bad('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 2–50 ตัว');
  const name = str(body.name).slice(0, 150);
  const isAdmin = Boolean(body.isAdmin);
  const isActive = body.isActive === undefined ? true : Boolean(body.isActive);
  const password = body.password === undefined || body.password === null ? '' : String(body.password);
  const pages = [];
  const seen = new Set();
  for (const p of Array.isArray(body.pages) ? body.pages : []) {
    const key = str(p?.key);
    if (!PAGE_RE.test(key) || seen.has(key)) continue;
    seen.add(key);
    pages.push({ key, edit: Boolean(p.edit) });
  }

  const existing = (await queryRead(`SELECT username FROM dbo.storefct_user WHERE username = @username`,
    { username: nv(username) }))[0];
  if (body.isNew && existing) throw bad(`มีชื่อผู้ใช้ "${username}" อยู่แล้ว`);
  if (!existing && !password) throw bad('ผู้ใช้ใหม่ต้องตั้งรหัสผ่าน');
  if (password) checkPassword(password);
  const hash = password ? await hashPassword(password) : null;

  await withTransaction(async (run) => {
    const params = {
      username: nv(username),
      name: nv(name || null, 150),
      isAdmin: { type: sql.Bit, value: isAdmin },
      isActive: { type: sql.Bit, value: isActive },
      hash: nv(hash, 255),
    };
    if (existing) {
      await run(
        `UPDATE dbo.storefct_user
            SET display_name = @name, is_admin = @isAdmin, is_active = @isActive,
                password_hash = COALESCE(@hash, password_hash), updated_at = SYSDATETIME()
          WHERE username = @username`,
        params
      );
    } else {
      await run(
        `INSERT dbo.storefct_user (username, password_hash, display_name, is_admin, is_active)
         VALUES (@username, @hash, @name, @isAdmin, @isActive)`,
        params
      );
    }
    // กันล็อกตัวเองออกทั้งระบบ — ต้องเหลือแอดมินที่ใช้งานได้อย่างน้อยหนึ่งคนเสมอ
    const admins = await run(`SELECT COUNT(*) AS n FROM dbo.storefct_user WHERE is_admin = 1 AND is_active = 1`);
    if (!(admins.recordset?.[0]?.n > 0)) throw bad('ต้องมีแอดมินที่เปิดใช้งานอยู่อย่างน้อยหนึ่งคน');
    await run(`DELETE dbo.storefct_user_page WHERE username = @username`, { username: nv(username) });
    for (const p of pages) {
      await run(
        `INSERT dbo.storefct_user_page (username, page_key, can_edit) VALUES (@username, @key, @edit)`,
        { username: nv(username), key: nv(p.key, 50), edit: { type: sql.Bit, value: p.edit } }
      );
    }
  });

  const { users, pages: pageRows } = await loadUsers(username);
  return { user: shape(users[0], pageRows) };
}

/** เปลี่ยนรหัสของตัวเอง — ต้องรู้รหัสเดิม */
async function storefctChangePassword(body) {
  const username = str(body.username);
  const { users } = await loadUsers(username);
  const row = users[0];
  if (!row || !row.is_active) throw bad('ไม่พบบัญชีนี้');
  const { ok } = await verifyPassword(String(body.oldPassword ?? ''), row.password_hash);
  if (!ok) throw bad('รหัสผ่านเดิมไม่ถูกต้อง');
  checkPassword(body.newPassword);
  await setPassword(row.username, String(body.newPassword));
  return { ok: true, message: 'เปลี่ยนรหัสผ่านแล้ว' };
}

export const STOREFCT_AUTH_ACTIONS = {
  storefctLogin,
  storefctGetUser,
  storefctListUsers,
  storefctSaveUser,
  storefctChangePassword,
};
