import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { Loader2, Save, Search, AlertCircle, PackageSearch, Eye, FileText, ClipboardList, Calculator, Plus, X, Trash2, Check, ChevronLeft, ChevronRight } from 'lucide-react';

// ยอดยกมาเดือนที่แล้ว = ยอดนับล่าสุดของ "เดือนก่อน" จาก stockHistory (date รูปแบบ dd/MM/yyyy)
// คำนวณฝั่ง client จากประวัติที่ getStockItems ส่งมาแล้ว (ไม่ต้องยิง API เพิ่ม)
function prevMonthFromHistory(history) {
  const now = new Date();
  let pMonth = now.getMonth(); // 0-based = เดือนก่อนหน้าแบบ 1-based
  let pYear = now.getFullYear();
  if (pMonth === 0) { pMonth = 12; pYear -= 1; }
  const mm = String(pMonth).padStart(2, '0');
  const yyyy = String(pYear);
  let best = null;
  for (const h of history || []) {
    const m = String(h.date || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) continue;
    if (m[2].padStart(2, '0') !== mm || m[3] !== yyyy) continue;
    const key = `${yyyy}-${mm}-${m[1].padStart(2, '0')}`;
    if (!best || key >= best.key) best = { key, qty: h.remaining, date: key }; // วันล่าสุด (ซ้ำวันเดียวกันเอาแถวหลัง)
  }
  return best;
}

// ── เครื่องคิดเลขสะสม: ใส่จำนวนทีละจุด เก็บเป็นรายการ แล้วรวมยอดลงช่องคงเหลือ ──
function CalcModal({ open, name, parts, onChangeParts, onApply, onClose }) {
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
import toast from 'react-hot-toast';

const thaiMonths = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
];

