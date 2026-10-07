import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronUp } from 'lucide-react';

// คู่มือกล่องยูนิฟอร์มพนักงาน (ปุ่มรูปเสื้อในหน้ารายชื่อพนักงาน)
// ย่อเก็บไว้เป็นค่าเริ่มต้นเหมือน StockGuide — คนที่ใช้ประจำไม่ต้องเลื่อนผ่าน กดเปิดดูเมื่อต้องการ
// ชื่อปุ่ม/หัวข้อที่อ้างถึงในนี้ต้องตรงกับที่เขียนไว้ใน pages/EmployeeList.jsx
const SECTIONS = [
  {
    title: '1. ส่งคำขอเบิกยูนิฟอร์ม',
    color: 'indigo',
    steps: [
      'เข้าเมนู "พนักงาน" > "รายชื่อพนักงาน" แล้วกดปุ่ม "ยูนิฟอร์ม" ในแถวของพนักงานที่จะได้รับของ',
      'ค้นหาไอเทม (กด "ดูรายละเอียด" เพื่อดูรูปสเปคก่อนได้) ใส่จำนวน แล้วกด "เพิ่มไอเทม" ให้ครบทุกรายการ — แถวพื้นม่วงคือยังไม่ได้ส่ง',
      'เลือก "วันที่ต้องการรับ"',
      'กด "ส่งคำขอเบิก" แถวจะขึ้นสถานะ "กำลังรออนุมัติ"',
    ],
    note: 'สาขาไม่ต้องออกใบเบิกเอง ใบเบิกจะออกให้โกดังเมื่อออฟฟิศกด "อนุมัติเบิก"',
  },
  {
    title: '2. ติดตามสถานะ',
    color: 'amber',
    steps: [
      '"กำลังรออนุมัติ" — ออฟฟิศยังไม่ได้ดู',
      '"รอสินค้าเข้า" — ออฟฟิศรับเรื่องแล้ว แต่ของยังไม่มี',
      '"อนุมัติเบิก" — ออกใบเบิกแล้ว (เลขที่ใบเบิกขึ้นใต้สถานะ)',
      '"กำลังรอจัดส่ง" — ของกำลังส่งมาที่สาขา ปุ่มในหน้ารายชื่อจะขึ้นป้ายสีเขียว "รอรับ"',
    ],
  },
  {
    title: '3. เมื่อของมาถึง',
    color: 'green',
    steps: [
      'เปิดกล่องยูนิฟอร์มของพนักงานคนนั้น',
      'แถวที่เป็น "กำลังรอจัดส่ง" กด "ได้รับของแล้ว" สีเขียว',
      'สถานะเปลี่ยนเป็น "ได้รับของแล้ว" ถือว่าจบงาน และนับว่าพนักงานได้รับยูนิฟอร์มชิ้นนั้นแล้ว',
    ],
    note: 'กดได้รับของเฉพาะเมื่อของถึงมือจริง กดแล้วย้อนกลับเองไม่ได้ (ติดต่อออฟฟิศ)',
  },
];

const COLOR = {
  green: { chip: 'bg-green-100 text-green-700', text: 'text-green-800', dot: 'bg-green-600' },
  indigo: { chip: 'bg-indigo-100 text-indigo-700', text: 'text-indigo-800', dot: 'bg-indigo-600' },
  amber: { chip: 'bg-amber-100 text-amber-700', text: 'text-amber-800', dot: 'bg-amber-600' },
};

export default function UniformGuide() {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-sky-100 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-2.5 flex items-center justify-between gap-3 bg-sky-50/60 hover:bg-sky-50 transition-colors"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <BookOpen className="w-4 h-4 text-sky-600 shrink-0" />
          <span className="text-sm font-bold text-gray-800">📖 คู่มือขอเบิกยูนิฟอร์ม</span>
        </div>
        <span className="flex items-center gap-1.5 text-xs font-medium text-sky-600 shrink-0">
          {open ? 'ซ่อนคู่มือ' : 'เปิดดูคู่มือ'}
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-3 border-t border-sky-100 grid grid-cols-1 md:grid-cols-3 gap-5">
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
