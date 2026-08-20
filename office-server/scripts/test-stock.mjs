#!/usr/bin/env node
/**
 * ตรวจว่าหน้านับสต๊อกอ่านจาก SQL ได้ผลตรงกับที่ Apps Script ตอบไหม
 *
 * ยิงคำสั่งเดียวกันสองทาง แล้วเทียบผลทีละรายการ:
 *   ทาง SQL         office-server ที่เครื่องนี้ (/schedule)
 *   ทาง Apps Script ของเดิมที่หน้าเว็บใช้อยู่ทุกวันนี้
 *
 * ใช้ก่อนจะเปิดให้หน้าเว็บอ่านจาก SQL — ถ้าตัวเลขไม่ตรง แปลว่ายังย้ายข้อมูลไม่ครบ
 * (หรือย้ายมาแล้วแต่ชีทมีคนบันทึกเพิ่มหลังจากนั้น ซึ่งเป็นเรื่องปกติจนกว่าจะย้ายฝั่งบันทึกด้วย)
 *
 * วิธีใช้ (รันจากโฟลเดอร์ office-server บนเครื่องที่ออฟฟิศ):
 *   node scripts/test-stock.mjs --branch=crm
 *
 * ตัวเลือก
 *   --branch=crm                   สาขาที่จะเทียบ (จำเป็น)
 *   --base=http://localhost:8787   ที่อยู่ office-server
 *   --sheet-only                   ดูเฉพาะผลจาก Apps Script (ไว้ตรวจว่าชีทตอบอะไรมา)
 *   --sql-only                     ดูเฉพาะผลจาก SQL + จำนวนแถวในแต่ละตาราง
 *   --show=20                      จำนวนรายการที่ต่างกันที่จะพิมพ์ออกมา (ค่าเริ่มต้น 10)
 *
 * อ่านอย่างเดียวทั้งหมด ไม่เขียนอะไรลงชีทหรือฐานข้อมูล
 */

import { config } from 'dotenv';
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
const BASE = argVal('base', 'http://localhost:8787').replace(/\/+$/, '');
const BRANCH = argVal('branch', '');
const SHOW = Number(argVal('show', '10')) || 10;
const SHEET_ONLY = args.includes('--sheet-only');
const SQL_ONLY = args.includes('--sql-only');

/* หน้าเว็บเรียก Apps Script ผ่าน URL นี้ (ตัวเดียวกับ SCRIPT_URL ใน src/services/api.js) */
const SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbwsGv4sz5ljPtdq347Y8zKaDP9FCLKAKKUNCPY5tarhAiAYz8RZdrC_nltVTeT0WWIXjA/exec';

const USER = { username: 'ทดสอบระบบ', branch: 'all' };

async function callSql(payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.API_TOKEN) headers['x-api-token'] = process.env.API_TOKEN;
  const res = await fetch(`${BASE}/schedule`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, _user: USER }),
  });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`office-server ตอบกลับมาไม่ใช่ JSON (HTTP ${res.status})`);
  if (body.status !== 'success') throw new Error(body.message || `HTTP ${res.status}`);
  return body.data;
}

async function callSheet(payload) {
  const res = await fetch(SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Apps Script ไม่รับ preflight
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`Apps Script ตอบกลับมาไม่ใช่ JSON (HTTP ${res.status})`);
  if (body.status !== 'success') throw new Error(body.message || `HTTP ${res.status}`);
  return body.data;
}

/** ค่าที่เอามาเทียบกันของสินค้าหนึ่งตัว — เทียบเฉพาะช่องที่หน้าเว็บใช้แสดงผลจริง */
const summarize = (it) => ({
  name: String(it.name || ''),
  unit: String(it.unit || ''),
  lastStock: String(it.lastStock ?? ''),
  lastStockDate: String(it.lastStockDate || ''),
  previousBalance: String(it.previousBalance ?? ''),
  lastRequest: String(it.lastRequest ?? ''),
  storageCat: String(it.storageCat || ''),
  history: Array.isArray(it.stockHistory) ? it.stockHistory.length : 0,
});

