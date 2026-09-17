#!/usr/bin/env node
/**
 * ตรวจว่า "ค่าที่แอดมิน (สิทธิ์ all) แก้ให้สาขา ไปถึงหน้าสาขาจริงไหม" — ครบวงจรในคำสั่งเดียว
 *
 * ยิงเข้า office-server เหมือนที่หน้าเว็บทำ แล้วไปอ่านจากตารางใน SQL Server ตรงๆ
 * เพื่อยืนยันว่าแถวลงจริงและเหลือแถวเดียว ไม่ใช่แค่ API ตอบว่าสำเร็จ
 *
 * ทดสอบสามอย่างที่เคยพลาด
 *   1. จำนวนหัวลูกค้าของสาขาปกติ  — บันทึกแล้วสาขาอ่านได้ค่าเดิมเป๊ะ (กันการแก้พลาดพฤติกรรมเดิม)
 *   2. จำนวนหัวลูกค้าของสาขาสองรหัส (zjp/sjp) — บันทึกใต้รหัสที่ดรอปดาวน์แอดมินให้มา แล้วสาขา
 *      ที่ล็อกอินด้วยอีกรหัสต้องเห็นค่าใหม่ ไม่ใช่ค่าเก่าที่ค้างอยู่ใต้รหัสพี่น้อง
 *   3. หมวดจัดเก็บของสาขาสองรหัส — แก้ใต้รหัสหนึ่ง อีกรหัสต้องเห็น และต้องเหลือแถวเดียว
 *
 * วิธีใช้ (รันจากโฟลเดอร์ office-server บนเครื่องที่ออฟฟิศ):
 *   node scripts/test-covers.mjs
 *
 * ตัวเลือก
 *   --base=http://localhost:8787   ที่อยู่ office-server (ค่าเริ่มต้นนี้)
 *   --branch=zbw                   พิมพ์จำนวนหัวที่บันทึกไว้ของสาขานี้ด้วย (อ่านอย่างเดียว)
 *   --keep                         ไม่ต้องลบข้อมูลทดสอบทิ้งตอนจบ (ไว้เข้าไปดูเองใน SSMS)
 *
 * ความปลอดภัยของข้อมูลจริง: เขียนเฉพาะวันที่ 2099-12-31 (วันปลอม) และหมวดจัดเก็บของสินค้า
 * ที่ "ยังไม่มีใครตั้งหมวดไว้" เท่านั้น แล้วลบทิ้งเมื่อจบ จึงไม่ทับข้อมูลที่สาขาใช้งานอยู่
 */

import { config } from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(here, '..', '.env') });

const { sql, stockDb } = await import('../hr-db.js');
const { queryRead } = stockDb;

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = argVal('base', 'http://localhost:8787').replace(/\/+$/, '');
const READ_BRANCH = argVal('branch', '');
const KEEP = args.includes('--keep');

const TEST_DATE = '2099-12-31';   // วันปลอม ไม่มีทางชนกับวันที่สาขาใช้จริง
const TEST_BRANCH = 'zztest';     // สาขาปลอมสำหรับเทสต์ข้อ 1
const TEST_CAT = 'ZZTEST-หมวดทดสอบ';

let failed = 0;
const ok = (msg) => console.log(`  [ผ่าน] ${msg}`);
const bad = (msg) => { failed++; console.log(`  [ไม่ผ่าน] ${msg}`); };
const check = (cond, msg, detail) => (cond ? ok(msg) : bad(`${msg} — ${detail}`));

