#!/usr/bin/env node
/**
 * ตรวจว่า "ทำไมสาขานี้ไม่เห็นสินค้าตัวนี้" — ไล่ตั้งแต่ชีททะเบียนจนถึงตารางที่หน้าเว็บอ่าน
 *
 * หน้านับสต๊อกอ่านรายการสินค้าจาก dbo.stock_item + dbo.stock_item_branch (ไม่ได้อ่านชีทแล้ว)
 * สินค้าจะขึ้นให้สาขาหนึ่งได้ต้องครบสี่ข้อ:
 *   1. มีอยู่ในชีท 'item' (ไฟล์ BOM)
 *   2. คอลัมน์ J ของแถวนั้นมีรหัสสาขานั้นอยู่
 *   3. ซิงก์เข้า SQL แล้ว (dbo.stock_item + แถวสาขาใน dbo.stock_item_branch)
 *   4. สถานะไม่ใช่ 'ปิดการใช้งาน'
 * สคริปต์นี้บอกว่าตกข้อไหน พร้อมวิธีแก้ของข้อนั้น
 *
 * วิธีใช้ (รันจากโฟลเดอร์ office-server บนเครื่องที่ออฟฟิศ):
 *   node scripts/check-item.mjs --item=11090061 --branch=scs
 *   node scripts/check-item.mjs --item=ขิงซอย            (ค้นด้วยชื่อก็ได้ ไม่ต้องรู้รหัส)
 *   node scripts/check-item.mjs --item=11090061 --branch=scs --sync   (ซิงก์ให้เลยแล้วตรวจซ้ำ)
 *
 * ตัวเลือก
 *   --item=<รหัสหรือชื่อ>   สินค้าที่จะตรวจ (จำเป็น) — ชื่อค้นแบบมีคำนี้อยู่ในชื่อ
 *   --branch=<รหัสสาขา>     สาขาที่ไม่เห็นสินค้า (ไม่ใส่ = ดูรวมว่าอยู่สาขาไหนบ้าง)
 *   --sync                  สั่งซิงก์ชีท -> SQL ก่อนตรวจซ้ำ (ตัวเดียวกับรอบอัตโนมัติ)
 *
 * ไม่ใส่ --sync จะอ่านอย่างเดียว ไม่เขียนอะไรทั้งนั้น
 */

import { config } from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(here, '..', '.env') });

const { fetchSheetRows, parseItems, syncItemsFromSheet } = await import('../item-sync.js');
const { stockDb, sql, isConfigured, describeDbError } = await import('../hr-db.js');

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ITEM = argVal('item', '').trim();
const BRANCH = argVal('branch', '').trim().toLowerCase();
const DO_SYNC = args.includes('--sync');

