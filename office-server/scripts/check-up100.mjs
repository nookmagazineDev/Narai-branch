#!/usr/bin/env node
/**
 * สาขาไหนขายหัวราคาสูงแบบไหน — UP100 (101116) / Premium 359 (101002) / ราคาเดียว
 *
 * ทำไมต้องถามยอดขาย: ไม่มีที่ไหนตั้งค่าไว้ว่าสาขานี้เป็นสาขา UP100 หน้าเว็บดูจากยอดขายจริง
 * ของเดือนที่แล้ว+เดือนนี้แล้วตัดสินเอง (ดู fetchCoverBuckets ใน src/pages/StockList.jsx)
 * สคริปต์นี้ถามด้วยกติกาเดียวกัน แต่ไล่ทีเดียวทุกสาขา แทนที่จะต้องเปิดทีละสาขาในหน้าเว็บ
 *
 * ทะเบียนสาขาอ่านจาก dbo.hr_branch (is_active = 1) แล้วส่ง outlet_id ให้ /dashboard ตรง ๆ
 * ไม่ผ่าน branchMap ใน server.js — สาขาที่ตกหล่นจาก branchMap (sts, fct) จึงยังตรวจได้
 *
 * วิธีใช้ (รันจากโฟลเดอร์ office-server บนเครื่องที่ออฟฟิศ)
 *   node scripts/check-up100.mjs
 *   node scripts/check-up100.mjs --months=3      # ย้อนหลังกี่เดือน (ค่าเริ่มต้น 2 = เดือนที่แล้ว+เดือนนี้)
 *   node scripts/check-up100.mjs --base=http://localhost:8787
 *
 * ต้องให้ office-server รันอยู่ (สคริปต์เรียก /dashboard ของมัน ไม่ได้ยิง POS เอง)
 * รอบแรกช้าเพราะต้องอุ่นแคชรายวัน สาขาถัด ๆ ไปใช้แคชก้อนเดียวกันจึงเร็ว
 */

import { config } from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(here, '..', '.env') });

const { queryRead, isConfigured, describeDbError } = await import('../hr-db.js');

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const MONTHS = Math.max(1, Number(argVal('months', '2')) || 2);
const BASE = String(argVal('base', `http://localhost:${process.env.PORT || 8787}`)).replace(/\/+$/, '');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const num = (v) => Number(v) || 0;
const int = (n) => Math.round(num(n)).toLocaleString('en-US');

const now = new Date();
const start = ymd(new Date(now.getFullYear(), now.getMonth() - (MONTHS - 1), 1));
const end = ymd(now);

// ความกว้างที่มองเห็นจริงของสตริง — อักษรไทยที่เป็นสระบน/ล่างกับวรรณยุกต์ไม่กินที่
const seen = (s) => [...String(s)].filter((c) => !/[ัิ-ฺ็-๎]/.test(c)).length;
const padEnd = (s, w) => String(s) + ' '.repeat(Math.max(0, w - seen(s)));
const padStart = (s, w) => ' '.repeat(Math.max(0, w - seen(s))) + String(s);

