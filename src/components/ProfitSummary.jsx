// ตารางสรุปกำไร/ขาดทุน (รายรับ–รายจ่าย)
//   รายรับ: Gross Sales / Tax / Sub Total / Net Sale (จากแดชบอร์ด = cpaidbetweendate)
//   ต้นทุน (Total Food Cost): ดึงจาก "ใบเบิก" (TRF/RCV) แยกหมวดตามช่วงรหัสสินค้า
//     กดหมวด → ดูรายการสินค้าในหมวด (มูลค่ารวมแต่ละตัว) → กดรายการ → ดูประวัติเบิก (วันที่/จำนวน/ราคา/หน่วย/มูลค่า)
//   ค่าใช้จ่ายอื่น (เช่า/น้ำ/ไฟ/…): กรอกเอง (ไม่บันทึกค่า)
//   กำไร = Net Sale − (Total Food Cost + ค่าใช้จ่ายรวม)
import { useEffect, useMemo, useState, useCallback } from 'react';
import { RefreshCw, X, Eye, Wallet, AlertCircle, ChevronRight, PieChart, Boxes } from 'lucide-react';
import { fetchWithdrawals, fetchStockCount } from '../services/dashboardApi';

const baht = (n) =>
  '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intf = (n) => Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const pct = (v, base) => (base ? `${((Number(v || 0) / base) * 100).toFixed(2)}%` : '0.00%');

// ───────── หมวดวัตถุดิบตามช่วงรหัส (เทียบเป็นเลขจำนวนเต็ม 8 หลัก) ─────────
const CATS = [
  { key: 'central', label: 'ครัวกลาง', test: (c) => c >= 1000001 && c <= 5000102 },
  { key: 'food', label: 'สินค้าประเภทอาหาร', test: (c) => c >= 11000001 && c <= 11050061 },
  { key: 'veg', label: 'ผัก,ผลไม้', test: (c) => c >= 11090003 && c <= 11090117 },
  { key: 'drink', label: 'เครื่องดื่ม', test: (c) => c >= 11100001 && c <= 11130025 },
  { key: 'supply', label: 'วัสดุใช้ไป', test: (c) => c >= 11300001 && c <= 11600020 },
  { key: 'consume', label: 'วัสดุสิ้นเปลือง', test: (c) => (c >= 11800001 && c <= 11800217) || c >= 41000001 },
  { key: 'other', label: 'อื่นๆ', test: () => true }, // fallback — รหัสนอกหมวด
];
const catOf = (code) => {
  const n = parseInt(String(code).replace(/\D/g, ''), 10) || 0;
  return (CATS.find((c) => c.test(n)) || CATS[CATS.length - 1]).key;
};

const EXPENSES = [
  { key: 'petty', label: 'Petty Cash' },
  { key: 'rent', label: 'ค่าเช่าพื้นที่' },
  { key: 'water', label: 'ค่าน้ำ' },
  { key: 'power', label: 'ค่าไฟ' },
  { key: 'ice', label: 'ค่าน้ำแข็ง' },
  { key: 'phone', label: 'ค่าโทรศัพท์' },
  { key: 'gas', label: 'ค่าแก๊ส' },
  { key: 'insurance', label: 'ค่าประกันภัย' },
];