/** เรียก action เหมือนหน้าเว็บ โดยสวมรอยเป็น user ที่ต้องการ (สิทธิ์ all หรือสาขา) */
async function callApi(payload, user) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.API_TOKEN) headers['x-api-token'] = process.env.API_TOKEN;
  const res = await fetch(`${BASE}/schedule`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, _user: user }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`office-server ตอบกลับมาไม่ใช่ JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || body.status !== 'success') {
    throw new Error(`${payload.action} ไม่สำเร็จ (HTTP ${res.status}): ${body.message || text.slice(0, 200)}`);
  }
  return body.data;
}

const ADMIN = { username: 'ทดสอบระบบ', branch: 'all' };
const asBranch = (b) => ({ username: `ทดสอบสาขา-${b}`, branch: b });

/** แถวจำนวนหัวของวันทดสอบ ในทุกรหัสที่ให้มา — อ่านจากตารางตรงๆ ไม่ผ่าน API */
const percentRows = (branches) => queryRead(
  `SELECT branch, percent_value, qty_259, qty_359 FROM dbo.stock_branch_percent
    WHERE percent_date = CONVERT(DATE, @d, 120) AND branch IN (${branches.map((_, i) => `@b${i}`).join(', ')})
    ORDER BY branch`,
  {
    d: { type: sql.NVarChar(10), value: TEST_DATE },
    ...Object.fromEntries(branches.map((b, i) => [`b${i}`, { type: sql.NVarChar(50), value: b }])),
  }
);

const deletePercent = (branches) => queryRead(
  `DELETE FROM dbo.stock_branch_percent
    WHERE percent_date = CONVERT(DATE, @d, 120) AND branch IN (${branches.map((_, i) => `@b${i}`).join(', ')})`,
  {
    d: { type: sql.NVarChar(10), value: TEST_DATE },
    ...Object.fromEntries(branches.map((b, i) => [`b${i}`, { type: sql.NVarChar(50), value: b }])),
  }
);

const coversOf = (rows, date) => {
  const hit = (rows || []).find((r) => r.date === date);
  return hit ? Number(hit.percent) : undefined;
};

/* ---------- 1) สาขาปกติ: บันทึกแล้วสาขาอ่านได้ค่าเดิม (พฤติกรรมเดิมต้องไม่เปลี่ยน) ---------- */
async function testPlainBranch() {
  console.log(`\n1) สาขารหัสเดียว (${TEST_BRANCH}) — บันทึกจำนวนหัวแล้วสาขาต้องอ่านได้ค่าเดิม`);
  await deletePercent([TEST_BRANCH]);

  await callApi({ action: 'saveBranchPercentagesBulk', branch: TEST_BRANCH, updates: [{ date: TEST_DATE, percent: 150 }] }, ADMIN);

  const rows = await percentRows([TEST_BRANCH]);
  check(rows.length === 1, 'มีแถวเดียวในฐานข้อมูล', `เจอ ${rows.length} แถว`);
  check(Number(rows[0]?.percent_value) === 150, 'ค่าที่บันทึกคือ 150', `เจอ ${rows[0]?.percent_value}`);

  const asStore = await callApi({ action: 'getBranchPercent', branch: TEST_BRANCH }, asBranch(TEST_BRANCH));
  check(coversOf(asStore.data, TEST_DATE) === 150, 'หน้าสาขาอ่านได้ 150', `ได้ ${coversOf(asStore.data, TEST_DATE)}`);

  // ส่ง 0 = สั่งลบวันนั้น (กติกาเดิม) — ต้องหายจริง
  await callApi({ action: 'saveBranchPercentagesBulk', branch: TEST_BRANCH, updates: [{ date: TEST_DATE, percent: 0 }] }, ADMIN);
  const after = await percentRows([TEST_BRANCH]);
  check(after.length === 0, 'ส่งค่า 0 แล้วแถวถูกลบ', `ยังเหลือ ${after.length} แถว`);
}

/* ---------- 2) สาขาสองรหัส: ค่าเก่าใต้รหัสพี่น้องต้องไม่กลบค่าใหม่ ---------- */
async function testAliasBranch() {
  console.log('\n2) สาขาสองรหัส (zjp/sjp) — แอดมินบันทึกใต้ sjp แล้วคนล็อกอิน zjp ต้องเห็นค่าใหม่');
  await deletePercent(['zjp', 'sjp']);

  // จำลองสถานะจริง: มีค่าเก่าค้างอยู่ใต้ zjp (สาขาเคยกรอกเองตอนที่ยังแก้ได้)
  await queryRead(
    `INSERT INTO dbo.stock_branch_percent (percent_date, branch, percent_value)
     VALUES (CONVERT(DATE, @d, 120), N'zjp', 111)`,
    { d: { type: sql.NVarChar(10), value: TEST_DATE } }
  );

  // แอดมินเลือกสาขาจากดรอปดาวน์ (ได้ sjp มา) แล้วบันทึกค่าใหม่
  await callApi({ action: 'saveBranchPercentagesBulk', branch: 'sjp', updates: [{ date: TEST_DATE, percent: 222 }] }, ADMIN);

  const rows = await percentRows(['zjp', 'sjp']);
  check(rows.length === 1, 'เหลือแถวเดียวในกลุ่ม (ไม่มีค่าเก่าค้างใต้รหัสพี่น้อง)',
    `เจอ ${rows.length} แถว: ${rows.map((r) => `${r.branch}=${r.percent_value}`).join(', ')}`);
  check(Number(rows[0]?.percent_value) === 222, 'ค่าที่เหลือคือ 222 (ของใหม่)', `เจอ ${rows[0]?.percent_value}`);

  const asZjp = await callApi({ action: 'getBranchPercent', branch: 'zjp' }, asBranch('zjp'));
  check(coversOf(asZjp.data, TEST_DATE) === 222, 'คนล็อกอิน zjp อ่านได้ 222', `ได้ ${coversOf(asZjp.data, TEST_DATE)}`);

  const asSjp = await callApi({ action: 'getBranchPercent', branch: 'sjp' }, asBranch('sjp'));
  check(coversOf(asSjp.data, TEST_DATE) === 222, 'คนล็อกอิน sjp อ่านได้ 222', `ได้ ${coversOf(asSjp.data, TEST_DATE)}`);

  if (!KEEP) await deletePercent(['zjp', 'sjp']);
}

/* ---------- 3) หมวดจัดเก็บของสาขาสองรหัส ---------- */
async function testStorageCategory() {
  console.log('\n3) หมวดจัดเก็บ (zjp/sjp) — แก้ใต้รหัสหนึ่ง อีกรหัสต้องเห็น และเหลือแถวเดียว');

  // เลือกสินค้าของร้านนี้ที่ "ยังไม่มีใครตั้งหมวดไว้" เท่านั้น เพื่อไม่ไปทับของจริง
  const picked = await queryRead(
    `SELECT TOP 1 i.item_key, i.item_code, i.item_name
       FROM dbo.stock_item i
       JOIN dbo.stock_item_branch b ON b.item_key = i.item_key
      WHERE b.branch = N'sjp'
        AND ISNULL(i.status, N'') <> N'ปิดการใช้งาน'
        AND NOT EXISTS (SELECT 1 FROM dbo.stock_storage_category c
                         WHERE c.item_key = i.item_key AND c.branch IN (N'zjp', N'sjp'))
      ORDER BY i.sort_order, i.item_code`
  );
  if (picked.length === 0) {
    console.log('  [ข้าม] ไม่มีสินค้าของร้าน sjp ที่ยังไม่มีหมวดจัดเก็บ — ข้ามข้อนี้เพื่อไม่ทับข้อมูลจริง');
    return;
  }
  const { item_key: key, item_code: code, item_name: name } = picked[0];
  console.log(`  ใช้สินค้า ${code} (${String(name || '').slice(0, 30)}) ที่ยังไม่มีหมวด`);

  const catRows = () => queryRead(
    `SELECT branch, category FROM dbo.stock_storage_category
      WHERE item_key = @k AND branch IN (N'zjp', N'sjp') ORDER BY branch`,
    { k: { type: sql.NVarChar(50), value: key } }
  );
  const cleanup = () => queryRead(
    `DELETE FROM dbo.stock_storage_category WHERE item_key = @k AND branch IN (N'zjp', N'sjp')`,
    { k: { type: sql.NVarChar(50), value: key } }
  );

  try {
    // ก) แอดมินเลือก sjp จากดรอปดาวน์แล้วตั้งหมวด — คนล็อกอิน zjp ต้องเห็น (ฝั่งอ่านครอบ alias)
    await callApi({ action: 'updateStorageCategory', branch: 'sjp', productId: code, name, category: TEST_CAT }, ADMIN);
    const itemsAsZjp = await callApi({ action: 'getStockItems', branch: 'zjp' }, asBranch('zjp'));
    const seen = (itemsAsZjp || []).find((it) => String(it.productId) === String(code));
    check(seen?.storageCat === TEST_CAT, 'คนล็อกอิน zjp เห็นหมวดที่แอดมินตั้งไว้ใต้ sjp',
      `เห็นเป็น "${seen?.storageCat ?? '(ไม่เจอสินค้าตัวนี้ในรายการของ zjp)'}"`);

    // ข) แก้ทับใต้อีกรหัส — ต้องเหลือแถวเดียว ไม่แตกเป็นสองกอง
    await callApi({ action: 'updateStorageCategory', branch: 'zjp', productId: code, name, category: `${TEST_CAT}-2` }, ADMIN);
    const rows = await catRows();
    check(rows.length === 1, 'เหลือแถวเดียวหลังแก้ทับใต้อีกรหัส',
      `เจอ ${rows.length} แถว: ${rows.map((r) => `${r.branch}=${r.category}`).join(', ')}`);
    check(rows[0]?.category === `${TEST_CAT}-2`, 'หมวดที่เหลือคือค่าล่าสุด', `เจอ "${rows[0]?.category}"`);
  } finally {
    if (!KEEP) {
      await cleanup();
      console.log('  คืนสภาพเดิมแล้ว (ลบหมวดทดสอบของสินค้าตัวนี้ทิ้ง)');
    }
  }
}

/* ---------- อ่านอย่างเดียว: จำนวนหัวที่บันทึกไว้ของสาขาที่ระบุ ---------- */
async function showBranch(branch) {
  console.log(`\nจำนวนหัวลูกค้าที่บันทึกไว้ของสาขา ${branch} (อ่านอย่างเดียว)`);
  const res = await callApi({ action: 'getBranchPercent', branch }, asBranch(branch));
  const rows = (res.data || []).filter((r) => r.date >= new Date().toISOString().slice(0, 8) + '01');
  console.log(`  ทั้งหมด ${(res.data || []).length} วัน · เดือนนี้ ${rows.length} วัน`);
  rows.slice(0, 10).forEach((r) => {
    const split = r.percent259 !== undefined || r.percent359 !== undefined
      ? ` (259=${r.percent259 ?? '-'} / พรีเมียม=${r.percent359 ?? '-'})` : '';
    console.log(`  ${r.date} = ${r.percent}${split}`);
  });
}

async function main() {
  console.log(`ทดสอบผ่าน office-server ที่ ${BASE}`);
  const health = await fetch(`${BASE}/health`, {
    headers: process.env.API_TOKEN ? { 'x-api-token': process.env.API_TOKEN } : {},
  }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  if (!health?.ok) throw new Error(`office-server ไม่พร้อม: ${health?.error || JSON.stringify(health)}`);
  console.log('office-server ตอบ /health แล้ว');

  await testPlainBranch();
  await testAliasBranch();
  await testStorageCategory();
  if (READ_BRANCH) await showBranch(READ_BRANCH);

  console.log(failed === 0 ? '\nสรุป: ผ่านทั้งหมด' : `\nสรุป: ไม่ผ่าน ${failed} ข้อ`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nรันไม่จบ: ${err.message}`);
  process.exit(1);
});
