import { queryRead, replyDbError } from '../lib/mysql.js';
import { outletIdOf } from '../lib/branchOutlet.js';

// ใบรับ (ยอดรับเข้าสาขา) — ดึงตรงจาก MySQL: inventory.dyndns.tv / myfbdata.trans
// ของที่รับเข้าสาขาถูกบันทึกเป็น Trn_Type IN ('TRF','RCV') โดยปลายทาง Trn_To = เลขสาขา
// (ต้องกรอง type เพราะ SLS = การขาย ก็มี Trn_To = สาขาเช่นกัน)

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


  const branchKey = String(branch).toLowerCase().trim();
  const outletId = queryOutletId || outletIdOf(branchKey) || branchKey;

  try {
    const rows = await queryRead(
      `SELECT Trn_itemCode AS itemCode, Trn_Unit AS unit,
              DATE_FORMAT(Trn_DocDate, '%Y-%m-%d') AS d,
              SUM(Trn_InvQty) AS qty
         FROM trans
        WHERE Trn_Type IN ('TRF','RCV')
          AND Trn_To = ?
          AND Trn_DocDate BETWEEN ? AND ?
        GROUP BY Trn_itemCode, Trn_Unit, d`,
      [outletId, startDate, endDate]
    );

    const receivedMap = {};
    for (const r of rows) {
      if (!r.itemCode) continue;
      const normId = String(r.itemCode).replace(/^0+/, '').toLowerCase();
      const qty = Number(r.qty) || 0;
      if (!receivedMap[normId]) {
        receivedMap[normId] = { total: 0, details: {}, unit: r.unit || '' };
      }
      receivedMap[normId].total += qty;
      receivedMap[normId].details[r.d] = (receivedMap[normId].details[r.d] || 0) + qty;
      if (!receivedMap[normId].unit && r.unit) receivedMap[normId].unit = r.unit;
    }

    // Fix floating point precision
    Object.keys(receivedMap).forEach(key => {
      receivedMap[key].total = Number(receivedMap[key].total.toFixed(2));
      Object.keys(receivedMap[key].details).forEach(dateKey => {
        receivedMap[key].details[dateKey] = Number(receivedMap[key].details[dateKey].toFixed(2));
      });
    });

    return res.status(200).json({ status: 'success', data: receivedMap });
  } catch (error) {
    return replyDbError(res, error, 'orderd');
  }
}