export default function StockList() {
  const { user } = useAuth();
  const isAll = user?.branch?.toLowerCase() === 'all';

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [sortBy, setSortBy] = useState('storageCat');
  const [isSaving, setIsSaving] = useState(false);
  const [isEditingCat, setIsEditingCat] = useState(false);
  const [requestDate, setRequestDate] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [counterName, setCounterName] = useState('');
  
  const [specialPcts, setSpecialPcts] = useState([]);
  const [showPctPanel, setShowPctPanel] = useState(false);
  const [isLoadingPct, setIsLoadingPct] = useState(false);
  const [currentCalMonth, setCurrentCalMonth] = useState(new Date().getMonth());
  const [currentCalYear, setCurrentCalYear] = useState(new Date().getFullYear());
  const [pctInputMap, setPctInputMap] = useState({});
  const [isSavingAllPcts, setIsSavingAllPcts] = useState(false);
  
  const [apiStartDate, setApiStartDate] = useState('');
  const [apiEndDate, setApiEndDate] = useState('');
  const [isFetchingApi, setIsFetchingApi] = useState(false);
  const [selectedUsageDetails, setSelectedUsageDetails] = useState(null);
  const [recipeMap, setRecipeMap] = useState({});
  const [usageByMenu, setUsageByMenu] = useState({});
  const [expandedMenu, setExpandedMenu] = useState(null);
  const [menuTables, setMenuTables] = useState({}); // { [menuName]: { loading, rows } }

  const toggleMenuTables = async (menuName) => {
    if (expandedMenu === menuName) { setExpandedMenu(null); return; }
    setExpandedMenu(menuName);
    if (menuTables[menuName]) return; // โหลดแล้ว
    setMenuTables(prev => ({ ...prev, [menuName]: { loading: true, rows: [] } }));
    try {
      const qs = `branch=${encodeURIComponent(effectiveBranch)}&startDate=${encodeURIComponent(apiStartDate)}&endDate=${encodeURIComponent(apiEndDate)}&menu=${encodeURIComponent(menuName)}`;
      const res = await fetch(`/api/usagebytable?${qs}`).then(r => r.json());
      setMenuTables(prev => ({ ...prev, [menuName]: { loading: false, rows: res.status === 'success' ? (res.data || []) : [] } }));
    } catch {
      setMenuTables(prev => ({ ...prev, [menuName]: { loading: false, rows: [] } }));
    }
  };
  const [selectedReceivedDetails, setSelectedReceivedDetails] = useState(null);
  const [withdrawalDocs, setWithdrawalDocs] = useState([]);
  const [showWithdrawalModal, setShowWithdrawalModal] = useState(false);
  const [isLoadingWithdrawals, setIsLoadingWithdrawals] = useState(false);
  const [expandedDoc, setExpandedDoc] = useState(null);
  const [selectedStockHistory, setSelectedStockHistory] = useState(null);
  const [pendingOrders, setPendingOrders] = useState([]);
  const [showPendingModal, setShowPendingModal] = useState(false);
  const [isLoadingPending, setIsLoadingPending] = useState(false);
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);

  // Effective branch used for data loading
  const effectiveBranch = isAll ? selectedBranch : user?.branch;

  const loadSpecialPcts = async (branch) => {
    if (!branch) {
      setSpecialPcts([]);
      return;
    }
    setIsLoadingPct(true);
    try {
      const res = await fetch(`/api/stockcount?getpercentages=1&branch=${encodeURIComponent(branch)}`).then(r => r.json());
      if (res.status === 'success') {
        setSpecialPcts(res.data || []);
      }
    } catch (err) {
      console.error('Failed to load daily percentages:', err);
    } finally {
      setIsLoadingPct(false);
    }
  };

  useEffect(() => {
    if (effectiveBranch) {
      loadSpecialPcts(effectiveBranch);
    } else {
      setSpecialPcts([]);
    }
  }, [effectiveBranch]);

  useEffect(() => {
    const newMap = {};
    specialPcts.forEach(item => {
      newMap[item.date] = item.percent;
    });
    setPctInputMap(newMap);
  }, [specialPcts]);

  const handlePrevMonth = () => {
    if (currentCalMonth === 0) {
      setCurrentCalMonth(11);
      setCurrentCalYear(prev => prev - 1);
    } else {
      setCurrentCalMonth(prev => prev - 1);
    }
  };

  const handleNextMonth = () => {
    if (currentCalMonth === 11) {
      setCurrentCalMonth(0);
      setCurrentCalYear(prev => prev + 1);
    } else {
      setCurrentCalMonth(prev => prev + 1);
    }
  };

  const handleTempPctChange = (ymdStr, val) => {
    setPctInputMap(prev => ({ ...prev, [ymdStr]: val }));
  };

  const handleSaveAllPcts = async () => {
    if (!effectiveBranch) return;

    const updates = [];
    const allDates = new Set([
      ...Object.keys(pctInputMap),
      ...specialPcts.map(p => p.date)
    ]);

    allDates.forEach(date => {
      const originalVal = specialPcts.find(p => p.date === date)?.percent;
      const currentValStr = pctInputMap[date];
      const currentVal = currentValStr === '' || currentValStr === undefined || currentValStr === null ? 0 : Number(currentValStr);
      const originalValNum = originalVal === undefined || originalVal === null ? 0 : Number(originalVal);

      if (currentVal !== originalValNum) {
        updates.push({
          date,
          percent: currentVal
        });
      }
    });

    if (updates.length === 0) {
      toast('ไม่มีข้อมูลเปอร์เซ็นต์พิเศษที่เปลี่ยนแปลง', { icon: 'ℹ️' });
      return;
    }

    setIsSavingAllPcts(true);
    try {
      await apiCall('saveBranchPercentagesBulk', {
        branch: effectiveBranch,
        updates
      });
      toast.success('บันทึกเปอร์เซ็นต์พิเศษทั้งหมดเรียบร้อยแล้ว');
      loadSpecialPcts(effectiveBranch);
    } catch (err) {
      toast.error(err.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setIsSavingAllPcts(false);
    }
  };

  const getCalendarDays = () => {
    const firstDayOfMonth = new Date(currentCalYear, currentCalMonth, 1);
    const startDayOfWeek = firstDayOfMonth.getDay(); // 0 = Sun, 1 = Mon...
    const daysInMonth = new Date(currentCalYear, currentCalMonth + 1, 0).getDate();
    
    const days = [];
    const prevMonthDays = new Date(currentCalYear, currentCalMonth, 0).getDate();
    
    // Padding days from previous month
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
      days.push({
        date: new Date(currentCalYear, currentCalMonth - 1, prevMonthDays - i),
        isCurrentMonth: false,
        key: `prev-${prevMonthDays - i}`
      });
    }
    
    // Current month days
    for (let i = 1; i <= daysInMonth; i++) {
      days.push({
        date: new Date(currentCalYear, currentCalMonth, i),
        isCurrentMonth: true,
        key: `curr-${i}`
      });
    }
    
    // Padding days for next month
    const totalCells = Math.ceil(days.length / 7) * 7;
    const nextMonthDaysNeeded = totalCells - days.length;
    for (let i = 1; i <= nextMonthDaysNeeded; i++) {
      days.push({
        date: new Date(currentCalYear, currentCalMonth + 1, i),
        isCurrentMonth: false,
        key: `next-${i}`
      });
    }
    
    return days;
  };

  const dateToYMD = (d) => {
    if (!d) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const formatDateTh = (ymd) => {
    if (!ymd) return '';
    const parts = ymd.split('-');
    if (parts.length !== 3) return ymd;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  };

  useEffect(() => {
    if (isAll) {
      // Load branch list for the dropdown selector
      apiCall('getBranches', {}).then(res => {
        if (res.status === 'success') setBranches(res.data);
      });
      // โหลดสูตรเมนู (วัตถุดิบ -> รายชื่อเมนู) ครั้งเดียว ใช้แสดงในป๊อปอัปรายละเอียดการเบิกใช้
      fetch('/api/recipe')
        .then(r => r.json())
        .then(res => { if (res.status === 'success') setRecipeMap(res.data || {}); })
        .catch(() => {});
    } else {
      loadData(user?.branch);
    }
  }, []);

  const loadData = async (branch) => {
    if (!branch) return;
    setLoading(true);
    setItems([]);
    try {
      const [itemsRes, empRes] = await Promise.all([
        apiCall('getStockItems', { branch }),
        apiCall('getScheduleEmployees', { branch }),
      ]);

      if (itemsRes.status === 'success') {
        // ยอดยกมาเดือนที่แล้ว คำนวณจาก stockHistory ที่ได้มาแล้ว (ไม่ยิง API เพิ่ม)
        setItems(itemsRes.data.map(item => {
          const pm = prevMonthFromHistory(item.stockHistory);
          return { ...item, remaining: '', requested: '', prevMonthQty: pm ? pm.qty : undefined, prevMonthDate: pm ? pm.date : '' };
        }));
      } else {
        toast.error('ไม่สามารถดึงข้อมูลรายการสินค้าได้');
      }
      if (empRes.status === 'success') setEmployees(empRes.data);
    } catch (err) {
      toast.error('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
    } finally {
      setLoading(false);
    }
  };

  const fetchApiData = async () => {
    if (!effectiveBranch || !apiStartDate || !apiEndDate) {
      toast.error('กรุณาเลือกสาขา และระบุช่วงวันที่ให้ครบถ้วน');
      return;
    }
    let currentOutletId = '';
    if (isAll) {
      const foundBranch = branches.find(b => b.name === effectiveBranch);
      if (foundBranch) currentOutletId = foundBranch.outletId;
    } else {
      currentOutletId = user?.outletId || '';
    }

    setIsFetchingApi(true);
    try {
      const qs = `branch=${encodeURIComponent(effectiveBranch)}&outletId=${encodeURIComponent(currentOutletId)}&startDate=${encodeURIComponent(apiStartDate)}&endDate=${encodeURIComponent(apiEndDate)}`;
      const supQs = `branch=${encodeURIComponent(effectiveBranch)}&start=${encodeURIComponent(apiStartDate)}&end=${encodeURIComponent(apiEndDate)}&supreceived=1`;
      const [receivedRes, usageMenuRes, supRcvRes] = await Promise.all([
        fetch(`/api/orderd?${qs}`).then(r => r.json()),
        fetch(`/api/usagemenu?${qs}`).then(r => r.json()).catch(() => ({ status: 'error' })),
        fetch(`/api/stockcount?${supQs}`).then(r => r.json()).catch(() => ({ status: 'error' })),
      ]);

      // ยอดรับจากรายจ่าย Supplier (ที่สาขากรอกในหน้ากรอกรายจ่าย) — merge เข้ากับยอดรับจาก POS
      const supRcv = supRcvRes.status === 'success' ? (supRcvRes.data || {}) : {};
      const mergeReceived = (a, b) => {
        if (!a && !b) return null;
        if (!a) return { ...b, fromSup: true };
        if (!b) return a;
        const details = { ...(a.details || {}) };
        for (const [d, q] of Object.entries(b.details || {})) details[d] = Number(((details[d] || 0) + q).toFixed(2));
        return { total: Number(((a.total || 0) + (b.total || 0)).toFixed(2)), details, unit: a.unit || b.unit, fromSup: true };
      };

      // ยอดใช้แยกตามเมนูที่ขายจริง (สูตร BOM × ยอดขาย จาก office-server) — ถ้าไม่มีข้อมูลจะเป็น {}
      const byMenuMap = usageMenuRes.status === 'success' ? (usageMenuRes.data || {}) : {};
      const byMenuDaily = usageMenuRes.status === 'success' ? (usageMenuRes.daily || {}) : {};
      setUsageByMenu(byMenuMap);

      setItems(prevItems => prevItems.map(item => {
        const normId = String(item.productId).replace(/^0+/, '').toLowerCase();
        // ยอดใช้: คำนวณจากสูตร BOM × ยอดขายจริงเท่านั้น (ไม่ใช้ชีท UsageHistory แล้ว)
        // วัตถุดิบที่ไม่มีสูตรใน BOM เลย จะไม่มียอดใช้แสดง (เดิม fallback ไปชีท UsageHistory)
        let apiUsage = null;
        const bomRows = byMenuMap[normId];
        if (bomRows && bomRows.length) {
          const bomTotal = Number(bomRows.reduce((s, r) => s + (Number(r.qty) || 0), 0).toFixed(2));
          if (bomTotal > 0) {
            const kgOnly = bomRows.every(r => /\(\s*กก/.test(String(r.menu || '')));
            apiUsage = { total: bomTotal, details: byMenuDaily[normId] || {}, source: 'bom', kgOnly };
          }
        }
        const posReceived = receivedRes.status === 'success' ? (receivedRes.data[normId] || null) : null;
        const merged = mergeReceived(posReceived, supRcv[normId] || null);
        return {
          ...item,
          apiUsage,
          apiReceived: merged !== null ? merged : item.apiReceived,
        };
      }));

      const msgs = [];
      if (usageMenuRes.status === 'success') msgs.push('ยอดใช้ (BOM)');
      else toast.error('ยอดใช้: ' + (usageMenuRes.message || 'เกิดข้อผิดพลาด'));
      if (receivedRes.status === 'success') msgs.push('ยอดรับเข้า');
      else toast.error('ยอดรับ: ' + (receivedRes.message || 'เกิดข้อผิดพลาด'));
      if (msgs.length > 0) toast.success(`ดึงข้อมูล ${msgs.join(' และ ')} สำเร็จ`);
    } catch (err) {
      toast.error(err.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อ API');
    } finally {
      setIsFetchingApi(false);
    }
  };

  const fetchWithdrawals = async () => {
    if (!effectiveBranch || !apiStartDate || !apiEndDate) {
      toast.error('กรุณาเลือกสาขา และระบุช่วงวันที่ให้ครบถ้วน');
      return;
    }
    let currentOutletId = '';
    if (isAll) {
      const foundBranch = branches.find(b => b.name === effectiveBranch);
      if (foundBranch) currentOutletId = foundBranch.outletId;
    } else {
      currentOutletId = user?.outletId || '';
    }
    setIsLoadingWithdrawals(true);
    try {
      const qs = `branch=${encodeURIComponent(effectiveBranch)}&outletId=${encodeURIComponent(currentOutletId)}&startDate=${encodeURIComponent(apiStartDate)}&endDate=${encodeURIComponent(apiEndDate)}`;
      const res = await fetch(`/api/withdrawals?${qs}`).then(r => r.json());
      if (res.status === 'success') {
        setWithdrawalDocs(res.data || []);
        setExpandedDoc(null);
        setShowWithdrawalModal(true);
        if ((res.data || []).length === 0) toast('ไม่พบใบเบิกในช่วงวันที่ที่เลือก', { icon: 'ℹ️' });
      } else {
        toast.error('ใบเบิก: ' + (res.message || 'เกิดข้อผิดพลาด'));
      }
    } catch (err) {
      toast.error(err.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อ');
    } finally {
      setIsLoadingWithdrawals(false);
    }
  };

  const handleBranchChange = (branch) => {
    setSelectedBranch(branch);
    setItems([]);
    setSearchTerm('');
    if (branch) loadData(branch);
  };

  const handleInputChange = (index, field, value) => {
    const newItems = [...items];
    newItems[index][field] = value;
    setItems(newItems);
  };

  // เครื่องคิดเลขสะสมของช่องคงเหลือ (นับหลายจุด/หลายลังแล้วรวม)
  const [calcFor, setCalcFor] = useState(null);   // { index, productId, name }
  const [calcParts, setCalcParts] = useState({});  // productId -> number[]

  // ── คำนวณยอดเบิกอัตโนมัติ ──
  // สูตร: ยอดเบิก = ค่าเฉลี่ยต่อหัว (ชีทค่าเฉลี่ยยอดใช้ต่อหัว) × (จำนวนหัวลูกค้าช่วงนับก่อนหน้า→นับล่าสุด ÷ จำนวนวันห่าง) × ตัวคูณวัน
  // ตัวคูณวันที่ใช้ของ: จ-พฤ ×1 | ศ ×1.1 | ส-อา/นักขัตฤกษ์ ×1.2
  const tomorrowYMD = () => {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const [useDate, setUseDate] = useState(tomorrowYMD());
  const [isCalcReq, setIsCalcReq] = useState(false);

  const parseDMY = (s) => {
    const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
  };
  const toYMD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const calcRequested = async () => {
    if (!effectiveBranch) { toast.error('กรุณาเลือกสาขา'); return; }
    if (!useDate) { toast.error('กรุณาเลือกวันที่ใช้ของ'); return; }
    setIsCalcReq(true);
    try {
      // 1) ค่าเฉลี่ยต่อหัวของสาขานี้
      const avgRes = await fetch(`/api/stockcount?avgperhead=1&branch=${encodeURIComponent(effectiveBranch)}`).then(r => r.json());
      if (avgRes.status !== 'success') throw new Error(avgRes.message || 'ดึงค่าเฉลี่ยต่อหัวไม่สำเร็จ');
      const avgMap = avgRes.data || {};
      if (!Object.keys(avgMap).length) throw new Error('ไม่พบค่าเฉลี่ยต่อหัวของสาขานี้ในชีท');

      // 2) ดึงเปอร์เซ็นต์พิเศษรายวัน
      const pctRes = await fetch(`/api/stockcount?getpercentages=1&branch=${encodeURIComponent(effectiveBranch)}`).then(r => r.json());
      const pctList = pctRes.status === 'success' ? (pctRes.data || []) : [];
      const pctMap = {};
      pctList.forEach(item => {
        pctMap[item.date] = 1 + (Number(item.percent) / 100);
      });

      // 3) หา ช่วงวัน (นับก่อนหน้า → นับล่าสุด) ต่อรายการ + ช่วงรวมสำหรับดึงจำนวนหัวลูกค้า
      let minPrev = null, maxLast = null;
      const jobs = [];
      items.forEach((item, idx) => {
        const nid = String(item.productId).replace(/^0+/, '').toLowerCase();
        const avg = Number(avgMap[nid]) || 0;
        if (avg <= 0) return;
        const prevD = parseDMY(item.previousBalanceDate);
        const lastD = parseDMY(item.lastStockDate);
        if (!prevD || !lastD) return;
        const gapDays = Math.round((lastD - prevD) / 86400000);
        if (gapDays < 1) return;
        jobs.push({ idx, avg, prevD, lastD, gapDays });
        if (!minPrev || prevD < minPrev) minPrev = prevD;
        if (!maxLast || lastD > maxLast) maxLast = lastD;
      });
      if (!jobs.length) throw new Error('ไม่มีรายการที่มีทั้งยอดนับก่อนหน้า + คงเหลือล่าสุด + ค่าเฉลี่ยต่อหัว');

      // จำกัดช่วงย้อนหลังไม่เกิน 92 วัน (กันดึงข้อมูลหนักเกิน)
      const minAllowed = new Date(); minAllowed.setDate(minAllowed.getDate() - 92);
      if (minPrev < minAllowed) minPrev = minAllowed;

      // 4) จำนวนหัวลูกค้ารายวันของสาขา (covers จากแดชบอร์ด)
      const dashRes = await fetch(`/api/dashboard?branch=${encodeURIComponent(effectiveBranch)}&startDate=${toYMD(minPrev)}&endDate=${toYMD(maxLast)}`).then(r => r.json());
      if (dashRes.status !== 'success') throw new Error(dashRes.message || 'ดึงจำนวนหัวลูกค้าไม่สำเร็จ');
      const coversByDate = {};
      (dashRes.data?.daily || []).forEach(d => { coversByDate[d.date] = Number(d.covers) || 0; });

      // 5) คำนวณและเติมลงช่องขอเบิก
      const newItems = [...items];
      let filled = 0;
      let totalCalculatedCovers = 0;
      for (const j of jobs) {
        let coversGap = 0;
        const d = new Date(j.prevD); d.setDate(d.getDate() + 1); // นับวันถัดจากวันนับก่อนหน้า ถึงวันนับล่าสุด
        while (d <= j.lastD) { coversGap += coversByDate[toYMD(d)] || 0; d.setDate(d.getDate() + 1); }
        if (coversGap <= 0) continue;

        // คำนวณระยะวันช่วงวางแผนใช้ของ: ตั้งแต่วันถัดจากวันนับล่าสุด (lastD + 1) ถึงวันที่ต้องการใช้ของ (useDate)
        const startForecast = new Date(j.lastD);
        startForecast.setDate(startForecast.getDate() + 1);
        const targetForecast = new Date(useDate + 'T00:00:00');
        
        let totalMult = 0;
        const tempD = new Date(startForecast);
        while (tempD <= targetForecast) {
          const ymdStr = toYMD(tempD);
          const dayMult = pctMap[ymdStr] !== undefined ? pctMap[ymdStr] : 1.0;
          totalMult += dayMult;
          tempD.setDate(tempD.getDate() + 1);
        }

        if (totalMult <= 0) continue;

        // สูตรยอดใช้คาดการณ์รวม: (avg per head * เฉลี่ยจำนวนลูกค้าต่อวันในช่วงก่อนหน้า) * ตัวคูณสะสมรวม
        const predictedUsage = j.avg * (coversGap / j.gapDays) * totalMult;

        // หักลบด้วยยอดคงเหลือปัจจุบัน: ช่อง "กรอกคงเหลือ" (remaining) ถ้าไม่มีใช้ "คงเหลือล่าสุด" (lastStock)
        const currentItem = newItems[j.idx];
        const remVal = (currentItem.remaining !== '' && currentItem.remaining !== null && currentItem.remaining !== undefined)
          ? Number(currentItem.remaining)
          : (Number(currentItem.lastStock) || 0);

        const suggested = Number(Math.max(0, predictedUsage - remVal).toFixed(2));
        newItems[j.idx] = { 
          ...newItems[j.idx], 
          requested: String(suggested),
          calcCovers: coversGap
        };
        filled++;
        totalCalculatedCovers = Math.max(totalCalculatedCovers, coversGap);
      }
      setItems(newItems);
      toast.success(`คำนวณยอดเบิกเสร็จสิ้น ${filled} รายการ (จำนวนลูกค้าสูงสุดในช่วงสะสม: ${totalCalculatedCovers} คน)`, { duration: 6000 });
    } catch (e) {
      toast.error(e.message || 'คำนวณยอดเบิกไม่สำเร็จ');
    } finally {
      setIsCalcReq(false);
    }
  };

  // --- Generate order number: YY + MM + running (0001) ---
  const generateOrderNo = async (outletId) => {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const prefix = `${yy}${mm}`;
    try {
      const res = await fetch(`/api/pending_orders?outletId=${encodeURIComponent(outletId)}`);
      const data = await res.json();
      let maxRun = 0;
      if (data.status === 'success' && Array.isArray(data.all)) {
        data.all.forEach(order => {
          const no = String(order.no || order.No || order.Ord_No || '');
          if (no.startsWith(prefix)) {
            const run = parseInt(no.slice(prefix.length), 10);
            if (!isNaN(run) && run > maxRun) maxRun = run;
          }
        });
      }
      const nextRun = String(maxRun + 1).padStart(4, '0');
      return `${prefix}${nextRun}`;
    } catch {
      return `${prefix}0001`;
    }
  };

  // --- Fetch pending orders ---
  // ── ปุ่ม "สั่งของ" — ส่งรายการที่ขอเบิกเข้า myfbdata.orderd โดยตรง ──
  //    เลขที่ใบสั่ง (Ord_No) ฝั่งเซิร์ฟเวอร์เป็นคนจองจาก config ของสาขา
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [orderDelDate, setOrderDelDate] = useState('');
  const [isOrdering, setIsOrdering] = useState(false);
  const [orderResult, setOrderResult] = useState(null); // { no, message }

  const submitOrder = async () => {
    if (!orderDelDate) { toast.error('กรุณาเลือกวันที่รับสินค้า'); return; }
    const outletId = isAll
      ? (branches.find(b => b.name === effectiveBranch)?.outletId || '')
      : (user?.outletId || '');
    if (!outletId) { toast.error('ไม่พบรหัสสาขา (outletId)'); return; }

    const orderItems = items
      .filter(i => Number(i.requested) > 0)
      .map(i => ({
        itemId: i.itemId,
        itemCode: i.productId,
        itemName: i.name,
        qty: Number(i.requested),
        unit: i.unit,
        price: Number(i.price) || 0,
      }));
    if (orderItems.length === 0) { toast.error('ไม่มีรายการที่ขอเบิก'); return; }

    setIsOrdering(true);
    setOrderResult(null);
    try {
      const res = await fetch('/api/insert_order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outletId,
          branch: effectiveBranch,
          deldate: orderDelDate,
          items: orderItems,
        }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        setOrderResult({
          ok: true, no: data.orderNo, count: data.count, deldate: data.deldate,
          message: `ส่งใบเบิกสำเร็จ • เลขที่ ${data.orderNo} (${data.count} รายการ)`,
        });
        toast.success(`📦 ส่งใบเบิกสำเร็จ! เลขที่ ${data.orderNo} • ${data.count} รายการ`, { duration: 8000 });
        // ดึงใบเบิกค้างใหม่ ให้ใบที่เพิ่งสั่งขึ้นมาทันที
        try {
          const p = await fetch(`/api/pending_orders?outletId=${encodeURIComponent(outletId)}`);
          const pj = await p.json();
          if (pj.status === 'success') setPendingOrders(pj.data || []);
        } catch (e) { /* ไม่เป็นไร กดดูเองได้ */ }
      } else {
        const detail = Array.isArray(data.missing) && data.missing.length
          ? `${data.message}\n${data.missing.slice(0, 5).join('\n')}`
          : (data.message || 'ส่งไม่สำเร็จ');
        setOrderResult({ ok: false, message: detail });
        toast.error(`ส่งสั่งของไม่สำเร็จ: ${data.message || 'เกิดข้อผิดพลาด'}`);
      }
    } catch (err) {
      setOrderResult({ ok: false, message: err.message });
      toast.error('ส่งสั่งของไม่สำเร็จ: ' + err.message);
    } finally {
      setIsOrdering(false);
    }
  };

  const fetchPendingOrders = async () => {
    const outletId = isAll
      ? (branches.find(b => b.name === effectiveBranch)?.outletId || '')
      : (user?.outletId || '');
    if (!outletId) { toast.error('ไม่พบรหัสสาขา'); return; }
    setIsLoadingPending(true);
    try {
      const res = await fetch(`/api/pending_orders?outletId=${encodeURIComponent(outletId)}`);
      const data = await res.json();
      if (data.status === 'success') {
        setPendingOrders(data.data || []);
        setShowPendingModal(true);
      } else {
        toast.error(data.message || 'ไม่สามารถดึงข้อมูลใบเบิกค้างได้');
      }
    } catch (err) {
      toast.error(err.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อ');
    } finally {
      setIsLoadingPending(false);
    }
  };

  const handleSave = async () => {
    const itemsToSave = items.filter(
      item => (item.remaining !== '' && item.remaining !== null) || (item.requested !== '' && Number(item.requested) > 0)
    );
    if (itemsToSave.length === 0) {
      toast.error('กรุณากรอกข้อมูลคงเหลือหรือยอดขอเบิกอย่างน้อย 1 รายการ');
      return;
    }
    const hasRemaining = itemsToSave.some(item => item.remaining !== '');
    if (hasRemaining && !counterName) {
      toast.error('กรุณาเลือกชื่อพนักงานนับสต๊อก');
      return;
    }
    const hasRequests = itemsToSave.some(item => item.requested !== '' && Number(item.requested) > 0);
    if (hasRequests) {
      if (!requestDate) { toast.error('กรุณาระบุวันที่ต้องการรับสินค้า'); return; }
      if (!requesterName) { toast.error('กรุณาเลือกชื่อผู้เบิก'); return; }
    }

    setIsSaving(true);
    try {
      const payloadItems = itemsToSave.map(item => ({ ...item, requested: item.requested ? Number(item.requested) : 0 }));
      const res = await apiCall('saveStock', {
        branch: effectiveBranch || 'Unknown',
        username: user?.username || 'Unknown',
        counterName,
        requestDate,
        requesterName,
        items: payloadItems
      });
      if (res.status === 'success') {
        toast.success(res.message || 'บันทึกข้อมูลเรียบร้อยแล้ว');

        // --- ส่งใบเบิกไปยัง External API ถ้ามีรายการขอเบิก ---
        if (hasRequests) {
          setIsSubmittingOrder(true);
          try {
            const outletId = isAll
              ? (branches.find(b => b.name === effectiveBranch)?.outletId || '')
              : (user?.outletId || '');
            if (outletId) {
              const orderNo = await generateOrderNo(outletId);
              const orderRes = await fetch(
                `/api/insert_order?outletId=${encodeURIComponent(outletId)}&deldate=${encodeURIComponent(requestDate)}&no=${encodeURIComponent(orderNo)}`
              );
              const orderData = await orderRes.json();
              if (orderData.status === 'success') {
                toast.success(`📋 ส่งใบเบิกสำเร็จ! เลขที่ใบเบิก: ${orderNo}`, { duration: 6000 });
              } else {
                toast.error(`ส่งใบเบิกไม่สำเร็จ: ${orderData.message || 'เกิดข้อผิดพลาด'}`);
              }
            }
          } catch (err) {
            toast.error('ส่งใบเบิกไปยังระบบไม่สำเร็จ: ' + err.message);
          } finally {
            setIsSubmittingOrder(false);
          }
        }

        setItems(items.map(item => ({ ...item, remaining: '', requested: '' })));
        setRequestDate('');
        setRequesterName('');
        setCounterName('');
        loadData(effectiveBranch);

      } else {
        toast.error(res.message || 'เกิดข้อผิดพลาดในการบันทึกข้อมูล');
      }
    } catch (err) {
      toast.error('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditCategory = async (item) => {
    const newCat = window.prompt(`ระบุหมวดจัดเก็บสำหรับ: ${item.name}`, item.storageCat);
    if (newCat !== null && newCat !== item.storageCat) {
      setIsEditingCat(true);
      try {
        const res = await apiCall('updateStorageCategory', {
          productId: item.productId,
          name: item.name,
          branch: effectiveBranch || 'Unknown',
          category: newCat
        });
        if (res.status === 'success') {
          toast.success(res.message || 'อัปเดตหมวดจัดเก็บเรียบร้อยแล้ว');
          loadData(effectiveBranch);
        } else {
          toast.error(res.message || 'เกิดข้อผิดพลาด');
        }
      } catch (err) {
        toast.error('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
      } finally {
        setIsEditingCat(false);
      }
    }
  };

  const uniqueCategories = useMemo(() => {
    const cats = new Set();
    items.forEach(item => {
      if (item.storageCat) cats.add(String(item.storageCat));
    });
    return Array.from(cats).sort((a, b) => a.localeCompare(b, 'th'));
  }, [items]);

  const sortedAndFilteredItems = useMemo(() => {
    let result = items.filter(item => {
      const itemNameStr = String(item.name || '').toLowerCase();
      const itemCatStr = String(item.storageCat || '');
      
      const matchSearch = itemNameStr.includes(searchTerm.toLowerCase()) ||
                          String(item.productId || '').toLowerCase().includes(searchTerm.toLowerCase());
      const matchCat = filterCategory === '' || itemCatStr === filterCategory;
      return matchSearch && matchCat;
    });

    result.sort((a, b) => {
      // รายการที่มียอดใช้จากระบบ ขึ้นก่อน ที่ยังไม่มีไว้ล่างสุด
      const ua = a.apiUsage && a.apiUsage.total > 0 ? 1 : 0;
      const ub = b.apiUsage && b.apiUsage.total > 0 ? 1 : 0;
      if (ua !== ub) return ub - ua;

      if (sortBy === 'storageCat') {
        const catA = String(a.storageCat || '');
        const catB = String(b.storageCat || '');
        return catA.localeCompare(catB, 'th') || String(a.productId || '').localeCompare(String(b.productId || ''));
      } else if (sortBy === 'productId') {
        return String(a.productId || '').localeCompare(String(b.productId || ''));
      } else if (sortBy === 'name') {
        return String(a.name || '').localeCompare(String(b.name || ''), 'th');
      }
      return 0;
    });

    return result;
  }, [items, searchTerm, filterCategory, sortBy]);

  // ---- Render ----
  const branchLabel = effectiveBranch || (isAll ? 'ยังไม่ได้เลือกสาขา' : user?.branch);

  return (
    <div className="max-w-7xl mx-auto space-y-5">

      {/* Header */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className={`p-3 rounded-xl ${isAll ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600'}`}>
            {isAll ? <Eye className="w-6 h-6" /> : <PackageSearch className="w-6 h-6" />}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">
              {isAll ? 'ภาพรวมสต๊อกสินค้า' : 'นับสต๊อกและขอเบิกสินค้า'}
            </h1>
            <p className="text-gray-500 mt-0.5 text-sm">
              {isAll ? 'ดูข้อมูลแบบอ่านอย่างเดียว' : 'จัดการรายการสินค้า'} · สาขา:{' '}
              <span className={`font-semibold ${isAll ? 'text-blue-600' : 'text-purple-600'}`}>{branchLabel}</span>
            </p>
          </div>
        </div>

        {/* Save + Pending Orders buttons — hidden for 'all' */}
        {!isAll && (
          <div className="flex gap-2">
            <button
              onClick={() => { setOrderResult(null); setShowOrderModal(true); }}
              disabled={!effectiveBranch}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-sky-600 text-white rounded-xl font-medium hover:bg-sky-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-sky-200"
            >
              <FileText className="w-4 h-4" />
              <span className="text-sm">สั่งของ</span>
            </button>
            <button
              onClick={fetchPendingOrders}
              disabled={isLoadingPending}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 text-white rounded-xl font-medium hover:bg-amber-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-amber-200"
            >
              {isLoadingPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />}
              <span className="text-sm">ใบเบิกค้าง</span>
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving || isSubmittingOrder || !effectiveBranch}
              className="flex items-center justify-center gap-2 px-6 py-2.5 bg-purple-600 text-white rounded-xl font-medium hover:bg-purple-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-purple-200"
            >
              {(isSaving || isSubmittingOrder) ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
              <span>{isSubmittingOrder ? 'กำลังส่งใบเบิก...' : isSaving ? 'กำลังบันทึก...' : 'บันทึกข้อมูล'}</span>
            </button>
          </div>
        )}

      </div>

      {/* Branch selector for 'all' users */}
      {isAll && (
        <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 flex items-center gap-4">
          <label className="text-blue-900 font-medium whitespace-nowrap text-sm">🏪 เลือกสาขา :</label>
          <select
            value={selectedBranch}
            onChange={(e) => handleBranchChange(e.target.value)}
            className="px-4 py-2 border border-blue-200 rounded-xl focus:ring-2 focus:ring-blue-400 outline-none text-gray-700 bg-white min-w-[180px]"
          >
            <option value="">-- เลือกสาขา --</option>
            {branches.map((br, idx) => (
              <option key={idx} value={br.name}>{br.name}</option>
            ))}
          </select>
          {selectedBranch && (
            <span className="ml-auto text-xs text-blue-500 bg-blue-100 px-3 py-1 rounded-full">
              👁 โหมดดูอย่างเดียว
            </span>
          )}
        </div>
      )}

      {/* Requester fields — show only when requests exist and not 'all' */}
      {!isAll && items.some(item => item.requested !== '' && Number(item.requested) > 0) && (
        <div className="bg-purple-50 border border-purple-100 p-4 rounded-xl flex flex-col sm:flex-row items-start sm:items-center gap-6">
          <div className="flex items-center gap-3">
            <label className="text-purple-900 font-medium whitespace-nowrap text-sm">📅 วันที่ต้องการรับสินค้า <span className="text-red-500">*</span> :</label>
            <input type="date" value={requestDate} onChange={(e) => setRequestDate(e.target.value)}
              className="px-4 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-gray-700 bg-white" />
          </div>
          <div className="flex items-center gap-3">
            <label className="text-purple-900 font-medium whitespace-nowrap text-sm">👤 ชื่อผู้เบิก <span className="text-red-500">*</span> :</label>
            <select value={requesterName} onChange={(e) => setRequesterName(e.target.value)}
              className="px-4 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-gray-700 bg-white min-w-[200px]">
              <option value="">-- เลือกผู้เบิก --</option>
              {employees.map((emp, idx) => <option key={idx} value={emp.name}>{emp.name}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Only show table section if branch selected (for 'all') or always for branch users */}
      {(!isAll || selectedBranch) && (
        <>
          {/* Search */}
          <div className="flex flex-col md:flex-row gap-4 mb-4">
            <div className="relative flex-1 flex gap-2">
              <div className="relative flex-1">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className="h-5 w-5 text-gray-400" />
                </div>
                <input type="text"
                  className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl bg-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-500 focus:border-purple-500 sm:text-sm"
                  placeholder="ค้นหาด้วยรหัส หรือ ชื่อสินค้า..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)} />
              </div>
              <select 
                value={filterCategory} 
                onChange={(e) => setFilterCategory(e.target.value)}
                className="border border-gray-200 rounded-xl px-3 py-3 bg-white text-sm focus:outline-none focus:ring-1 focus:ring-purple-500 text-gray-700 max-w-[200px]"
              >
                <option value="">ทั้งหมด (ทุกหมวด)</option>
                {uniqueCategories.map((cat, idx) => (
                  <option key={idx} value={cat}>{cat}</option>
                ))}
              </select>
              <select 
                value={sortBy} 
                onChange={(e) => setSortBy(e.target.value)}
                className="border border-gray-200 rounded-xl px-3 py-3 bg-white text-sm focus:outline-none focus:ring-1 focus:ring-purple-500 text-gray-700"
              >
                <option value="storageCat">เรียงตามหมวดจัดเก็บ</option>
                <option value="productId">เรียงตามรหัสสินค้า</option>
                <option value="name">เรียงตามชื่อสินค้า</option>
              </select>
            </div>
            
            {/* Shared Date Picker for Usage + Received */}
            <div className="flex items-center gap-2 bg-gradient-to-r from-emerald-50 to-sky-50 border border-emerald-100 p-2 rounded-xl">
              <span className="text-sm font-medium text-gray-700 ml-2 whitespace-nowrap">วันที่ :</span>
              <input type="date" value={apiStartDate} onChange={(e) => setApiStartDate(e.target.value)}
                className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500" />
              <span className="text-gray-500 text-sm">-</span>
              <input type="date" value={apiEndDate} onChange={(e) => setApiEndDate(e.target.value)}
                className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500" />
              <button
                onClick={fetchApiData}
                disabled={isFetchingApi || !effectiveBranch || !apiStartDate || !apiEndDate}
                className="px-4 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2 transition-colors whitespace-nowrap">
                {isFetchingApi ? <Loader2 className="w-4 h-4 animate-spin" /> : 'ดึงข้อมูลยอดใช้,ยอดรับเข้า'}
              </button>
              <button
                onClick={fetchWithdrawals}
                disabled={isLoadingWithdrawals || !effectiveBranch || !apiStartDate || !apiEndDate}
                className="px-4 py-1.5 bg-sky-600 text-white text-sm rounded-lg hover:bg-sky-700 disabled:opacity-50 flex items-center gap-2 transition-colors whitespace-nowrap">
                {isLoadingWithdrawals ? <Loader2 className="w-4 h-4 animate-spin" /> : <><FileText className="w-4 h-4" /> ใบเบิก</>}
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-purple-100 overflow-hidden">
            {/* Counter name row — hidden for 'all' */}
            {!isAll && (
              <div className="p-4 border-b border-amber-100 bg-amber-50/40 flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="text-amber-900 font-medium whitespace-nowrap text-sm">🧮 คำนวณยอดเบิกอัตโนมัติ — วันที่ใช้ของ:</label>
                  <input type="date" value={useDate} onChange={(e) => setUseDate(e.target.value)}
                    className="px-2 py-1.5 border border-amber-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-amber-500" />
                  
                  <button
                    onClick={calcRequested}
                    disabled={isCalcReq || !effectiveBranch || !useDate}
                    className="px-4 py-1.5 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2 whitespace-nowrap">
                    {isCalcReq ? <Loader2 className="w-4 h-4 animate-spin" /> : 'คำนวณยอดเบิก'}
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowPctPanel(!showPctPanel)}
                    className="px-3 py-1.5 border border-amber-300 text-amber-800 text-xs rounded-lg hover:bg-amber-100/50 flex items-center gap-1.5 transition-colors whitespace-nowrap">
                    ⚙️ ตั้งค่าเปอร์เซ็นต์เพิ่มพิเศษรายวัน ({specialPcts.length})
                  </button>
                </div>
                
                <div className="text-[11px] text-gray-500 leading-relaxed">
                  สูตร: (ยอดใช้เฉลี่ยรายวัน × วันห่างนับล่าสุดถึงวันใช้ของ × %ตัวคูณตามชีท) - สต๊อกคงเหลือล่าสุด
                </div>
                
                {showPctPanel && (
                  <div className="bg-white border border-amber-200 rounded-xl p-4 mt-2 max-w-2xl space-y-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">⚙️ ตั้งค่าเปอร์เซ็นต์เพิ่มพิเศษรายวัน (สาขา {effectiveBranch})</h4>
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={handlePrevMonth} className="p-1 hover:bg-amber-50 text-amber-700 rounded transition-colors">
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="text-xs font-bold text-amber-900 bg-amber-50 px-2.5 py-1 rounded-md min-w-[125px] text-center">
                          {thaiMonths[currentCalMonth]} {currentCalYear + 543}
                        </span>
                        <button type="button" onClick={handleNextMonth} className="p-1 hover:bg-amber-50 text-amber-700 rounded transition-colors">
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {isLoadingPct ? (
                      <div className="flex justify-center py-8">
                        <Loader2 className="w-6 h-6 animate-spin text-amber-600" />
                      </div>
                    ) : (
                      <div>
                        {/* Calendar Header */}
                        <div className="grid grid-cols-7 gap-1 text-center font-semibold text-[10px] text-gray-400 uppercase tracking-wider mb-1">
                          <div className="text-rose-500">อา.</div>
                          <div>จ.</div>
                          <div>อ.</div>
                          <div>พ.</div>
                          <div>พฤ.</div>
                          <div className="text-teal-600">ศ.</div>
                          <div className="text-rose-500">ส.</div>
                        </div>

                        {/* Calendar Grid */}
                        <div className="grid grid-cols-7 gap-1">
                          {getCalendarDays().map((dayObj) => {
                            const ymdStr = dateToYMD(dayObj.date);
                            const isToday = dateToYMD(new Date()) === ymdStr;
                            const val = pctInputMap[ymdStr] !== undefined ? pctInputMap[ymdStr] : '';
                            
                            const originalVal = specialPcts.find(p => p.date === ymdStr)?.percent;
                            const currentValNum = val === '' ? 0 : Number(val);
                            const originalValNum = originalVal === undefined ? 0 : Number(originalVal);
                            const isModified = dayObj.isCurrentMonth && (currentValNum !== originalValNum);

                            return (
                              <div
                                key={dayObj.key}
                                className={`p-1.5 border rounded-lg flex flex-col justify-between min-h-[64px] transition-colors ${
                                  dayObj.isCurrentMonth
                                    ? isModified
                                      ? 'border-amber-400 bg-amber-50/50 shadow-sm'
                                      : isToday
                                        ? 'border-purple-400 bg-purple-50/30'
                                        : 'border-gray-100 bg-gray-50/20'
                                    : 'border-gray-50 bg-gray-50/10 opacity-30 pointer-events-none'
                                }`}
                              >
                                <div className="flex justify-between items-center">
                                  <span className={`text-[10px] font-bold ${
                                    dayObj.isCurrentMonth
                                      ? isToday
                                        ? 'text-purple-700 font-extrabold'
                                        : 'text-gray-500'
                                      : 'text-gray-300'
                                  }`}>
                                    {dayObj.date.getDate()}
                                  </span>
                                  {isModified && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" title="ยังไม่ได้บันทึก" />
                                  )}
                                </div>

                                <div className={`mt-1 flex items-center bg-white border rounded px-1 py-0.5 focus-within:ring-1 ${
                                  isModified 
                                    ? 'border-amber-300 focus-within:ring-amber-500 focus-within:border-amber-500' 
                                    : 'border-gray-200 focus-within:ring-purple-500 focus-within:border-purple-500'
                                }`}>
                                  <span className="text-[9px] text-gray-400 font-semibold">%</span>
                                  <input
                                    type="number"
                                    min="0"
                                    placeholder="0"
                                    value={val}
                                    onChange={(e) => handleTempPctChange(ymdStr, e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.target.blur();
                                      }
                                    }}
                                    disabled={isSavingAllPcts}
                                    className="w-full text-right text-xs bg-transparent border-none outline-none font-bold text-gray-700 p-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        
                        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-4 pt-3 border-t border-gray-100">
                          <div className="text-[10px] text-gray-400 flex items-center gap-1.5">
                            <span>💡 กรอกตัวเลขเปอร์เซ็นต์ที่ต้องการลงในตาราง (ช่องที่แก้ไขจะมีจุดสีส้ม <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />) แล้วกดปุ่มบันทึกข้อมูลด้านขวาเพื่อบันทึกการเปลี่ยนแปลงทั้งหมด</span>
                          </div>
                          <button
                            type="button"
                            onClick={handleSaveAllPcts}
                            disabled={isSavingAllPcts}
                            className="w-full sm:w-auto px-5 py-2.5 bg-amber-500 text-white text-xs font-semibold rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-sm shadow-amber-200 shrink-0 cursor-pointer"
                          >
                            {isSavingAllPcts ? <Loader2 className="w-3 h-3 animate-spin" /> : '💾'}
                            <span>{isSavingAllPcts ? 'กำลังบันทึก...' : 'บันทึกเปอร์เซ็นต์พิเศษ'}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {!isAll && (
              <div className="p-4 border-b border-purple-100 bg-purple-50/30 flex items-center gap-3 max-w-sm">
                <label className="text-purple-900 font-medium whitespace-nowrap text-sm">👤 พนักงานนับสต๊อก <span className="text-red-500">*</span> :</label>
                <select value={counterName} onChange={(e) => setCounterName(e.target.value)}
                  className="px-4 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-gray-700 bg-white w-full text-sm">
                  <option value="">-- เลือกพนักงาน --</option>
                  {employees.map((emp, idx) => <option key={idx} value={emp.name}>{emp.name}</option>)}
                </select>
              </div>
            )}

            <div className="overflow-x-auto">
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <div className="flex flex-col items-center gap-3 text-purple-600">
                    <Loader2 className="w-8 h-8 animate-spin" />
                    <p className="font-medium text-sm">กำลังโหลดข้อมูล...</p>
                  </div>
                </div>
              ) : (
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50/50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-28">รหัส</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ชื่อสินค้า</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-28">หมวดจัดเก็บ</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-16">หน่วย</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-teal-600 uppercase w-32 bg-teal-50/60">ยอดยกมาเดือนที่แล้ว</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-purple-600 uppercase w-32 bg-purple-50/60">ยอดนับก่อนหน้า</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-indigo-600 uppercase w-36 bg-indigo-50/60">คงเหลือล่าสุด</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-orange-600 uppercase w-36 bg-orange-50/60">ยอดเบิกล่าสุด</th>
                      {isAll && <th className="px-4 py-3 text-center text-xs font-semibold text-emerald-600 uppercase w-32 bg-emerald-50/60">ยอดใช้จากระบบ</th>}
                      <th className="px-4 py-3 text-center text-xs font-semibold text-sky-600 uppercase w-32 bg-sky-50/60">ยอดรับ</th>
                      {isAll && <th className="px-4 py-3 text-center text-xs font-semibold text-amber-700 uppercase w-36 bg-amber-50/80">ยอดคงเหลือจากระบบ</th>}
                      {!isAll && <th className="px-2 py-3 text-center text-xs font-semibold text-gray-500 uppercase w-40 min-w-[150px]">กรอกคงเหลือ</th>}
                      {!isAll && <th className="px-2 py-3 text-center text-xs font-semibold text-gray-500 uppercase w-32 min-w-[110px]">ขอเบิก</th>}
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-100">
                    {sortedAndFilteredItems.length === 0 ? (
                      <tr>
                        <td colSpan={12} className="px-6 py-12 text-center text-gray-400">
                          <AlertCircle className="w-8 h-8 mx-auto mb-2" />
                          ไม่พบรายการสินค้า
                        </td>
                      </tr>
                    ) : sortedAndFilteredItems.map((item, index) => {
                      const originalIndex = items.findIndex(i => i.productId === item.productId);
                      return (
                        <tr key={item.productId || index} className="hover:bg-gray-50/50 transition-colors">
                          <td className="px-4 py-3 whitespace-nowrap text-xs font-mono text-gray-600">{item.productId}</td>
                          <td className="px-4 py-3 text-sm text-gray-800 font-medium">{item.name}</td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="flex items-center gap-1.5 group">
                              <span className="text-xs text-gray-500">{item.storageCat || '-'}</span>
                              {!isAll && (
                                <button onClick={() => handleEditCategory(item)} disabled={isEditingCat}
                                  className="text-gray-300 hover:text-purple-500 opacity-0 group-hover:opacity-100 transition-opacity" title="แก้ไขหมวดจัดเก็บ">
                                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">{item.unit}</td>

                          {/* ยอดยกมาเดือนที่แล้ว (นับสิ้นเดือนก่อน จาก stockcount.previous) */}
                          <td className="px-4 py-3 text-center bg-teal-50/30">
                            <div className="font-semibold text-teal-700 text-sm">
                              {item.prevMonthQty !== undefined && item.prevMonthQty !== null ? item.prevMonthQty : '-'}
                            </div>
                            {item.prevMonthDate && item.prevMonthQty !== undefined && (
                              <div className="text-[10px] text-gray-400 mt-0.5">{item.prevMonthDate}</div>
                            )}
                          </td>

                          {/* ยอดนับก่อนหน้า */}
                          <td className="px-4 py-3 text-center bg-purple-50/30">
                            <div
                              className={`font-semibold text-purple-700 text-sm ${item.stockHistory && item.stockHistory.length > 1 ? 'cursor-pointer hover:underline hover:text-purple-900' : ''}`}
                              onClick={() => item.stockHistory && item.stockHistory.length > 1 && setSelectedStockHistory({ name: item.name, history: item.stockHistory, highlight: 'previous' })}
                              title={item.stockHistory && item.stockHistory.length > 1 ? 'คลิกเพื่อดูประวัติ' : ''}
                            >
                              {item.previousBalance !== '' && item.previousBalance !== undefined ? item.previousBalance : '-'}
                            </div>
                            {item.previousBalanceDate && (
                              <div className="text-[10px] text-gray-400 mt-0.5">{String(item.previousBalanceDate || '').split(' ')[0]}</div>
                            )}
                          </td>

                          {/* คงเหลือล่าสุด (from ข้อมูลนับสตอค) */}
                          <td className="px-4 py-3 text-center bg-indigo-50/30">
                            <div
                              className={`font-semibold text-indigo-700 text-sm ${item.stockHistory && item.stockHistory.length > 0 ? 'cursor-pointer hover:underline hover:text-indigo-900' : ''}`}
                              onClick={() => item.stockHistory && item.stockHistory.length > 0 && setSelectedStockHistory({ name: item.name, history: item.stockHistory, highlight: 'last' })}
                              title={item.stockHistory && item.stockHistory.length > 0 ? 'คลิกเพื่อดูประวัติ' : ''}
                            >
                              {item.lastStock !== '' && item.lastStock !== undefined ? item.lastStock : '-'}
                            </div>
                            {item.lastStockDate && (
                              <div className="text-[10px] text-gray-400 mt-0.5" title={`นับโดย: ${item.lastStockCounter || '-'}`}>
                                {String(item.lastStockDate || '').split(' ')[0]}
                                {item.lastStockCounter && <span className="ml-1 text-indigo-400">· {item.lastStockCounter}</span>}
                              </div>
                            )}
                          </td>

                          {/* ยอดเบิกล่าสุด */}
                          <td className="px-4 py-3 text-center bg-orange-50/30">
                            <div className="font-semibold text-orange-600 text-sm">
                              {item.lastRequest !== '' && item.lastRequest !== undefined ? item.lastRequest : '-'}
                            </div>
                            {item.lastRequestDate && (
                              <div className="text-[10px] text-gray-400 mt-0.5" title={`ผู้เบิก: ${item.lastRequester || '-'}`}>
                                {String(item.lastRequestDate || '').split(' ')[0]}
                                {item.lastRequester && <span className="ml-1 text-orange-400">· {item.lastRequester}</span>}
                              </div>
                            )}
                          </td>

                          {/* ยอดใช้จาก API — เฉพาะ isAll */}
                          {isAll && (
                          <td className="px-4 py-3 text-center bg-emerald-50/30">
                            {item.apiUsage && item.apiUsage.total !== undefined ? (
                              <div
                                className="font-semibold text-emerald-600 text-sm cursor-pointer hover:underline hover:text-emerald-800"
                                onClick={() => {
                                  const nid = String(item.productId).replace(/^0+/, '').toLowerCase();
                                  setExpandedMenu(null);
                                  // ยอดใช้หลัก = สูตร BOM × ยอดขายจริง อยู่แล้ว — แสดงตามจริงไม่ต้องปรับสเกล
                                  const byMenu = (usageByMenu[nid] || []).map(r => ({ ...r, qty: Number((Number(r.qty) || 0).toFixed(2)) }));
                                  setSelectedUsageDetails({
                                    name: item.name, details: item.apiUsage.details, menus: recipeMap[nid] || [],
                                    byMenu, posTotal: null, scaled: false,
                                    kgOnly: !!item.apiUsage.kgOnly, source: item.apiUsage.source,
                                  });
                                }}
                                title="คลิกเพื่อดูรายละเอียด"
                              >
                                {item.apiUsage.total}
                              </div>
                            ) : (
                              <div className="font-semibold text-emerald-600 text-sm">-</div>
                            )}
                            {item.apiUsage?.kgOnly ? (
                              <div className="text-[10px] text-amber-500 mt-0.5">ชั่งกิโลจริง (เมนู กก)</div>
                            ) : item.apiUsage?.source === 'sheet' ? (
                              <div className="text-[10px] text-gray-400 mt-0.5">จากชีท UsageHistory</div>
                            ) : null}
                          </td>
                          )}

                          {/* ยอดรับจาก API — ทุกคนเห็นได้ */}
                          <td className="px-4 py-3 text-center bg-sky-50/30">
                            {item.apiReceived && item.apiReceived.total !== undefined ? (
                              <div
                                className="font-semibold text-sky-600 text-sm cursor-pointer hover:underline hover:text-sky-800"
                                onClick={() => setSelectedReceivedDetails({ name: item.name, details: item.apiReceived.details })}
                                title="คลิกเพื่อดูรายละเอียด"
                              >
                                {item.apiReceived.total}
                              </div>
                            ) : (
                              <div className="font-semibold text-sky-600 text-sm">-</div>
                            )}
                          </td>

                          {/* ยอดคงเหลือจากระบบ — เฉพาะ isAll */}
                          {isAll && (
                          <td className="px-4 py-3 text-center bg-amber-50/50 border-l-2 border-amber-200">
                            {(() => {
                              const prevBal = parseFloat(item.previousBalance);
                              const received = item.apiReceived?.total;
                              const usage = item.apiUsage?.total;
                              const hasReceived = received !== undefined && received !== null;
                              const hasUsage = usage !== undefined && usage !== null;
                              if (isNaN(prevBal) && !hasReceived && !hasUsage) {
                                return <div className="font-bold text-amber-700 text-sm">-</div>;
                              }
                              const base = isNaN(prevBal) ? 0 : prevBal;
                              const rec = hasReceived ? received : 0;
                              const use = hasUsage ? usage : 0;
                              const systemBalance = Number((base + rec - use).toFixed(2));
                              const color = systemBalance < 0 ? 'text-red-600' : 'text-amber-800';
                              return (
                                <div className={`font-bold text-sm ${color}`}>
                                  {systemBalance}
                                </div>
                              );
                            })()}
                            <div className="text-[10px] text-amber-400 mt-0.5">ยกมา+รับ-ใช้</div>
                          </td>
                          )}

                          {/* Input fields — hidden for 'all' */}
                          {!isAll && (
                            <td className="px-2 py-3 whitespace-nowrap">
                              <div className="flex items-center gap-1">
                                <input type="number" min="0" step="any" inputMode="decimal"
                                  value={item.remaining}
                                  onChange={(e) => handleInputChange(originalIndex, 'remaining', e.target.value)}
                                  className="w-full min-w-[80px] px-2 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-center text-base sm:text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                  placeholder="จำนวน" />
                                <button type="button" title="รวมยอดหลายจุด (เครื่องคิดเลข)"
                                  onClick={() => setCalcFor({ index: originalIndex, productId: item.productId, name: item.name })}
                                  className={`shrink-0 p-2 rounded-lg border transition-colors ${(calcParts[item.productId]?.length) ? 'border-purple-300 bg-purple-50 text-purple-700' : 'border-gray-200 text-purple-500 hover:bg-purple-50'}`}>
                                  <Calculator className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          )}
                          {!isAll && (
                            <td className="px-2 py-3 whitespace-nowrap">
                              <input type="number" min="0" step="any" inputMode="decimal"
                                value={item.requested}
                                onChange={(e) => handleInputChange(originalIndex, 'requested', e.target.value)}
                                className="w-full min-w-[96px] px-2 py-2 border border-purple-200 bg-purple-50/30 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-center text-base sm:text-sm font-semibold text-purple-700 placeholder:font-normal placeholder:text-gray-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                placeholder="เบิก" />
                              {item.calcCovers !== undefined && (
                                <div className="text-[10px] text-amber-600 mt-1 text-center font-medium" title="จำนวนลูกค้าสะสมที่ใช้คำนวณยอดเบิก">
                                  👥 ลูกค้า {item.calcCovers} คน
                                </div>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      {/* Prompt to select branch for 'all' */}
      {isAll && !selectedBranch && (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400 gap-3">
          <PackageSearch className="w-12 h-12 text-gray-300" />
          <p className="text-lg font-medium">เลือกสาขาเพื่อดูข้อมูลสต๊อก</p>
          <p className="text-sm">ใช้ตัวเลือกสาขาด้านบนเพื่อดูรายละเอียด</p>
        </div>
      )}

      {/* Usage Details Modal */}
      {selectedUsageDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm transition-opacity" onClick={() => setSelectedUsageDetails(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b bg-emerald-50 flex justify-between items-center">
              <h3 className="font-bold text-emerald-800">รายละเอียดการเบิกใช้</h3>
              <button onClick={() => setSelectedUsageDetails(null)} className="text-emerald-400 hover:text-emerald-700 font-bold text-xl leading-none">&times;</button>
            </div>
            <div className="p-5 max-h-96 overflow-y-auto">
              <p className="text-sm text-gray-700 mb-4 font-semibold border-b pb-3">{selectedUsageDetails.name}</p>
              <table className="w-full text-sm text-left border-collapse">
                <thead className="bg-gray-100 border-b">
                  <tr>
                    <th className="px-4 py-2 font-semibold text-gray-700 rounded-tl-md">วันที่</th>
                    <th className="px-4 py-2 font-semibold text-gray-700 text-right rounded-tr-md">จำนวน</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {Object.entries(selectedUsageDetails.details).sort(([a], [b]) => a.localeCompare(b)).map(([date, qty], idx) => (
                    <tr key={idx} className="hover:bg-emerald-50/50 transition-colors">
                      <td className="px-4 py-3 text-gray-600">{date}</td>
                      <td className="px-4 py-3 text-gray-900 text-right font-bold">{qty}</td>
                    </tr>
                  ))}
                  {Object.keys(selectedUsageDetails.details).length === 0 && (
                    <tr>
                      <td colSpan="2" className="px-4 py-6 text-center text-gray-400">ไม่มีข้อมูลการเบิกใช้</td>
                    </tr>
                  )}
                </tbody>
              </table>

              {/* ยอดใช้แยกตามเมนู */}
              <div className="mt-5 pt-4 border-t">
                {selectedUsageDetails.byMenu && selectedUsageDetails.byMenu.length > 0 ? (
                  <>
                    {/* Method 2: เมนูที่ขายจริง + ปริมาณที่ใช้ */}
                    <p className="text-sm font-semibold text-emerald-800 mb-2">
                      ใช้จากเมนู (ตามยอดขายจริง)
                      <span className="ml-1 text-emerald-500 font-normal">({selectedUsageDetails.byMenu.length} เมนู)</span>
                    </p>
                    <p className="text-[11px] text-gray-400 mb-1">
                      แตะที่ชื่อเมนูเพื่อดูโต๊ะที่ขาย — แต่ละโต๊ะแสดง <span className="font-semibold text-emerald-600">ขาย (จำนวนที่สั่ง)</span> · <span className="font-semibold text-amber-600">ใช้ (กก.)</span>
                      {selectedUsageDetails.kgOnly
                        ? <span className="text-amber-600"> · ยอดชั่งกิโลจริงจาก POS (เมนู กก)</span>
                        : selectedUsageDetails.source === 'bom' && <span className="text-emerald-500"> · คำนวณจากสูตร BOM × ยอดขายจริง</span>}
                    </p>
                    <table className="w-full text-sm text-left border-collapse">
                      <thead className="bg-emerald-50 border-b">
                        <tr>
                          <th className="px-3 py-2 font-semibold text-emerald-800 rounded-tl-md">เมนู</th>
                          <th className="px-3 py-2 font-semibold text-emerald-800 text-right">ขาย</th>
                          <th className="px-3 py-2 font-semibold text-emerald-800 text-right rounded-tr-md">ปริมาณใช้</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {selectedUsageDetails.byMenu.map((row, idx) => {
                          const isOpen = expandedMenu === row.menu;
                          const tbl = menuTables[row.menu];
                          return (
                            <React.Fragment key={idx}>
                              <tr className="hover:bg-emerald-50/50 cursor-pointer" onClick={() => toggleMenuTables(row.menu)}>
                                <td className="px-3 py-2 text-emerald-700">
                                  <span className="inline-block w-3 text-emerald-400">{isOpen ? '▾' : '▸'}</span> {row.menu}
                                </td>
                                <td className="px-3 py-2 text-right font-semibold text-emerald-700">{row.sold != null ? row.sold : '-'}</td>
                                <td className="px-3 py-2 text-gray-900 text-right font-bold">{row.qty}</td>
                              </tr>
                              {isOpen && (
                                <tr className="bg-gray-50/70">
                                  <td colSpan="3" className="px-3 py-2">
                                    {tbl && tbl.loading && <div className="text-xs text-gray-400">กำลังโหลดโต๊ะ...</div>}
                                    {tbl && !tbl.loading && tbl.rows.length > 0 && (() => {
                                      const sumQty = tbl.rows.reduce((s, t) => s + (Number(t.qty) || 0), 0);
                                      return (
                                        <div className="flex flex-wrap gap-1.5">
                                          {tbl.rows.map((t, i) => {
                                            const kg = sumQty > 0 ? (Number(row.qty) * (Number(t.qty) || 0) / sumQty) : 0;
                                            return (
                                              <span key={i} className="text-xs bg-white border border-emerald-200 rounded px-2 py-0.5 text-gray-600">
                                                โต๊ะ {t.table}
                                                <span className="text-gray-400"> · ขาย </span><span className="font-bold text-emerald-700">{t.qty}</span>
                                                <span className="text-gray-400"> · ใช้ </span><span className="font-bold text-amber-600">{kg.toFixed(2)}</span><span className="text-amber-400"> กก.</span>
                                              </span>
                                            );
                                          })}
                                        </div>
                                      );
                                    })()}
                                    {tbl && !tbl.loading && tbl.rows.length === 0 && <div className="text-xs text-gray-400">ไม่พบข้อมูลโต๊ะ</div>}
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-emerald-200 bg-emerald-50/60">
                          <td className="px-3 py-2 font-bold text-emerald-800">ยอดรวม</td>
                          <td className="px-3 py-2 text-right font-bold text-emerald-800">
                            {selectedUsageDetails.byMenu.reduce((s, r) => s + (Number(r.sold) || 0), 0).toFixed(2)}
                          </td>
                          <td className="px-3 py-2 text-right font-bold text-emerald-800">
                            {(selectedUsageDetails.posTotal != null
                              ? Number(selectedUsageDetails.posTotal)
                              : selectedUsageDetails.byMenu.reduce((s, r) => s + (Number(r.qty) || 0), 0)
                            ).toFixed(2)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-semibold text-emerald-800 mb-2">ใช้จากเมนู (ตามยอดขายจริง)</p>
                    <p className="text-sm text-gray-400 py-2">ไม่มีเมนูที่ตัดวัตถุดิบนี้ในช่วงวันที่ที่เลือก</p>
                  </>
                )}
              </div>
            </div>
            <div className="px-5 py-3 border-t bg-gray-50 flex justify-end">
              <button 
                onClick={() => setSelectedUsageDetails(null)}
                className="px-5 py-2 bg-white border border-gray-200 shadow-sm text-gray-700 rounded-lg hover:bg-gray-50 hover:text-gray-900 transition-colors text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Received Details Modal */}
      {selectedReceivedDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm transition-opacity" onClick={() => setSelectedReceivedDetails(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b bg-sky-50 flex justify-between items-center">
              <h3 className="font-bold text-sky-800">รายละเอียดการรับสินค้า</h3>
              <button onClick={() => setSelectedReceivedDetails(null)} className="text-sky-400 hover:text-sky-700 font-bold text-xl leading-none">&times;</button>
            </div>
            <div className="p-5 max-h-96 overflow-y-auto">
              <p className="text-sm text-gray-700 mb-4 font-semibold border-b pb-3">{selectedReceivedDetails.name}</p>
              <table className="w-full text-sm text-left border-collapse">
                <thead className="bg-gray-100 border-b">
                  <tr>
                    <th className="px-4 py-2 font-semibold text-gray-700">วันที่</th>
                    <th className="px-4 py-2 font-semibold text-gray-700 text-right">จำนวนรับ</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {Object.entries(selectedReceivedDetails.details).sort(([a], [b]) => a.localeCompare(b)).map(([date, qty], idx) => (
                    <tr key={idx} className="hover:bg-sky-50/50 transition-colors">
                      <td className="px-4 py-3 text-gray-600">{date}</td>
                      <td className="px-4 py-3 text-gray-900 text-right font-bold">{qty}</td>
                    </tr>
                  ))}
                  {Object.keys(selectedReceivedDetails.details).length === 0 && (
                    <tr>
                      <td colSpan="2" className="px-4 py-6 text-center text-gray-400">ไม่มีข้อมูลการรับสินค้า</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3 border-t bg-gray-50 flex justify-end">
              <button
                onClick={() => setSelectedReceivedDetails(null)}
                className="px-5 py-2 bg-white border border-gray-200 shadow-sm text-gray-700 rounded-lg hover:bg-gray-50 hover:text-gray-900 transition-colors text-sm font-medium focus:outline-none focus:ring-2 focus:ring-sky-500/20"
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stock Count History Modal */}
      {selectedStockHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setSelectedStockHistory(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b bg-indigo-50 flex justify-between items-center">
              <h3 className="font-bold text-indigo-800">ประวัติการนับสต็อก</h3>
              <button onClick={() => setSelectedStockHistory(null)} className="text-indigo-400 hover:text-indigo-700 font-bold text-xl leading-none">&times;</button>
            </div>
            <div className="p-5 max-h-96 overflow-y-auto">
              <p className="text-sm text-gray-700 mb-4 font-semibold border-b pb-3">{selectedStockHistory.name}</p>
              <table className="w-full text-sm text-left border-collapse">
                <thead className="bg-gray-100 border-b">
                  <tr>
                    <th className="px-4 py-2 font-semibold text-gray-700">วันที่นับ</th>
                    <th className="px-4 py-2 font-semibold text-gray-700 text-right">ยอดคงเหลือ</th>
                    <th className="px-4 py-2 font-semibold text-gray-700">ผู้นับ</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {[...selectedStockHistory.history].reverse().map((entry, idx) => {
                    const isLatest = idx === 0;
                    const isPrevious = idx === 1;
                    return (
                      <tr
                        key={idx}
                        className={`transition-colors ${isLatest ? 'bg-indigo-50 font-semibold' : isPrevious ? 'bg-purple-50' : 'hover:bg-gray-50'}`}
                      >
                        <td className="px-4 py-3 text-gray-700">
                          {entry.date}
                          {isLatest && <span className="ml-2 text-[10px] bg-indigo-500 text-white px-1.5 py-0.5 rounded-full">ล่าสุด</span>}
                          {isPrevious && <span className="ml-2 text-[10px] bg-purple-400 text-white px-1.5 py-0.5 rounded-full">ยกมา</span>}
                        </td>
                        <td className={`px-4 py-3 text-right font-bold ${isLatest ? 'text-indigo-700' : isPrevious ? 'text-purple-700' : 'text-gray-800'}`}>
                          {entry.remaining}
                        </td>
                        <td className="px-4 py-3 text-gray-500 text-xs">{entry.counter || '-'}</td>
                      </tr>
                    );
                  })}
                  {selectedStockHistory.history.length === 0 && (
                    <tr>
                      <td colSpan="3" className="px-4 py-6 text-center text-gray-400">ไม่มีข้อมูลประวัติ</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3 border-t bg-gray-50 flex justify-end">
              <button
                onClick={() => setSelectedStockHistory(null)}
                className="px-5 py-2 bg-white border border-gray-200 shadow-sm text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pending Orders Modal */}
      {showPendingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setShowPendingModal(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b bg-amber-50 flex justify-between items-center">
              <h3 className="font-bold text-amber-800 flex items-center gap-2">
                <FileText className="w-5 h-5" />
                ใบเบิกที่ยังไม่ได้รับของ
              </h3>
              <button onClick={() => setShowPendingModal(false)} className="text-amber-400 hover:text-amber-700 font-bold text-xl leading-none">&times;</button>
            </div>
            <div className="p-5 max-h-[60vh] overflow-y-auto">
              {pendingOrders.length === 0 ? (
                <div className="text-center py-10 text-gray-400">
                  <ClipboardList className="w-10 h-10 mx-auto mb-3 opacity-40" />
                  <p>ไม่มีใบเบิกค้างในขณะนี้</p>
                </div>
              ) : (
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-amber-50 border-b">
                    <tr>
                      <th className="px-4 py-2 text-left text-amber-800 font-semibold">เลขที่ใบเบิก</th>
                      <th className="px-4 py-2 text-left text-amber-800 font-semibold">วันที่สั่ง</th>
                      <th className="px-4 py-2 text-left text-amber-800 font-semibold">วันที่รับ</th>
                      <th className="px-4 py-2 text-right text-amber-800 font-semibold">รายการ</th>
                      <th className="px-4 py-2 text-center text-amber-800 font-semibold">สถานะ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {pendingOrders.map((order, idx) => {
                      const no = order.no || order.No || order.Ord_No || '-';
                      const ordDate = order.orderDate || '-';
                      const date = order.deldate || order.DelDate || order.Ord_DelDate || order.date || '-';
                      const status = order.status || order.Status || order.Ord_Status || 'รอรับของ';
                      return (
                        <tr key={idx} className="hover:bg-amber-50/50 transition-colors">
                          <td className="px-4 py-3 font-mono font-semibold text-amber-700">{no}</td>
                          <td className="px-4 py-3 text-gray-600">{String(ordDate).split('T')[0]}</td>
                          <td className="px-4 py-3 text-gray-600">{String(date).split('T')[0]}</td>
                          <td className="px-4 py-3 text-right text-gray-600">
                            {order.itemCount != null ? `${order.itemCount} รายการ` : '-'}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">{status}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="px-5 py-3 border-t bg-gray-50 flex justify-end">
              <button
                onClick={() => setShowPendingModal(false)}
                className="px-5 py-2 bg-white border border-gray-200 shadow-sm text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm font-medium"
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Withdrawal (ใบเบิก) Modal */}
      {showWithdrawalModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setShowWithdrawalModal(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b bg-sky-50 flex justify-between items-center">
              <h3 className="font-bold text-sky-800 flex items-center gap-2">
                <FileText className="w-5 h-5" />
                ใบเบิก · {branchLabel}
                <span className="text-sky-500 font-normal text-sm">({withdrawalDocs.length} ใบ · {apiStartDate} ถึง {apiEndDate})</span>
              </h3>
              <button onClick={() => setShowWithdrawalModal(false)} className="text-sky-400 hover:text-sky-700 font-bold text-xl leading-none">&times;</button>
            </div>
            <div className="p-5 max-h-[65vh] overflow-y-auto">
              {withdrawalDocs.length === 0 ? (
                <div className="text-center py-10 text-gray-400">
                  <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
                  <p>ไม่พบใบเบิกในช่วงวันที่ที่เลือก</p>
                </div>
              ) : (
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-sky-50 border-b">
                    <tr>
                      <th className="px-4 py-2 text-left text-sky-800 font-semibold">เลขที่ใบเบิก</th>
                      <th className="px-4 py-2 text-left text-sky-800 font-semibold">วันที่</th>
                      <th className="px-4 py-2 text-right text-sky-800 font-semibold">จำนวนรายการ</th>
                      <th className="px-4 py-2 text-right text-sky-800 font-semibold">ยอดรวม (จำนวน)</th>
                      <th className="px-4 py-2 text-right text-sky-800 font-semibold">มูลค่า (บาท)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {withdrawalDocs.map((doc) => {
                      const key = doc.invNo || `DOC-${doc.docNo}`;
                      const isOpen = expandedDoc === key;
                      return (
                        <React.Fragment key={key}>
                          <tr className="hover:bg-sky-50/50 cursor-pointer transition-colors" onClick={() => setExpandedDoc(isOpen ? null : key)}>
                            <td className="px-4 py-3 font-mono font-semibold text-sky-700">
                              <span className="inline-block w-3 text-sky-400">{isOpen ? '▾' : '▸'}</span> {doc.invNo || `(${doc.docNo})`}
                            </td>
                            <td className="px-4 py-3 text-gray-600">{doc.docDate}</td>
                            <td className="px-4 py-3 text-right text-gray-700">{doc.itemCount}</td>
                            <td className="px-4 py-3 text-right font-semibold text-gray-800">{doc.totalQty}</td>
                            <td className="px-4 py-3 text-right font-semibold text-gray-800">{doc.totalAmt.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                          </tr>
                          {isOpen && (
                            <tr className="bg-gray-50/70">
                              <td colSpan="5" className="px-4 py-3">
                                <table className="w-full text-xs border-collapse">
                                  <thead className="bg-white border-b">
                                    <tr>
                                      <th className="px-3 py-2 text-left text-gray-500 font-semibold">รหัส</th>
                                      <th className="px-3 py-2 text-left text-gray-500 font-semibold">ชื่อสินค้า</th>
                                      <th className="px-3 py-2 text-right text-gray-500 font-semibold">จำนวน</th>
                                      <th className="px-3 py-2 text-left text-gray-500 font-semibold">หน่วย</th>
                                      <th className="px-3 py-2 text-right text-gray-500 font-semibold">ราคา/หน่วย</th>
                                      <th className="px-3 py-2 text-right text-gray-500 font-semibold">มูลค่า</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y">
                                    {doc.items.map((it, i) => (
                                      <tr key={i} className="hover:bg-sky-50/40">
                                        <td className="px-3 py-2 font-mono text-gray-500">{it.itemCode}</td>
                                        <td className="px-3 py-2 text-gray-800">{it.itemName}</td>
                                        <td className="px-3 py-2 text-right font-semibold text-sky-700">{it.qty}</td>
                                        <td className="px-3 py-2 text-gray-500">{it.unit}</td>
                                        <td className="px-3 py-2 text-right text-gray-600">{it.unitPrice}</td>
                                        <td className="px-3 py-2 text-right text-gray-700">{it.amount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="px-5 py-3 border-t bg-gray-50 flex justify-end">
              <button onClick={() => setShowWithdrawalModal(false)} className="px-5 py-2 bg-white border border-gray-200 shadow-sm text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm font-medium">ปิด</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal สั่งของ — พรีวิวรายการที่จะเบิก + เลือกวันรับ แล้วยิง insert_order */}
      {showOrderModal && (() => {
        const orderItems = items.filter(i => Number(i.requested) > 0);
        const totalQty = orderItems.reduce((s, i) => s + (Number(i.requested) || 0), 0);
        return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={() => !isOrdering && setShowOrderModal(false)}>
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[88vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 bg-sky-600 text-white flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-base font-bold flex items-center gap-2"><FileText className="w-5 h-5" /> สั่งของ (ส่งใบเบิก)</h3>
                <p className="text-xs text-sky-100 mt-0.5">สาขา {effectiveBranch} • {orderItems.length} รายการ</p>
              </div>
              <button onClick={() => !isOrdering && setShowOrderModal(false)} className="text-sky-100 hover:text-white text-xl leading-none">&times;</button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* พรีวิวรายการที่ขอเบิก */}
              <div>
                <p className="text-sm font-semibold text-gray-700 mb-2">รายการที่จะเบิก ({orderItems.length})</p>
                {orderItems.length === 0 ? (
                  <div className="py-8 text-center text-amber-600 text-sm bg-amber-50 border border-amber-200 rounded-xl">
                    ยังไม่มีรายการที่กรอก "ขอเบิก" — กรุณากรอกจำนวนในช่องขอเบิกก่อน
                  </div>
                ) : (
                  <div className="border border-gray-100 rounded-xl overflow-hidden max-h-[40vh] overflow-y-auto">
                    <table className="w-full text-xs border-collapse">
                      <thead className="sticky top-0">
                        <tr className="text-gray-600 bg-gray-50">
                          <th className="px-3 py-2 text-left">รหัส</th>
                          <th className="px-3 py-2 text-left">ชื่อสินค้า</th>
                          <th className="px-3 py-2 text-center">หน่วย</th>
                          <th className="px-3 py-2 text-right">ขอเบิก</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 text-gray-700">
                        {orderItems.map((it) => (
                          <tr key={it.productId} className="hover:bg-sky-50/40">
                            <td className="px-3 py-1.5 font-mono text-gray-400">{it.productId}</td>
                            <td className="px-3 py-1.5 font-medium text-gray-800">{it.name}</td>
                            <td className="px-3 py-1.5 text-center text-gray-500">{it.unit || '-'}</td>
                            <td className="px-3 py-1.5 text-right font-mono font-semibold text-sky-700">{Number(it.requested).toLocaleString('th-TH', { maximumFractionDigits: 2 })}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-gray-50 font-bold text-gray-800">
                          <td className="px-3 py-2" colSpan={3}>รวม {orderItems.length} รายการ</td>
                          <td className="px-3 py-2 text-right font-mono">{Number(totalQty).toLocaleString('th-TH', { maximumFractionDigits: 2 })}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>

              {/* วันที่รับ */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">วันที่ต้องการรับสินค้า <span className="text-red-500">*</span></label>
                <input type="date" value={orderDelDate} onChange={(e) => setOrderDelDate(e.target.value)}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-sky-500 outline-none" />
                <p className="text-[11px] text-gray-400 mt-1">ระบบจะรันเลขที่ใบเบิกต่อจากใบล่าสุดของสาขาให้อัตโนมัติ</p>
              </div>

              {orderResult && (
                orderResult.ok ? (
                  <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 px-4 py-3 text-center">
                    <p className="text-xs font-medium text-emerald-600">ส่งใบเบิกสำเร็จ • เลขที่ใบเบิก</p>
                    <p className="text-3xl font-bold font-mono text-emerald-700 my-1 tracking-wide">{orderResult.no}</p>
                    <p className="text-xs text-emerald-600">
                      {orderResult.count} รายการ • รับวันที่ {orderResult.deldate}
                    </p>
                    <p className="text-[11px] text-emerald-500 mt-1.5">บันทึกไว้ในใบเบิกค้างแล้ว</p>
                  </div>
                ) : (
                  <div className="text-sm rounded-lg px-3 py-2 bg-red-50 text-red-700 border border-red-200 whitespace-pre-line">
                    {orderResult.message}
                  </div>
                )
              )}
            </div>

            <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2 shrink-0">
              <button onClick={() => setShowOrderModal(false)} disabled={isOrdering}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">ปิด</button>
              <button onClick={submitOrder} disabled={isOrdering || !orderDelDate || orderItems.length === 0}
                className="px-5 py-2 rounded-xl text-sm font-semibold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 flex items-center gap-2">
                {isOrdering ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                {isOrdering ? 'กำลังส่ง…' : `ยืนยันสั่งของ (${orderItems.length})`}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* เครื่องคิดเลขสะสมของช่องคงเหลือ */}
      <CalcModal
        open={!!calcFor}
        name={calcFor?.name}
        parts={calcFor ? (calcParts[calcFor.productId] || []) : []}
        onChangeParts={(arr) => setCalcParts((p) => ({ ...p, [calcFor.productId]: arr }))}
        onApply={(total) => { handleInputChange(calcFor.index, 'remaining', String(total)); setCalcFor(null); }}
        onClose={() => setCalcFor(null)}
      />
    </div>
  );
}