if (!ITEM) {
  console.error('ต้องระบุสินค้า เช่น --item=11090061 หรือ --item=ขิงซอย');
  process.exit(1);
}
if (!isConfigured()) {
  console.error('ยังไม่ได้ตั้ง HR_DB_USER / HR_DB_PASSWORD ใน .env ของ office-server');
  process.exit(1);
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const normCode = (v) => str(v).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

// รหัสสาขาในชีท 'item' เขียน SJP แต่ผู้ใช้ล็อกอิน zjp — ต้องแปลงให้ตรงกับที่ stock.js ใช้ตอน JOIN
const ITEM_BRANCH_ALIAS = { zjp: 'sjp', zip: 'sjp' };
const itemBranchOf = (b) => ITEM_BRANCH_ALIAS[b] || b;

const yes = (ok) => (ok ? '✅' : '❌');
const line = () => console.log('─'.repeat(72));

async function main() {
  if (DO_SYNC) {
    console.log('กำลังซิงก์ชีท -> SQL ก่อนตรวจ...');
    const r = await syncItemsFromSheet();
    console.log(`  ${r.message}`);
    line();
  }

  // ---- ฝั่งชีท ----
  const rows = await fetchSheetRows();
  const { items } = parseItems(rows);
  const key = normCode(ITEM);
  const hits = items.filter((it) => (key && it.key === key) || (ITEM && it.name.includes(ITEM)));

  if (hits.length === 0) {
    console.log(`${yes(false)} หาไม่เจอในชีททะเบียนสินค้า: "${ITEM}"`);
    console.log(`   ชีทมีทั้งหมด ${items.length} รายการ`);
    console.log('   -> ฝ่ายจัดซื้อต้องเพิ่มแถวนี้ในชีท item ก่อน หน้าเว็บถึงจะเห็นได้');
    return;
  }
  if (hits.length > 1) {
    console.log(`เจอในชีท ${hits.length} รายการที่เข้าเกณฑ์ — จะตรวจทีละตัว`);
    line();
  }

  // ---- ฝั่ง SQL (ดึงทีเดียวใช้ได้ทุกตัว) ----
  const keys = hits.map((h) => h.key);
  const inClause = keys.map((_, i) => `@k${i}`).join(', ');
  const keyParams = Object.fromEntries(keys.map((k, i) => [`k${i}`, { type: sql.NVarChar(50), value: k }]));
  const [sqlItems, sqlBranches] = await Promise.all([
    stockDb.queryRead(
      `SELECT item_key, item_code, item_name, unit, request_unit, price, pos_item_id,
              status, store_cat, plan_only, sort_order,
              CONVERT(NVARCHAR(19), updated_at, 120) AS updated_text
         FROM dbo.stock_item WHERE item_key IN (${inClause})`,
      keyParams
    ),
    stockDb.queryRead(
      `SELECT item_key, branch FROM dbo.stock_item_branch WHERE item_key IN (${inClause})`,
      keyParams
    ),
  ]);
  const sqlByKey = new Map(sqlItems.map((r) => [str(r.item_key), r]));
  const branchesByKey = new Map();
  for (const r of sqlBranches) {
    const k = str(r.item_key);
    const set = branchesByKey.get(k) || new Set();
    set.add(str(r.branch).toLowerCase());
    branchesByKey.set(k, set);
  }

  for (const it of hits) {
    line();
    console.log(`${it.code}  ${it.name}`);
    console.log('');

    // 1) ชีท
    console.log(`  ในชีท item        ${yes(true)} เจอ (แถวข้อมูลที่ ${it.sortOrder + 1} ไม่นับหัวตาราง)`);
    console.log(`    สถานะ (E)       ${it.status || '(ว่าง = ใช้งานอยู่)'}`);
    console.log(`    สาขาที่ใช้ (J)   ${it.branches.length ? it.branches.join(', ') : '(ว่าง)'}`);
    console.log(`    itemid (K)      ${it.posItemId || '(ว่าง)'}`);
    console.log(`    หน่วยเบิก (L)    ${it.requestUnit || '(ว่าง)'}`);
    console.log(`    ราคา (C)        ${it.price === null ? '(ว่าง)' : it.price}`);
    console.log(`    หมวดสโตร์ (N)   ${it.storeCat || '(ว่าง)'}`);
    console.log(`    Plan (O)        ${it.planOnly ? 'TRUE — สั่งได้เฉพาะปุ่มสั่งสินค้าแพลน/สั่งเพิ่มเติม' : '(ว่าง)'}`);

    // 2) SQL
    const row = sqlByKey.get(it.key);
    const brSet = branchesByKey.get(it.key) || new Set();
    console.log('');
    console.log(`  ใน dbo.stock_item ${yes(Boolean(row))} ${row ? `เจอ (อัปเดตล่าสุด ${row.updated_text})` : 'ไม่เจอ'}`);
    if (row) {
      console.log(`    ชื่อ            ${str(row.item_name)}`);
      console.log(`    สถานะ          ${str(row.status) || '(ว่าง)'}`);
      console.log(`    itemid         ${str(row.pos_item_id) || '(ว่าง)'}`);
      console.log(`    หน่วยเบิก       ${str(row.request_unit) || '(ว่าง)'}`);
      console.log(`    ราคา           ${row.price === null ? '(ว่าง)' : Number(row.price)}`);
    }
    console.log(`    สาขาใน stock_item_branch: ${brSet.size ? [...brSet].sort().join(', ') : '(ไม่มีสักสาขา)'}`);

    // 3) สรุปว่าติดตรงไหน
    console.log('');
    if (!BRANCH) {
      console.log('  (ไม่ได้ระบุ --branch จึงบอกได้แค่ว่าอยู่สาขาไหนบ้าง)');
      continue;
    }

    const wantInSheet = itemBranchOf(BRANCH);
    const inSheetBranch = it.branches.includes(wantInSheet);
    const inSqlBranch = brSet.has(wantInSheet);
    const active = str(row?.status) !== 'ปิดการใช้งาน';
    const hidden = /อุปกรณ์/.test(str(row?.store_cat) || it.storeCat);

    console.log(`  สาขา ${BRANCH}${wantInSheet !== BRANCH ? ` (ในทะเบียนเขียนว่า ${wantInSheet})` : ''}`);
    console.log(`    ${yes(inSheetBranch)} ชีทคอลัมน์ J ระบุสาขานี้`);
    console.log(`    ${yes(Boolean(row))} มีในทะเบียน SQL`);
    console.log(`    ${yes(inSqlBranch)} มีแถวสาขานี้ใน stock_item_branch`);
    console.log(`    ${yes(active)} สถานะไม่ใช่ 'ปิดการใช้งาน'`);
    console.log('');

    if (!inSheetBranch) {
      console.log(`  สาเหตุ: ชีทไม่ได้ระบุว่าสาขา ${BRANCH} ใช้สินค้าตัวนี้`);
      console.log(`  แก้: เติม ${wantInSheet.toUpperCase()} ลงคอลัมน์ J ของแถวนี้ในชีท item แล้วรอรอบซิงก์ (ไม่เกิน 1 ชม.)`);
      console.log('       หรือรันคำสั่งนี้ซ้ำโดยเติม --sync เพื่อให้ซิงก์เดี๋ยวนี้');
    } else if (!row || !inSqlBranch) {
      console.log('  สาเหตุ: ชีทถูกแล้ว แต่ SQL ยังตามไม่ทัน (ยังไม่ได้ซิงก์รอบที่มีการแก้นี้)');
      console.log('  แก้: รันคำสั่งนี้ซ้ำโดยเติม --sync หรือรอรอบอัตโนมัติ (ไม่เกิน 1 ชม.)');
      console.log('       ถ้าซิงก์แล้วยังไม่ขึ้น ให้ดู log ของ office-server ว่ารอบซิงก์ล้มเหลวด้วยสาเหตุอะไร');
    } else if (!active) {
      console.log("  สาเหตุ: สถานะเป็น 'ปิดการใช้งาน' ฝั่งอ่านจึงกรองออกทุกสาขา");
      console.log('  แก้: ล้างช่องสถานะ (E) ในชีท item แล้วซิงก์ใหม่');
    } else if (hidden) {
      console.log('  ครบทุกข้อแล้ว แต่หมวดสโตร์มีคำว่า "อุปกรณ์" ซึ่งหน้านับสต๊อกซ่อนไว้');
      console.log('  แก้: ในหน้านับสต๊อก กดปุ่ม "หมวดอุปกรณ์" เพื่อดูและกรอกขอเบิก (ไม่ใช่ข้อมูลหาย)');
    } else {
      console.log('  ครบทุกข้อ — ข้อมูลฝั่งเซิร์ฟเวอร์ถูกต้องแล้ว สาขานี้ต้องเห็นสินค้าตัวนี้ในตารางนับ');
      if (row.plan_only) {
        console.log('  หมายเหตุ: Plan (O) = TRUE สินค้าตัวนี้จะ "เห็นแต่สั่งไม่ได้" ด้วยปุ่มส่งใบเบิกปกติ');
        console.log('            ต้องใช้ปุ่ม "สั่งสินค้าแพลน/สั่งเพิ่มเติม" แทน — ถ้าอาการคือสั่งไม่ได้ นี่คือสาเหตุ');
      }
      console.log('  ถ้ายังไม่เห็นจริง ๆ ให้ลอง: กด Ctrl+F5 ล้างแคช, เช็คช่องค้นหาและปุ่มกรองหมวดในหน้านั้น,');
      console.log('  ดูว่าผู้ใช้ล็อกอินด้วยรหัสสาขานี้จริง และเช็คหมวดจัดเก็บของสาขา (dbo.stock_storage_category)');
      console.log('  ว่าตั้งเป็นหมวดที่มีคำว่า "อุปกรณ์" ไว้หรือเปล่า — หน้าเว็บซ่อนหมวดนั้นไว้หลังปุ่ม');
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ตรวจไม่สำเร็จ:', describeDbError ? describeDbError(e) : e.message);
    process.exit(1);
  });
