// กรอกรายจ่าย (ต้นทุนจาก Supplier + ผัก/ผลไม้) — ตาราง dbo.stock_sup_cost (ดู sql/supcost-001-table.sql)
//
// ย้ายมาจาก Apps Script (saveSupCost / getSupCost ที่เขียนชีท "ต้นทุนจากsup") กติกาเดิมทุกข้อ:
//   - หนึ่งแถวต่อ (วันที่ + สาขา + สินค้า) บันทึกซ้ำวันเดิมแก้ทับแถวเดิม
//   - ราคาที่หน้าเว็บส่งมาเป็นตัวหลักเสมอ (manualPrice = ราคาที่สาขาพิมพ์เอง เช่นผักทุกแถว)
//     ส่งราคามาไม่ครบค่อยถอยไปใช้ราคาในทะเบียนสินค้า (แทนชีทราคากลาง 8.2 ที่ Apps Script ใช้)
//   - จำนวน 0 = แก้แถวที่เคยบันทึกไว้ให้เป็น 0 · ไม่มีแถวเดิมก็ข้าม (ไม่สร้างแถว 0 ใหม่)
//
// สาขาเทียบแบบตรงตัวเหมือนในชีท ไม่รวมรหัสพี่น้อง (zjp/sjp) — ยอดในสรุปกำไรจึงเท่าเดิมทุกบาท
// และบันทึกด้วยรหัสไหนก็แก้ได้ด้วยรหัสนั้น ไม่เกิดแถวซ้ำข้ามรหัส

import { sql, stockDb } from './hr-db.js';
import { branchFor } from './hr-session.js';

const { queryRead, withTransaction } = stockDb;

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** รหัสที่ normalize แล้ว — ต้องให้ผลตรงกับ normCode() ใน stock.js เป๊ะ */
const normCode = (v) => str(v).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

const badRequest = (msg) => Object.assign(new Error(msg), { badRequest: true });

const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(str(v));

const two = (n) => String(n).padStart(2, '0');
function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** บันทึกรายจ่ายของ (สาขา + วันที่) — body: { branch, date, recorder, items:[{code,name,unit,qty,price,manualPrice}] } */
async function saveSupCost(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const date = str(body.date);
  const recorder = str(body.recorder) || str(session?.username) || 'Unknown';
  const items = Array.isArray(body.items) ? body.items : [];
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  if (!isYmd(date)) throw badRequest('ไม่ระบุวันที่');
  if (items.length === 0) throw badRequest('ไม่มีรายการที่กรอกจำนวน');

  // ราคาสำรองจากทะเบียนสินค้า — ใช้เฉพาะรายการปกติที่หน้าเว็บส่งราคามาไม่ครบ
  const needFallback = items
    .filter((it) => !it.manualPrice && !(parseFloat(it.price) > 0))
    .map((it) => normCode(it.code))
    .filter(Boolean);
  const registryPrice = {};
  if (needFallback.length) {
    const params = {};
    const list = [...new Set(needFallback)].map((k, i) => {
      params[`k${i}`] = { type: sql.NVarChar(50), value: k };
      return `@k${i}`;
    }).join(', ');
    const rows = await queryRead(`SELECT item_key, price FROM dbo.stock_item WHERE item_key IN (${list})`, params);
    for (const r of rows) registryPrice[normCode(r.item_key)] = Number(r.price) || 0;
  }

  const rows = [];
  for (const it of items) {
    const qty = parseFloat(it.qty);
    if (!Number.isFinite(qty) || qty < 0) continue;
    const code = str(it.code);
    const key = normCode(code);
    if (!key) continue;
    const sent = parseFloat(it.price);
    let unitPrice;
    if (it.manualPrice) unitPrice = Number.isFinite(sent) ? sent : 0;
    else if (Number.isFinite(sent) && sent > 0) unitPrice = sent;
    else unitPrice = registryPrice[key] || 0;
    rows.push({ key, code, name: str(it.name), unit: str(it.unit), qty, unitPrice, amount: round2(qty * unitPrice) });
  }
  if (rows.length === 0) throw badRequest('ไม่มีรายการที่กรอกจำนวนถูกต้อง');

  const now = localStamp();
  let created = 0, updated = 0, total = 0;
  await withTransaction(async (run) => {
    for (const r of rows) {
      const p = {
        cost_date: { type: sql.NVarChar(10), value: date },
        branch: { type: sql.NVarChar(50), value: branch },
        item_key: { type: sql.NVarChar(50), value: r.key },
        item_code: { type: sql.NVarChar(50), value: r.code },
        item_name: { type: sql.NVarChar(255), value: r.name || null },
        unit: { type: sql.NVarChar(50), value: r.unit || null },
        qty: { type: sql.Decimal(18, 3), value: r.qty },
        unit_price: { type: sql.Decimal(18, 4), value: r.unitPrice },
        amount: { type: sql.Decimal(18, 2), value: r.amount },
        recorder: { type: sql.NVarChar(255), value: recorder },
        now: { type: sql.NVarChar(19), value: now },
      };
      // แก้แถวเดิมก่อน (จำนวน/ราคา/มูลค่า + เวลาแก้ไข เหมือนคอลัมน์ F,G,H,K ในชีท) ไม่มีค่อยเพิ่มใหม่
      // UPDLOCK + HOLDLOCK กันสองเครื่องกดบันทึกวันเดียวกันพร้อมกันแล้วชน unique key
      const res = await run(
        `UPDATE dbo.stock_sup_cost WITH (UPDLOCK, HOLDLOCK)
            SET qty = @qty, unit_price = @unit_price, amount = @amount,
                updated_at = CONVERT(DATETIME2(0), @now, 120), updated_by = @recorder
          WHERE cost_date = CONVERT(DATE, @cost_date, 120) AND branch = @branch AND item_key = @item_key;
         SELECT @@ROWCOUNT AS n;`,
        p
      );
      const n = Number(res.recordset?.[0]?.n) || 0;
      if (n > 0) {
        updated++;
      } else if (r.qty > 0) {
        await run(
          `INSERT INTO dbo.stock_sup_cost
             (cost_date, branch, item_key, item_code, item_name, unit, qty, unit_price, amount, recorder, saved_at, source)
           VALUES (CONVERT(DATE, @cost_date, 120), @branch, @item_key, @item_code, @item_name, @unit,
                   @qty, @unit_price, @amount, @recorder, CONVERT(DATETIME2(0), @now, 120), N'web');`,
          p
        );
        created++;
      } else {
        continue; // จำนวน 0 และไม่มีแถวเดิม — ไม่มีอะไรต้องแก้
      }
      total += r.amount;
    }
  });

  total = round2(total);
  return {
    message: `บันทึกแล้ว ${created + updated} รายการ (ใหม่ ${created} / แก้ไข ${updated}) รวม ฿${total.toFixed(2)}`,
    count: created + updated,
    updated,
    total,
  };
}

