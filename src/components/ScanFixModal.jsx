// กล่อง "แก้ไขเวลาสแกน" ของหน้าสแกนเข้า-ออก
//
// ใช้ตอนพนักงานลืมสแกน เครื่องเสีย หรือสแกนผิดรอบ — สาขา (หรือแอดมิน) กรอกเวลาที่ถูกต้องพร้อมเหตุผล
// เวลาที่แก้จะใช้แทนเวลาสแกนเฉพาะช่องที่กรอก และวันนั้นจะไม่ถูกแจ้งเตือนอีก
// ไม่ได้แก้ข้อมูลของเครื่องสแกน — เวลาสแกนจริงยังดูได้ในแท็บ "ทุกครั้งที่สแกน" (ดู office-server/attendance.js)
import { useState } from 'react';
import toast from 'react-hot-toast';
import { X, Save, RotateCcw, RefreshCw } from 'lucide-react';
import { apiCall } from '../services/api';
import { hhmm } from '../utils/attendance';

export const FIX_REASONS = ['ลืมสแกน', 'เครื่องสแกนเสีย / ไฟดับ', 'สแกนผิดรอบ', 'ทำงานนอกสถานที่', 'อื่น ๆ'];

const SLOTS = [
  { key: 'timeIn', label: 'เข้างาน', from: 'first', plan: 'in' },
  { key: 'breakOut', label: 'ออกเบรค', from: 'breakOut', plan: 'breakOut' },
  { key: 'breakIn', label: 'เข้าเบรค', from: 'breakIn', plan: 'breakIn' },
  { key: 'timeOut', label: 'ออกงาน', from: 'last', plan: 'out' },
];

/**
 * row = แถวสรุปรายวัน (หลัง applyFixes/attachSchedule) ที่จะแก้
 * onSaved() เรียกหลังบันทึก/ยกเลิกสำเร็จ ให้หน้าหลักโหลดรายการแก้ไขใหม่
 */
export default function ScanFixModal({ row, branch, onClose, onSaved }) {
  const fix = row.fix || null;
  // ค่าเริ่มต้น = เวลาที่แก้ไว้แล้ว ถ้าไม่มีก็เวลาที่สแกนได้ (ช่องที่ขาดเว้นว่างไว้ให้กรอก)
  const [times, setTimes] = useState(() => Object.fromEntries(
    SLOTS.map((s) => [s.key, fix?.[s.key] || (row[s.from] ? hhmm(row[s.from]) : '')])
  ));
  const [reason, setReason] = useState(fix?.reason || FIX_REASONS[0]);
  const [note, setNote] = useState(fix?.note || '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (SLOTS.every((s) => !times[s.key])) { toast.error('กรอกเวลาอย่างน้อย 1 ช่อง'); return; }
    setBusy(true);
    try {
      const res = await apiCall('saveScanFix', {
        branch, workDate: row.date, empCode: row.empCode, empName: row.name,
        ...times, reason, note,
      });
      if (res?.status !== 'success') throw new Error(res?.message || 'บันทึกไม่สำเร็จ');
      toast.success(res.message || 'บันทึกแล้ว');
      onSaved();
    } catch (e) {
      toast.error(e.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    setBusy(true);
    try {
      const res = await apiCall('deleteScanFix', { branch, workDate: row.date, empCode: row.empCode });
      if (res?.status !== 'success') throw new Error(res?.message || 'ยกเลิกไม่สำเร็จ');
      toast.success(res.message || 'ยกเลิกการแก้ไขแล้ว');
      onSaved();
    } catch (e) {
      toast.error(e.message || 'ยกเลิกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-gray-800">แก้ไขเวลาสแกน</h3>
            <p className="text-sm text-gray-500">{row.name || row.empCode} · {row.date}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100" aria-label="ปิด"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {SLOTS.map((s) => {
              const scanned = row.fix ? '' : (row[s.from] ? hhmm(row[s.from]) : '');
              return (
                <label key={s.key} className="block">
                  <span className="text-xs font-medium text-gray-600">{s.label}</span>
                  <input id={`fix-${s.key}`} type="time" value={times[s.key]}
                    onChange={(e) => setTimes((t) => ({ ...t, [s.key]: e.target.value }))}
                    className={`mt-1 w-full px-2 py-1.5 border rounded-lg text-sm font-mono focus:ring-2 focus:ring-teal-500 outline-none ${
                      times[s.key] ? 'border-gray-200' : 'border-rose-300 bg-rose-50/50'}`} />
                  <span className="block mt-0.5 text-[11px] text-gray-400">
                    ตาราง {row.plan?.[s.plan] || '—'}{scanned ? ` · สแกน ${scanned}` : ''}
                  </span>
                </label>
              );
            })}
          </div>
          <p className="text-[11px] text-gray-400">ช่องที่เว้นว่างจะใช้เวลาสแกนจริงตามเดิม · เวลาสแกนจริงยังดูได้ในแท็บ "ทุกครั้งที่สแกน"</p>

          <label className="block">
            <span className="text-xs font-medium text-gray-600">เหตุผล</span>
            <select id="fix-reason" value={reason} onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 outline-none">
              {FIX_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">หมายเหตุ (ถ้ามี)</span>
            <input id="fix-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
              placeholder="เช่น ผู้จัดการยืนยันว่าออก 18:00"
              className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 outline-none" />
          </label>

          {fix && (
            <p className="text-xs text-sky-700 bg-sky-50 rounded-lg px-3 py-2">
              แก้ไขล่าสุดโดย {fix.savedBy || '-'} เมื่อ {fix.savedAt || '-'}
            </p>
          )}
        </div>

        <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex flex-wrap items-center justify-between gap-2">
          {fix ? (
            <button onClick={undo} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-50">
              <RotateCcw className="w-4 h-4" /> ยกเลิกการแก้ไข
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm border border-gray-200 text-gray-600 hover:bg-white">ปิด</button>
            <button onClick={save} disabled={busy}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50">
              {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} บันทึก
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
