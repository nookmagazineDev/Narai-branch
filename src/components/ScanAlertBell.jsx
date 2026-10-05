// กระดิ่งแจ้งเตือนมุมขวาบน — สแกนไม่ครบ / ชั่วโมงขาด 7 วันล่าสุด (ดู services/scanAlerts.js)
// ตัวเลขแดง = รายการที่ยังไม่ได้เปิดดู (จำไว้ในเครื่องนี้) กดรายการแล้วพาไปหน้าสแกนเข้า-ออกที่วันและพนักงานนั้น
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, RefreshCw, CheckCheck } from 'lucide-react';

const MAX_SHOWN = 50;

const thaiDay = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const y = new Date(); y.setDate(y.getDate() - 1);
  const same = d.toDateString() === y.toDateString();
  const label = d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
  return same ? `เมื่อวาน ${label}` : label;
};

/**
 * alerts = { items, failed, at } | null (กำลังโหลดครั้งแรก)
 * seen = Set ของ key ที่เปิดดูแล้ว
 */
export default function ScanAlertBell({ alerts, seen, loading, isAdmin, onRefresh, onSeen }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const navigate = useNavigate();

  // คลิกข้างนอก / กด Esc = ปิด
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items = alerts?.items || [];
  const unread = items.filter((i) => !seen.has(i.key)).length;

  const go = (it) => {
    onSeen([it.key]);
    setOpen(false);
    const p = new URLSearchParams({ date: it.date, branch: it.branch });
    if (it.empCode) p.set('emp', it.empCode);
    navigate(`/attendance?${p.toString()}`);
  };

  return (
    <div className="relative" ref={boxRef}>
      <button onClick={() => setOpen((v) => !v)}
        aria-label={unread ? `การแจ้งเตือน ${unread} รายการที่ยังไม่ได้ดู` : 'การแจ้งเตือน'}
        aria-expanded={open}
        className="relative p-2 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-purple-500">
        <Bell className="w-5 h-5" />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full bg-rose-600 text-white text-[11px] font-semibold leading-5 text-center border-2 border-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[min(380px,calc(100vw-2rem))] bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
            <div>
              <p className="font-semibold text-gray-800 text-sm">สแกนไม่ครบ / เวลาไม่ตรง</p>
              <p className="text-[11px] text-gray-400">{ALERT_RANGE_TEXT}{isAdmin ? ' · ทุกสาขา' : ''}</p>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={onRefresh} disabled={loading} title="โหลดใหม่"
                className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-50">
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
              {unread > 0 && (
                <button onClick={() => onSeen(items.map((i) => i.key))}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-teal-700 hover:bg-teal-50">
                  <CheckCheck className="w-3.5 h-3.5" /> อ่านทั้งหมดแล้ว
                </button>
              )}
            </div>
          </div>

          <div className="max-h-[60vh] overflow-auto divide-y divide-gray-100">
            {!alerts ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">กำลังตรวจการสแกน…</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-emerald-700">สแกนครบทุกคนตามตารางงาน</p>
            ) : items.slice(0, MAX_SHOWN).map((it) => {
              const isNew = !seen.has(it.key);
              return (
                <button key={it.key} onClick={() => go(it)}
                  className={`w-full text-left px-4 py-2.5 flex gap-3 hover:bg-gray-50 ${isNew ? 'bg-rose-50/40' : ''}`}>
                  <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${it.level === 'crit' ? 'bg-rose-500' : 'bg-amber-500'} ${isNew ? '' : 'opacity-40'}`} />
                  <span className="min-w-0">
                    <span className={`block text-sm ${isNew ? 'font-medium text-gray-800' : 'text-gray-500'}`}>
                      {it.name} · {it.label}
                    </span>
                    <span className="block text-[11px] text-gray-400">
                      {thaiDay(it.date)}{isAdmin ? ` · ${it.branch.toUpperCase()}` : ''}{it.detail ? ` · ${it.detail}` : ''}
                    </span>
                  </span>
                </button>
              );
            })}
            {items.length > MAX_SHOWN && (
              <p className="px-4 py-2 text-center text-xs text-gray-400">และอีก {items.length - MAX_SHOWN} รายการ — ดูทั้งหมดในหน้าสแกนเข้า-ออก</p>
            )}
            {alerts?.failed?.length > 0 && (
              <p className="px-4 py-2 text-[11px] text-amber-700 bg-amber-50">
                ดึงข้อมูลไม่ได้: {alerts.failed.map((b) => b.toUpperCase()).join(', ')}
              </p>
            )}
          </div>

          <button onClick={() => { setOpen(false); navigate('/attendance'); }}
            className="w-full px-4 py-2.5 text-center text-sm font-semibold text-teal-700 bg-gray-50 border-t border-gray-100 hover:bg-gray-100">
            เปิดหน้าสแกนเข้า-ออก →
          </button>
        </div>
      )}
    </div>
  );
}

const ALERT_RANGE_TEXT = '7 วันล่าสุด ถึงเมื่อวาน';
