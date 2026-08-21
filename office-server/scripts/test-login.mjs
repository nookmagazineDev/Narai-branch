#!/usr/bin/env node
/**
 * ทดสอบว่า "ล็อกอินแล้วตรวจกับตาราง hr_user จริงไหม" — ครบวงจรในคำสั่งเดียว
 *
 * ยิงเข้า office-server เหมือนที่หน้าเว็บทำ แล้วไปอ่านตาราง hr_user ใน SQL Server ตรงๆ
 * เพื่อยืนยันสองเรื่องที่ API บอกเองไม่ได้
 *   1) ผู้ใช้ถูกเก็บลงตารางจริง
 *   2) รหัสผ่านในตาราง "ไม่ใช่รหัสจริง" (ต้องขึ้นต้นด้วย scrypt$ และหารหัสจริงไม่เจอ)
 *
 * วิธีใช้ (รันจากโฟลเดอร์ office-server บนเครื่องที่ออฟฟิศ):
 *   node scripts/test-login.mjs
 *
 * ตัวเลือก
 *   --base=http://localhost:8787   ที่อยู่ office-server (ค่าเริ่มต้นนี้)
 *   --keep                         ไม่ต้องลบผู้ใช้ทดสอบทิ้งตอนจบ
 *
 * ใช้ผู้ใช้ปลอมชื่อ zztest_login ที่สคริปต์ใส่ลงตารางเอง แล้วลบทิ้งเมื่อจบ
 * จึงไม่แตะผู้ใช้จริงของสาขาไหน และไม่ไปรบกวนชีทเดิมเลย
 */

import { config } from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';
import { hashPassword } from '../hr-password.js';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(here, '..', '.env') });

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = argVal('base', 'http://localhost:8787').replace(/\/+$/, '');
const KEEP = args.includes('--keep');

/* ค่าทดสอบ — จงใจให้ดูออกชัดว่าเป็นของปลอม */
const USERNAME = 'zztest_login';
const PASSWORD = 'ZzTest-รหัสทดสอบ-9931';
const BRANCH = 'ZZTEST';
const OUTLET = '999';

const ok = (msg) => console.log(`  [ผ่าน] ${msg}`);
const bad = (msg) => { console.log(`  [ไม่ผ่าน] ${msg}`); process.exitCode = 1; };

