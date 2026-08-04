import { queryRead, replyDbError } from '../lib/mysql.js';

// ใบเบิก (รายการเอกสารโอน/รับเข้าสาขา) — ดึงตรงจาก MySQL: inventory.dyndns.tv / myfbdata.trans
// จัดกลุ่มตาม Trn_InvNo (เลขที่ใบเบิก) พร้อมรายการสินค้าในแต่ละใบ
// ใช้เกณฑ์เดียวกับใบรับ: Trn_Type IN ('TRF','RCV') ที่ Trn_To = เลขสาขา ในช่วง Trn_DocDate

const r2 = (n) => Number((Number(n) || 0).toFixed(2));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Date');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { branch, startDate, endDate, outletId: queryOutletId } = req.query;

  if (!branch || !startDate || !endDate) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน' });
  }

  const branchMap = {
    'sjp': '7', 'crm': '12', 'xcm': '19', 'slr': '37', 'sum': '51',
    'xum': '59', 'scs': '61', 'smp': '63', 'xsb': '67', 'xhh': '72',
    'hrs': '78', 'clk': '79', 'p90': '80', 'hps': '109', 'zbw': '400',
    'zpt': '401', 'npt': '500', 'wrm': '501', 'wmt': '503', 'ipr': '904',
    'zk3': '906'
  };

  const branchKey = String(branch).toLowerCase().trim();
  const outletId = queryOutletId || branchMap[branchKey] || branchKey;

  try {
    // ตาราง trans มี 1.4 ล้านแถว ไม่มี index ตามสาขา/วันที่ — คิวรีตรงๆ กวาดทั้งตาราง (~5 วิ)
    // เร่งด้วยการบีบช่วงเลขเอกสาร (Trn_DocNo) ให้ MySQL ใช้ PRIMARY KEY (Trn_Type, Trn_DocNo นำหน้า)
    // เลขเอกสารเดินจากตัวนับกลาง config: TRF ใช้ Cfg_LstIss, RCV ใช้ Cfg_LstRcv (~15 เลข/วัน)
    let docNoFilter = '';
    let docNoParams = [];
    try {
      const cfg = await queryRead('SELECT Cfg_LstIss AS iss, Cfg_LstRcv AS rcv FROM config LIMIT 1');
      const lastIss = Number(cfg[0]?.iss) || 0;
      const lastRcv = Number(cfg[0]?.rcv) || 0;
      const days = Math.max(1, Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000) + 1)
        + Math.max(0, Math.ceil((Date.now() - new Date(endDate)) / 86400000)); // ย้อนถึงช่วงที่ขอ
      const span = days * 25 + 300; // อัตราจริง ~15 เลข/วัน — เผื่อไว้ ~1.7 เท่า (ยิ่งกว้างยิ่งช้า)
      if (lastIss > 0 && lastRcv > 0) {
        docNoFilter = `AND ((Trn_Type = 'TRF' AND Trn_DocNo BETWEEN ? AND ?)
                         OR (Trn_Type = 'RCV' AND Trn_DocNo BETWEEN ? AND ?))`;
        docNoParams = [lastIss - span, lastIss + 50, lastRcv - span, lastRcv + 50];
      }
    } catch (e) { /* อ่านตัวนับไม่ได้ → ใช้คิวรีเต็มตาราง */ }

    const rows = await queryRead(
      `SELECT Trn_InvNo AS invNo, Trn_Type AS docType, Trn_DocNo AS docNo,
              DATE_FORMAT(Trn_DocDate, '%Y-%m-%d') AS docDate,
              Trn_itemCode AS itemCode, Trn_itemName AS itemName,
              Trn_InvQty AS qty, Trn_Unit AS unit, Trn_UnitPr AS unitPrice
         FROM trans
        WHERE Trn_Type IN ('TRF','RCV')
          ${docNoFilter}
          AND Trn_To = ?
          AND Trn_DocDate BETWEEN ? AND ?
        ORDER BY Trn_DocDate DESC, Trn_InvNo DESC, Trn_Seq ASC`,
      [...docNoParams, outletId, startDate, endDate]
    );

    // จัดกลุ่มเป็นใบเบิกตาม Trn_InvNo
    const docsMap = {};
    const order = [];
    for (const r of rows) {
      const key = r.invNo || `DOC-${r.docNo}`;
      if (!docsMap[key]) {
        docsMap[key] = {
          invNo: r.invNo || '',
          docNo: r.docNo,
          docDate: r.docDate,
          docType: r.docType,
          items: [],
          itemCount: 0,
          totalQty: 0,
          totalAmt: 0,
        };
        order.push(key);
      }
      const qty = Number(r.qty) || 0;
      const price = Number(r.unitPrice) || 0;
      const doc = docsMap[key];
      doc.items.push({
        itemCode: r.itemCode || '',
        itemName: r.itemName || '',
        qty: r2(qty),
        unit: r.unit || '',
        unitPrice: r2(price),
        amount: r2(qty * price),
      });
      doc.itemCount += 1;
      doc.totalQty += qty;
      doc.totalAmt += qty * price;
    }

    const data = order.map(k => {
      const d = docsMap[k];
      d.totalQty = r2(d.totalQty);
      d.totalAmt = r2(d.totalAmt);
      return d;
    });

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return replyDbError(res, error, 'withdrawals');
  }
}
