#!/usr/bin/env node
/**
 * ตั้งฐานข้อมูลของกล่องยูนิฟอร์ม (ปุ่มรูปเสื้อในหน้ารายชื่อพนักงาน) ให้เสร็จในคำสั่งเดียว
 *
 * สร้างตาราง dbo.UniformBranch จาก docs/schema-uniform.sql แล้วไล่ตรวจให้ครบทุกข้อที่ทำให้
 * กล่องยูนิฟอร์มใช้งานได้จริง — ไม่ต้องมี sqlcmd และไม่ต้องเปิด SSMS
 *   1) ต่อฐานข้อมูลได้ (ค่าใน .env ถูก) และต่อไปฐานไหน
 *   2) มีตาราง dbo.UniformBranch (ไม่มี = สร้างให้)
 *   3) คอลัมน์ครบตามที่ uniform.js อ้างถึง
 *   4) มีอินเด็กซ์ทั้งสองตัว (เปิดกล่องของพนักงาน + สรุปรายสาขาถึงจะไม่ช้า)
 *   5) login ที่เว็บใช้มีสิทธิ์ SELECT / INSERT / DELETE บนตารางนี้
 *   6) มีไอเทมรหัส 800000* ใน dbo.stock_item (ไม่มี = ช่องค้นหาในกล่องจะว่างเปล่า)
 *   7) มีตาราง dbo.stock_request (ปุ่ม "เบิกเข้าสาขา" ลงตารางเดียวกับใบเบิกของสต๊อก)
 *   8) ตอนนี้มีข้อมูลอยู่กี่แถว
 *
 * วิธีใช้ (รันจากโฟลเดอร์ office-server บนเครื่องที่ออฟฟิศ):
 *   node scripts/setup-uniform-db.mjs                      สร้างให้ (มีอยู่แล้วก็ข้าม) + ตรวจ
 *   node scripts/setup-uniform-db.mjs --check              ตรวจอย่างเดียว ไม่เขียนอะไรเลย
 *   node scripts/setup-uniform-db.mjs --user=sa --password='<รหัส sa>'
 *
 * ตัวเลือก
 *   --check              อ่านอย่างเดียว ไม่สร้าง/ไม่แก้อะไรในฐานข้อมูล
 *   --sync-items         ซิงก์ทะเบียนสินค้าจากชีท BOM ก่อนตรวจ (ใส่เมื่อไอเทม 800000* ยังไม่ขึ้น)
 *   --user= --password=  ใช้ login อื่นแทนค่าใน .env (ใส่ตอนที่ login ของเว็บสร้างตารางไม่ได้)
 *   --db=InventoryNarai  ฐานข้อมูลปลายทาง (ไม่ใส่ = STOCK_DB_NAME ใน .env หรือ InventoryNarai)
 *   --file=<path>        ไฟล์สคีมาที่จะรัน (ไม่ใส่ = docs/schema-uniform.sql ของ repo นี้)
 *
 * เรื่องสิทธิ์: login ของเว็บ (narai_web) มีแค่ db_datareader + db_datawriter จึง "สร้างตารางไม่ได้"
 * ถ้าขึ้นว่าไม่มีสิทธิ์สร้างตาราง ให้รันซ้ำด้วย --user=sa --password=... ครั้งเดียว
 * แล้วปล่อยให้ service ใช้ login เดิมต่อไปตามปกติ (ไม่ต้องแก้ .env)
 *
 * รันซ้ำได้ปลอดภัย: ทุกคำสั่งในสคีมาห่อด้วย IF NOT EXISTS อยู่แล้ว ข้อมูลที่บันทึกไว้ไม่ถูกแตะ
 */

import { config } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(here, '..', '.env') });

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const CHECK_ONLY = args.includes('--check');
const SYNC_ITEMS = args.includes('--sync-items');
const SQL_FILE = path.resolve(here, argVal('file', path.join('..', '..', 'docs', 'schema-uniform.sql')));

/* ทับค่า login/ฐานข้อมูลก่อน import hr-db.js — ไฟล์นั้นอ่าน env ตอนเรียกใช้ จึงทับทีนี่ได้
   ประโยชน์คือรันด้วย sa ได้ครั้งเดียวโดยไม่ต้องไปแก้ .env ที่ service ใช้อยู่ */
const OVERRIDE_USER = argVal('user', '');
const OVERRIDE_PASS = argVal('password', '');
if (OVERRIDE_USER) process.env.HR_DB_USER = OVERRIDE_USER;
if (OVERRIDE_PASS) process.env.HR_DB_PASSWORD = OVERRIDE_PASS;
const OVERRIDE_DB = argVal('db', '');
if (OVERRIDE_DB) process.env.STOCK_DB_NAME = OVERRIDE_DB;

