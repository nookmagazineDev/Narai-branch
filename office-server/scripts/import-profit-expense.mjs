#!/usr/bin/env node
/**
 * ย้ายค่าใช้จ่ายอื่น ๆ ของตารางสรุปกำไร (Petty Cash / ค่าเช่า / ค่าน้ำ / ค่าไฟ / ค่าน้ำแข็ง / ค่าโทรศัพท์ /
 * ค่าแก๊ส / ค่าประกันภัย + ยอด Member / Delivery) จาก Google Sheet เข้า SQL dbo.profit_expense
 *
 * วิธีใช้ (รันจากโฟลเดอร์ office-server บนเครื่องเซิร์ฟเวอร์ หลังรัน update-office-server.bat แล้ว):
 *   node scripts/import-profit-expense.mjs --url="<ลิงก์แท็บ>"            # รายงานอย่างเดียว ไม่เขียนอะไร
 *   node scripts/import-profit-expense.mjs --url="<ลิงก์แท็บ>" --apply    # เขียนจริง
 *
 *   ลิงก์แท็บ = เปิดแท็บนั้นในเบราว์เซอร์แล้วก๊อป URL ทั้งอันมาวาง (มี #gid=... ท้าย) — สคริปต์แกะ id ไฟล์กับ gid ให้เอง
 *   ชีทต้องตั้งแชร์เป็น "ทุกคนที่มีลิงก์ • ผู้อ่าน" (อ่านผ่าน gviz เหมือน import-sup-cost.mjs)
 *
 * ตัวเลือก
 *   --apply           เขียนจริง (ไม่ใส่ = รายงานอย่างเดียว)
 *   --branch=crm      แท็บนี้เป็นของสาขาเดียว (ชีทไม่มีคอลัมน์สาขา) หรือใช้กรองเฉพาะสาขานั้น
 *   --month=2026-10   แท็บนี้เป็นของเดือนเดียว (ชีทไม่มีคอลัมน์เดือน/วันที่)
 *   --overwrite       แถวที่ย้ายมาจากชีทรอบก่อน (source = 'sheet') ให้แก้ตามชีทล่าสุดด้วย
 *                     ไม่แตะค่าที่สาขากรอกผ่านเว็บ (source = 'web') ไม่ว่ากรณีไหน
 *
 * อ่านหัวตารางแล้วเดารูปแบบให้เอง (ดูบรรทัด "รูปแบบชีท" ในผลลัพธ์ว่าเดาถูกไหม ก่อนใส่ --apply):
 *   A) หนึ่งแถวต่อเดือน    : [สาขา] [เดือน/วันที่] [Petty Cash] [ค่าเช่าพื้นที่] [ค่าน้ำ] ...
 *   B) รายการเป็นแถว       : [รายการ] [ต.ค. 69] [พ.ย. 69] ...   (หัวคอลัมน์เป็นเดือน แบบตาราง P&L)
 *   C) หนึ่งแถวต่อรายจ่าย  : [วันที่/เดือน] [สาขา] [รายการ] [จำนวนเงิน]
 * รูปแบบ A กับ C ถ้ามีหลายแถวของ (สาขา+เดือน+รายการ) เดียวกัน จะรวมยอดเข้าด้วยกัน (เช่น Petty Cash รายวัน)
 *
 * รันซ้ำได้ปลอดภัย — ค่าเริ่มต้นเติมเฉพาะ (เดือน+สาขา+รายการ) ที่ยังไม่มีในตาราง
 */

import { config } from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(here, '..', '.env') });

const { sql, stockDb, isConfigured, describeDbError } = await import('../hr-db.js');
const { PROFIT_EXPENSE_KEYS, storageBranch } = await import('../profitexpense.js');

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const APPLY = args.includes('--apply');
const OVERWRITE = args.includes('--overwrite');
const ONLY_BRANCH = String(argVal('branch', '')).toLowerCase().trim();
const FIXED_MONTH = String(argVal('month', '')).trim();

