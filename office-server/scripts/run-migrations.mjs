#!/usr/bin/env node
/**
 * รันไฟล์ .sql ทุกไฟล์ใน office-server/sql/ ลงฐาน InventoryNarai ตามลำดับชื่อไฟล์
 *
 *   node scripts/run-migrations.mjs          (รันจากโฟลเดอร์ office-server)
 *
 * ใช้ login เดียวกับที่ service ใช้อยู่ (HR_DB_USER / HR_DB_PASSWORD ใน office-server/.env)
 * คนที่อัปเดตเครื่องจึงไม่ต้องรู้รหัส sa — เรียกผ่าน update-office-server.bat
 *
 * ทุกไฟล์ใน sql/ ต้องรันซ้ำได้ (เช็คก่อนสร้าง/ลบทุกครั้ง) เพราะตัวรันไม่ได้จดว่าไฟล์ไหนรันไปแล้ว
 * รันทุกไฟล์ทุกครั้งที่อัปเดต — ไฟล์ที่รันไปแล้วจะไม่มีอะไรเกิดขึ้น
 *
 * ตัดคำสั่งเป็นชุดตามบรรทัด GO เหมือน sqlcmd แต่ละไฟล์รันใน transaction เดียว (คอนเนกชันเดียว)
 * เพราะ SET NOEXEC / SET QUOTED_IDENTIFIER ติดอยู่กับคอนเนกชัน ถ้าคนละเส้นตัวกันจะหลุดเงียบ ๆ
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import sql from 'mssql';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// โหลด .env ของ office-server เสมอ ไม่ว่าจะรันจากโฟลเดอร์ไหน
dotenv.config({ path: join(serverDir, '.env') });

const { isConfigured, stockDb, describeDbError } = await import('../hr-db.js');

if (!isConfigured()) {
  console.error('❌ ไม่พบ HR_DB_USER / HR_DB_PASSWORD ใน office-server\\.env — ตั้งค่าเหมือนตอนติดตั้ง service ก่อน');
  process.exit(1);
}

const splitBatches = (text) => text
  .split(/^\s*GO\s*;?\s*$/gim)
  .map((b) => b.trim())
  .filter(Boolean);

const sqlDir = join(serverDir, 'sql');
const files = readdirSync(sqlDir).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
if (files.length === 0) {
  console.log('ไม่มีไฟล์ใน sql/ — ไม่มีอะไรต้องทำ');
  process.exit(0);
}

let pool;
try {
  pool = await stockDb.getPool();
} catch (err) {
  console.error(`❌ ต่อฐานข้อมูลไม่ได้: ${describeDbError(err)}`);
  process.exit(1);
}

/**
 * รันหนึ่งไฟล์ใน transaction เดียว — ทุกชุดคำสั่งอยู่บนคอนเนกชันเดียวกัน (SET ต่าง ๆ จึงไม่หลุด)
 * และถ้าชุดไหนพัง ย้อนทั้งไฟล์ ไม่เหลือฐานครึ่ง ๆ กลาง ๆ (DDL ของ SQL Server ย้อนใน transaction ได้)
 */
async function runFile(file) {
  const batches = splitBatches(readFileSync(join(sqlDir, file), 'utf8'));
  console.log(`  ${file} (${batches.length} ชุดคำสั่ง)`);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    for (const [i, batch] of batches.entries()) {
      const req = new sql.Request(tx);
      req.on('info', (m) => console.log(`    ${m.message}`));
      try {
        await req.batch(batch);
      } catch (err) {
        err.batchNo = i + 1;
        throw err;
      }
    }
    await tx.commit();
  } catch (err) {
    try { await tx.rollback(); } catch { /* transaction ตายไปพร้อม error แล้ว */ }
    throw err;
  }
}

let failed = false;
for (const file of files) {
  try {
    await runFile(file);
  } catch (err) {
    console.error(`\n❌ ${file} ชุดที่ ${err.batchNo ?? '?'} ล้มเหลว (ย้อนทั้งไฟล์แล้ว): ${err.message}`);
    if (/permission|denied/i.test(err.message)) {
      console.error('   login ใน .env ไม่มีสิทธิ์แก้โครงสร้างตาราง — ให้คนที่มีรหัส sa เปิดไฟล์นี้ใน SSMS แล้วกด Execute แทน');
    }
    failed = true;
    break;
  }
}

await pool.close();
if (failed) process.exit(1);
console.log('  ✓ ฐานข้อมูลเป็นรุ่นล่าสุดแล้ว');