function compare(sqlItems, sheetItems) {
  const sqlMap = new Map(sqlItems.map((it) => [String(it.productId), it]));
  const sheetMap = new Map(sheetItems.map((it) => [String(it.productId), it]));

  const onlySql = [...sqlMap.keys()].filter((k) => !sheetMap.has(k));
  const onlySheet = [...sheetMap.keys()].filter((k) => !sqlMap.has(k));
  const diffs = [];

  for (const [code, sqlItem] of sqlMap) {
    const sheetItem = sheetMap.get(code);
    if (!sheetItem) continue;
    const a = summarize(sqlItem);
    const b = summarize(sheetItem);
    const fields = Object.keys(a).filter((f) => a[f] !== b[f]);
    if (fields.length) diffs.push({ code, name: a.name || b.name, fields, sql: a, sheet: b });
  }

  console.log(`\nสรุปการเทียบสาขา ${BRANCH}`);
  console.log(`  จาก SQL         ${sqlItems.length} รายการ`);
  console.log(`  จาก Apps Script ${sheetItems.length} รายการ`);
  console.log(`  มีเฉพาะใน SQL   ${onlySql.length} รายการ`);
  console.log(`  มีเฉพาะในชีท    ${onlySheet.length} รายการ`);
  console.log(`  ค่าไม่ตรงกัน     ${diffs.length} รายการ`);

  if (onlySheet.length) console.log(`  ตัวอย่างที่ขาดใน SQL: ${onlySheet.slice(0, SHOW).join(', ')}`);
  if (onlySql.length) console.log(`  ตัวอย่างที่เกินมาใน SQL: ${onlySql.slice(0, SHOW).join(', ')}`);

  for (const d of diffs.slice(0, SHOW)) {
    console.log(`\n  [${d.code}] ${d.name}`);
    for (const f of d.fields) {
      console.log(`    ${f}: SQL='${d.sql[f]}'  ชีท='${d.sheet[f]}'`);
    }
  }

  const same = diffs.length === 0 && onlySql.length === 0 && onlySheet.length === 0;
  console.log(same ? '\n[ผ่าน] สองทางให้ผลตรงกัน' : '\n[ยังไม่ตรง] ดูรายการข้างบนก่อนเปิดใช้จาก SQL');
  return same;
}

async function main() {
  if (!BRANCH) {
    console.error('ต้องระบุสาขาที่จะเทียบ เช่น --branch=crm');
    process.exitCode = 1;
    return;
  }

  if (!SHEET_ONLY) {
    const status = await callSql({ action: 'stockStatus' });
    console.log('จำนวนแถวในฐานข้อมูล');
    for (const [table, count] of Object.entries(status.tables || {})) {
      console.log(`  ${table.padEnd(24)} ${count}`);
    }
    if (status.latestCount) {
      console.log(`  การนับล่าสุดใน SQL: ${status.latestCount.date} (สาขา ${status.latestCount.branch})`);
    }
  }

  const sqlItems = SHEET_ONLY ? [] : await callSql({ action: 'getStockItems', branch: BRANCH });
  const sheetItems = SQL_ONLY ? [] : await callSheet({ action: 'getStockItems', branch: BRANCH, debug: true });

  if (SQL_ONLY || SHEET_ONLY) {
    const list = SQL_ONLY ? sqlItems : sheetItems;
    console.log(`\n${SQL_ONLY ? 'จาก SQL' : 'จาก Apps Script'}: ${list.length} รายการ`);
    list.slice(0, SHOW).forEach((it) => console.log(`  ${it.productId} ${JSON.stringify(summarize(it))}`));
    return;
  }

  if (!compare(sqlItems, sheetItems)) process.exitCode = 1;
}

main().catch((err) => {
  console.error('ล้มเหลว:', err.message);
  process.exitCode = 1;
});
