import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronUp } from 'lucide-react';

// คู่มือกล่องยูนิฟอร์มพนักงาน (ปุ่มรูปเสื้อในหน้ารายชื่อพนักงาน)
// ย่อเก็บไว้เป็นค่าเริ่มต้นเหมือน StockGuide — คนที่ใช้ประจำไม่ต้องเลื่อนผ่าน กดเปิดดูเมื่อต้องการ
// ชื่อปุ่ม/หัวข้อที่อ้างถึงในนี้ต้องตรงกับที่เขียนไว้ใน pages/EmployeeList.jsx
const SECTIONS = [
  {
    title: 'บันทึกยูนิฟอร์มที่พนักงานได้รับ',
    color: 'green',
    steps: [
      'เข้าเมนู "พนักงาน" แล้วเลือก "รายชื่อพนักงาน" จากนั้นกดปุ่ม "ยูนิฟอร์ม" ในแถวของพนักงานคนนั้น',
      'พิมพ์รหัสหรือชื่อไอเทมในช่องค้นหา เช่น "เสื้อ" แล้วคลิกเลือกไอเทมจากรายการ',
      'ใส่จำนวน แล้วกด "เพิ่มไอเทม" (ทำซ้ำได้หลายไอเทม รายการจะไปอยู่ใน "รายการที่จะบันทึก")',
      'เลือก "วันที่จ่ายของ" ตามวันที่พนักงานรับของจริง (ย้อนหลังได้)',
      'กด "บันทึกข้อมูล" สีเขียว รายการจะขึ้นใน "ประวัติที่เคยจ่าย" ทันที',
    ],
    note: 'บันทึกผิด ให้กดรูปถังขยะท้ายแถวใน "ประวัติที่เคยจ่าย" เพื่อลบ แล้วบันทึกใหม่ (แก้ไขแถวเดิมไม่ได้)',
  },
  {
    title: 'เบิกยูนิฟอร์มเข้าสาขา',
    color: 'indigo',
    steps: [
      'กดปุ่ม "ยูนิฟอร์ม" ในแถวของพนักงานที่จะได้รับของ (ใบเบิกจะลงชื่อพนักงานคนนี้เป็นผู้ขอเบิก)',
      'ค้นหาไอเทม ใส่จำนวน แล้วกด "เพิ่มไอเทม" ให้ครบทุกรายการที่จะเบิก',
      'เลือก "วันที่ต้องการรับของ (สำหรับเบิก)"',
      'กด "เบิกเข้าสาขา" สีน้ำเงิน ระบบจะแจ้งเลขที่ใบเบิกที่มุมขวาบน',
      'ใบเบิกขึ้นในส่วน "ขอเบิกเข้าสาขาไว้" สีส้ม และปุ่ม "ยูนิฟอร์ม" ในหน้ารายชื่อจะมีป้าย "เบิก" บอกจำนวนที่ขอไว้',
    ],
    note: 'ใบเบิกยูนิฟอร์มเป็นใบเบิกชุดเดียวกับหน้านับสต๊อก ดูสถานะได้ที่ "ใบเบิกค้าง" ในหน้านับสต๊อกและขอเบิก',
  },
  {
    title: 'เมื่อของที่เบิกมาถึงสาขา',
    color: 'amber',
    steps: [
      'เปิดกล่องยูนิฟอร์มของพนักงานคนนั้น ดูส่วน "ขอเบิกเข้าสาขาไว้" ว่าขออะไรไว้เท่าไหร่',
      'ตอนส่งของให้พนักงาน เพิ่มไอเทมตามที่ได้รับจริง แล้วกด "บันทึกข้อมูล" (ขั้นตอนเดียวกับหัวข้อแรก)',
      'ตรวจใน "ประวัติที่เคยจ่าย" ว่าขึ้นครบ',
    ],
    note: 'การเบิกกับการบันทึกแยกกัน: กดเบิกแล้วยังไม่นับว่าพนักงานได้รับของ ต้องกด "บันทึกข้อมูล" ตอนส่งของจริงด้วยทุกครั้ง',
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
          <span className="text-sm font-bold text-gray-800">📖 คู่มือเบิกและบันทึกยูนิฟอร์ม</span>
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