const { stockDb, sql, isConfigured, describeDbError } = await import('../hr-db.js');

if (!isConfigured()) {
  console.error('ยังไม่ได้ตั้ง HR_DB_USER / HR_DB_PASSWORD ใน .env ของ office-server');
  console.error('(หรือส่งมาทางคำสั่งก็ได้: --user=sa --password=...)');
  process.exit(1);
}

const TABLE = 'dbo.UniformBranch';

/* คอลัมน์ที่โค้ดใน uniform.js อ้างถึงจริง — ไว้จับกรณีตารางถูกสร้างไว้ตั้งแต่เวอร์ชันก่อน
   แล้วขาดคอลัมน์ที่เพิ่มมาทีหลัง (เช่น size) ซึ่งจะพังตอนกดบันทึก ไม่ใช่ตอนเปิดกล่อง */
const EXPECTED_COLUMNS = [
  'uniform_id', 'branch', 'hr_code', 'emp_name', 'item_key', 'item_code', 'item_name',
  'unit', 'size', 'qty', 'note', 'issued_at', 'saved_at', 'saved_by',
];
const EXPECTED_INDEXES = ['IX_UniformBranch_emp', 'IX_UniformBranch_branch_date'];

const yes = (ok) => (ok ? '✅' : '❌');
const warn = '⚠️ ';
const line = () => console.log('─'.repeat(72));

/** นับข้อที่ยังไม่ผ่าน แล้วพิมพ์วิธีแก้ของข้อนั้นต่อท้ายทันที ไม่ต้องไปสรุปรวมท้ายไฟล์ */
let problems = 0;
const fail = (how) => {
  problems += 1;
  console.log(`   ${how}`);
};

/** แยกไฟล์สคีมาเป็นก้อนตาม GO เหมือนที่ sqlcmd ทำ และตัด USE ออก
   (ตัด USE เพราะ pool ต่อฐานข้อมูลที่ต้องการไว้แล้ว ถ้าปล่อยไว้ --db= จะไม่มีผล) */
function sqlBatches(text) {
  return text
    .split(/^\s*GO\s*;?\s*$/gim)
    .map((b) => b.replace(/^\s*USE\s+[^;]+;?\s*$/gim, '').trim())
    .filter((b) => b.length > 0);
}