async function dashboard(outletId) {
  const url = `${BASE}/dashboard?outletid=${encodeURIComponent(outletId)}&start=${start}&end=${end}`;
  const res = await fetch(url, {
    headers: process.env.API_TOKEN ? { 'x-api-token': process.env.API_TOKEN } : {},
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.status !== 'success') {
    throw new Error((json && json.message) || `HTTP ${res.status}`);
  }
  return json.data || {};
}

if (!isConfigured()) {
  console.error('ยังไม่ได้ตั้งค่า HR_DB_USER / HR_DB_PASSWORD ใน office-server/.env');
  process.exit(2);
}

try {
  const branches = await queryRead(
    `SELECT branch, branch_name, outlet_id FROM dbo.hr_branch
      WHERE is_active = 1 AND outlet_id IS NOT NULL ORDER BY branch`
  );
  console.log(`ยอดขาย ${start} ถึง ${end} · ${branches.length} สาขา · ผ่าน ${BASE}`);
  console.log('─'.repeat(88));
  // แยกคอลัมน์ Premium 359 (ขายตรงด้วย 101002) ออกจาก UP100 — ตัวเลข buffet359 ที่ /dashboard
  // คืนมารวมสองอย่างไว้ด้วยกัน ถ้าโชว์ดิบ ๆ สาขา UP100 ล้วนจะเห็นเลข 359 เท่ากับ UP100 แล้วงงว่าขายทั้งสองแบบ
  console.log(`  ${padEnd('สาขา', 7)}${padEnd('ชื่อ', 24)}${padStart('หัว 259', 10)}${padStart('UP100', 9)}${padStart('Premium 359', 13)}   สรุป`);

  const rows = [];
  for (const b of branches) {
    const code = String(b.branch || '').toLowerCase();
    try {
      const d = await dashboard(b.outlet_id);
      const groups = d.coversBreakdown || [];
      const qtyOf = (key) => num(groups.find((g) => g.key === key)?.qty);
      const up100 = num(d.up100Qty);
      // coversBreakdown หักหัวที่อัพเกรดออกจากกลุ่ม 259 ไปแล้ว บวกกลับเพื่อให้เห็นหัว 259 ทั้งหมด
      const q259 = qtyOf('buffet259') + up100;
      const q359 = qtyOf('buffet359');
      const premiumOnly = Math.max(0, q359 - up100);   // 359 ที่ขายตรง ไม่ใช่ค่าอัพเกรด
      const verdict = up100 > 0
        ? (premiumOnly > 0 ? 'UP100 + Premium 359 ปนกัน' : 'UP100')
        : (q359 > 0 ? 'Premium 359' : (q259 > 0 ? 'ราคาเดียว' : 'ไม่มียอดหัวในช่วงนี้'));
      rows.push({ code, name: b.branch_name || '', q259, q359, premiumOnly, up100, verdict });
    } catch (e) {
      rows.push({ code, name: b.branch_name || '', err: e.message });
    }
  }

  for (const r of rows) {
    if (r.err) {
      console.log(`  ${padEnd(r.code, 7)}${padEnd(r.name, 24)}${padStart('-', 10)}${padStart('-', 9)}${padStart('-', 13)}   ⚠️ ${r.err}`);
      continue;
    }
    console.log(`  ${padEnd(r.code, 7)}${padEnd(r.name, 24)}${padStart(int(r.q259), 10)}${padStart(int(r.up100), 9)}${padStart(int(r.premiumOnly), 13)}   ${r.verdict}`);
  }

  const up100Branches = rows.filter((r) => !r.err && r.up100 > 0).map((r) => r.code);
  const twoTier = rows.filter((r) => !r.err && r.up100 === 0 && r.q359 > 0).map((r) => r.code);
  const single = rows.filter((r) => !r.err && r.q359 === 0 && r.q259 > 0).map((r) => r.code);
  const quiet = rows.filter((r) => !r.err && r.q259 === 0 && r.q359 === 0).map((r) => r.code);
  const failed = rows.filter((r) => r.err).map((r) => r.code);

  console.log('─'.repeat(88));
  console.log(`สาขาหัว UP100 (${up100Branches.length}): ${up100Branches.join(', ') || '-'}`);
  console.log(`สาขาหัว 2 ราคาแบบ Premium 359 (${twoTier.length}): ${twoTier.join(', ') || '-'}`);
  console.log(`สาขาราคาเดียว (${single.length}): ${single.join(', ') || '-'}`);
  if (quiet.length) console.log(`ไม่มียอดหัวในช่วงนี้ (${quiet.length}): ${quiet.join(', ')}`);
  if (failed.length) console.log(`ถามยอดไม่สำเร็จ (${failed.length}): ${failed.join(', ')}`);
  console.log('');
  console.log('UP100 = ค่าอัพเกรด 259 -> 359 (รหัส 101116) หัวนั้นถูกนับเป็นหัว 259 ไปแล้ว ไม่ใช่หัวเพิ่ม');
  console.log('สาขาที่เพิ่งเริ่มขาย 2 ราคาในช่วงนี้ยอดจะยังน้อย — ถ้าน้อยจนหน้าเว็บตรวจไม่เจอ ให้ใส่รหัสสาขา');
  console.log('ใน TWO_TIER_BRANCHES ที่ src/pages/StockList.jsx');
  process.exit(0);
} catch (err) {
  console.error('ทำงานไม่สำเร็จ:', describeDbError ? describeDbError(err) : err.message);
  process.exit(2);
}
