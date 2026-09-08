import { useAuth } from '../contexts/AuthContext';
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  DollarSign, Layers, TrendingUp, FileText, Users, BarChart3,
  RefreshCw, DatabaseBackup, Calendar, AlertCircle, Scale, Ban,
  Eye, X, ShoppingBag, Search, CheckCircle, XCircle, ReceiptText, Store,
} from 'lucide-react';
import { fetchDashboard, refreshDashboardCache, fetchBills, fetchBillDetail, presetRange, PRESETS, fmtDate } from '../services/dashboardApi';
import { apiCall } from '../services/api';
import ProfitSummary from '../components/ProfitSummary';

const baht = (n) =>
  '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intf = (n) => Number(n || 0).toLocaleString('th-TH');

// ---- การ์ดสรุป (กดดูรายละเอียดได้ถ้าส่ง onClick) ----
function StatCard({ title, value, sub, icon: Icon, accent, onClick }) {
  const clickable = typeof onClick === 'function';
  const Wrapper = clickable ? 'button' : 'div';
  return (
    <Wrapper
      type={clickable ? 'button' : undefined}
      onClick={onClick}
      className={`w-full text-left bg-white rounded-2xl p-5 shadow-sm border border-gray-100 transition-all ${
        clickable ? 'cursor-pointer hover:shadow-md hover:border-indigo-300' : 'hover:shadow-md'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-gray-500 text-sm font-medium truncate">{title}</h3>
          <p className={`text-2xl font-bold mt-1 ${accent?.text || 'text-gray-800'}`}>{value}</p>
          {sub && <p className="text-xs text-gray-400 mt-1 truncate">{sub}</p>}
          {clickable && <p className={`text-[11px] font-semibold mt-1 ${accent?.text || 'text-indigo-500'}`}>คลิกดูรายละเอียด →</p>}
        </div>
        <div className={`w-11 h-11 shrink-0 rounded-xl flex items-center justify-center ${accent?.bg || 'bg-gray-50'} ${accent?.icon || 'text-gray-500'}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </Wrapper>
  );
}

// ---- Modal แสดง breakdown รายไอเทม (ต้นทุน/โต๊ะเตรียม/ไม่นับคำนวณ) ----
function BreakdownModal({ open, onClose, title, rows, accent, showReason }) {
  if (!open) return null;
  const totalQty = rows.reduce((s, r) => s + (r.qty || 0), 0);
  const totalCost = rows.reduce((s, r) => s + (r.totalCost || 0), 0);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 bg-gray-900 text-white flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-bold">{title}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{rows.length.toLocaleString('th-TH')} รายการ</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {rows.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">ไม่มีข้อมูล</div>
          ) : (
            <div className="overflow-auto max-h-[60vh] border border-gray-100 rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="text-gray-600">
                    {showReason && <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">เหตุผล</th>}
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">รหัส</th>
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">ชื่อรายการ</th>
                    <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">จำนวน</th>
                    <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">ต้นทุน/หน่วย</th>
                    <th className={`px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200 ${accent}`}>ต้นทุนรวม</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {rows.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-50/50">
                      {showReason && <td className="px-3 py-2"><span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{r.reason}</span></td>}
                      <td className="px-3 py-2 font-mono text-gray-400">{r.itemCode}</td>
                      <td className="px-3 py-2 font-medium text-gray-800">{r.name}</td>
                      <td className="px-3 py-2 text-right font-mono">{intf(r.qty)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{baht(r.unitCost)}</td>
                      <td className={`px-3 py-2 text-right font-mono font-bold ${accent}`}>{baht(r.totalCost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-300 font-bold text-gray-800 sticky bottom-0">
                    <td className="px-3 py-2.5" colSpan={showReason ? 3 : 2}>รวมทั้งหมด</td>
                    <td className="px-3 py-2.5 text-right font-mono">{intf(totalQty)}</td>
                    <td />
                    <td className={`px-3 py-2.5 text-right font-mono ${accent}`}>{baht(totalCost)}</td>
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

// ---- badge ประเภทการชำระเงิน ----
function PaidBadge({ value }) {
  const v = String(value || '').toLowerCase();
  const cls = v.includes('cash') || v.includes('สด')
    ? 'bg-emerald-50 text-emerald-700'
    : v.includes('credit') || v.includes('บัตร')
      ? 'bg-violet-50 text-violet-700'
      : 'bg-amber-50 text-amber-700';
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${cls}`}>{value || '-'}</span>;
}

// ---- Modal: รายละเอียดรายการในบิลเดียว (line items) ----
function BillDetailModal({ open, onClose, bill, branch, outletId }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (!open || !bill) return;
    let alive = true;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setError(''); setRows([]);
    fetchBillDetail({ branch, outletId, date: bill.date, checkID: bill.checkID, signal: controller.signal })
      .then((res) => { if (alive) setRows(res.data || []); })
      .catch((e) => { if (alive && e.name !== 'AbortError') setError(e.message || 'เกิดข้อผิดพลาด'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, [open, bill, branch, outletId]);

  if (!open || !bill) return null;
  const totalQty = rows.reduce((s, r) => s + (r.qty || 0), 0);
  const totalGross = rows.reduce((s, r) => s + (r.grossPrice || 0), 0);
  const totalVat = rows.reduce((s, r) => s + (r.tax || 0), 0);
  const totalCost = rows.reduce((s, r) => s + (r.void ? 0 : r.lineCost || 0), 0);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 bg-gray-900 text-white flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-bold flex items-center gap-2"><ShoppingBag className="w-4 h-4 text-amber-400" /> รายละเอียดรายการในบิล</h3>
            <p className="text-xs text-gray-400 mt-1">
              เลขที่บิล <span className="font-mono font-bold text-white bg-gray-800 px-2 py-0.5 rounded">{bill.checkID}</span>
              <span className="ml-2">โต๊ะ {bill.tableID ?? '-'} • {bill.date} • {bill.startTime || '-'}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="py-16 flex flex-col items-center text-gray-400 text-sm"><RefreshCw className="w-6 h-6 animate-spin mb-3" /> กำลังโหลดรายละเอียดบิล…</div>
          ) : error ? (
            <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm flex items-center gap-2"><XCircle className="w-4 h-4" /> {error}</div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">ไม่พบรายการในบิลนี้</div>
          ) : (
            <div className="overflow-auto max-h-[58vh] border border-gray-100 rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="text-gray-600">
                    {['รหัส', 'ชื่อรายการ'].map((h) => <th key={h} className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">{h}</th>)}
                    {['จำนวน', 'ราคา/หน่วย', 'ก่อน Vat', 'Vat', 'รวม', 'ต้นทุน/หน่วย', 'ต้นทุนรวม'].map((h) => <th key={h} className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">{h}</th>)}
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">สถานะ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {rows.map((r, i) => (
                    <tr key={i} className={`hover:bg-gray-50/50 ${r.void ? 'bg-rose-50/40 line-through text-gray-400' : ''}`}>
                      <td className="px-3 py-2 font-mono text-gray-400">{r.itemCode}</td>
                      <td className="px-3 py-2 font-medium text-gray-800">{r.name}</td>
                      <td className="px-3 py-2 text-right font-mono">{intf(r.qty)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{baht(r.unitPrice)}</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-600">{baht(r.grossPrice)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{baht(r.tax)}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-600 font-semibold">{baht(r.grossPrice + r.tax)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{baht(r.unitCost)}</td>
                      <td className="px-3 py-2 text-right font-mono text-rose-600 font-bold">{baht(r.lineCost)}</td>
                      <td className="px-3 py-2">
                        {r.void
                          ? <span className="inline-flex items-center gap-1 text-rose-600 font-semibold no-underline"><XCircle className="w-3 h-3" /> ยกเลิก</span>
                          : <span className="inline-flex items-center gap-1 text-emerald-600 font-semibold"><CheckCircle className="w-3 h-3" /> ปกติ</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-300 font-bold text-gray-800 sticky bottom-0">
                    <td className="px-3 py-2.5" colSpan={2}>รวมทั้งหมด</td>
                    <td className="px-3 py-2.5 text-right font-mono">{intf(totalQty)}</td>
                    <td />
                    <td className="px-3 py-2.5 text-right font-mono text-emerald-700">{baht(totalGross)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-gray-500">{baht(totalVat)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-amber-700">{baht(totalGross + totalVat)}</td>
                    <td />
                    <td className="px-3 py-2.5 text-right font-mono text-rose-700">{baht(totalCost)}</td>
                    <td />
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

// ---- Modal: ตารางรายการขาย (รายการบิลทั้งหมด) ----
function BillsModal({ open, onClose, branch, outletId, startDate, endDate }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null); // บิลที่กดดูรายละเอียด

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setError(''); setRows([]); setSearch(''); setSelected(null);
    fetchBills({ branch, outletId, startDate, endDate, signal: controller.signal })
      .then((res) => { if (alive) setRows(res.data || []); })
      .catch((e) => { if (alive && e.name !== 'AbortError') setError(e.message || 'เกิดข้อผิดพลาด'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, [open, branch, outletId, startDate, endDate]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.checkID, r.tableID, r.cashierName, r.waiterName, r.paidType, r.memberTel, r.orderID]
        .some((v) => String(v ?? '').toLowerCase().includes(q))
    );
  }, [rows, search]);

  const totals = useMemo(() => filtered.reduce((a, r) => ({
    amount: a.amount + (r.amount || 0),
    beforeVat: a.beforeVat + (r.beforeVat || 0),
    vat: a.vat + (r.vat || 0),
    billTotal: a.billTotal + (r.billTotal || 0),
    billCost: a.billCost + (r.billCost || 0),
    cover: a.cover + (r.cover || 0),
  }), { amount: 0, beforeVat: 0, vat: 0, billTotal: 0, billCost: 0, cover: 0 }), [filtered]);

  if (!open) return null;
  const cols = [
    { h: 'วันที่' }, { h: 'Check ID' }, { h: 'โต๊ะ', r: true }, { h: 'แคชเชียร์' }, { h: 'พนักงานรับออเดอร์' },
    { h: 'Amount', r: true }, { h: 'ก่อน Vat', r: true }, { h: 'Vat', r: true }, { h: 'Bill Total', r: true },
    { h: 'ต้นทุนรวม', r: true }, { h: 'ชำระ' }, { h: 'สมาชิก' }, { h: 'Cover', r: true }, { h: 'Cover All', r: true }, { h: 'เวลาเริ่ม' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-[95vw] xl:max-w-7xl max-h-[88vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 bg-gray-900 text-white flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-bold flex items-center gap-2"><ReceiptText className="w-4 h-4 text-indigo-300" /> ตารางรายการขาย</h3>
            <p className="text-xs text-gray-400 mt-1">{loading ? 'กำลังโหลด…' : `พบ ${filtered.length.toLocaleString('th-TH')} บิล`} • {startDate} ถึง {endDate}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative hidden sm:block">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาบิล…"
                className="pl-8 pr-3 py-1.5 rounded-lg bg-gray-800 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-56"
              />
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800"><X className="w-5 h-5" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {loading ? (
            <div className="py-20 flex flex-col items-center text-gray-400 text-sm"><RefreshCw className="w-6 h-6 animate-spin mb-3" /> กำลังโหลดรายการบิล…</div>
          ) : error ? (
            <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm flex items-center gap-2"><XCircle className="w-4 h-4" /> {error}</div>
          ) : filtered.length === 0 ? (
            <div className="py-20 text-center text-gray-400 text-sm">ไม่พบรายการบิล</div>
          ) : (
            <div className="overflow-auto border border-gray-100 rounded-xl">
              <table className="w-full text-left text-xs border-collapse whitespace-nowrap">
                <thead>
                  <tr className="text-gray-600">
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">ดูบิล</th>
                    {cols.map((c) => <th key={c.h} className={`px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200 ${c.r ? 'text-right' : ''}`}>{c.h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {filtered.map((r, i) => (
                    <tr key={i} className="hover:bg-indigo-50/40 cursor-pointer" onClick={() => setSelected(r)}>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1 px-2 py-1 border border-indigo-200 text-indigo-600 rounded-lg text-[10px] font-semibold"><Eye className="w-3 h-3" /> ดู</span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.date}</td>
                      <td className="px-3 py-2 font-mono">{r.checkID}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-600">{r.tableID ?? '-'}</td>
                      <td className="px-3 py-2 text-gray-600">{r.cashierName || '-'}</td>
                      <td className="px-3 py-2 text-gray-600">{r.waiterName || '-'}</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-600 font-semibold">{baht(r.amount)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-600">{baht(r.beforeVat)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{baht(r.vat)}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-600 font-bold">{baht(r.billTotal)}</td>
                      <td className="px-3 py-2 text-right font-mono text-rose-600 font-semibold">{baht(r.billCost)}</td>
                      <td className="px-3 py-2"><PaidBadge value={r.paidType} /></td>
                      <td className="px-3 py-2 font-mono text-gray-600">{r.memberTel || '-'}</td>
                      <td className="px-3 py-2 text-right font-mono">{intf(r.cover)}</td>
                      <td className="px-3 py-2 text-right font-mono">{intf(r.coverAll)}</td>
                      <td className="px-3 py-2 text-gray-500">{r.startTime || '-'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-300 font-bold text-gray-800 sticky bottom-0">
                    <td className="px-3 py-2.5" colSpan={6}>รวม {filtered.length.toLocaleString('th-TH')} บิล</td>
                    <td className="px-3 py-2.5 text-right font-mono text-emerald-700">{baht(totals.amount)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{baht(totals.beforeVat)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-gray-500">{baht(totals.vat)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-amber-700">{baht(totals.billTotal)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-rose-700">{baht(totals.billCost)}</td>
                    <td colSpan={2} />
                    <td className="px-3 py-2.5 text-right font-mono">{intf(totals.cover)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
      <BillDetailModal open={!!selected} onClose={() => setSelected(null)} bill={selected} branch={branch} outletId={outletId} />
    </div>
  );
}

// ---- กราฟยอดขายรายวัน (SVG area chart, ไม่ต้องพึ่ง lib) ----
function DailySalesChart({ daily }) {
  const w = 760, h = 280, pad = { t: 16, r: 16, b: 28, l: 56 };
  const points = daily || [];
  if (!points.length) {
    return <div className="h-64 flex items-center justify-center text-gray-400 text-sm">ไม่มีข้อมูลในช่วงนี้</div>;
  }
  const max = Math.max(...points.map((p) => p.sales), 1);
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const x = (i) => pad.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / max) * ih;
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.sales).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`;
  const ticks = 4;
  const gridVals = Array.from({ length: ticks + 1 }, (_, i) => (max / ticks) * i);
  const labelEvery = Math.ceil(points.length / 8);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {gridVals.map((v, i) => (
        <g key={i}>
          <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke="#f1f5f9" strokeWidth="1" />
          <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
            {'฿' + Math.round(v).toLocaleString('th-TH')}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#salesFill)" />
      <path d={line} fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(p.sales)} r="2.5" fill="#6366f1">
            <title>{`${p.date}: ${baht(p.sales)}`}</title>
          </circle>
          {i % labelEvery === 0 && (
            <text x={x(i)} y={h - 10} textAnchor="middle" fontSize="9.5" fill="#94a3b8">
              {p.date.slice(5)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ---- นิยามเมตริกที่กดดู drill-down รายวันได้ ----
// kind 'bill' = ลงลึกเป็นรายการบิลของวันนั้น | 'cost'/'prep'/'excluded' = breakdown รายไอเทมของวันนั้น
const METRICS = {
  sales:    { key: 'sales',        label: 'ยอดขายรวมทั้งหมด',     kind: 'bill',     fmt: 'baht', colLabel: 'ยอดขาย',  accent: 'text-emerald-600' },
  // คอลัมน์หลัก (สีเหลือง) ของบิล แสดง "จำนวนหัวลูกค้า" (covers) แทนจำนวนบิลที่ซ้ำกับคอลัมน์ซ้าย — colKey = ฟิลด์ที่เอามาแสดง/รวมยอดในคอลัมน์นั้น
  bills:    { key: 'bills',        label: 'จำนวนบิลทั้งหมด',       kind: 'bill',     fmt: 'int',  colKey: 'covers', colLabel: 'จำนวนหัวลูกค้า', accent: 'text-amber-600' },
  cost:     { key: 'cost',         label: 'ต้นทุนรวมทั้งหมด',      kind: 'cost',     breakdownKey: 'costBreakdown',     fmt: 'baht', colLabel: 'ต้นทุน', accent: 'text-rose-600' },
  prep:     { key: 'prepCost',     label: 'ต้นทุนโต๊ะเตรียม(กก)',  kind: 'prep',     breakdownKey: 'prepBreakdown',     fmt: 'baht', colLabel: 'ต้นทุน', accent: 'text-orange-600' },
  excluded: { key: 'excludedCost', label: 'รายการไม่นับคำนวณ',      kind: 'excluded', breakdownKey: 'excludedBreakdown', fmt: 'baht', colLabel: 'ต้นทุน', accent: 'text-gray-600' },
};

// ---- Modal: สรุปเมตริกรายวัน → คลิกวันเพื่อดูรายละเอียดของวันนั้น ----
function DailyDrilldownModal({ open, onClose, metric, daily, branch, outletId }) {
  const [day, setDay] = useState(null);          // วันที่เลือกดูรายละเอียด
  const [loading, setLoading] = useState(false); // โหลด breakdown ของวัน (เฉพาะ kind ต้นทุน)
  const [error, setError] = useState('');
  const [dayRows, setDayRows] = useState([]);

  useEffect(() => { if (!open) setDay(null); }, [open]);

  useEffect(() => {
    if (!open || !day || metric.kind === 'bill') return;
    let alive = true;
    const controller = new AbortController();
    setLoading(true); setError(''); setDayRows([]);
    fetchDashboard({ branch, outletId, startDate: day, endDate: day, signal: controller.signal })
      .then((res) => { if (alive) setDayRows(res.data?.[metric.breakdownKey] || []); })
      .catch((e) => { if (alive && e.name !== 'AbortError') setError(e.message || 'เกิดข้อผิดพลาด'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, [open, day, metric, branch, outletId]);

  if (!open) return null;

  // ---- ชั้นที่ 2: รายละเอียดของวันที่เลือก ----
  if (day) {
    if (metric.kind === 'bill') {
      return <BillsModal open onClose={() => setDay(null)} branch={branch} outletId={outletId} startDate={day} endDate={day} />;
    }
    if (loading || error) {
      return (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={() => setDay(null)}>
          <div className="bg-white rounded-2xl p-8 shadow-2xl text-sm" onClick={(e) => e.stopPropagation()}>
            {loading
              ? <div className="flex items-center gap-2 text-gray-500"><RefreshCw className="w-5 h-5 animate-spin" /> กำลังโหลดรายละเอียด {day}…</div>
              : <div className="flex items-center gap-2 text-red-600"><XCircle className="w-5 h-5" /> {error}</div>}
          </div>
        </div>
      );
    }
    return (
      <BreakdownModal
        open onClose={() => setDay(null)}
        title={`${metric.label} • ${day}`} rows={dayRows}
        accent={metric.accent} showReason={metric.kind === 'excluded'}
      />
    );
  }

  // ---- ชั้นที่ 1: สรุปรายวัน ----
  const fmt = metric.fmt === 'int' ? intf : baht;
  const rows = [...(daily || [])]
    .filter((r) => (Number(r[metric.key]) || 0) > 0)
    .sort((a, b) => b.date.localeCompare(a.date));
  const colKey = metric.colKey || metric.key;
  const total = rows.reduce((s, r) => s + (Number(r[colKey]) || 0), 0);
  const isBill = metric.kind === 'bill';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 bg-gray-900 text-white flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-bold">{metric.label} — สรุปรายวัน</h3>
            <p className="text-xs text-gray-400 mt-0.5">{rows.length.toLocaleString('th-TH')} วัน • คลิกที่วันเพื่อดูรายละเอียด</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {rows.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">ไม่มีข้อมูลในช่วงนี้</div>
          ) : (
            <div className="overflow-auto max-h-[62vh] border border-gray-100 rounded-xl">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="text-gray-600">
                    <th className="px-4 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">วันที่</th>
                    {isBill && <th className="px-4 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">จำนวนบิล</th>}
                    {isBill && <th className="px-4 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200 text-purple-600">บิลสมาชิก</th>}
                    <th className={`px-4 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200 ${metric.accent}`}>{metric.colLabel}</th>
                    <th className="px-4 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {rows.map((r) => (
                    <tr key={r.date} className="hover:bg-indigo-50/40 cursor-pointer" onClick={() => setDay(r.date)}>
                      <td className="px-4 py-2.5 font-medium text-gray-800">{r.date}</td>
                      {isBill && <td className="px-4 py-2.5 text-right font-mono text-gray-500">{intf(r.bills)}</td>}
                      {isBill && <td className="px-4 py-2.5 text-right font-mono text-purple-600">{intf(r.memberBills)}</td>}
                      <td className={`px-4 py-2.5 text-right font-mono font-semibold ${metric.accent}`}>{fmt(r[colKey])}</td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="inline-flex items-center gap-1 px-2 py-1 border border-indigo-200 text-indigo-600 rounded-lg text-[10px] font-semibold"><Eye className="w-3 h-3" /> ดู</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-300 font-bold text-gray-800 sticky bottom-0">
                    <td className="px-4 py-2.5">รวมทั้งหมด</td>
                    {isBill && <td className="px-4 py-2.5 text-right font-mono text-gray-600">{intf(rows.reduce((s, r) => s + (Number(r.bills) || 0), 0))}</td>}
                    {isBill && <td className="px-4 py-2.5 text-right font-mono text-purple-700">{intf(rows.reduce((s, r) => s + (Number(r.memberBills) || 0), 0))}</td>}
                    <td className={`px-4 py-2.5 text-right font-mono ${metric.accent}`}>{fmt(total)}</td>
                    <td />
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

// ---- Modal: จำนวนลูกค้า — แยกประเภท / เปรียบเทียบเป็น % รายวันของทั้งเดือน ----
const WEEKDAY_TH = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
// กลุ่มที่ไม่ถูกนับรวมใน covers (เด็กฟรี/ผู้สูงอายุฟรี) — คิด % ไม่ได้ เพราะไม่ได้อยู่ในฐาน
const FREE_COVER_KEYS = ['kidFree', 'elderFree'];
const pct1 = (v) => `${Number(v || 0).toLocaleString('th-TH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const signPct1 = (v) => `${v > 0 ? '+' : ''}${pct1(v)}`;

function CoversModal({ open, onClose, covers, breakdown, daily, rangeText }) {
  // mount ใหม่ทุกครั้งที่เปิด (parent render เฉพาะตอนเปิด) — แท็บจึงกลับมาเริ่มที่ "แยกประเภท" เสมอ
  const [tab, setTab] = useState('type'); // 'type' = แยกประเภท | 'daily' = % รายวัน

  // สรุปรายวัน: เอาเฉพาะวันที่มีลูกค้า → % ของทั้งช่วง (ทั้งเดือน) + เทียบกับค่าเฉลี่ยต่อวัน
  const st = useMemo(() => {
    const base = (daily || [])
      .map((r) => ({ date: r.date, covers: Number(r.covers) || 0 }))
      .filter((r) => r.covers > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    const total = base.reduce((s, r) => s + r.covers, 0);
    const max = base.reduce((m, r) => Math.max(m, r.covers), 0);
    const avg = base.length ? total / base.length : 0;
    const rows = base.map((r) => ({
      ...r,
      share: total ? (r.covers / total) * 100 : 0,      // % ของทั้งเดือน
      vsAvg: avg ? ((r.covers - avg) / avg) * 100 : 0,  // เทียบค่าเฉลี่ยต่อวัน
      bar: max ? (r.covers / max) * 100 : 0,
      dow: new Date(`${r.date}T00:00:00`).getDay(),
    }));
    const best = rows.reduce((b, r) => (!b || r.covers > b.covers ? r : b), null);
    const worst = rows.reduce((b, r) => (!b || r.covers < b.covers ? r : b), null);
    return { rows, total, avg, max, best, worst };
  }, [daily]);

  if (!open) return null;

  const groups = breakdown || [];
  const coverBase = Number(covers) || 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 bg-gray-900 text-white flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-bold flex items-center gap-2"><Users className="w-4 h-4 text-sky-300" /> จำนวนลูกค้าทั้งหมด {intf(coverBase)} คน</h3>
            <p className="text-xs text-gray-400 mt-0.5">{rangeText}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800"><X className="w-5 h-5" /></button>
        </div>

        {/* ปุ่มสลับ: แยกประเภท / % เปรียบเทียบรายวัน */}
        <div className="px-4 pt-3 shrink-0">
          <div className="inline-flex rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
            <button
              onClick={() => setTab('type')}
              className={`px-4 py-1.5 text-sm font-medium transition-colors ${tab === 'type' ? 'bg-sky-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              แยกประเภท
            </button>
            <button
              onClick={() => setTab('daily')}
              className={`px-4 py-1.5 text-sm font-medium transition-colors ${tab === 'daily' ? 'bg-sky-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              % เปรียบเทียบรายวัน
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'type' ? (
            <>
              <div className="border border-gray-100 rounded-xl overflow-hidden">
                {groups.map((g) => {
                  const free = FREE_COVER_KEYS.indexOf(g.key) >= 0;
                  const share = coverBase ? (Number(g.qty || 0) / coverBase) * 100 : 0;
                  return (
                    <div key={g.key} className="px-4 py-2.5 border-b border-gray-100 last:border-b-0 hover:bg-sky-50/40">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-gray-700 truncate">{g.label}</span>
                        <span className="flex items-baseline gap-2 shrink-0">
                          <span className="font-mono font-semibold text-sky-700 tabular-nums">{intf(g.qty)}</span>
                          <span className={`font-mono text-xs tabular-nums w-14 text-right ${free ? 'text-gray-300' : 'text-gray-500'}`}>
                            {free ? 'ไม่นับ' : pct1(share)}
                          </span>
                        </span>
                      </div>
                      {!free && (
                        <div className="mt-1.5 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                          <div className="h-full rounded-full bg-sky-400" style={{ width: `${Math.min(100, share)}%` }} />
                        </div>
                      )}
                    </div>
                  );
                })}
                <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 font-bold text-gray-800">
                  <span className="text-sm">จำนวนลูกค้าทั้งหมด (Covers)</span>
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono tabular-nums">{intf(coverBase)}</span>
                    <span className="font-mono text-xs tabular-nums w-14 text-right text-gray-500">{coverBase ? '100.0%' : '—'}</span>
                  </span>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-gray-400">* เด็กฟรี / ผู้สูงอายุฟรี เป็นข้อมูลแสดง ไม่นับรวมในจำนวนลูกค้าทั้งหมด (จึงไม่คิด %)</p>
            </>
          ) : st.rows.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">ไม่มีข้อมูลลูกค้าในช่วงนี้</div>
          ) : (
            <>
              {/* สรุปย่อ: เฉลี่ยต่อวัน / วันที่มากสุด / วันที่น้อยสุด */}
              <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
                  <p className="text-[11px] text-gray-500">เฉลี่ยต่อวัน</p>
                  <p className="text-sm font-bold text-gray-800 font-mono tabular-nums">{intf(Math.round(st.avg))} คน</p>
                  <p className="text-[11px] text-gray-400 font-mono">{pct1(st.rows.length ? 100 / st.rows.length : 0)} ของเดือน</p>
                </div>
                <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2">
                  <p className="text-[11px] text-emerald-600">วันที่มากที่สุด</p>
                  <p className="text-sm font-bold text-emerald-700 font-mono tabular-nums">{intf(st.best?.covers)} คน</p>
                  <p className="text-[11px] text-emerald-500 font-mono">{st.best?.date.slice(5)} • {pct1(st.best?.share)}</p>
                </div>
                <div className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2">
                  <p className="text-[11px] text-rose-600">วันที่น้อยที่สุด</p>
                  <p className="text-sm font-bold text-rose-700 font-mono tabular-nums">{intf(st.worst?.covers)} คน</p>
                  <p className="text-[11px] text-rose-500 font-mono">{st.worst?.date.slice(5)} • {pct1(st.worst?.share)}</p>
                </div>
              </div>

              <div className="overflow-auto max-h-[52vh] border border-gray-100 rounded-xl">
                <table className="w-full text-left text-sm border-collapse">
                  <thead>
                    <tr className="text-gray-600">
                      <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">วันที่</th>
                      <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">ลูกค้า</th>
                      <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200 text-sky-600">% ของเดือน</th>
                      <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">เทียบเฉลี่ย</th>
                      <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200 w-28"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 text-gray-700">
                    {st.rows.map((r) => {
                      const holiday = r.dow === 0 || r.dow === 5 || r.dow === 6; // ศ-ส-อา
                      return (
                        <tr key={r.date} className="hover:bg-sky-50/40">
                          <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">
                            {r.date}
                            <span className={`ml-1.5 text-[11px] ${holiday ? 'text-amber-500' : 'text-gray-400'}`}>{WEEKDAY_TH[r.dow]}</span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">{intf(r.covers)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-sky-700">{pct1(r.share)}</td>
                          <td className={`px-3 py-2 text-right font-mono tabular-nums ${r.vsAvg >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                            {signPct1(r.vsAvg)}
                          </td>
                          <td className="px-3 py-2">
                            <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                              <div className={`h-full rounded-full ${r.vsAvg >= 0 ? 'bg-sky-500' : 'bg-sky-300'}`} style={{ width: `${r.bar}%` }} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-50 border-t-2 border-gray-300 font-bold text-gray-800 sticky bottom-0">
                      <td className="px-3 py-2.5">รวม {intf(st.rows.length)} วัน</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">{intf(st.total)}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-sky-700">100.0%</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-gray-400">
                * % ของเดือน = จำนวนลูกค้าวันนั้น ÷ จำนวนลูกค้าทั้งช่วงที่เลือก • เทียบเฉลี่ย = สูง/ต่ำกว่าค่าเฉลี่ยต่อวันกี่ % (นับเฉพาะวันที่มีลูกค้า)
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- แถบ "ส่งใบเบิกสำเร็จแล้ว" — ขึ้นตอนถูกเด้งกลับมาจากหน้านับสต๊อกหลังกดยืนยันสั่งของ ----
function OrderSuccessBanner({ info, onClose }) {
  if (!info) return null;
  const docs = info.docs || [];
  const totalCount = docs.reduce((s, d) => s + (Number(d.count) || 0), 0);
  return (
    <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 shadow-sm p-5">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 shrink-0 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
          <CheckCircle className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold text-emerald-800">ส่งสำเร็จแล้ว</h3>
          <p className="text-sm text-emerald-600 mt-0.5">
            ส่งใบเบิก {docs.length.toLocaleString('th-TH')} ใบ
            {totalCount > 0 && ` • รวม ${totalCount.toLocaleString('th-TH')} รายการ`}
            {info.branch && ` • สาขา ${info.branch}`}
            {info.deldate && ` • รับวันที่ ${info.deldate}`}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {docs.map((d) => (
              <div key={d.no} className="bg-white border border-emerald-200 rounded-xl px-4 py-2">
                <p className="text-[11px] font-medium text-emerald-600">เลขที่ใบเบิก{d.label ? ` • ${d.label}` : ''}</p>
                <p className="text-xl font-bold font-mono text-emerald-700 tracking-wide">{d.no}</p>
                {Number(d.count) > 0 && (
                  <p className="text-[11px] text-emerald-500">{Number(d.count).toLocaleString('th-TH')} รายการ</p>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-emerald-500 mt-2">บันทึกไว้ในใบเบิกค้างแล้ว</p>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-emerald-500 hover:bg-emerald-100 shrink-0"
          title="ปิด"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export default function DashboardHome() {
  const { user } = useAuth();
  const isAdmin = String(user?.branch || '').toLowerCase() === 'all';
  const location = useLocation();
  const navigate = useNavigate();

  // เลขที่ใบเบิกที่เพิ่งส่งสำเร็จ — ส่งมาทาง location.state จากหน้านับสต๊อก
  // อ่านตอน mount ครั้งเดียว (มาจากหน้าอื่นเสมอ = หน้านี้ถูก mount ใหม่) แล้วเก็บไว้ใน state ของหน้า
  const [orderSuccess, setOrderSuccess] = useState(() => location.state?.orderSuccess || null);
  useEffect(() => {
    if (!location.state?.orderSuccess) return;
    // ล้าง state ทิ้งจากประวัติ ไม่ให้แถบเด้งซ้ำตอนรีเฟรชหรือกดย้อนกลับ (แถบยังอยู่เพราะเก็บไว้ใน state แล้ว)
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);

  // ผู้ใช้ระดับ all: เลือกสาขาที่จะดูได้ | ผู้ใช้ปกติ: ใช้สาขาของตัวเอง
  const [branchList, setBranchList] = useState([]);
  const [selBranch, setSelBranch] = useState(null); // { name, outletId }

  // สาขาที่ใช้ดึงข้อมูลจริง
  const branch = isAdmin ? (selBranch?.name || '') : (user?.branch || '');
  const outletId = isAdmin ? (selBranch?.outletId || '') : (user?.outletId || '');

  const [preset, setPreset] = useState('thisMonth');
  const initial = presetRange('thisMonth');
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState(null); // เมตริกที่กดดู drill-down รายวัน
  const [resyncing, setResyncing] = useState(false); // กำลังสั่งดึงข้อมูลจาก POS ใหม่
  const [showCovers, setShowCovers] = useState(false); // breakdown ประเภทลูกค้า
  const abortRef = useRef(null);

  const load = useCallback(
    async (sd, ed) => {
      if (!branch && !outletId) return;
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError('');
      try {
        const res = await fetchDashboard({ branch, outletId, startDate: sd, endDate: ed, signal: controller.signal });
        setData(res.data);
      } catch (e) {
        if (e.name !== 'AbortError') setError(e.message || 'เกิดข้อผิดพลาด');
      } finally {
        setLoading(false);
      }
    },
    [branch, outletId]
  );

  // สั่งดึงข้อมูลจาก POS ใหม่ (ล้างแคชรายวันของ office-server) แล้วโหลดหน้าใหม่
  // ใช้ตอนยอดขายบางวันไม่ขึ้นเพราะตอนที่แคชวันนั้นไว้ POS ยัง sync ไม่เสร็จ
  // ถ้ามีวันที่ยอดขายเป็น 0 อยู่แล้ว ดึงเฉพาะวันพวกนั้นพอ (เร็วกว่าดึงใหม่ทั้งเดือนมาก)
  const resync = useCallback(async (sd, ed, dailyRows) => {
    const zeroDays = (dailyRows || []).filter((r) => !(Number(r.sales) > 0)).map((r) => r.date);
    setResyncing(true);
    setError('');
    try {
      await refreshDashboardCache(zeroDays.length ? { dates: zeroDays } : { startDate: sd, endDate: ed });
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || 'ดึงข้อมูลจาก POS ใหม่ไม่สำเร็จ');
    } finally {
      setResyncing(false);
    }
    await load(sd, ed);
  }, [load]);

  // โหลดรายชื่อสาขา (เฉพาะผู้ใช้ระดับ all) แล้วเลือกสาขาแรกอัตโนมัติ
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    apiCall('getBranches')
      .then((res) => {
        if (!alive) return;
        if (res?.status === 'success' && Array.isArray(res.data)) {
          // กรองแถว header ('ชื่อสาขา'), 'all' และค่าที่ outletId ไม่ใช่ตัวเลข (ไม่ใช่สาขาจริง)
          const list = res.data.filter((b) => {
            const name = String(b?.name || '').trim().toLowerCase();
            if (!name || name === 'all' || name === 'ชื่อสาขา') return false;
            const oid = b?.outletId;
            return oid === '' || oid == null || !Number.isNaN(Number(oid));
          });
          setBranchList(list);
          setSelBranch((prev) => prev || list[0] || null);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [isAdmin]);

  // ออโต้โหลดข้อมูลเมื่อเข้าหน้า/เปลี่ยนสาขา (ใช้ช่วงวันที่ที่เลือกอยู่)
  useEffect(() => {
    if (!branch && !outletId) return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    load(startDate, endDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, outletId, load]);

  const applyPreset = (key) => {
    setPreset(key);
    if (key === 'custom') return;
    const r = presetRange(key);
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    load(r.startDate, r.endDate);
  };

  const d = data || {};
  const profitPositive = (d.profit ?? 0) >= 0;

  // ส่งจำนวน (น้ำซุป/กุ้งแก้ว/ขนมหวาน/จำนวนหัว) ขึ้นแถบหัวเว็บ (ข้างหน้า "ผู้ใช้งาน")
  const { setTopStats } = useOutletContext() || {};
  useEffect(() => {
    if (!setTopStats) return;
    if (!data) { setTopStats(null); return; }
    const soupQty = Number(data.soupQty) || 0;
    const shrimpQty = Number(data.shrimpQty) || 0;
    const dessertQty = Number(data.dessertQty) || 0;
    const covers = Number(data.covers) || 0;
    setTopStats({ soupQty, shrimpQty, dessertQty, totalQty: soupQty + shrimpQty + dessertQty, covers });
  }, [data, setTopStats]);
  // ออกจากหน้าแดชบอร์ด → คงค่าสถิติตามที่ผู้ใช้งานต้องการ (ไม่เคลียร์เป็น null)

  // หน่วยแสดงผลการ์ด: บาท / % ของยอดขาย (ยอดขาย = ฐาน 100%) / ต่อหัว (หารด้วยจำนวนลูกค้า)
  const [unit, setUnit] = useState('baht'); // 'baht' | 'pct' | 'head'
  const salesBase = Number(d.sales) || 0;
  const coverBase = Number(d.covers) || 0;
  const pctf = (v) => (salesBase ? `${((Number(v || 0) / salesBase) * 100).toLocaleString('th-TH', { maximumFractionDigits: 2 })}%` : '—');
  // ต่อหัว = ยอด ÷ จำนวนลูกค้าทั้งหมด (covers) — ไม่มีจำนวนหัวก็คิดไม่ได้
  const headf = (v) => (coverBase ? baht(Number(v || 0) / coverBase) : '—');
  const disp = (v) => (unit === 'pct' ? pctf(v) : unit === 'head' ? headf(v) : baht(v));
  // โหมดบาทโชว์คำอธิบายเดิม, โหมด %/ต่อหัว โชว์ยอดเต็มเป็นบาทกำกับไว้แทน
  // (โหมดต่อหัวตัดทศนิยมของยอดรวมทิ้ง บรรทัดล่างจะได้ไม่ยาวเกินช่องจนถูกตัดปลาย)
  const subOf = (v, text) => (unit === 'baht' ? text : unit === 'head' ? `ต่อหัว • ฿${Math.round(Number(v) || 0).toLocaleString('th-TH')}` : baht(v));
  const coversPerBill = Number(d.bills) > 0 ? coverBase / Number(d.bills) : 0;

  const rangeText = useMemo(() => `${startDate} ถึง ${endDate}`, [startDate, endDate]);
  // จำนวนวันในช่วงที่เลือก — ปุ่มดึงข้อมูลจาก POS ใหม่ทำได้ครั้งละไม่เกิน 31 วัน (ตามลิมิตของ office-server)
  const rangeDays = useMemo(() => {
    const a = new Date(startDate + 'T00:00:00Z').getTime();
    const b = new Date(endDate + 'T00:00:00Z').getTime();
    return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) + 1 : 0;
  }, [startDate, endDate]);
  // จำนวนวันในช่วงที่ยอดขายยังเป็น 0 (เป้าหมายของปุ่มดึงข้อมูลจาก POS ใหม่)
  const zeroDayCount = useMemo(() => (d.daily || []).filter((r) => !(Number(r.sales) > 0)).length, [d.daily]);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <OrderSuccessBanner info={orderSuccess} onClose={() => setOrderSuccess(null)} />

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-100 text-indigo-600 rounded-xl">
            <BarChart3 className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">แดชบอร์ดสาขา</h1>
            <p className="text-sm text-gray-500 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" /> {rangeText}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin ? (
            <div className="flex items-center gap-1.5 pl-3 pr-1 py-1 bg-purple-100 rounded-full">
              <Store className="w-4 h-4 text-purple-600 shrink-0" />
              <select
                value={selBranch?.name || ''}
                onChange={(e) => {
                  const b = branchList.find((x) => x.name === e.target.value);
                  if (b) setSelBranch(b);
                }}
                className="bg-transparent text-purple-800 text-sm font-medium pr-2 py-0.5 focus:outline-none cursor-pointer"
                title="เลือกสาขาที่ต้องการดู"
              >
                {branchList.length === 0 && <option value="">กำลังโหลดสาขา…</option>}
                {branchList.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}{b.outletId ? ` (${b.outletId})` : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <span className="px-3 py-1.5 bg-purple-100 text-purple-800 text-sm font-medium rounded-full">
              สาขา: {branch || outletId || '-'}
            </span>
          )}
          <button
            onClick={() => load(startDate, endDate)}
            disabled={loading || resyncing}
            className="p-2 rounded-lg bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title="โหลดใหม่"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => resync(startDate, endDate, d.daily)}
            disabled={loading || resyncing || (zeroDayCount === 0 && rangeDays > 31)}
            className="p-2 rounded-lg bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title={zeroDayCount > 0
              ? `ดึงข้อมูลจาก POS ใหม่ ${zeroDayCount} วันที่ยอดขายยังไม่ขึ้น — ใช้เวลาสักครู่`
              : (rangeDays > 31
                ? 'ดึงข้อมูลจาก POS ใหม่ได้ครั้งละไม่เกิน 31 วัน — เลือกช่วงให้สั้นลง'
                : 'ดึงข้อมูลจาก POS ใหม่ทั้งช่วงที่เลือก — ใช้เวลาสักครู่')}
          >
            <DatabaseBackup className={`w-4 h-4 ${resyncing ? 'animate-pulse' : ''}`} />
          </button>
        </div>
      </div>

      {/* ตัวเลือกช่วงเวลา */}
      <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                preset === p.key
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200'
                  : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
              }`}
            >
              {p.label}
            </button>
          ))}
          {preset === 'custom' && (
            <div className="flex flex-wrap items-center gap-2 ml-1">
              <input
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500"
              />
              <span className="text-gray-400">ถึง</span>
              <input
                type="date"
                value={endDate}
                min={startDate}
                max={fmtDate(new Date())}
                onChange={(e) => setEndDate(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500"
              />
              <button
                onClick={() => load(startDate, endDate)}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700"
              >
                ค้นหา
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>ดึงข้อมูลไม่สำเร็จ: {error}</span>
        </div>
      )}

      {/* สรุปกำไร/ขาดทุน (รายรับ–รายจ่าย) — ต้นทุนจากใบเบิก */}
      <ProfitSummary branch={branch} outletId={outletId} startDate={startDate} endDate={endDate} dash={d} />

      {/* สลับหน่วยแสดงผลการ์ด: บาท / % ของยอดขาย / ต่อหัวลูกค้า */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-gray-400">
          แสดงผลเป็น
          {unit === 'head' && (
            <span className="ml-1 text-sky-600 font-medium">(ฐาน {intf(coverBase)} หัวลูกค้า)</span>
          )}
        </span>
        <div className="inline-flex rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
          <button
            onClick={() => setUnit('baht')}
            className={`px-4 py-1.5 text-sm font-medium transition-colors ${unit === 'baht' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
          >
            ฿ บาท
          </button>
          <button
            onClick={() => setUnit('pct')}
            className={`px-4 py-1.5 text-sm font-medium transition-colors ${unit === 'pct' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
          >
            % ของยอดขาย
          </button>
          <button
            onClick={() => setUnit('head')}
            className={`px-4 py-1.5 text-sm font-medium transition-colors ${unit === 'head' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            title="เฉลี่ยต่อหัวลูกค้า = ยอด ÷ จำนวนลูกค้าทั้งหมด"
          >
            ต่อหัว (฿/คน)
          </button>
        </div>
      </div>

      {/* การ์ดสรุป */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="ยอดขายรวมทั้งหมด"
          value={unit === 'pct' ? '100%' : unit === 'head' ? headf(d.sales) : baht(d.sales)}
          sub={subOf(d.sales, 'ก่อน VAT (Bill − VAT)')}
          icon={DollarSign} accent={{ text: 'text-emerald-600', bg: 'bg-emerald-50', icon: 'text-emerald-600' }}
          onClick={data ? () => setDrill(METRICS.sales) : undefined}
        />
        <StatCard
          title="ต้นทุนรวมทั้งหมด" value={disp(d.cost)}
          sub={subOf(d.cost, 'ต้นทุนวัตถุดิบ (ไม่รวมโต๊ะเตรียม)')}
          icon={Layers} accent={{ text: 'text-rose-500', bg: 'bg-rose-50', icon: 'text-rose-500' }}
          onClick={data ? () => setDrill(METRICS.cost) : undefined}
        />
        <StatCard
          title="ต้นทุนโต๊ะเตรียม(กก)" value={disp(d.prepCost)}
          sub={subOf(d.prepCost, `${intf(d.prepQty)} กก • วัตถุดิบเตรียม`)}
          icon={Scale} accent={{ text: 'text-orange-500', bg: 'bg-orange-50', icon: 'text-orange-500' }}
          onClick={data ? () => setDrill(METRICS.prep) : undefined}
        />
        <StatCard
          title="กำไร / ขาดทุนสุทธิ" value={disp(d.profit)}
          sub={subOf(d.profit, 'ยอดขาย − ต้นทุนรวม')}
          icon={TrendingUp}
          accent={profitPositive
            ? { text: 'text-indigo-600', bg: 'bg-indigo-50', icon: 'text-indigo-600' }
            : { text: 'text-rose-600', bg: 'bg-rose-50', icon: 'text-rose-600' }}
        />
        <StatCard
          title="จำนวนบิลทั้งหมด" value={intf(d.bills)}
          sub={unit === 'head'
            ? `เฉลี่ย ${coversPerBill.toLocaleString('th-TH', { maximumFractionDigits: 2 })} คน/บิล`
            : `${intf(d.covers)} หัวลูกค้า • มีสมาชิก ${intf(d.memberBills)} บิล`}
          icon={FileText} accent={{ text: 'text-amber-600', bg: 'bg-amber-50', icon: 'text-amber-600' }}
          onClick={data ? () => setDrill(METRICS.bills) : undefined}
        />
        <StatCard
          title={unit === 'head' ? 'ยอดเฉลี่ยต่อหัว' : 'ยอดเฉลี่ยต่อบิล'}
          value={unit === 'head' ? headf(d.gross ?? d.sales) : baht(d.avgPerBill)}
          sub={unit === 'head'
            ? `ต่อบิล ฿${Math.round(Number(d.avgPerBill) || 0).toLocaleString('th-TH')}`
            : 'เฉลี่ยต่อบิล (รวม VAT)'}
          icon={TrendingUp} accent={{ text: 'text-emerald-600', bg: 'bg-emerald-50', icon: 'text-emerald-600' }}
        />
        <StatCard
          title="จำนวนลูกค้าทั้งหมด"
          // โหมด % : จำนวนลูกค้าทั้งช่วงคือฐาน 100% ของ "% เปรียบเทียบรายวัน" ในหน้ารายละเอียด
          value={unit === 'pct' && Number(d.covers) > 0 ? '100%' : intf(d.covers)}
          sub={(() => {
            // สาขาที่มีหัว 2 ราคา (Buffet 259 + Premium 359 พร้อมกัน) แยกให้เห็นตรงนี้เลย ไม่ต้องคลิกเข้าไปดู
            const bd = d.coversBreakdown || [];
            const cov = Number(d.covers) || 0;
            const q259 = bd.find(g => g.key === 'buffet259')?.qty || 0;
            const q359 = bd.find(g => g.key === 'buffet359')?.qty || 0;
            // โหมดต่อหัวใช้จำนวนลูกค้าเป็นตัวหาร จึงบอกว่าเป็นฐาน แทนการแยก 259/359 (ยาวเกินช่อง)
            if (unit === 'head') return 'ฐานคิดต่อหัว (Covers)';
            const head = unit === 'pct' ? `${intf(cov)} คน` : 'คน (Covers)';
            if (!(q259 > 0 && q359 > 0)) return head;
            const p = (q) => (cov ? ` (${pct1((q / cov) * 100)})` : '');
            return `259: ${intf(q259)}${p(q259)} • 359: ${intf(q359)}${p(q359)}`;
          })()}
          icon={Users} accent={{ text: 'text-sky-600', bg: 'bg-sky-50', icon: 'text-sky-600' }}
          onClick={data ? () => setShowCovers(true) : undefined}
        />
        <StatCard
          title="รายการไม่นับคำนวณ" value={disp(d.excludedCost)}
          sub={subOf(d.excludedCost, `${intf(d.excludedQty)} ชิ้น • ไม่นำมาคิดต้นทุน`)}
          icon={Ban} accent={{ text: 'text-gray-500', bg: 'bg-gray-100', icon: 'text-gray-500' }}
          onClick={data ? () => setDrill(METRICS.excluded) : undefined}
        />
      </div>

      {/* กราฟยอดขายรายวัน */}
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
        <div className="mb-3">
          <h2 className="text-lg font-bold text-gray-800">ยอดขายรายวัน</h2>
          <p className="text-sm text-gray-400">แนวโน้มรายได้การขายในแต่ละวัน</p>
        </div>
        {loading && !data ? (
          <div className="h-64 flex items-center justify-center text-gray-400 text-sm">
            <RefreshCw className="w-5 h-5 animate-spin mr-2" /> กำลังโหลดข้อมูล...
          </div>
        ) : (
          <DailySalesChart daily={d.daily} />
        )}
      </div>

      {/* Modal: จำนวนลูกค้า — แยกประเภท + % เปรียบเทียบรายวันของทั้งเดือน */}
      {showCovers && (
        <CoversModal
          open onClose={() => setShowCovers(false)}
          covers={d.covers} breakdown={d.coversBreakdown} daily={d.daily} rangeText={rangeText}
        />
      )}

      {/* Drill-down: สรุปรายวัน → คลิกวัน → รายละเอียด (บิล/breakdown ต้นทุน) */}
      {drill && (
        <DailyDrilldownModal
          open onClose={() => setDrill(null)}
          metric={drill} daily={d.daily || []}
          branch={branch} outletId={outletId}
        />
      )}
    </div>
  );
}
