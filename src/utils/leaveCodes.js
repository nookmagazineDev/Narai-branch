// ประเภทการลาที่ใช้ในหน้าลงตารางงาน
//
// เก็บลงฐานข้อมูลเป็น "รหัส" ล้วน (เช่น '13') เพราะฝ่ายบุคคลเอารหัสไปทำรายงานต่อ
// ส่วนชื่อไทยใช้ตอนแสดงผลเท่านั้น แปลงด้วย leaveText()
//
// รหัสห้ามซ้ำข้ามสองชุด — '13 ป่วย' (รับค่าแรง) กับ '21 ป่วย' (ไม่รับค่าแรง)
// เป็นคนละอย่างกัน ถ้าใช้รหัสเดียวกันจะแยกไม่ออกตอนคิดเงิน

export const PAID_LEAVE = [
  { code: '10', label: 'หยุด' },
  { code: '11', label: 'ชดเชย' },
  { code: '12', label: 'V' },
  { code: '13', label: 'ป่วย' },
  { code: '14', label: 'กิจ' },
  { code: '15', label: 'cd off' },
  { code: '16', label: 'M, ประชุม' },
  { code: '17', label: 'คลอด' },
  { code: '19', label: 'อบรม' },
  { code: '80', label: '8hr' },
];

export const UNPAID_LEAVE = [
  { code: '21', label: 'ป่วย' },
  { code: '22', label: 'กิจ' },
  { code: '23', label: 'ขาดงาน' },
];

const LABEL_BY_CODE = new Map(
  [...PAID_LEAVE, ...UNPAID_LEAVE].map(({ code, label }) => [code, label])
);

/**
 * แปลงค่าที่เก็บไว้ให้เป็นข้อความที่คนอ่านรู้เรื่อง
 *   '13'         -> '13 ป่วย'
 *   '13 ป่วย'     -> '13 ป่วย'   (แถวที่บันทึกช่วงที่เคยเก็บทั้งก้อน)
 *   'ลากิจ'       -> 'ลากิจ'     (ข้อมูลเก่าก่อนเปลี่ยนมาใช้รหัส)
 */
export const leaveText = (value) => {
  const v = String(value ?? '').trim();
  if (!v) return '';
  const label = LABEL_BY_CODE.get(v);
  if (label) return `${v} ${label}`;
  // ค่าที่ขึ้นต้นด้วยรหัสอยู่แล้ว หรือเป็นข้อความเก่า — คืนตามเดิม
  return v;
};

/** เอาเฉพาะรหัสไปใช้ต่อ (ข้อมูลเก่าที่ไม่มีรหัสจะได้ค่าว่าง) */
export const leaveCode = (value) => {
  const v = String(value ?? '').trim();
  const first = v.split(/\s+/)[0];
  return LABEL_BY_CODE.has(first) ? first : '';
};