// ───────── Modal: ประวัติการเบิกของสินค้าตัวเดียว ─────────
function ItemHistoryModal({ item, onClose }) {
  if (!item) return null;
  const lines = item.lines || [];
  const totalQty = lines.reduce((s, r) => s + (r.qty || 0), 0);
  const totalAmt = lines.reduce((s, r) => s + (r.amount || 0), 0);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 bg-gray-900 text-white flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-bold truncate">{item.itemName || '-'}</h3>
            <p className="text-xs text-gray-400 mt-0.5">รหัส <span className="font-mono">{item.itemCode}</span> • เบิก {lines.length} ครั้ง</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="overflow-auto max-h-[60vh] border border-gray-100 rounded-xl">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="text-gray-600">
                  <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">วันที่เบิก</th>
                  <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">เลขที่ใบเบิก</th>
                  <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">จำนวน</th>
                  <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">หน่วย</th>
                  <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">ราคา/หน่วย</th>
                  <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">มูลค่ารวม</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-gray-700">
                {lines.map((r, i) => (
                  <tr key={i} className="hover:bg-gray-50/50">
                    <td className="px-3 py-2 whitespace-nowrap">{r.docDate}</td>
                    <td className="px-3 py-2 font-mono text-gray-500">{r.invNo || '-'}</td>
                    <td className="px-3 py-2 text-right font-mono">{intf(r.qty)}</td>
                    <td className="px-3 py-2 text-gray-500">{r.unit || '-'}</td>
                    <td className="px-3 py-2 text-right font-mono text-gray-500">{baht(r.unitPrice)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold text-rose-600">{baht(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 border-t-2 border-gray-300 font-bold text-gray-800 sticky bottom-0">
                  <td className="px-3 py-2.5" colSpan={2}>รวม {lines.length} ครั้ง</td>
                  <td className="px-3 py-2.5 text-right font-mono">{intf(totalQty)}</td>
                  <td colSpan={2} />
                  <td className="px-3 py-2.5 text-right font-mono text-rose-700">{baht(totalAmt)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────── Modal: รายการสินค้าในหมวด (รวมต่อ itemCode) ─────────
function CategoryModal({ cat, onClose }) {
  const [selected, setSelected] = useState(null);
  if (!cat) return null;
  const items = cat.items || [];
  const totalAmt = items.reduce((s, r) => s + (r.totalAmount || 0), 0);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[86vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 bg-gray-900 text-white flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-bold">{cat.label}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{items.length} รายการ • รวม {baht(totalAmt)}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {items.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">ไม่มีรายการในหมวดนี้</div>
          ) : (
            <div className="overflow-auto max-h-[64vh] border border-gray-100 rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="text-gray-600">
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">ดู</th>
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">รหัส</th>
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">ชื่อรายการ</th>
                    <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">จำนวนรวม</th>
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">หน่วย</th>
                    <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">มูลค่ารวม</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {items.map((r, i) => (
                    <tr key={i} className="hover:bg-indigo-50/40 cursor-pointer" onClick={() => setSelected(r)}>
                      <td className="px-3 py-2"><span className="inline-flex items-center gap-1 px-2 py-1 border border-indigo-200 text-indigo-600 rounded-lg text-[10px] font-semibold"><Eye className="w-3 h-3" /> เบิก</span></td>
                      <td className="px-3 py-2 font-mono text-gray-400">{r.itemCode}</td>
                      <td className="px-3 py-2 font-medium text-gray-800">{r.itemName}</td>
                      <td className="px-3 py-2 text-right font-mono">{intf(r.totalQty)}</td>
                      <td className="px-3 py-2 text-gray-500">{r.unit || '-'}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-rose-600">{baht(r.totalAmount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-300 font-bold text-gray-800 sticky bottom-0">
                    <td className="px-3 py-2.5" colSpan={5}>รวมทั้งหมด</td>
                    <td className="px-3 py-2.5 text-right font-mono text-rose-700">{baht(totalAmt)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
      <ItemHistoryModal item={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// ───────── Modal: รายละเอียดมูลค่าสต๊อกคงเหลือ ─────────
function StockModal({ open, onClose, title, rows, countDate, total }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[86vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 bg-gray-900 text-white flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-bold flex items-center gap-2"><Boxes className="w-4 h-4 text-indigo-300" /> {title || 'มูลค่าสต๊อกคงเหลือ'}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{countDate ? `นับ ณ ${countDate} • ` : ''}{rows.length} รายการ • รวม {baht(total)}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {rows.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">ไม่มีข้อมูลสต๊อก</div>
          ) : (
            <div className="overflow-auto max-h-[64vh] border border-gray-100 rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="text-gray-600">
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">รหัส</th>
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">ชื่อสินค้า</th>
                    <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">คงเหลือ</th>
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">หน่วย</th>
                    <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">ราคาต้นทุน</th>
                    <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">มูลค่า</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {rows.map((r, i) => (
                    <tr key={i} className={`hover:bg-gray-50/50 ${!r.priced && r.qty > 0 ? 'bg-amber-50/40' : ''}`}>
                      <td className="px-3 py-2 font-mono text-gray-400">{r.itemCode}</td>
                      <td className="px-3 py-2 font-medium text-gray-800">{r.itemName}</td>
                      <td className="px-3 py-2 text-right font-mono">{intf(r.qty)}</td>
                      <td className="px-3 py-2 text-gray-500">{r.unit || '-'}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-500">{r.priced ? baht(r.unitPrice) : <span className="text-amber-600">ไม่มีราคา</span>}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-indigo-600">{baht(r.value)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-300 font-bold text-gray-800 sticky bottom-0">
                    <td className="px-3 py-2.5" colSpan={5}>รวมมูลค่าสต๊อก</td>
                    <td className="px-3 py-2.5 text-right font-mono text-indigo-700">{baht(total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────── Modal: รายจ่ายจาก Supplier (ชีท "ต้นทุนจากsup") ─────────
function SupCostModal({ open, onClose, items, total }) {
  if (!open) return null;
  const rows = items || [];
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[86vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 bg-gray-900 text-white flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-bold flex items-center gap-2"><Wallet className="w-4 h-4 text-rose-300" /> รายจ่ายจาก Supplier</h3>
            <p className="text-xs text-gray-400 mt-0.5">ชีท "ต้นทุนจากsup" • {rows.length} รายการ • รวม {baht(total)}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {rows.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">ไม่มีรายจ่ายจาก Supplier ในช่วงนี้</div>
          ) : (
            <div className="overflow-auto max-h-[64vh] border border-gray-100 rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="text-gray-600">
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">วันที่</th>
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">รหัส</th>
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">ชื่อรายการ</th>
                    <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">จำนวน</th>
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">หน่วย</th>
                    <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">ราคา/หน่วย</th>
                    <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">มูลค่า</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {rows.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-50/50">
                      <td className="px-3 py-2 whitespace-nowrap text-gray-500">{r.date}</td>
                      <td className="px-3 py-2 font-mono text-gray-400">{r.code}</td>
                      <td className="px-3 py-2 font-medium text-gray-800">{r.name}</td>
                      <td className="px-3 py-2 text-right font-mono">{intf(r.qty)}</td>
                      <td className="px-3 py-2 text-gray-500">{r.unit || '-'}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-500">{baht(r.unitPrice)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-rose-600">{baht(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-300 font-bold text-gray-800 sticky bottom-0">
                    <td className="px-3 py-2.5" colSpan={6}>รวมรายจ่ายจาก Supplier</td>
                    <td className="px-3 py-2.5 text-right font-mono text-rose-700">{baht(total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// แถวในตาราง P&L
function Row({ label, value, percent, bold, accent, indent, onClick, input }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 border-b border-gray-100 ${bold ? 'bg-gray-50 font-bold' : ''} ${onClick ? 'cursor-pointer hover:bg-indigo-50/50' : ''}`} onClick={onClick}>
      <span className={`flex-1 text-sm truncate ${indent ? 'pl-3' : ''} ${bold ? 'text-gray-800' : 'text-gray-600'}`}>
        {onClick && <ChevronRight className="inline w-3.5 h-3.5 -ml-1 mr-0.5 text-indigo-400" />}
        {label}
      </span>
      {input ? (
        input
      ) : (
        <span className={`w-32 text-right font-mono text-sm tabular-nums ${accent || (bold ? 'text-gray-800' : 'text-gray-700')}`}>{baht(value)}</span>
      )}
      <span className="w-16 text-right font-mono text-xs text-gray-400 tabular-nums">{percent}</span>
    </div>
  );
}

export default function ProfitSummary({ branch, outletId, startDate, endDate, dash }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lines, setLines] = useState(null);     // null = ยังไม่โหลด
  const [loadedRange, setLoadedRange] = useState('');
  const [expenses, setExpenses] = useState(() => Object.fromEntries(EXPENSES.map((e) => [e.key, ''])));
  const [member, setMember] = useState('');
  const [delivery, setDelivery] = useState('');
  const [openCat, setOpenCat] = useState(null);
  const [stock, setStock] = useState(null);       // { current:{countDate,items}, previous:{countDate,items} }
  const [stockModal, setStockModal] = useState(null); // { title, rows, countDate, total } | null
  const [supCost, setSupCost] = useState(null);   // { total, count, items:[...] } — รายจ่ายจากชีท "ต้นทุนจากsup"
  const [supModal, setSupModal] = useState(false);

  const rangeKey = `${startDate}~${endDate}`;
  const stale = lines !== null && loadedRange !== rangeKey;

  const load = useCallback(async () => {
    if (!branch && !outletId) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    try {
      const [wRes, sRes] = await Promise.all([
        fetchWithdrawals({ branch, outletId, startDate, endDate, signal: controller.signal }),
        fetchStockCount({ branch, startDate, endDate, signal: controller.signal }).catch(() => null), // ไม่มีข้อมูลสต๊อก/รายจ่ายก็ไม่เป็นไร
      ]);
      const flat = [];
      for (const doc of wRes.data || []) {
        for (const it of doc.items || []) {
          flat.push({
            itemCode: String(it.itemCode || ''),
            itemName: it.itemName || '-',
            qty: Number(it.qty) || 0,
            unit: it.unit || '',
            unitPrice: Number(it.unitPrice) || 0,
            amount: Number(it.amount) || 0,
            docDate: doc.docDate || '',
            invNo: doc.invNo || doc.docNo || '',
            cat: catOf(it.itemCode),
          });
        }
      }
      setLines(flat);
      setStock(sRes ? {
        current: { countDate: sRes.current?.countDate || '', data: sRes.current?.data || [] },
        previous: { countDate: sRes.previous?.countDate || '', data: sRes.previous?.data || [] },
      } : { current: { countDate: '', data: [] }, previous: { countDate: '', data: [] } });
      setSupCost(sRes?.supCost ? {
        total: Number(sRes.supCost.total) || 0,
        count: Number(sRes.supCost.count) || 0,
        items: sRes.supCost.items || [],
      } : { total: 0, count: 0, items: [] });
      setLoadedRange(rangeKey);
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || 'เกิดข้อผิดพลาด');
    } finally {
      setLoading(false);
    }
  }, [branch, outletId, startDate, endDate, rangeKey]);

  // โหลดใหม่อัตโนมัติเมื่อช่วงวันที่เปลี่ยน (เฉพาะถ้าเคยโหลดแล้ว)
  useEffect(() => {
    if (lines !== null && loadedRange !== rangeKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      load();
    }
  }, [rangeKey, lines, loadedRange, load]);

  // รวมต่อหมวด + ต่อ itemCode
  const cats = useMemo(() => {
    const byCat = Object.fromEntries(CATS.map((c) => [c.key, { ...c, total: 0, byItem: {} }]));
    for (const ln of lines || []) {
      const c = byCat[ln.cat] || byCat.other;
      c.total += ln.amount;
      const it = c.byItem[ln.itemCode] || (c.byItem[ln.itemCode] = { itemCode: ln.itemCode, itemName: ln.itemName, unit: ln.unit, totalQty: 0, totalAmount: 0, lines: [] });
      it.totalQty += ln.qty;
      it.totalAmount += ln.amount;
      it.lines.push({ docDate: ln.docDate, invNo: ln.invNo, qty: ln.qty, unit: ln.unit, unitPrice: ln.unitPrice, amount: ln.amount });
    }
    return CATS.map((c) => {
      const cc = byCat[c.key];
      const items = Object.values(cc.byItem)
        .map((it) => ({ ...it, lines: it.lines.sort((a, b) => String(a.docDate).localeCompare(String(b.docDate))) }))
        .sort((a, b) => b.totalAmount - a.totalAmount);
      return { key: c.key, label: c.label, total: cc.total, items };
    });
  }, [lines]);

  // ต้นทุนจากใบเบิก (รวมทุกหมวด) — เป็นส่วนหนึ่งของสูตร Total Food Cost
  const withdrawCost = cats.reduce((s, c) => s + c.total, 0);

  // มูลค่าสต๊อก (ราคาจากชีท 8.2 คิดมาจาก API แล้ว) — เดือนนี้ / เดือนที่แล้ว
  const curStock = useMemo(() => (stock?.current?.data || []).slice().sort((a, b) => b.value - a.value), [stock]);
  const prevStock = useMemo(() => (stock?.previous?.data || []).slice().sort((a, b) => b.value - a.value), [stock]);
  const curStockValue = useMemo(() => curStock.reduce((s, r) => s + (r.value || 0), 0), [curStock]);
  const prevStockValue = useMemo(() => prevStock.reduce((s, r) => s + (r.value || 0), 0), [prevStock]);
  const curUnpriced = useMemo(() => curStock.filter((r) => r.qty > 0 && !r.priced).length, [curStock]);

  // รายจ่ายจากชีท "ต้นทุนจากsup" (Supplier) ในช่วงวันที่เดียวกัน
  const supCostValue = Number(supCost?.total || 0);

  // Total Food Cost (COGS) = ต้นทุนจากใบเบิก + รายจ่ายจาก Supplier + สต๊อกต้นเดือน − สต๊อกปลายเดือน
  const totalFoodCost = withdrawCost + supCostValue + prevStockValue - curStockValue;

  // รายรับ
  const grossSales = Number(dash?.gross ?? ((dash?.sales || 0) + (dash?.tax || 0)));
  const tax = Number(dash?.tax ?? Math.max(grossSales - (dash?.sales || 0), 0));
  const subTotal = grossSales - tax;          // = ยอดขายก่อน VAT
  const netSale = subTotal;                   // Member/Delivery เป็นบันทึกอ้างอิง ไม่เข้าสูตร
  const expenseTotal = EXPENSES.reduce((s, e) => s + (parseFloat(expenses[e.key]) || 0), 0);
  const totalCost = totalFoodCost + expenseTotal;   // สรุปค่าใช้จ่ายรวม
  const profit = netSale - totalCost;

  const moneyInput = (val, set) => (
    <input
      type="number" inputMode="decimal" value={val} placeholder="0.00"
      onChange={(e) => set(e.target.value)}
      className="w-32 text-right font-mono text-sm px-2 py-1 border border-gray-200 rounded-lg focus:ring-2 focus:ring-indigo-400 focus:outline-none bg-amber-50/40"
    />
  );

  const notLoaded = lines === null;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      {/* หัวข้อ + แถบกำไร */}
      <div className="px-5 py-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-indigo-100 text-indigo-600 rounded-xl"><PieChart className="w-5 h-5" /></div>
          <div>
            <h2 className="text-lg font-bold text-gray-800">สรุปกำไร / ขาดทุน</h2>
            <p className="text-xs text-gray-400">รายรับจากการขาย • Total Food Cost = ใบเบิก + Supplier + สต๊อกต้นเดือน − ปลายเดือน • ค่าใช้จ่าย (กรอกเอง)</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {!notLoaded && (
            <div className="text-right">
              <div className={`text-xl font-bold tabular-nums ${profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{baht(profit)}</div>
              <div className="text-xs text-gray-400">{pct(profit, netSale)} ของ Net Sale</div>
            </div>
          )}
          <button
            onClick={load} disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {notLoaded ? 'โหลดต้นทุนจากใบเบิก' : 'รีเฟรช'}
          </button>
        </div>
      </div>

      {error && (
        <div className="m-4 flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" /> <span>{error}</span>
        </div>
      )}
      {stale && (
        <div className="mx-4 mt-3 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          ช่วงวันที่เปลี่ยนเป็น {startDate} ถึง {endDate} — กำลังอัปเดต…
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-gray-100">
        {/* ───── รายรับ ───── */}
        <div className="bg-white">
          <div className="px-3 py-2 bg-emerald-50 text-emerald-800 text-sm font-bold text-center">Sales (รายรับ)</div>
          <Row label="Gross Sales" value={grossSales} percent="100%" />
          <Row label="Tax (VAT)" value={tax} percent={pct(tax, grossSales)} accent="text-gray-500" />
          <Row label="Sub Total" value={subTotal} percent={pct(subTotal, grossSales)} bold />
          <Row label="ยอดขาย Member" percent={pct(parseFloat(member) || 0, grossSales)} input={moneyInput(member, setMember)} />
          <Row label="Delivery Service" percent={pct(parseFloat(delivery) || 0, grossSales)} input={moneyInput(delivery, setDelivery)} />
          <Row label="Net Sale" value={netSale} percent={pct(netSale, grossSales)} bold accent="text-emerald-700" />
          {stock && (
            <>
              <div className="px-3 pt-3 pb-1 text-xs font-bold text-indigo-700 flex items-center gap-1.5"><Boxes className="w-3.5 h-3.5" /> มูลค่าสต๊อกคงเหลือ</div>
              <Row
                label={`เดือนนี้${stock.current.countDate ? ` (นับ ${stock.current.countDate})` : ' (ยังไม่นับ)'}`}
                value={curStockValue} percent={pct(curStockValue, netSale)} indent accent="text-indigo-600"
                onClick={curStock.length ? () => setStockModal({ title: 'มูลค่าสต๊อกคงเหลือ (เดือนนี้)', rows: curStock, countDate: stock.current.countDate, total: curStockValue }) : undefined}
              />
              <Row
                label={`เดือนที่แล้ว${stock.previous.countDate ? ` (นับ ${stock.previous.countDate})` : ' (ไม่มีข้อมูล)'}`}
                value={prevStockValue} percent={pct(prevStockValue, netSale)} indent accent="text-indigo-500"
                onClick={prevStock.length ? () => setStockModal({ title: 'มูลค่าสต๊อกเดือนที่แล้ว', rows: prevStock, countDate: stock.previous.countDate, total: prevStockValue }) : undefined}
              />
              <p className="px-3 py-2 text-[11px] text-gray-400">
                * มูลค่าสต๊อก = ยอดคงเหลือสิ้นเดือน × ราคาต้นทุน (จากชีท 8.2) — เข้าสูตร Total Food Cost (ต้นเดือน + / ปลายเดือน −)
                {curUnpriced ? ` • เดือนนี้ ${curUnpriced} รายการไม่มีราคาในชีท 8.2` : ''}
              </p>
            </>
          )}
          <p className="px-3 py-2 text-[11px] text-gray-400">* Member / Delivery เป็นช่องบันทึกอ้างอิง (ยังไม่นำเข้าสูตรกำไร)</p>
        </div>

        {/* ───── ต้นทุน + ค่าใช้จ่าย ───── */}
        <div className="bg-white">
          <div className="px-3 py-2 bg-rose-50 text-rose-800 text-sm font-bold text-center">Cost (ต้นทุน + ค่าใช้จ่าย)</div>
          {notLoaded ? (
            <div className="py-12 text-center text-gray-400 text-sm">
              {loading ? (<><RefreshCw className="w-5 h-5 animate-spin inline mr-2" />กำลังดึงใบเบิก…</>) : 'กดปุ่ม “โหลดต้นทุนจากใบเบิก” เพื่อคำนวณ'}
            </div>
          ) : (
            <>
              {cats.map((c) => (
                <Row
                  key={c.key} label={c.label} value={c.total} percent={pct(c.total, netSale)}
                  accent="text-rose-600" onClick={c.items.length ? () => setOpenCat(c) : undefined}
                />
              ))}
              <Row label="รวมต้นทุนจากใบเบิก" value={withdrawCost} percent={pct(withdrawCost, netSale)} indent accent="text-rose-500" />
              <Row
                label={`+ รายจ่ายจาก Supplier${supCost?.count ? ` (${supCost.count} รายการ)` : ''}`}
                value={supCostValue} percent={pct(supCostValue, netSale)} indent accent="text-rose-500"
                onClick={supCost?.items?.length ? () => setSupModal(true) : undefined}
              />
              <Row
                label={`+ สต๊อกต้นเดือน${stock?.previous?.countDate ? ` (นับ ${stock.previous.countDate})` : ''}`}
                value={prevStockValue} percent={pct(prevStockValue, netSale)} indent accent="text-rose-500"
                onClick={prevStock.length ? () => setStockModal({ title: 'สต๊อกต้นเดือน (เดือนที่แล้ว)', rows: prevStock, countDate: stock.previous.countDate, total: prevStockValue }) : undefined}
              />
              <Row
                label={`− สต๊อกปลายเดือน${stock?.current?.countDate ? ` (นับ ${stock.current.countDate})` : ' (ยังไม่นับ)'}`}
                value={-curStockValue} percent={pct(curStockValue, netSale)} indent accent="text-emerald-600"
                onClick={curStock.length ? () => setStockModal({ title: 'สต๊อกปลายเดือน (เดือนนี้)', rows: curStock, countDate: stock.current.countDate, total: curStockValue }) : undefined}
              />
              <Row label="Total Food Cost" value={totalFoodCost} percent={pct(totalFoodCost, netSale)} bold accent="text-rose-700" />
              <p className="px-3 py-1.5 text-[11px] text-gray-400">
                * Total Food Cost = ต้นทุนจากใบเบิก + รายจ่ายจาก Supplier + สต๊อกต้นเดือน − สต๊อกปลายเดือน
                {stock && !stock.current.countDate ? ' • เดือนนี้ยังไม่นับสต๊อก (สต๊อกปลายเดือน = 0)' : ''}
              </p>
              {EXPENSES.map((e) => (
                <Row
                  key={e.key} label={e.label} indent
                  percent={pct(parseFloat(expenses[e.key]) || 0, netSale)}
                  input={moneyInput(expenses[e.key], (v) => setExpenses((p) => ({ ...p, [e.key]: v })))}
                />
              ))}
              <Row label="สรุปค่าใช้จ่ายรวม" value={totalCost} percent={pct(totalCost, netSale)} bold accent="text-rose-700" />
            </>
          )}
        </div>
      </div>

      {/* แถบกำไรล่าง */}
      {!notLoaded && (
        <div className={`px-5 py-3 flex items-center justify-between ${profit >= 0 ? 'bg-emerald-50' : 'bg-rose-50'}`}>
          <span className="flex items-center gap-2 font-bold text-gray-800"><Wallet className="w-5 h-5" /> กำไร / ขาดทุน</span>
          <span className={`font-mono font-bold text-lg tabular-nums ${profit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
            {baht(profit)} <span className="text-sm font-normal text-gray-500">({pct(profit, netSale)})</span>
          </span>
        </div>
      )}

      <CategoryModal cat={openCat} onClose={() => setOpenCat(null)} />
      <StockModal
        open={!!stockModal} onClose={() => setStockModal(null)}
        title={stockModal?.title} rows={stockModal?.rows || []} countDate={stockModal?.countDate} total={stockModal?.total || 0}
      />
      <SupCostModal open={supModal} onClose={() => setSupModal(false)} items={supCost?.items || []} total={supCostValue} />
    </div>
  );
}
