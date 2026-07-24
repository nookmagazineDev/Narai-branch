import { useState } from 'react';
import { Calculator, Plus, X, Trash2, Check } from 'lucide-react';

// ── เครื่องคิดเลขสะสม: ใส่จำนวนทีละจุด เก็บเป็นรายการ แล้วรวมยอดลงช่องกรอก ──
export default function CalcModal({ open, name, parts, onChangeParts, onApply, onClose }) {
  const [entry, setEntry] = useState('');
  if (!open) return null;
  const nums = parts || [];
  const total = nums.reduce((s, n) => s + (Number(n) || 0), 0);
  const totalR = Number(total.toFixed(4));
  const add = () => {
    const v = parseFloat(entry);
    if (isNaN(v)) return;
    onChangeParts([...nums, v]);
    setEntry('');
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 bg-gray-900 text-white flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-bold flex items-center gap-2"><Calculator className="w-4 h-4 text-purple-300" /> รวมยอดคงเหลือ</h3>
            <p className="text-xs text-gray-400 mt-0.5 truncate">{name}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex gap-2">
            <input
              type="number" step="any" inputMode="decimal" autoFocus
              value={entry} onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
              placeholder="ใส่จำนวนแต่ละจุด"
              className="flex-1 min-w-0 px-3 py-2 border border-gray-200 rounded-lg text-center text-base focus:ring-2 focus:ring-purple-500 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <button onClick={add} className="px-4 rounded-lg bg-purple-600 text-white hover:bg-purple-700 flex items-center shrink-0"><Plus className="w-5 h-5" /></button>
          </div>
          {nums.length > 0 ? (
            <div className="border border-gray-100 rounded-xl divide-y divide-gray-100 max-h-52 overflow-y-auto">
              {nums.map((n, i) => (
                <div key={i} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-gray-400 text-xs w-8">#{i + 1}</span>
                  <span className="font-mono flex-1 text-right pr-3">{n}</span>
                  <button onClick={() => onChangeParts(nums.filter((_, idx) => idx !== i))} className="text-rose-400 hover:text-rose-600"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-gray-400 text-xs py-4">ยังไม่มีรายการ — ใส่จำนวนแต่ละจุดแล้วกด +</p>
          )}
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-sm text-gray-500">รวม ({nums.length} รายการ)</span>
            <span className="text-2xl font-bold text-purple-700 font-mono">{totalR}</span>
          </div>
          <button
            onClick={() => onApply(totalR)} disabled={!nums.length}
            className="w-full py-2.5 rounded-xl bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <Check className="w-4 h-4" /> ใช้ค่านี้ ลงช่องคงเหลือ
          </button>
        </div>
      </div>
    </div>
  );
}
