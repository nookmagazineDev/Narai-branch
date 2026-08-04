import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronUp } from 'lucide-react';

// คู่มือการนับสต๊อกและขอเบิกสินค้า — เนื้อหาตามไฟล์คู่มือ (PDF) ที่ฝ่ายปฏิบัติการทำไว้
// ย่อเก็บไว้เป็นค่าเริ่มต้น เพื่อไม่ให้ดันตารางนับสต๊อกที่ใช้งานทุกวันลงไปไกล — กดเปิดดูเมื่อต้องการ
const SECTIONS = [
  {
    title: 'นับสต๊อกและขอเบิกสินค้า',
    color: 'purple',
    steps: [
      'เลือกเมนู "สต๊อก" → "นับสต๊อกและขอเบิก"',
      'เลือกพนักงานนับสต๊อก',
      'กรอกจำนวนยอดคงเหลือของแต่ละรายการ',
      'กด "บันทึกข้อมูล"',
      'เลือกวันที่ใช้ของ แล้วกด "คำนวณยอดเบิก" (จะมีข้อความแจ้งเตือนขึ้นมุมขวาบนของเว็บ)',
      'ตรวจสอบตัวเลขในช่อง "ขอเบิก" ที่ระบบคำนวณให้',
      'กดปุ่ม "สั่งของ"',
      'เลื่อนลงด้านล่างสุด เลือกวันที่รับสินค้า แล้วกด "ยืนยันสั่งของ"',
    ],
    note: 'หลังกดบันทึกข้อมูล ให้ดูตัวเลขยอดคงเหลืออีกครั้ง — ถ้าตัวเลขยังไม่เปลี่ยน ให้กด F5 เพื่อรีเฟรชหน้าเว็บ',
  },
  {
    title: 'การสั่งสินค้าแพลน / สั่งเพิ่มเติม',
    color: 'teal',
    steps: [
      'กดปุ่ม "สั่งสินค้าแพลน/สั่งเพิ่มเติม"',
      'ใส่รายละเอียดสินค้า จำนวน และวันที่รับ แล้วกด "+ เพิ่มรายการลงตะกร้า"',
      'รายการจะเข้าไปอยู่ในตะกร้า จากนั้นกด "ตรวจสอบก่อนส่ง" เพื่อยืนยัน',
    ],
  },
  {
    title: 'ใบเบิกค้าง',
    color: 'amber',
    steps: [
      'กดปุ่ม "ใบเบิกค้าง"',
      'ดูเลขที่ใบเบิกที่เพิ่งสั่งไป และกดที่แถวเพื่อดูรายการสินค้าในใบนั้น',
      'ดาวน์โหลดข้อมูลได้ที่ปุ่ม Export — มีทั้งไฟล์ตาราง (Excel) และ PDF',
    ],
  },
];

const COLOR = {
  purple: { chip: 'bg-purple-100 text-purple-700', text: 'text-purple-800', dot: 'bg-purple-600' },
  teal: { chip: 'bg-teal-100 text-teal-700', text: 'text-teal-800', dot: 'bg-teal-600' },
  amber: { chip: 'bg-amber-100 text-amber-700', text: 'text-amber-800', dot: 'bg-amber-600' },
};

export default function StockGuide() {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-gray-50/70 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 rounded-xl bg-sky-100 text-sky-600 shrink-0">
            <BookOpen className="w-5 h-5" />
          </div>
          <div className="text-left min-w-0">
            <h2 className="font-bold text-gray-800 text-sm">📖 คู่มือการนับสต๊อกและขอเบิกสินค้า</h2>
            <p className="text-xs text-gray-400 mt-0.5 truncate">ขั้นตอนการนับสต๊อก · สั่งของ · สั่งสินค้าแพลน · ดูใบเบิกค้าง</p>
          </div>
        </div>
        <span className="flex items-center gap-1.5 text-xs font-medium text-sky-600 shrink-0">
          {open ? 'ซ่อนคู่มือ' : 'เปิดดูคู่มือ'}
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>

      {open && (
        <div className="px-5 pb-5 pt-1 border-t border-gray-100 grid grid-cols-1 lg:grid-cols-3 gap-5">
          {SECTIONS.map((sec) => {
            const c = COLOR[sec.color];
            return (
              <div key={sec.title}>
                <div className={`inline-block px-2.5 py-1 rounded-full text-xs font-bold mb-3 ${c.chip}`}>
                  {sec.title}
                </div>
                <ol className="space-y-2">
                  {sec.steps.map((step, i) => (
                    <li key={i} className="flex gap-2.5 text-sm text-gray-700 leading-relaxed">
                      <span className={`shrink-0 w-5 h-5 rounded-full ${c.dot} text-white text-[11px] font-bold flex items-center justify-center mt-0.5`}>
                        {i + 1}
                      </span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
                {sec.note && (
                  <p className={`mt-3 text-xs ${c.text} bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 leading-relaxed`}>
                    ⚠️ {sec.note}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