const TAB_URL = String(argVal('url', '')).trim();
const urlFile = TAB_URL.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
const urlGid = TAB_URL.match(/[#?&]gid=(\d+)/);
if (!urlFile) {
  console.error('❌ ใส่ --url="<ลิงก์แท็บของ Google Sheet ที่มีค่าใช้จ่าย>" (เปิดแท็บนั้นแล้วก๊อป URL จากแถบที่อยู่)');
  process.exit(1);
}
if (FIXED_MONTH && !/^\d{4}-(0[1-9]|1[0-2])$/.test(FIXED_MONTH)) {
  console.error('❌ --month ต้องเป็น YYYY-MM (ค.ศ.) เช่น --month=2026-10');
  process.exit(1);
}

const pad = (n) => String(n).padStart(2, '0');
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = str(v).replace(/[,฿\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/* ── ชื่อรายการในชีท -> คีย์ในตาราง (น้ำแข็งต้องมาก่อนค่าน้ำ) ── */
const LABELS = { petty: 'Petty Cash', rent: 'ค่าเช่าพื้นที่', water: 'ค่าน้ำ', power: 'ค่าไฟ', ice: 'ค่าน้ำแข็ง',
  phone: 'ค่าโทรศัพท์', gas: 'ค่าแก๊ส', insurance: 'ค่าประกันภัย', member: 'ยอดขาย Member', delivery: 'Delivery Service' };
const ALIASES = [
  ['petty', /petty|เงินสดย่อย/i],
  ['rent', /เช่า|\brent\b/i],
  ['ice', /น้ำแข็ง|\bice\b/i],
  ['water', /ค่าน้ำ|น้ำประปา|water/i],
  ['power', /ค่าไฟ|ไฟฟ้า|electric|\bpower\b/i],
  ['phone', /โทร|phone/i],
  ['gas', /แก๊ส|แก็ส|ก๊าซ|\bgas\b/i],
  ['insurance', /ประกัน|insurance/i],
  ['member', /member|สมาชิก/i],
  ['delivery', /delivery|เดลิเวอ/i],
];
const keyOf = (label) => {
  const s = str(label);
  if (!s || s.length > 60) return '';
  const hit = ALIASES.find(([, re]) => re.test(s));
  return hit ? hit[0] : '';
};

/* ── เดือน 'YYYY-MM' จากค่าในชีท: Date(...) ของ gviz, 2026-10[-05], 05/10/2026, 10/2026, ต.ค. 69, ตุลาคม 2569, Oct 2026 ── */
const TH_MONTHS = [
  ['ม.ค', 'มกรา'], ['ก.พ', 'กุมภา'], ['มี.ค', 'มีนา'], ['เม.ย', 'เมษา'], ['พ.ค', 'พฤษภา'], ['มิ.ย', 'มิถุนา'],
  ['ก.ค', 'กรกฎา'], ['ส.ค', 'สิงหา'], ['ก.ย', 'กันยา'], ['ต.ค', 'ตุลา'], ['พ.ย', 'พฤศจิกา'], ['ธ.ค', 'ธันวา'],
];
const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function fixYear(y) {
  let n = Number(y);
  if (!n) return 0;
  if (n < 100) n += n >= 40 ? 2500 : 2000;   // 69 -> 2569 (พ.ศ.) · 26 -> 2026
  if (n > 2400) n -= 543;                   // พ.ศ. -> ค.ศ.
  return n;
}
function toMonth(v) {
  const s = str(v);
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?/);
  if (m) return monthKey(fixYear(m[1]), Number(m[2]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);      // DD/MM/YYYY
  if (m) return monthKey(fixYear(m[3]), Number(m[2]));
  m = s.match(/^(\d{1,2})[/-](\d{4}|\d{2})$/);           // MM/YYYY
  if (m) return monthKey(fixYear(m[2]), Number(m[1]));
  const y = s.match(/(\d{4}|\d{2})\s*$/);
  if (!y) return '';
  const low = s.toLowerCase();
  const th = TH_MONTHS.findIndex(([abbr, full]) => s.includes(abbr) || s.includes(full));
  if (th >= 0) return monthKey(fixYear(y[1]), th + 1);
  const en = EN_MONTHS.findIndex((e) => low.startsWith(e));
  if (en >= 0) return monthKey(fixYear(y[1]), en + 1);
  return '';
}
function monthKey(y, mo) {
  if (!y || !mo || mo < 1 || mo > 12) return '';
  return `${y}-${pad(mo)}`;
}

async function fetchRows() {
  const target = urlGid ? `gid=${encodeURIComponent(urlGid[1])}` : '';
  const url = `https://docs.google.com/spreadsheets/d/${urlFile[1]}/gviz/tq?tqx=out:json&headers=0${target ? `&${target}` : ''}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('อ่านชีทไม่ได้ — ตรวจว่าตั้งลิงก์เป็น "ทุกคนที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง');
  const json = JSON.parse(text.slice(a, b + 1));
  if (json.status === 'error') throw new Error(`gviz: ${(json.errors || []).map((e) => e.detailed_message || e.message).join(' / ')}`);
  const cols = json.table.cols || [];
  return (json.table.rows || []).map((row) =>
    cols.map((_, i) => {
      const cell = row.c && row.c[i];
      if (!cell) return '';
      if (typeof cell.v === 'string') {
        const m = cell.v.match(/^Date\((\d+),(\d+),(\d+)/);
        if (m) return `${m[1]}-${pad(Number(m[2]) + 1)}-${pad(Number(m[3]))}`;
      }
      if ((cell.v === null || cell.v === undefined) && cell.f) return cell.f;
      return cell.v === null || cell.v === undefined ? '' : cell.v;
    })
  );
}

/* ── เดารูปแบบชีท แล้วแปลงเป็น [{branch, month, key, amount}] ── */
const isBranchHead = (c) => /^(สาขา|branch|รหัสสาขา)/i.test(str(c));
const isMonthHead = (c) => /^(เดือน|month|วันที่|date|งวด|ประจำเดือน)/i.test(str(c));
const isItemHead = (c) => /^(รายการ|ประเภท|หมวด|item|ค่าใช้จ่าย)/i.test(str(c));
const isAmountHead = (c) => /(จำนวนเงิน|ยอดเงิน|ยอด|amount|บาท|รวม)/i.test(str(c));

function parse(rows) {
  const scan = rows.slice(0, 10);

  // A) หนึ่งแถวต่อเดือน — หัวตารางมีชื่อรายการอย่างน้อย 2 คอลัมน์
  for (let h = 0; h < scan.length; h++) {
    const head = rows[h].map(str);
    const keyCols = head.map((c, i) => [keyOf(c), i]).filter(([k]) => k);
    if (keyCols.length < 2) continue;
    const monthCol = head.findIndex(isMonthHead);
    const branchCol = head.findIndex(isBranchHead);
    if (monthCol < 0 && !FIXED_MONTH) continue;
    if (branchCol < 0 && !ONLY_BRANCH) {
      throw new Error('ชีทไม่มีคอลัมน์ "สาขา" — ใส่ --branch=<รหัสสาขา> ถ้าแท็บนี้เป็นของสาขาเดียว');
    }
    const out = [];
    let bad = 0;
    for (const r of rows.slice(h + 1)) {
      const month = FIXED_MONTH || toMonth(r[monthCol]);
      const branch = branchCol >= 0 ? str(r[branchCol]).toLowerCase() : ONLY_BRANCH;
      const hasNumber = keyCols.some(([, i]) => num(r[i]) !== null);
      if (!hasNumber) continue;
      if (!month || !branch) { bad++; continue; }
      for (const [key, i] of keyCols) {
        const amount = num(r[i]);
        if (amount !== null) out.push({ branch, month, key, amount });
      }
    }
    return { layout: `A) หนึ่งแถวต่อเดือน (หัวตารางแถวที่ ${h + 1}: ${keyCols.map(([k]) => LABELS[k]).join(', ')})`, out, bad };
  }

  // B) รายการเป็นแถว หัวคอลัมน์เป็นเดือน
  for (let h = 0; h < scan.length; h++) {
    const monthCols = rows[h].map((c, i) => [toMonth(c), i]).filter(([m]) => m);
    if (monthCols.length < 1) continue;
    const labelRows = rows.slice(h + 1).filter((r) => r.some((c) => keyOf(c)));
    if (labelRows.length < 2) continue;
    if (!ONLY_BRANCH) throw new Error('ชีทแบบรายการเป็นแถว (ไม่มีคอลัมน์สาขา) — ใส่ --branch=<รหัสสาขา> ของแท็บนี้');
    const out = [];
    for (const r of labelRows) {
      const labelIdx = r.findIndex((c) => keyOf(c));
      const key = keyOf(r[labelIdx]);
      for (const [month, i] of monthCols) {
        if (i <= labelIdx) continue;
        const amount = num(r[i]);
        if (amount !== null) out.push({ branch: ONLY_BRANCH, month, key, amount });
      }
    }
    return { layout: `B) รายการเป็นแถว เดือนเป็นคอลัมน์ (${monthCols.map(([m]) => m).join(', ')})`, out, bad: 0 };
  }

  // C) หนึ่งแถวต่อรายจ่าย
  for (let h = 0; h < scan.length; h++) {
    const head = rows[h].map(str);
    const itemCol = head.findIndex(isItemHead);
    const amountCol = head.findIndex((c, i) => i !== itemCol && isAmountHead(c));
    if (itemCol < 0 || amountCol < 0) continue;
    const monthCol = head.findIndex(isMonthHead);
    const branchCol = head.findIndex(isBranchHead);
    if (monthCol < 0 && !FIXED_MONTH) continue;
    if (branchCol < 0 && !ONLY_BRANCH) {
      throw new Error('ชีทไม่มีคอลัมน์ "สาขา" — ใส่ --branch=<รหัสสาขา> ถ้าแท็บนี้เป็นของสาขาเดียว');
    }
    const out = [];
    let bad = 0;
    const unknown = new Map();
    for (const r of rows.slice(h + 1)) {
      const amount = num(r[amountCol]);
      if (amount === null) continue;
      const key = keyOf(r[itemCol]);
      if (!key) { const l = str(r[itemCol]) || '(ว่าง)'; unknown.set(l, (unknown.get(l) || 0) + 1); continue; }
      const month = FIXED_MONTH || toMonth(r[monthCol]);
      const branch = branchCol >= 0 ? str(r[branchCol]).toLowerCase() : ONLY_BRANCH;
      if (!month || !branch) { bad++; continue; }
      out.push({ branch, month, key, amount });
    }
    return { layout: `C) หนึ่งแถวต่อรายจ่าย (หัวตารางแถวที่ ${h + 1})`, out, bad, unknown };
  }

  throw new Error('เดารูปแบบชีทไม่ออก — ไม่เจอหัวตารางที่มีชื่อรายการ (ค่าเช่า/ค่าน้ำ/ค่าไฟ/…) กับคอลัมน์เดือน/วันที่');
}

const line = () => console.log('─'.repeat(78));

if (!isConfigured()) {
  console.error('❌ ไม่พบ HR_DB_USER / HR_DB_PASSWORD ใน office-server\\.env');
  process.exit(1);
}

console.log(APPLY ? '▶ โหมดเขียนจริง (--apply)' : '▶ โหมดรายงาน (ยังไม่เขียนอะไร — ใส่ --apply เพื่อเขียนจริง)');
if (OVERWRITE) console.log('  --overwrite: แถวที่ย้ายจากชีทรอบก่อนจะถูกแก้ตามชีทล่าสุด (ไม่แตะค่าที่กรอกผ่านเว็บ)');
if (ONLY_BRANCH) console.log(`  สาขา ${ONLY_BRANCH}`);
if (FIXED_MONTH) console.log(`  เดือน ${FIXED_MONTH}`);
line();

let parsed;
try {
  const rows = await fetchRows();
  console.log(`อ่านชีทได้ ${rows.length.toLocaleString()} แถว`);
  parsed = parse(rows);
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
console.log(`รูปแบบชีท: ${parsed.layout}`);
if (parsed.bad) console.log(`  ข้ามแถวที่อ่านเดือน/สาขาไม่ได้ ${parsed.bad} แถว`);
if (parsed.unknown?.size) {
  console.log(`  ข้ามรายการที่ไม่ใช่ 10 ช่องของตารางสรุปกำไร: ${[...parsed.unknown].map(([l, n]) => `${l} (${n})`).join(', ')}`);
}

// รวมยอดต่อ (เดือน + สาขา + รายการ) · เก็บใต้รหัสหลักของกลุ่มสาขาเหมือนหน้าเว็บ
const byKey = new Map();
let negative = 0;
for (const r of parsed.out) {
  const branch = storageBranch(r.branch);
  if (ONLY_BRANCH && storageBranch(ONLY_BRANCH) !== branch) continue;
  if (!PROFIT_EXPENSE_KEYS.includes(r.key)) continue;
  if (r.amount < 0) { negative++; continue; }
  const k = `${r.month}|${branch}|${r.key}`;
  const cur = byKey.get(k) || { month: r.month, branch, key: r.key, amount: 0 };
  cur.amount = Math.round((cur.amount + r.amount) * 100) / 100;
  byKey.set(k, cur);
}
if (negative) console.log(`  ข้ามยอดติดลบ ${negative} ช่อง`);
const rows = [...byKey.values()].sort((a, b) => `${a.branch}|${a.month}`.localeCompare(`${b.branch}|${b.month}`));
console.log(`ได้ ${rows.length.toLocaleString()} ค่า (เดือน+สาขา+รายการ)`);

let pool;
try {
  pool = await stockDb.getPool();
} catch (err) {
  console.error(`❌ ต่อฐานข้อมูลไม่ได้: ${describeDbError(err)}`);
  process.exit(1);
}
const exists = await pool.request().query(`SELECT OBJECT_ID(N'dbo.profit_expense', N'U') AS id`);
if (!exists.recordset[0].id) {
  console.error('❌ ยังไม่มีตาราง dbo.profit_expense — รัน update-office-server.bat ก่อน (สร้างตารางให้จาก sql/profitexp-001-table.sql)');
  await pool.close();
  process.exit(1);
}

const have = new Map();
const existing = await pool.request().query(`SELECT exp_month, branch, item_key, source FROM dbo.profit_expense`);
for (const e of existing.recordset) have.set(`${e.exp_month}|${e.branch}|${e.item_key}`, e.source);

const toInsert = [], toUpdate = [];
let keepWeb = 0, keepSheet = 0;
for (const r of rows) {
  const src = have.get(`${r.month}|${r.branch}|${r.key}`);
  if (!src) toInsert.push(r);
  else if (src === 'sheet' && OVERWRITE) toUpdate.push(r);
  else if (src === 'web') keepWeb++;
  else keepSheet++;
}

// ตารางให้ตรวจด้วยตา: สาขา / เดือน / ค่าแต่ละช่อง (ที่จะเขียน)
line();
console.log(`เพิ่มใหม่ ${toInsert.length} ค่า` + (OVERWRITE ? ` · แก้ตามชีท ${toUpdate.length} ค่า` : '') +
  ` · มีอยู่แล้ว (ย้ายรอบก่อน) ${keepSheet} · กรอกผ่านเว็บแล้ว ไม่แตะ ${keepWeb}`);
const grid = new Map();
for (const r of [...toInsert, ...toUpdate]) {
  const g = `${r.branch}|${r.month}`;
  if (!grid.has(g)) grid.set(g, {});
  grid.get(g)[r.key] = r.amount;
}
for (const [g, vals] of [...grid].sort()) {
  const [b, m] = g.split('|');
  const parts = PROFIT_EXPENSE_KEYS.filter((k) => vals[k] !== undefined).map((k) => `${LABELS[k]} ${vals[k].toLocaleString('th-TH')}`);
  console.log(`  ${b.padEnd(6)} ${m}  ${parts.join(' · ')}`);
}
line();

if (!APPLY) {
  console.log('ยังไม่ได้เขียนอะไร — ตรวจตัวเลขด้านบนแล้วรันซ้ำพร้อม --apply');
  await pool.close();
  process.exit(0);
}

let inserted = 0, updated = 0;
const tx = new sql.Transaction(pool);
await tx.begin();
try {
  for (const r of toInsert) {
    const res = await new sql.Request(tx)
      .input('m', sql.Char(7), r.month)
      .input('b', sql.NVarChar(50), r.branch)
      .input('k', sql.NVarChar(30), r.key)
      .input('a', sql.Decimal(18, 2), r.amount)
      .query(`IF NOT EXISTS (SELECT 1 FROM dbo.profit_expense WHERE exp_month = @m AND branch = @b AND item_key = @k)
                INSERT INTO dbo.profit_expense (exp_month, branch, item_key, amount, created_by, source)
                VALUES (@m, @b, @k, @a, N'Google Sheet', N'sheet');`);
    inserted += res.rowsAffected.reduce((s, n) => s + n, 0);
  }
  for (const r of toUpdate) {
    const res = await new sql.Request(tx)
      .input('m', sql.Char(7), r.month)
      .input('b', sql.NVarChar(50), r.branch)
      .input('k', sql.NVarChar(30), r.key)
      .input('a', sql.Decimal(18, 2), r.amount)
      .query(`UPDATE dbo.profit_expense SET amount = @a, updated_at = SYSDATETIME(), updated_by = N'Google Sheet'
               WHERE exp_month = @m AND branch = @b AND item_key = @k AND source = N'sheet';`);
    updated += res.rowsAffected.reduce((s, n) => s + n, 0);
  }
  await tx.commit();
} catch (err) {
  await tx.rollback().catch(() => {});
  console.error(`❌ เขียนไม่สำเร็จ: ${describeDbError(err)} — ย้อนทั้งหมดแล้ว รันซ้ำได้เลย`);
  await pool.close();
  process.exit(1);
}
console.log(`✅ เพิ่ม ${inserted} ค่า` + (OVERWRITE ? ` · แก้ ${updated} ค่า` : ''));
await pool.close();