/* ล็อกอินไม่ต้องแนบ _user (ยังไม่มีเซสชัน) ต่างจาก action อื่นทั้งหมด */
async function callLogin(username, password) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.API_TOKEN) headers['x-api-token'] = process.env.API_TOKEN;
  const res = await fetch(`${BASE}/schedule`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'login', username, password }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`office-server ตอบกลับมาไม่ใช่ JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, body };
}

/* ต่อฐานข้อมูลตรงๆ ด้วยค่าชุดเดียวกับที่ office-server ใช้ — ไม่ผ่าน API เพื่อดูของจริงในตาราง */
function dbConfig() {
  return {
    server: process.env.HR_DB_HOST || 'localhost',
    database: process.env.HR_DB_NAME || 'narai_hr',
    user: process.env.HR_DB_USER || '',
    password: process.env.HR_DB_PASSWORD || '',
    options: {
      encrypt: false,
      trustServerCertificate: true,
      ...(process.env.HR_DB_INSTANCE ? { instanceName: process.env.HR_DB_INSTANCE } : {}),
    },
    ...(process.env.HR_DB_PORT ? { port: Number(process.env.HR_DB_PORT) } : { port: 1433 }),
    connectionTimeout: 15000,
  };
}

const readUser = (pool) =>
  pool.request().input('u', sql.NVarChar(100), USERNAME)
    .query('SELECT username, password_hash, branch, outlet_id, is_active, last_login_at FROM dbo.hr_user WHERE username = @u')
    .then((r) => r.recordset[0] || null);

async function main() {
  console.log(`ทดสอบผ่าน ${BASE}/schedule`);
  console.log(`ผู้ใช้ทดสอบ: ${USERNAME} / สาขา ${BRANCH}\n`);

  if (!process.env.HR_DB_USER || !process.env.HR_DB_PASSWORD) {
    console.error('ยังไม่ได้ตั้ง HR_DB_USER / HR_DB_PASSWORD ใน .env ของ office-server');
    process.exitCode = 1;
    return;
  }

  let pool;
  try {
    pool = await new sql.ConnectionPool(dbConfig()).connect();

    /* 0) เตรียมผู้ใช้ทดสอบลงตารางเอง — ไม่พึ่งชีท เพื่อให้เทสไม่ไปแตะข้อมูลจริง */
    console.log('0. เตรียมผู้ใช้ทดสอบใน hr_user');
    const hash = await hashPassword(PASSWORD);
    await pool.request()
      .input('u', sql.NVarChar(100), USERNAME)
      .input('h', sql.NVarChar(255), hash)
      .input('b', sql.NVarChar(50), BRANCH)
      .input('o', sql.NVarChar(50), OUTLET)
      .query(`MERGE dbo.hr_user WITH (HOLDLOCK) AS t USING (SELECT @u AS username) AS s ON t.username = s.username
              WHEN MATCHED THEN UPDATE SET password_hash = @h, branch = @b, outlet_id = @o, is_active = 1
              WHEN NOT MATCHED THEN INSERT (username, password_hash, branch, outlet_id) VALUES (@u, @h, @b, @o);`);
    ok('ใส่ผู้ใช้ทดสอบแล้ว');

    /* 1) รหัสถูก -> ต้องผ่าน และได้สาขา/outlet กลับมาครบ */
    console.log('\n1. ล็อกอินด้วยรหัสที่ถูกต้อง');
    const good = await callLogin(USERNAME, PASSWORD);
    if (good.status === 200 && good.body.status === 'success') {
      const d = good.body.data || {};
      ok(`เข้าได้ — สาขา ${d.branch} / outlet ${d.outletId}`);
      if (d.branch !== BRANCH) bad(`สาขาที่ตอบกลับไม่ตรง (ได้ ${d.branch} ควรเป็น ${BRANCH})`);
      if (String(d.outletId) !== OUTLET) bad(`outlet ที่ตอบกลับไม่ตรง (ได้ ${d.outletId} ควรเป็น ${OUTLET})`);
    } else {
      bad(`เข้าไม่ได้ทั้งที่รหัสถูก (HTTP ${good.status}): ${good.body.message}`);
    }

    /* 2) รหัสผิด -> ต้องไม่ผ่าน */
    console.log('\n2. ล็อกอินด้วยรหัสผิด');
    const wrong = await callLogin(USERNAME, 'รหัสผิดแน่ๆ-0000');
    if (wrong.body.status === 'success') bad('รหัสผิดแต่เข้าได้ — อันตราย');
    else ok(`ถูกปฏิเสธตามที่ควร: ${wrong.body.message}`);

    /* 3) ชื่อผู้ใช้ที่ไม่มีอยู่ -> ต้องได้ข้อความเดียวกับรหัสผิด (ไม่บอกใบ้ว่าชื่อไหนมีจริง) */
    console.log('\n3. ล็อกอินด้วยชื่อผู้ใช้ที่ไม่มีอยู่');
    const nobody = await callLogin('zztest_ไม่มีคนนี้', 'อะไรก็ได้-0000');
    if (nobody.body.status === 'success') bad('ชื่อผู้ใช้ที่ไม่มีอยู่กลับเข้าได้ — อันตราย');
    else if (nobody.body.message === wrong.body.message) ok('ได้ข้อความเดียวกับรหัสผิด (ไม่บอกใบ้ว่าชื่อไหนมีจริง)');
    else bad(`ข้อความต่างกัน จะเดาได้ว่าชื่อไหนมีจริง: "${nobody.body.message}" vs "${wrong.body.message}"`);

    /* 4) ของจริงในตาราง — ข้อที่ API บอกเองไม่ได้ */
    console.log('\n4. อ่านจากตาราง hr_user ตรงๆ');
    const row = await readUser(pool);
    if (!row) {
      bad('ไม่พบผู้ใช้ทดสอบในตาราง');
    } else {
      if (row.password_hash.startsWith('scrypt$')) ok('รหัสในตารางถูกเข้ารหัสไว้ (scrypt$...)');
      else bad(`รหัสในตารางไม่ได้เข้ารหัส: ${row.password_hash.slice(0, 40)}`);

      if (row.password_hash.includes(PASSWORD)) bad('พบรหัสจริงอยู่ในค่าที่เก็บ — ห้ามเด็ดขาด');
      else ok('หารหัสจริงในค่าที่เก็บไม่เจอ');

      if (row.last_login_at) ok(`บันทึกเวลาล็อกอินล่าสุดแล้ว (${row.last_login_at.toISOString()})`);
      else bad('ไม่ได้บันทึก last_login_at');
    }

    /* 5) ปิดบัญชีแล้วต้องเข้าไม่ได้ */
    console.log('\n5. ปิดบัญชี (is_active = 0) แล้วลองเข้าอีกครั้ง');
    await pool.request().input('u', sql.NVarChar(100), USERNAME)
      .query('UPDATE dbo.hr_user SET is_active = 0 WHERE username = @u');
    const disabled = await callLogin(USERNAME, PASSWORD);
    if (disabled.body.status === 'success') bad('บัญชีถูกปิดแล้วแต่ยังเข้าได้');
    else ok(`ถูกปฏิเสธตามที่ควร: ${disabled.body.message}`);
  } catch (err) {
    bad(err.message);
  } finally {
    if (pool) {
      if (!KEEP) {
        await pool.request().input('u', sql.NVarChar(100), USERNAME)
          .query('DELETE FROM dbo.hr_user WHERE username = @u')
          .then(() => console.log('\nลบผู้ใช้ทดสอบทิ้งแล้ว'))
          .catch((e) => console.log(`\nลบผู้ใช้ทดสอบไม่สำเร็จ: ${e.message} (ลบเองด้วย: DELETE FROM dbo.hr_user WHERE username = N'${USERNAME}')`));
      } else {
        console.log(`\nเก็บผู้ใช้ทดสอบไว้ตามที่สั่ง (--keep) ลบเองด้วย: DELETE FROM dbo.hr_user WHERE username = N'${USERNAME}'`);
      }
      await pool.close();
    }
    console.log(process.exitCode ? '\nมีข้อที่ไม่ผ่าน — ดูรายละเอียดด้านบน' : '\nผ่านทั้งหมด');
  }
}

main();