/** รายจ่ายที่บันทึกไว้ของ (สาขา + วันที่) มาแก้ในหน้ากรอกรายจ่าย — { รหัสที่ตัด 0 นำหน้า: {qty, price, amount} } */
async function getSupCost(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const date = str(body.date);
  if (!branch || !isYmd(date)) return {};
  const rows = await queryRead(
    `SELECT item_key, qty, unit_price, amount
       FROM dbo.stock_sup_cost
      WHERE branch = @branch AND cost_date = CONVERT(DATE, @cost_date, 120)`,
    {
      branch: { type: sql.NVarChar(50), value: branch },
      cost_date: { type: sql.NVarChar(10), value: date },
    }
  );
  const out = {};
  for (const r of rows) {
    out[normCode(r.item_key)] = { qty: Number(r.qty), price: Number(r.unit_price), amount: Number(r.amount) };
  }
  return out;
}

/**
 * แถวรายจ่ายของสาขาในช่วงวันที่ — ใช้จาก /api/stockcount
 *   - สรุปกำไร: รายจ่ายจาก Supplier ในช่วง [from, to]
 *   - หน้านับสต๊อก (?supreceived=1): รวมเป็น "ยอดรับ"
 * from/to ว่าง = ไม่จำกัดด้านนั้น · เรียงตามวันที่แล้วตามลำดับที่บันทึก
 */
async function getSupCostRows(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  if (!branch) throw badRequest('ระบุสาขา');
  const from = isYmd(body.from) ? str(body.from) : '0001-01-01';
  const to = isYmd(body.to) ? str(body.to) : '9999-12-31';
  const rows = await queryRead(
    `SELECT CONVERT(NVARCHAR(10), cost_date, 23) AS date_text, item_code, item_name, unit, qty, unit_price, amount
       FROM dbo.stock_sup_cost
      WHERE branch = @branch
        AND cost_date BETWEEN CONVERT(DATE, @from, 120) AND CONVERT(DATE, @to, 120)
      ORDER BY cost_date, sup_id`,
    {
      branch: { type: sql.NVarChar(50), value: branch },
      from: { type: sql.NVarChar(10), value: from },
      to: { type: sql.NVarChar(10), value: to },
    }
  );
  return rows.map((r) => ({
    date: r.date_text,
    code: str(r.item_code),
    name: str(r.item_name),
    unit: str(r.unit),
    qty: Number(r.qty) || 0,
    unitPrice: Number(r.unit_price) || 0,
    amount: Number(r.amount) || 0,
  }));
}

export const SUPCOST_ACTIONS = {
  saveSupCost,
  getSupCost,
  getSupCostRows,
};