async function main() {
  console.log('ตั้งฐานข้อมูลกล่องยูนิฟอร์ม (ปุ่มรูปเสื้อในหน้ารายชื่อพนักงาน)');
  line();

  /* ---------- 0. ซิงก์ทะเบียนสินค้า (เฉพาะเมื่อสั่ง) ----------
     ตัวเดียวกับรอบอัตโนมัติทุกชั่วโมงของ service และ action syncItemRegistry ในหน้าเว็บ
     ใส่ไว้ที่นี่เพราะไอเทม 800000* ที่จัดซื้อเพิ่งเพิ่มในชีท จะยังไม่ขึ้นในกล่องจนกว่าจะซิงก์ */
  if (SYNC_ITEMS) {
    if (CHECK_ONLY) {
      console.log('0) --sync-items ใช้กับ --check ไม่ได้ (อันหนึ่งเขียน อันหนึ่งอ่านอย่างเดียว) — ข้ามการซิงก์');
    } else {
      const { syncItemsFromSheet } = await import('../item-sync.js');
      const r = await syncItemsFromSheet();
      console.log(`0) ซิงก์ทะเบียนสินค้าจากชีท   ${r?.message || 'เรียบร้อย'}`);
    }
    line();
  }

  /* ---------- 1. ต่อฐานข้อมูล ---------- */
  const pool = await stockDb.getPool();
  const [where] = await stockDb.queryRead(
    `SELECT DB_NAME() AS db, @@SERVERNAME AS server, SUSER_SNAME() AS login_name`
  );
  console.log(`1) ต่อฐานข้อมูลได้           ${yes(true)}`);
  console.log(`   เครื่อง: ${where.server}   ฐานข้อมูล: ${where.db}   login: ${where.login_name}`);

  /* ---------- 2. ตาราง ---------- */
  const exists = async () =>
    Boolean((await stockDb.queryRead(`SELECT OBJECT_ID(N'${TABLE}', N'U') AS id`))[0]?.id);

  let hasTable = await exists();
  if (!hasTable && CHECK_ONLY) {
    console.log(`2) ตาราง ${TABLE}   ${yes(false)} ยังไม่มี`);
    fail('โหมด --check ไม่สร้างให้ — รันซ้ำโดยไม่ใส่ --check');
  } else if (!hasTable) {
    if (!fs.existsSync(SQL_FILE)) {
      console.log(`2) ตาราง ${TABLE}   ${yes(false)} ยังไม่มี`);
      fail(`หาไฟล์สคีมาไม่เจอ: ${SQL_FILE} (ระบุเองด้วย --file=)`);
    } else {
      console.log(`2) ตาราง ${TABLE}   ยังไม่มี — กำลังสร้างจาก ${path.relative(process.cwd(), SQL_FILE)}`);
      const batches = sqlBatches(fs.readFileSync(SQL_FILE, 'utf8'));
      for (const [i, batch] of batches.entries()) {
        try {
          await pool.request().batch(batch);
        } catch (err) {
          console.log(`   ${yes(false)} ก้อนคำสั่งที่ ${i + 1} ไม่ผ่าน: ${err.message}`);
          if (/CREATE TABLE permission denied|permission was denied/i.test(err.message)) {
            console.log(`   ${warn}login "${where.login_name}" สร้างตารางไม่ได้ (มีแค่สิทธิ์อ่าน-เขียน)`);
            console.log('      รันซ้ำครั้งเดียวด้วย: node scripts/setup-uniform-db.mjs --user=sa --password=\'<รหัส sa>\'');
          }
          throw err;
        }
      }
      hasTable = await exists();
      console.log(`   ${yes(hasTable)} สร้างตารางเรียบร้อย (${batches.length} ก้อนคำสั่ง)`);
    }
  } else {
    console.log(`2) ตาราง ${TABLE}   ${yes(true)} มีอยู่แล้ว (ไม่แตะข้อมูลเดิม)`);
  }

  if (!hasTable) {
    line();
    console.log('ยังไม่มีตาราง จึงตรวจข้ออื่นต่อไม่ได้');
    return;
  }

  /* ---------- 3. คอลัมน์ ---------- */
  const cols = await stockDb.queryRead(
    `SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(N'${TABLE}')`
  );
  const colNames = cols.map((c) => String(c.name));
  const missingCols = EXPECTED_COLUMNS.filter((c) => !colNames.includes(c));
  console.log(`3) คอลัมน์ครบ               ${yes(missingCols.length === 0)} มี ${colNames.length} คอลัมน์`);
  if (missingCols.length) {
    fail(`ขาด: ${missingCols.join(', ')} — เทียบกับ docs/schema-uniform.sql แล้ว ALTER TABLE เพิ่มเอง`);
  }

  /* ---------- 4. อินเด็กซ์ ---------- */
  const idx = await stockDb.queryRead(
    `SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID(N'${TABLE}') AND name IS NOT NULL`
  );
  const idxNames = idx.map((r) => String(r.name));
  const missingIdx = EXPECTED_INDEXES.filter((n) => !idxNames.includes(n));
  console.log(`4) อินเด็กซ์                 ${yes(missingIdx.length === 0)} ${idxNames.join(', ') || '(ไม่มี)'}`);
  if (missingIdx.length) {
    fail(`ขาด: ${missingIdx.join(', ')} — รันสคริปต์นี้ซ้ำโดยไม่ใส่ --check จะสร้างให้`);
  }

  /* ---------- 5. สิทธิ์ของ login ที่เว็บใช้ ----------
     เตือนเฉพาะกรณีที่รันด้วย login ของเว็บจริงๆ — ถ้ารันด้วย sa ผลที่ได้ไม่ได้บอกอะไรเกี่ยวกับ
     login ของเว็บเลย (sa ผ่านทุกข้ออยู่แล้ว) จึงบอกให้ตรวจซ้ำแทนที่จะขึ้น ✅ ให้หลงเข้าใจผิด */
  const [perm] = await stockDb.queryRead(
    `SELECT HAS_PERMS_BY_NAME(N'${TABLE}', N'OBJECT', N'SELECT') AS can_select,
            HAS_PERMS_BY_NAME(N'${TABLE}', N'OBJECT', N'INSERT') AS can_insert,
            HAS_PERMS_BY_NAME(N'${TABLE}', N'OBJECT', N'DELETE') AS can_delete`
  );
  const canAll = Number(perm.can_select) === 1 && Number(perm.can_insert) === 1 && Number(perm.can_delete) === 1;
  const webLogin = String(process.env.HR_DB_USER || '');
  const ranAsWebLogin = !OVERRIDE_USER || OVERRIDE_USER === webLogin;
  console.log(`5) สิทธิ์อ่าน/เขียน/ลบ        ${yes(canAll)} (login: ${where.login_name})`);
  if (!canAll) {
    fail('ให้สิทธิ์ด้วย: ALTER ROLE db_datareader ADD MEMBER <login>; ALTER ROLE db_datawriter ADD MEMBER <login>;');
  } else if (!ranAsWebLogin) {
    console.log(`   ${warn}รันด้วย login อื่น (${where.login_name}) ไม่ใช่ตัวที่ service ใช้`);
    console.log('      ตรวจของ service ซ้ำด้วย: node scripts/setup-uniform-db.mjs --check');
  }

  /* ---------- 6. ทะเบียนไอเทม 800000* ----------
     กล่องยูนิฟอร์มไม่ได้มีทะเบียนไอเทมของตัวเอง อ่านจาก dbo.stock_item ที่ซิงก์มาจากชีท BOM
     ถ้าไม่มีรหัสขึ้นต้น 800000 เลย ตารางจะพร้อมแต่ช่องค้นหาในกล่องจะว่าง (คนใช้จะแจ้งว่า "หาไม่เจอ") */
  const hasStockItem = Boolean(
    (await stockDb.queryRead(`SELECT OBJECT_ID(N'dbo.stock_item', N'U') AS id`))[0]?.id
  );
  if (!hasStockItem) {
    console.log(`6) ไอเทมยูนิฟอร์ม 800000*    ${yes(false)} ไม่มีตาราง dbo.stock_item`);
    fail('รัน docs/schema-stock.sql ก่อน (กล่องยูนิฟอร์มอ่านทะเบียนไอเทมจากตารางนั้น)');
  } else {
    const items = await stockDb.queryRead(
      `SELECT COUNT(*) AS n
         FROM dbo.stock_item
        WHERE item_code LIKE @prefix + '%' AND ISNULL(status, N'') <> N'ปิดการใช้งาน'`,
      { prefix: { type: sql.NVarChar(20), value: '800000' } }
    );
    const n = Number(items[0]?.n || 0);
    console.log(`6) ไอเทมยูนิฟอร์ม 800000*    ${yes(n > 0)} ${n} รายการใน dbo.stock_item`);
    if (n === 0) {
      fail('ยังไม่มีไอเทมรหัส 800000* — เพิ่มในชีท BOM แท็บ item ก่อน แล้วสั่งซิงก์ด้วย --sync-items');
    }
  }

  /* ---------- 7. ปุ่ม "เบิกเข้าสาขา" ---------- */
  const hasRequest = Boolean(
    (await stockDb.queryRead(`SELECT OBJECT_ID(N'dbo.stock_request', N'U') AS id`))[0]?.id
  );
  console.log(`7) ตาราง dbo.stock_request   ${yes(hasRequest)} (ปุ่ม "เบิกเข้าสาขา" ลงตารางนี้)`);
  if (!hasRequest) fail('รัน docs/schema-stock.sql — ปุ่มเบิกใช้ใบเบิกชุดเดียวกับหน้านับสต๊อก');

  /* ---------- 8. ข้อมูลที่มีอยู่ ---------- */
  const [count] = await stockDb.queryRead(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT hr_code) AS emps,
            CONVERT(NVARCHAR(19), MAX(issued_at), 120) AS last_issued
       FROM ${TABLE}`
  );
  console.log(`8) ข้อมูลในตารางตอนนี้        ${Number(count.n)} แถว / พนักงาน ${Number(count.emps)} คน` +
    (count.last_issued ? ` / จ่ายล่าสุด ${count.last_issued}` : ''));

  line();
  if (problems === 0) {
    console.log('พร้อมใช้งานครบทุกข้อ ✅');
    console.log('ไม่ต้องรีสตาร์ท service (ไม่ได้แก้โค้ด) — เปิดหน้ารายชื่อพนักงานแล้วกดปุ่มรูปเสื้อได้เลย');
  } else {
    console.log(`ยังมี ${problems} ข้อที่ต้องแก้ (ดูวิธีแก้ใต้ข้อที่ขึ้น ❌ ข้างบน)`);
    console.log('รายละเอียดเพิ่มเติม: docs/uniform-sql-migration.md');
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('');
  console.error(`ทำไม่สำเร็จ: ${describeDbError(err)}`);
  process.exitCode = 1;
} finally {
  try {
    const pool = await stockDb.getPool();
    await pool.close();
  } catch {
    // ปิด pool ไม่ได้ก็ไม่เป็นไร สคริปต์จบอยู่แล้ว
  }
}
