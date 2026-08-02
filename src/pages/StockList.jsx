import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { Loader2, Save, Search, AlertCircle, PackageSearch, Eye, FileText, ClipboardList, Calculator, Plus, X, Trash2, Check, ChevronLeft, ChevronRight, FileDown, FileSpreadsheet } from 'lucide-react';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import * as XLSX from 'xlsx';

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

import toast from 'react-hot-toast';
import CalcModal from '../components/CalcModal';

const thaiMonths = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
];

// ── คาดการณ์จำนวนหัวลูกค้ารายวัน จากข้อมูลเดือนที่แล้ว ──
// แบ่งวัน 3 ประเภท: วันธรรมดา (จ-พฤ) / วันศุกร์ (แยกเดี่ยว) / วันหยุดสุดสัปดาห์ (ส-อา)
// แบ่งช่วงเดือน 3 ช่วง: ต้นเดือน 1-10 / กลางเดือน 11-23 / ปลายเดือน 24-สิ้นเดือน
const dayBand = (dayOfMonth) => (dayOfMonth <= 10 ? 'early' : dayOfMonth <= 23 ? 'mid' : 'late');
const DAY_TYPES = ['weekday', 'friday', 'weekend'];
const dayType = (dow) => (dow >= 1 && dow <= 4 ? 'weekday' : dow === 5 ? 'friday' : 'weekend'); // 0=อา,5=ศ,6=ส

// สรุปยอดหัวลูกค้ารายวัน (coversByDate: {ymd: number}) เป็นค่าเฉลี่ย 9 กลุ่ม (3 ประเภทวัน × 3 ช่วงเดือน)
function buildCoverBuckets(coversByDate) {
  const emptyBands = () => ({ early: 0, mid: 0, late: 0 });
  const sums = { weekday: emptyBands(), friday: emptyBands(), weekend: emptyBands() };
  const counts = { weekday: emptyBands(), friday: emptyBands(), weekend: emptyBands() };
  Object.entries(coversByDate).forEach(([ymd, covers]) => {
    const d = new Date(ymd + 'T00:00:00');
    if (isNaN(d)) return;
    const type = dayType(d.getDay());
    const band = dayBand(d.getDate());
    sums[type][band] += Number(covers) || 0;
    counts[type][band] += 1;
  });
  const avg = { weekday: {}, friday: {}, weekend: {} };
  DAY_TYPES.forEach(type => {
    ['early', 'mid', 'late'].forEach(band => {
      avg[type][band] = counts[type][band] > 0 ? sums[type][band] / counts[type][band] : 0;
    });
  });
  return avg;
}

// ค่าคาดการณ์จำนวนหัวลูกค้าของวันที่กำหนด จากกลุ่มค่าเฉลี่ยที่คำนวณไว้ (ปัดเป็นจำนวนเต็ม)
function coverBucketFor(date, buckets) {
  if (!buckets) return 0;
  const type = dayType(date.getDay());
  const band = dayBand(date.getDate());
  return Math.round(buckets[type]?.[band] || 0);
}

const bandLabel = { early: 'ต้นเดือน (1-10)', mid: 'กลางเดือน (11-23)', late: 'ปลายเดือน (24-สิ้นเดือน)' };
// เรียงรหัสสินค้า — ตัวเลขล้วนเรียงตามค่าตัวเลข (กันปัญหา "11090003" มาก่อน "1000005" ทั้งที่ 1000005 น้อยกว่า)
// รหัสที่ไม่ใช่ตัวเลขล้วนเรียงแบบ string เทียบกัน
const byProductCode = (a, b) => {
  const ca = String(a.productId ?? '').trim();
  const cb = String(b.productId ?? '').trim();
  const na = Number(ca), nb = Number(cb);
  if (ca !== '' && cb !== '' && !isNaN(na) && !isNaN(nb)) return na - nb;
  return ca.localeCompare(cb);
};

// จัดเรียงรายการสั่งของตามหมวดสโตร์ (คอลัมน์ N ชีท item) แล้วเรียงตามรหัสสินค้าในหมวดเดียวกัน
// ช่วยให้คลังหยิบของเป็นโซนเดียวกันต่อเนื่องกัน — สินค้าที่ยังไม่มีหมวด (คอลัมน์ N ว่าง) จะไปอยู่ท้ายสุดของรายการ
const byStoreCat = (a, b) => {
  const ca = String(a.storeCat || '').trim();
  const cb = String(b.storeCat || '').trim();
  if (ca === cb) return byProductCode(a, b);
  if (!ca) return 1;
  if (!cb) return -1;
  return ca.localeCompare(cb, 'th');
};

// หมวดที่ต้องแยกเป็นใบเบิกต่างหากเสมอ (คนละ Ord_No จากใบหลัก) แม้วันที่รับจะเป็นวันเดียวกัน
// เพิ่มชื่อหมวดในนี้ได้เรื่อยๆ ถ้ามีคลัง/ทีมที่ต้องแยกใบเพิ่ม
// หมายเหตุ: ชื่อหมวดในชีท item (คอลัมน์ N) ถูกเปลี่ยนจาก "ห้องผัก" เป็น "ผัก" — ใส่ไว้ทั้งคู่กันเผื่อเปลี่ยนชื่อกลับ/มีทั้งสองแบบปนกัน
const SPLIT_ORDER_CATEGORIES = ['ผัก', 'ห้องผัก'];

// แบ่งรายการที่จะสั่งออกเป็นกลุ่มใบเบิก — 1 กลุ่ม = 1 ใบ (1 Ord_No)
// รายการหมวดใน SPLIT_ORDER_CATEGORIES แยกออกไปเป็นใบของตัวเอง ที่เหลือรวมเป็น "ใบเบิกทั่วไป" 1 ใบ
function partitionOrderGroups(sortedItems) {
  const main = [];
  const special = {};
  sortedItems.forEach(it => {
    const cat = String(it.storeCat || '').trim();
    if (SPLIT_ORDER_CATEGORIES.includes(cat)) {
      (special[cat] = special[cat] || []).push(it);
    } else {
      main.push(it);
    }
  });
  const groups = [];
  if (main.length) groups.push({ label: 'ใบเบิกทั่วไป', cat: null, items: main });
  SPLIT_ORDER_CATEGORIES.forEach(cat => {
    if (special[cat]?.length) groups.push({ label: `ใบเบิก ${cat}`, cat, items: special[cat] });
  });
  return groups;
}
const fmtBucketLine = (b) => `ต้นเดือน ${Math.round(b.early)} · กลางเดือน ${Math.round(b.mid)} · ปลายเดือน ${Math.round(b.late)} คน`;

// สินค้ากลุ่มพรีเมียม — เสิร์ฟเฉพาะลูกค้าราคา 359 เท่านั้น (ลูกค้า 259 ไม่มีสิทธิ์)
// ใช้จำนวนหัวลูกค้า 359 ล้วนๆ ในการคำนวณยอดเบิก แทนยอดรวมทุกราคา — เฉพาะสาขาที่มี 2 ราคาเท่านั้น
const PREMIUM_359_ONLY_CODES = new Set([
  '2000038', '11010068', '2000062', '11000441', '11000442', '11000499', '1000198',
  '11000622', '11000623', '11000629', '11000145', '11000425', '11050007', '11050101',
  '3000016', '5000102', '5000103', '11000261', '11000701', '11020050', '11020051',
  '11050030', '11050069',
]);

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
  const [avgDraft, setAvgDraft] = useState({});   // productId -> ค่าที่กำลังพิมพ์ในช่องค่าเฉลี่ย/หัว (string)
  const [savingAvg, setSavingAvg] = useState({}); // productId -> กำลังบันทึกค่าเฉลี่ย/หัว
  const [requestDate, setRequestDate] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [counterName, setCounterName] = useState('');
  
  const [specialPcts, setSpecialPcts] = useState([]);
  const [showPctPanel, setShowPctPanel] = useState(false);
  const [isLoadingPct, setIsLoadingPct] = useState(false);
  const [currentCalMonth, setCurrentCalMonth] = useState(new Date().getMonth());
  const [currentCalYear, setCurrentCalYear] = useState(new Date().getFullYear());
  const [pctInputMap, setPctInputMap] = useState({});
  const [pct259InputMap, setPct259InputMap] = useState({}); // สาขาหัว 2 ราคาเท่านั้น — date -> จำนวนลูกค้าราคา 259 ที่กรอก
  const [pct359InputMap, setPct359InputMap] = useState({}); // สาขาหัว 2 ราคาเท่านั้น — date -> จำนวนลูกค้าราคา 359 ที่กรอก
  const [isSavingAllPcts, setIsSavingAllPcts] = useState(false);
  const [coverBuckets, setCoverBuckets] = useState(null);
  const [coverBucketsLabel, setCoverBucketsLabel] = useState('');
  const [isLoadingBuckets, setIsLoadingBuckets] = useState(false);

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
  const [expandedPendingNo, setExpandedPendingNo] = useState(null); // เลขที่ใบเบิกที่กำลังกางดูรายการอยู่
  const [pendingItemsCache, setPendingItemsCache] = useState({});   // เลขที่ใบเบิก -> รายการสินค้า (กันยิงซ้ำ)
  const [isLoadingPendingItems, setIsLoadingPendingItems] = useState(false);
  const [showPendingModal, setShowPendingModal] = useState(false);
  const [isLoadingPending, setIsLoadingPending] = useState(false);
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);
  const [pulledOrderKeys, setPulledOrderKeys] = useState(new Set());       // "สาขา-เลขที่ใบเบิก" ที่ทีมอื่นดึงข้อมูลไปแล้ว
  const [cancelledOrderKeys, setCancelledOrderKeys] = useState(new Set()); // "สาขา-เลขที่ใบเบิก" ที่กดยกเลิกไปแล้ว
  const [preparingOrderKeys, setPreparingOrderKeys] = useState(new Set()); // ชีท จัดของ — โกดังกำลังจัดของ/จัดส่งแล้ว
  const [receivedOrderKeys, setReceivedOrderKeys] = useState(new Set());   // ชีท รับของ — สาขายืนยันรับของแล้ว
  const [cancellingKey, setCancellingKey] = useState(null); // กันกดยกเลิกซ้ำระหว่างรอผลลัพธ์

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

  // ดึงจำนวนหัวลูกค้ารายวันของ "เดือนที่แล้ว" (เดือนปฏิทินก่อนหน้าวันนี้) มาสรุปเป็นค่าเฉลี่ย 9 กลุ่ม
  // ใช้เป็นค่าคาดการณ์เริ่มต้นในปฏิทิน และใน "คำนวณยอดเบิก" (ยังใช้ยอดรวม ไม่แยกราคา)
  // สาขาที่มีหัว 2 ราคา (Buffet 259 + Premium 359) จะได้ buckets259/buckets359 มาแสดงแยกเพิ่มด้วย (informational)
  const fetchCoverBuckets = async (branch) => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const label = `${thaiMonths[start.getMonth()]} ${start.getFullYear() + 543}`;
    try {
      const res = await fetch(`/api/dashboard?branch=${encodeURIComponent(branch)}&startDate=${ymd(start)}&endDate=${ymd(end)}`).then(r => r.json());
      const coversByDate = {}, covers259ByDate = {}, covers359ByDate = {};
      let total259 = 0, total359 = 0;
      if (res.status === 'success') {
        (res.data?.daily || []).forEach(d => {
          coversByDate[d.date] = Number(d.covers) || 0;
          const q259 = Number(d.buffet259) || 0;
          const q359 = Number(d.buffet359) || 0;
          covers259ByDate[d.date] = q259;
          covers359ByDate[d.date] = q359;
          total259 += q259;
          total359 += q359;
        });
      }
      return {
        buckets: buildCoverBuckets(coversByDate),
        buckets259: buildCoverBuckets(covers259ByDate),
        buckets359: buildCoverBuckets(covers359ByDate),
        hasTwoTier: total259 > 0 && total359 > 0,
        label,
      };
    } catch (e) {
      return { buckets: buildCoverBuckets({}), buckets259: buildCoverBuckets({}), buckets359: buildCoverBuckets({}), hasTwoTier: false, label };
    }
  };

  useEffect(() => {
    if (effectiveBranch) {
      loadSpecialPcts(effectiveBranch);
      setIsLoadingBuckets(true);
      fetchCoverBuckets(effectiveBranch).then((info) => {
        setCoverBuckets(info);
        setCoverBucketsLabel(info.label);
        setIsLoadingBuckets(false);
      });
    } else {
      setSpecialPcts([]);
      setCoverBuckets(null);
      setCoverBucketsLabel('');
    }
  }, [effectiveBranch]);

  useEffect(() => {
    const newMap = {}, new259 = {}, new359 = {};
    specialPcts.forEach(item => {
      newMap[item.date] = item.percent;
      if (item.percent259 !== undefined) new259[item.date] = item.percent259;
      if (item.percent359 !== undefined) new359[item.date] = item.percent359;
    });
    setPctInputMap(newMap);
    setPct259InputMap(new259);
    setPct359InputMap(new359);
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
  const handleTemp259Change = (ymdStr, val) => {
    setPct259InputMap(prev => ({ ...prev, [ymdStr]: val }));
  };
  const handleTemp359Change = (ymdStr, val) => {
    setPct359InputMap(prev => ({ ...prev, [ymdStr]: val }));
  };

  const handleSaveAllPcts = async () => {
    if (!effectiveBranch) return;
    const isTwoTier = !!coverBuckets?.hasTwoTier;

    const updates = [];
    if (isTwoTier) {
      // สาขาหัว 2 ราคา — เทียบทั้งจำนวน 259 และ 359 แยกกัน เปลี่ยนตัวใดตัวหนึ่งก็ถือว่าต้องบันทึก
      const allDates = new Set([
        ...Object.keys(pct259InputMap), ...Object.keys(pct359InputMap),
        ...specialPcts.map(p => p.date),
      ]);
      allDates.forEach(date => {
        const orig = specialPcts.find(p => p.date === date);
        const orig259 = Number(orig?.percent259) || 0;
        const orig359 = Number(orig?.percent359) || 0;
        const cur259Str = pct259InputMap[date];
        const cur359Str = pct359InputMap[date];
        const cur259 = cur259Str === '' || cur259Str === undefined || cur259Str === null ? 0 : Number(cur259Str);
        const cur359 = cur359Str === '' || cur359Str === undefined || cur359Str === null ? 0 : Number(cur359Str);
        if (cur259 !== orig259 || cur359 !== orig359) {
          updates.push({ date, percent259: cur259, percent359: cur359 });
        }
      });
    } else {
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
    }

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
      const outletId = isAll
        ? (branches.find(b => b.name === branch)?.outletId || '')
        : (user?.outletId || '');

      const [itemsRes, empRes, incomingRes, avgRes] = await Promise.all([
        apiCall('getStockItems', { branch }),
        apiCall('getScheduleEmployees', { branch }),
        outletId
          ? fetch(`/api/pending_orders?outletId=${encodeURIComponent(outletId)}&incoming=1`).then(r => r.json()).catch(() => null)
          : Promise.resolve(null),
        fetch(`/api/stockcount?avgperhead=1&branch=${encodeURIComponent(branch)}`).then(r => r.json()).catch(() => null),
      ]);

      if (itemsRes.status === 'success') {
        const incomingMap = (incomingRes?.status === 'success') ? incomingRes.data : {};
        const avgMap = (avgRes?.status === 'success') ? avgRes.data : {};
        // ยอดยกมาเดือนที่แล้ว คำนวณจาก stockHistory ที่ได้มาแล้ว (ไม่ยิง API เพิ่ม)
        setItems(itemsRes.data.map(item => {
          const pm = prevMonthFromHistory(item.stockHistory);
          const nid = String(item.productId).replace(/^0+/, '');
          const incoming = incomingMap[nid];
          return {
            ...item, remaining: '', requested: '', prevMonthQty: pm ? pm.qty : undefined, prevMonthDate: pm ? pm.date : '',
            incomingQty: incoming ? incoming.qty : undefined,
            incomingDate: incoming ? incoming.deldate : '',
            incomingOrderNo: incoming ? incoming.orderNo : '',
            avgPerHead: avgMap[nid.toLowerCase()] !== undefined ? Number(avgMap[nid.toLowerCase()]) : undefined,
          };
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

  // ── Export ใบสั่งของ (ใบเบิก) เป็น PDF / Excel ──
  //    จัดกลุ่มรายการตามหมวดสโตร์ (คอลัมน์ N ชีท item) ก่อน export เสมอ — ช่วยให้ตรวจของตามโซนคลังง่ายขึ้น
  //    doc.items ที่ส่งเข้ามาไม่มี storeCat ติดมา (มาจาก withdrawals/pending_orders API) ต้อง lookup จาก items state เอง
  const normCode = (v) => String(v ?? '').trim().replace(/^0+/, '').toLowerCase();

  const groupDocItemsByStoreCat = (docItems) => {
    const catMap = {};
    items.forEach(i => {
      const norm = normCode(i.productId);
      if (norm) catMap[norm] = i.storeCat || '';
    });
    const withCat = docItems.map(it => ({ ...it, storeCat: catMap[normCode(it.itemCode)] || '' }));
    withCat.sort((a, b) => {
      if (a.storeCat === b.storeCat) {
        const na = Number(a.itemCode), nb = Number(b.itemCode);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return String(a.itemCode).localeCompare(String(b.itemCode));
      }
      if (!a.storeCat) return 1;
      if (!b.storeCat) return -1;
      return a.storeCat.localeCompare(b.storeCat, 'th');
    });
    const groups = [];
    withCat.forEach(it => {
      const cat = it.storeCat || 'ไม่ระบุหมวด';
      let g = groups[groups.length - 1];
      if (!g || g.cat !== cat) { g = { cat, items: [] }; groups.push(g); }
      g.items.push(it);
    });
    return groups;
  };

  // PDF: render เป็น HTML แล้วแคปเจอร์ด้วย html2canvas ก่อนฝังลง jsPDF กันปัญหาฟอนต์ไทย
  const buildInvoiceExportEl = (doc) => {
    const groups = groupDocItemsByStoreCat(doc.items);
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:-9999px;top:0;width:700px;background:#fff;padding:24px;font-family:"Segoe UI",sans-serif;color:#111;';
    el.innerHTML = `
      <h2 style="text-align:center;margin:0 0 4px;font-size:18px;">ใบสั่งของ / ใบเบิก</h2>
      <p style="text-align:center;margin:0 0 16px;font-size:12px;color:#555;">สาขา ${branchLabel}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:12px;font-size:12px;">
        <tr>
          <td style="padding:2px 0;"><b>เลขที่ใบเบิก:</b> ${doc.invNo || doc.docNo}</td>
          <td style="padding:2px 0;text-align:right;"><b>วันที่:</b> ${doc.docDate}</td>
        </tr>
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead>
          <tr style="background:#f3f4f6;">
            <th style="border:1px solid #ddd;padding:4px;text-align:left;">รหัส</th>
            <th style="border:1px solid #ddd;padding:4px;text-align:left;">ชื่อสินค้า</th>
            <th style="border:1px solid #ddd;padding:4px;text-align:right;">จำนวน</th>
            <th style="border:1px solid #ddd;padding:4px;text-align:left;">หน่วย</th>
            <th style="border:1px solid #ddd;padding:4px;text-align:right;">ราคา/หน่วย</th>
            <th style="border:1px solid #ddd;padding:4px;text-align:right;">มูลค่า</th>
          </tr>
        </thead>
        <tbody>
          ${groups.map(g => `
            <tr>
              <td colspan="6" style="border:1px solid #ddd;padding:4px 6px;background:#eef2ff;font-weight:bold;color:#3730a3;">หมวด: ${g.cat}</td>
            </tr>
            ${g.items.map(it => `
              <tr>
                <td style="border:1px solid #ddd;padding:4px;">${it.itemCode}</td>
                <td style="border:1px solid #ddd;padding:4px;">${it.itemName}</td>
                <td style="border:1px solid #ddd;padding:4px;text-align:right;">${it.qty}</td>
                <td style="border:1px solid #ddd;padding:4px;">${it.unit}</td>
                <td style="border:1px solid #ddd;padding:4px;text-align:right;">${Number(it.unitPrice).toLocaleString('th-TH')}</td>
                <td style="border:1px solid #ddd;padding:4px;text-align:right;">${Number(it.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
              </tr>`).join('')}`).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2" style="padding:6px 4px;text-align:right;font-weight:bold;border-top:2px solid #333;">รวม</td>
            <td style="padding:6px 4px;text-align:right;font-weight:bold;border-top:2px solid #333;">${doc.totalQty}</td>
            <td style="border-top:2px solid #333;"></td>
            <td style="border-top:2px solid #333;"></td>
            <td style="padding:6px 4px;text-align:right;font-weight:bold;border-top:2px solid #333;">${Number(doc.totalAmt).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
          </tr>
        </tfoot>
      </table>
    `;
    document.body.appendChild(el);
    return el;
  };

  const exportDocToPDF = async (doc) => {
    const loadingToast = toast.loading('กำลังสร้าง PDF...');
    const el = buildInvoiceExportEl(doc);
    try {
      const canvas = await html2canvas(el, {
        scale: 2, useCORS: true, backgroundColor: '#ffffff',
        // Tailwind v4 กำหนดสีพื้นฐานของ body/html เป็น oklch() ซึ่ง html2canvas parse ไม่ได้ (throw error)
        // บังคับตั้งเป็น hex สีธรรมดาในเอกสารที่ clone ไว้ก่อนแคปเจอร์ ป้องกัน error ตอน export
        onclone: (clonedDoc) => {
          clonedDoc.documentElement.style.setProperty('background-color', '#ffffff', 'important');
          clonedDoc.body.style.setProperty('background-color', '#ffffff', 'important');
          clonedDoc.body.style.setProperty('color', '#111111', 'important');
        },
      });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({ orientation: 'p', unit: 'pt', format: 'a4' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const imgWidth = pageWidth - 40;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      pdf.addImage(imgData, 'PNG', 20, 20, imgWidth, imgHeight);
      pdf.save(`ใบเบิก_${doc.invNo || doc.docNo}.pdf`);
      toast.success('บันทึก PDF สำเร็จ', { id: loadingToast });
    } catch (err) {
      console.error(err);
      toast.error('สร้าง PDF ไม่สำเร็จ', { id: loadingToast });
    } finally {
      document.body.removeChild(el);
    }
  };

  // ใบเบิกที่ยังไม่ได้รับของ (pendingOrders) มีแค่สรุปยอด ไม่มีรายการสินค้าติดมาด้วย
  // ต้องดึงรายละเอียดจาก /api/pending_orders?no=... ก่อน แล้วแปลงเป็นรูปแบบเดียวกับ doc ของ withdrawalDocs
  const buildDocFromPendingOrder = async (order) => {
    // order.outletId มีติดมาด้วยแล้วตอนดึงแบบ "ทุกสาขา" (isAll) — ถ้าไม่มีค่อย fallback ไปหาแบบสาขาเดียว
    const outletId = order.outletId || (isAll
      ? (branches.find(b => b.name === effectiveBranch)?.outletId || '')
      : (user?.outletId || ''));
    if (!outletId) throw new Error('ไม่พบรหัสสาขา (outletId)');
    const res = await fetch(`/api/pending_orders?no=${encodeURIComponent(order.no)}&outletId=${encodeURIComponent(outletId)}`);
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message || 'ดึงรายละเอียดใบเบิกไม่สำเร็จ');
    const items = (data.items || []).map(it => ({
      itemCode: it.itemCode, itemName: it.itemName, qty: Number(it.qty) || 0,
      unit: it.unit, unitPrice: Number(it.unitPrice) || 0,
      amount: Math.round((Number(it.qty) || 0) * (Number(it.unitPrice) || 0) * 100) / 100,
    }));
    return {
      invNo: order.no, docNo: order.no, docDate: order.orderDate,
      items,
      totalQty: items.reduce((s, i) => s + i.qty, 0),
      totalAmt: items.reduce((s, i) => s + i.amount, 0),
    };
  };

  const exportPendingOrderToPDF = async (order) => {
    try {
      const doc = await buildDocFromPendingOrder(order);
      await exportDocToPDF(doc);
    } catch (err) {
      console.error(err);
      toast.error(err.message || 'สร้าง PDF ไม่สำเร็จ');
    }
  };

  const exportPendingOrderToExcel = async (order) => {
    try {
      const doc = await buildDocFromPendingOrder(order);
      exportDocToExcel(doc);
    } catch (err) {
      console.error(err);
      toast.error(err.message || 'สร้าง Excel ไม่สำเร็จ');
    }
  };

  // กางดูรายการสินค้าในใบเบิกค้าง (pendingOrders มีแค่สรุปยอด ไม่มีรายการติดมาด้วย) — ดึงตอนกางครั้งแรกแล้วเก็บแคชไว้
  // ใช้ outletId+เลขที่ใบเบิก เป็น key (โหมดดูทุกสาขา เลขที่ใบเบิกอาจซ้ำกันข้ามสาขาได้ เพราะนับแยกต่อสาขา)
  const pendingKey = (order) => `${order.outletId || ''}-${order.no}`;
  const togglePendingExpand = async (order) => {
    const key = pendingKey(order);
    if (expandedPendingNo === key) { setExpandedPendingNo(null); return; }
    setExpandedPendingNo(key);
    if (pendingItemsCache[key]) return;
    setIsLoadingPendingItems(true);
    try {
      const doc = await buildDocFromPendingOrder(order);
      setPendingItemsCache(prev => ({ ...prev, [key]: doc.items }));
    } catch (err) {
      toast.error(err.message || 'ดึงรายการสินค้าไม่สำเร็จ');
      setExpandedPendingNo(null);
    } finally {
      setIsLoadingPendingItems(false);
    }
  };

  const exportDocToExcel = (doc) => {
    try {
      const groups = groupDocItemsByStoreCat(doc.items);
      const rows = [
        ['ใบสั่งของ / ใบเบิก'],
        [`สาขา ${branchLabel}`],
        [`เลขที่ใบเบิก: ${doc.invNo || doc.docNo}`, '', `วันที่: ${doc.docDate}`],
        [],
        ['รหัส', 'ชื่อสินค้า', 'จำนวน', 'หน่วย', 'ราคา/หน่วย', 'มูลค่า'],
        ...groups.flatMap(g => [
          [`หมวด: ${g.cat}`],
          ...g.items.map(it => [it.itemCode, it.itemName, Number(it.qty), it.unit, Number(it.unitPrice), Number(it.amount)]),
        ]),
        [],
        ['', 'รวม', Number(doc.totalQty), '', '', Number(doc.totalAmt)],
      ];
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 12 }, { wch: 32 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 14 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'ใบเบิก');
      XLSX.writeFile(wb, `ใบเบิก_${doc.invNo || doc.docNo}.xlsx`);
      toast.success('บันทึก Excel สำเร็จ');
    } catch (err) {
      console.error(err);
      toast.error('สร้าง Excel ไม่สำเร็จ');
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

      // 1.5) หน่วยเบิกของแต่ละสินค้า (คอลัมน์ L ชีท item) — ใช้ปัดเศษยอดเบิกเป็นจำนวนเต็มหน่วย
      let unitMap = {};
      try {
        const uRes = await fetch('/api/insert_order?units=1').then(r => r.json());
        if (uRes.status === 'success') unitMap = uRes.units || {};
      } catch (e) { /* ไม่มีหน่วยเบิก → ปัดเป็นจำนวนเต็มปกติ */ }

      // 2) หารายการที่พร้อมคำนวณ (ต้องมีทั้งค่าเฉลี่ยต่อหัว + วันนับล่าสุด)
      const jobs = [];
      items.forEach((item, idx) => {
        const nid = String(item.productId).replace(/^0+/, '').toLowerCase();
        const avg = Number(avgMap[nid]) || 0;
        if (avg <= 0) return;
        const lastD = parseDMY(item.lastStockDate);
        if (!lastD) return;
        jobs.push({ idx, avg, lastD, isPremium359Only: PREMIUM_359_ONLY_CODES.has(nid) });
      });
      if (!jobs.length) throw new Error('ไม่มีรายการที่มีทั้งยอดคงเหลือล่าสุด + ค่าเฉลี่ยต่อหัว');

      // 3) จำนวนหัวลูกค้ารายวันในช่วงคำนวณ เรียงลำดับความสำคัญ:
      //    ก) วันที่ผ่านไปแล้วจริง (ก่อนวันนี้) → ใช้ยอดขายจริงจากแดชบอร์ด (แม่นกว่าค่าประมาณเสมอ)
      //    ข) วันนี้/อนาคต ที่มีค่าบันทึกไว้เองในปฏิทิน → ใช้ค่านั้น
      //    ค) วันนี้/อนาคต ที่ไม่มีค่าบันทึก → ใช้ค่าเฉลี่ยจากเดือนที่แล้ว (9 กลุ่ม)
      const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);
      const todayYmd = toYMD(todayDate);
      const targetForecast = new Date(useDate + 'T00:00:00');

      let realRangeStart = null;
      jobs.forEach(j => {
        const sf = new Date(j.lastD); sf.setDate(sf.getDate() + 1);
        if (!realRangeStart || sf < realRangeStart) realRangeStart = sf;
      });
      const yesterday = new Date(todayDate); yesterday.setDate(yesterday.getDate() - 1);
      const realRangeEnd = targetForecast < yesterday ? targetForecast : yesterday;

      const [pctRes, bucketInfo, realRes] = await Promise.all([
        fetch(`/api/stockcount?getpercentages=1&branch=${encodeURIComponent(effectiveBranch)}`).then(r => r.json()),
        fetchCoverBuckets(effectiveBranch),
        (realRangeStart && realRangeStart <= realRangeEnd)
          ? fetch(`/api/dashboard?branch=${encodeURIComponent(effectiveBranch)}&startDate=${toYMD(realRangeStart)}&endDate=${toYMD(realRangeEnd)}`).then(r => r.json())
          : Promise.resolve(null),
      ]);

      const savedCoversMap = {};
      const savedCovers359Map = {};
      if (pctRes.status === 'success') {
        (pctRes.data || []).forEach(item => {
          savedCoversMap[item.date] = Number(item.percent) || 0;
          if (item.percent359 !== undefined) savedCovers359Map[item.date] = Number(item.percent359) || 0;
        });
      }
      const realCoversMap = {};
      const realCovers359Map = {};
      if (realRes && realRes.status === 'success') {
        (realRes.data?.daily || []).forEach(d => {
          realCoversMap[d.date] = Number(d.covers) || 0;
          realCovers359Map[d.date] = Number(d.buffet359) || 0;
        });
      }
      const coversForDate = (d) => {
        const ymdStr = toYMD(d);
        if (realCoversMap[ymdStr] !== undefined) return realCoversMap[ymdStr];
        return savedCoversMap[ymdStr] !== undefined ? savedCoversMap[ymdStr] : coverBucketFor(d, bucketInfo.buckets);
      };
      // สำหรับสินค้าพรีเมียม (PREMIUM_359_ONLY_CODES) ในสาขาที่มี 2 ราคา — ใช้หัวลูกค้า 359 ล้วนๆ แทนยอดรวม
      // ลำดับความสำคัญ: ยอดขายจริง (วันที่ผ่านไปแล้ว) > ค่าที่กรอกเองแยกราคาในปฏิทิน > ค่าเฉลี่ย 359 จากเดือนที่แล้ว
      const covers359ForDate = (d) => {
        const ymdStr = toYMD(d);
        if (realCovers359Map[ymdStr] !== undefined) return realCovers359Map[ymdStr];
        if (savedCovers359Map[ymdStr] !== undefined) return savedCovers359Map[ymdStr];
        return coverBucketFor(d, bucketInfo.buckets359);
      };

      // 4) คำนวณและเติมลงช่องขอเบิก
      const newItems = [...items];
      let filled = 0;
      let maxForecastCovers = 0;
      for (const j of jobs) {
        // ช่วงวางแผนใช้ของ: ตั้งแต่วันถัดจากวันนับล่าสุด (lastD + 1) ถึงวันที่ต้องการใช้ของ (useDate)
        const startForecast = new Date(j.lastD);
        startForecast.setDate(startForecast.getDate() + 1);

        // สินค้าพรีเมียม 359 อย่างเดียว + สาขามี 2 ราคาจริง → ใช้หัวลูกค้า 359 ล้วนๆ แทนยอดรวมทุกราคา
        const usePremiumOnly = j.isPremium359Only && bucketInfo.hasTwoTier;
        const getDayCovers = usePremiumOnly ? covers359ForDate : coversForDate;

        let totalForecastCovers = 0;
        const tempD = new Date(startForecast);
        while (tempD <= targetForecast) {
          totalForecastCovers += getDayCovers(tempD);
          tempD.setDate(tempD.getDate() + 1);
        }
        if (totalForecastCovers <= 0) continue;

        // สูตรยอดใช้คาดการณ์รวม: ค่าเฉลี่ยต่อหัว × ผลรวมจำนวนหัวลูกค้าที่คาดการณ์แต่ละวัน
        const predictedUsage = j.avg * totalForecastCovers;

        // หักลบด้วยยอดคงเหลือปัจจุบัน: ช่อง "กรอกคงเหลือ" (remaining) ถ้าไม่มีใช้ "คงเหลือล่าสุด" (lastStock)
        const currentItem = newItems[j.idx];
        const remVal = (currentItem.remaining !== '' && currentItem.remaining !== null && currentItem.remaining !== undefined)
          ? Number(currentItem.remaining)
          : (Number(currentItem.lastStock) || 0);

        const rawNeed = Math.max(0, predictedUsage - remVal);

        // ปัดเศษเป็นจำนวนเต็มตามหน่วยเบิก (คอลัมน์ L): เศษเกิน 30% ของหน่วย → ปัดขึ้น, ไม่เกิน → ปัดลง
        // เช่น หน่วยเบิก 5: คำนวณได้ 12 → 12/5=2.4 → ปัดขึ้น 3 → เบิก 15 | ได้ 10.5 → 2.1 → ปัดลง 2 → เบิก 10
        const unitSize = Number(unitMap[String(currentItem.productId).trim()]) || 1;
        const ratio = rawNeed / unitSize;
        const whole = Math.floor(ratio);
        const frac = ratio - whole;
        const suggested = (frac > 0.3 + 1e-9 ? whole + 1 : whole) * unitSize;

        newItems[j.idx] = {
          ...newItems[j.idx],
          requested: String(suggested),
          calcCovers: totalForecastCovers
        };
        filled++;
        maxForecastCovers = Math.max(maxForecastCovers, totalForecastCovers);
      }
      setItems(newItems);
      if (filled === 0) {
        toast.error('ไม่พบจำนวนหัวลูกค้าคาดการณ์สำหรับช่วงวันที่เลือก กรุณาตรวจสอบข้อมูลยอดขายเดือนที่แล้ว หรือตั้งค่าจำนวนหัวลูกค้ารายวันเอง');
      } else {
        toast.success(`คำนวณยอดเบิกเสร็จสิ้น ${filled} รายการ (จำนวนหัวลูกค้าคาดการณ์สะสมสูงสุด: ${maxForecastCovers} คน)`, { duration: 6000 });
      }
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
  const [orderResult, setOrderResult] = useState(null); // [{ ok, label, no, count, deldate, message }] — 1 รายการต่อใบเบิกที่ส่ง

  const submitOrder = async () => {
    if (!orderDelDate) { toast.error('กรุณาเลือกวันที่รับสินค้า'); return; }
    const outletId = isAll
      ? (branches.find(b => b.name === effectiveBranch)?.outletId || '')
      : (user?.outletId || '');
    if (!outletId) { toast.error('ไม่พบรหัสสาขา (outletId)'); return; }

    // จัดกลุ่มตามหมวดสโตร์ก่อนส่ง — ลำดับนี้จะถูกบันทึกเป็น Ord_Seq ในใบเบิกด้วย
    // สินค้าที่คอลัมน์ Plan = true สั่งได้เฉพาะปุ่ม "สั่งสินค้าแพลน/สั่งเพิ่มเติม" เท่านั้น ไม่ส่งไปกับปุ่มนี้
    const eligible = items.filter(i => Number(i.requested) > 0 && !i.planOnly).sort(byStoreCat);
    if (eligible.length === 0) { toast.error('ไม่มีรายการที่ขอเบิก'); return; }

    // หมวดใน SPLIT_ORDER_CATEGORIES (เช่น "ห้องผัก") แยกเป็นใบเบิกของตัวเอง ที่เหลือรวมเป็นใบเบิกทั่วไป
    const groups = partitionOrderGroups(eligible);

    setIsOrdering(true);
    setOrderResult(null);
    const results = [];
    for (const g of groups) {
      const payloadItems = g.items.map(i => ({
        itemId: i.itemId,
        itemCode: i.productId,
        itemName: i.name,
        qty: Number(i.requested),
        unit: i.unit,
        price: Number(i.price) || 0,
      }));
      try {
        const res = await fetch('/api/insert_order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outletId, branch: effectiveBranch, deldate: orderDelDate, items: payloadItems }),
        });
        const data = await res.json();
        if (data.status === 'success') {
          results.push({ ok: true, label: g.label, no: data.orderNo, count: data.count, deldate: data.deldate });
        } else {
          const detail = Array.isArray(data.missing) && data.missing.length
            ? `${data.message}\n${data.missing.slice(0, 5).join('\n')}`
            : (data.message || 'ส่งไม่สำเร็จ');
          results.push({ ok: false, label: g.label, message: detail });
        }
      } catch (err) {
        results.push({ ok: false, label: g.label, message: err.message });
      }
    }
    setOrderResult(results);
    setIsOrdering(false);

    const okResults = results.filter(r => r.ok);
    if (okResults.length === results.length) {
      toast.success(
        results.length > 1
          ? `📦 ส่งใบเบิกสำเร็จ ${results.length} ใบ (เลขที่ ${okResults.map(r => r.no).join(', ')})`
          : `📦 ส่งใบเบิกสำเร็จ! เลขที่ ${okResults[0].no} • ${okResults[0].count} รายการ`,
        { duration: 8000 }
      );
      // สำเร็จครบทุกใบ — ปิดหน้าต่างทันที ไม่ต้องค้างให้กดปิดเอง (เลขที่ใบเบิกโชว์ผ่าน toast ด้านบนแล้ว)
      setShowOrderModal(false);
      setOrderResult(null);
    } else {
      toast.error(`ส่งสำเร็จ ${okResults.length}/${results.length} ใบ — บางใบมีปัญหา ดูรายละเอียดด้านล่าง`);
    }
    // ดึงใบเบิกค้างใหม่ ให้ใบที่เพิ่งสั่งขึ้นมาทันที
    try {
      const p = await fetch(`/api/pending_orders?outletId=${encodeURIComponent(outletId)}`);
      const pj = await p.json();
      if (pj.status === 'success') setPendingOrders(pj.data || []);
    } catch (e) { /* ไม่เป็นไร กดดูเองได้ */ }
  };

  // ── ปุ่ม "สั่งสินค้าแพลน/สั่งเพิ่มเติม" — เลือกสินค้า/จำนวน/วันรับเองอิสระจากตารางนับสต๊อก ──
  //    เพิ่มได้หลายรายการ, สินค้าเดิมซ้ำได้ถ้าคนละวันที่รับ, ส่งจริงจะแยกเป็นใบเบิกตามวันที่รับ (1 วัน = 1 ใบ)
  const [showManualOrderModal, setShowManualOrderModal] = useState(false);
  const [manualCart, setManualCart] = useState([]); // [{key, itemCode, itemId, itemName, unit, price, qty, delDate}]
  const [manualSearchTerm, setManualSearchTerm] = useState('');
  const [manualPickedItem, setManualPickedItem] = useState(null);
  const [manualPickQty, setManualPickQty] = useState('');
  const [manualPickDate, setManualPickDate] = useState('');
  const [isManualOrdering, setIsManualOrdering] = useState(false);
  const [manualOrderResults, setManualOrderResults] = useState(null); // [{deldate, ok, no, count, message}]
  const [manualConfirmStep, setManualConfirmStep] = useState(false); // true = อยู่หน้าพรีวิวยืนยันรอบสุดท้าย

  const manualSearchResults = manualSearchTerm.trim().length
    ? items.filter(i => {
        const t = manualSearchTerm.trim().toLowerCase();
        return String(i.productId).toLowerCase().includes(t) || String(i.name).toLowerCase().includes(t);
      }).slice(0, 8)
    : [];

  const addManualCartRow = () => {
    if (!manualPickedItem) { toast.error('กรุณาเลือกสินค้า'); return; }
    const qty = Number(manualPickQty);
    if (!qty || qty <= 0) { toast.error('กรุณาระบุจำนวนให้ถูกต้อง'); return; }
    if (!manualPickDate) { toast.error('กรุณาเลือกวันที่รับ'); return; }
    setManualCart(prev => ([
      ...prev,
      {
        key: `${manualPickedItem.productId}-${manualPickDate}-${prev.length}-${prev.filter(r => r.itemCode === manualPickedItem.productId && r.delDate === manualPickDate).length}`,
        itemCode: manualPickedItem.productId,
        itemId: manualPickedItem.itemId,
        itemName: manualPickedItem.name,
        unit: manualPickedItem.unit,
        price: Number(manualPickedItem.price) || 0,
        qty,
        delDate: manualPickDate,
      },
    ]));
    setManualPickedItem(null);
    setManualSearchTerm('');
    setManualPickQty('');
    // เก็บวันที่รับไว้ ช่วยให้ใส่หลายรายการติดกันสำหรับวันเดียวกันได้เร็วขึ้น
  };

  const removeManualCartRow = (key) => {
    setManualCart(prev => prev.filter(r => r.key !== key));
  };

  const submitManualOrder = async () => {
    if (manualCart.length === 0) { toast.error('ยังไม่มีรายการในตะกร้า'); return; }
    const outletId = isAll
      ? (branches.find(b => b.name === effectiveBranch)?.outletId || '')
      : (user?.outletId || '');
    if (!outletId) { toast.error('ไม่พบรหัสสาขา (outletId)'); return; }

    // จัดกลุ่มตามวันที่รับ — วันที่รับต่างกัน = ใบเบิกคนละใบ (Ord_No แยกกัน)
    const groups = {};
    manualCart.forEach(r => { (groups[r.delDate] = groups[r.delDate] || []).push(r); });
    const dates = Object.keys(groups).sort();

    setIsManualOrdering(true);
    setManualOrderResults(null);
    const results = [];
    for (const date of dates) {
      const rows = groups[date];
      try {
        const res = await fetch('/api/insert_order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            outletId, branch: effectiveBranch, deldate: date,
            items: rows.map(r => ({ itemId: r.itemId, itemCode: r.itemCode, itemName: r.itemName, qty: r.qty, unit: r.unit, price: r.price })),
          }),
        });
        const data = await res.json();
        if (data.status === 'success') {
          results.push({ deldate: date, ok: true, no: data.orderNo, count: data.count });
          // บันทึกสำเนาลงชีท "plan" ด้วย — ไม่บล็อกผลลัพธ์หลักถ้าเขียนชีทไม่สำเร็จ (SQL คือตัวจริงที่บันทึกไปแล้ว)
          try {
            await apiCall('savePlanOrderLog', {
              branch: effectiveBranch,
              outletId,
              orderNo: data.orderNo,
              deldate: date,
              requester: user?.username || '',
              items: rows.map(r => ({ itemId: r.itemId, itemCode: r.itemCode, itemName: r.itemName, qty: r.qty, unit: r.unit, price: r.price })),
            });
          } catch (logErr) {
            console.error('บันทึกชีท plan ไม่สำเร็จ:', logErr);
          }
        } else {
          results.push({ deldate: date, ok: false, message: data.message, missing: data.missing });
        }
      } catch (err) {
        results.push({ deldate: date, ok: false, message: err.message });
      }
    }
    setManualOrderResults(results);
    setIsManualOrdering(false);
    setManualConfirmStep(false); // ส่งแล้ว กลับไปหน้าตะกร้าปกติ (ไม่ค้างอยู่หน้ายืนยันรอบสุดท้าย)

    const okResults = results.filter(r => r.ok);
    const failedDates = new Set(results.filter(r => !r.ok).map(r => r.deldate));
    // ลบเฉพาะรายการของวันที่สำเร็จออกจากตะกร้า เหลือเฉพาะวันที่ล้มเหลวไว้ให้แก้ไข/ลองใหม่
    setManualCart(prev => prev.filter(r => failedDates.has(r.delDate)));

    if (okResults.length === results.length) {
      toast.success(`ส่งสำเร็จทั้งหมด ${okResults.length} ใบ (เลขที่ ${okResults.map(r => r.no).join(', ')})`, { duration: 8000 });
    } else if (okResults.length > 0) {
      toast.error(`ส่งสำเร็จ ${okResults.length}/${results.length} ใบ — บางวันมีปัญหา ดูรายละเอียดด้านล่างแล้วลองใหม่`);
    } else {
      toast.error('ส่งสั่งของไม่สำเร็จเลยสักใบ');
    }
    try {
      const p = await fetch(`/api/pending_orders?outletId=${encodeURIComponent(outletId)}`);
      const pj = await p.json();
      if (pj.status === 'success') setPendingOrders(pj.data || []);
    } catch (e) { /* ไม่เป็นไร กดดูเองได้ */ }
  };

  // เช็คสถานะพิเศษของใบเบิกค้าง — "ดึงข้อมูลแล้ว"/"ยกเลิกแล้ว" (ชีทของเราเอง คีย์ "สาขา-เลขที่" ชัดเจน)
  // และ "กำลังจัดส่ง"/"รับของสำเร็จ" (ชีท จัดของ/รับของ ของทีมอื่น บางแถวไม่มีสาขานำหน้า จึงต้องเช็คทั้งแบบมี/ไม่มีสาขาด้วย)
  const loadPendingOrderStatus = async () => {
    try {
      const res = await apiCall('getPendingOrderStatus', {});
      if (res.status === 'success') {
        setPulledOrderKeys(new Set(res.data?.pulled || []));
        setCancelledOrderKeys(new Set(res.data?.cancelled || []));
        setPreparingOrderKeys(new Set(res.data?.preparing || []));
        setReceivedOrderKeys(new Set(res.data?.received || []));
      }
    } catch (e) { /* เช็คสถานะพิเศษไม่ได้ก็ไม่เป็นไร แสดงแค่ "รอรับของ" ตามปกติ */ }
  };
  const orderStatusKey = (order, branchOverride) => `${(order.branchName || branchOverride || '').toLowerCase()}-${order.no}`;
  // จัดของ/รับของ บางแถวเก็บแค่เลขที่ใบเบิกเปล่าๆ ไม่มีสาขานำหน้า (ข้อมูลจากทีมอื่น ไม่ได้มาตรฐานเดียวกันทั้งหมด)
  // เช็คทั้ง "สาขา-เลขที่" และเลขที่เปล่าๆ กันพลาด
  const matchesOrderKey = (set, order, branchOverride) => {
    if (set.has(orderStatusKey(order, branchOverride))) return true;
    return set.has(String(order.no).toLowerCase());
  };

  const fetchPendingOrders = async () => {
    // user สาขา 'all' ดูใบเบิกค้างของ "ทุกสาขา" รวมกันเลย (ไม่ผูกกับ selectedBranch) — ยิงพร้อมกันทีละสาขา
    if (isAll) {
      const targets = branches.filter(b => b.outletId);
      if (!targets.length) { toast.error('ไม่พบรายชื่อสาขา'); return; }
      setIsLoadingPending(true);
      try {
        const results = await Promise.all(targets.map(async (b) => {
          try {
            const res = await fetch(`/api/pending_orders?outletId=${encodeURIComponent(b.outletId)}`);
            const data = await res.json();
            if (data.status === 'success') {
              return (data.data || []).map(o => ({ ...o, branchName: b.name, outletId: b.outletId }));
            }
          } catch (e) { /* สาขานี้ดึงไม่ได้ ข้ามไปสาขาอื่นต่อ */ }
          return [];
        }));
        const merged = results.flat().sort((a, b) => {
          const byDate = String(b.orderDate || '').localeCompare(String(a.orderDate || ''));
          return byDate !== 0 ? byDate : Number(b.no || 0) - Number(a.no || 0);
        });
        setPendingOrders(merged);
        setShowPendingModal(true);
        loadPendingOrderStatus();
      } finally {
        setIsLoadingPending(false);
      }
      return;
    }

    const outletId = user?.outletId || '';
    if (!outletId) { toast.error('ไม่พบรหัสสาขา'); return; }
    setIsLoadingPending(true);
    try {
      const res = await fetch(`/api/pending_orders?outletId=${encodeURIComponent(outletId)}`);
      const data = await res.json();
      if (data.status === 'success') {
        setPendingOrders(data.data || []);
        setShowPendingModal(true);
        loadPendingOrderStatus();
      } else {
        toast.error(data.message || 'ไม่สามารถดึงข้อมูลใบเบิกค้างได้');
      }
    } catch (err) {
      toast.error(err.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อ');
    } finally {
      setIsLoadingPending(false);
    }
  };

  const cancelPendingOrder = async (order) => {
    const branchName = order.branchName || effectiveBranch;
    const key = orderStatusKey(order, branchName);
    if (cancelledOrderKeys.has(key)) return;
    if (!window.confirm(`ยืนยันยกเลิกใบเบิกเลขที่ ${order.no} (สาขา ${branchName})?\nระบบจะบันทึกการยกเลิกไว้ให้ทีมที่เกี่ยวข้องไปดำเนินการต่อ ไม่ได้ลบข้อมูลใบสั่งจริงออกจากระบบ POS`)) return;
    setCancellingKey(key);
    try {
      const res = await apiCall('cancelPendingOrder', {
        branch: branchName,
        orderNo: order.no,
        orderDate: order.orderDate,
        deldate: order.deldate,
        itemCount: order.itemCount,
        recorder: user?.username || 'Unknown',
      });
      if (res.status === 'success') {
        toast.success(res.message || 'บันทึกยกเลิกใบเบิกเรียบร้อยแล้ว');
        setCancelledOrderKeys(prev => new Set(prev).add(key));
      } else {
        toast.error(res.message || 'บันทึกยกเลิกไม่สำเร็จ');
      }
    } catch (err) {
      toast.error(err.message || 'เกิดข้อผิดพลาดในการบันทึก');
    } finally {
      setCancellingKey(null);
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

  // แก้ไข "ค่าเฉลี่ย/หัว" ในตาราง แล้วบันทึกลงชีทอัตโนมัติ (ไม่มีค่าเดิม = เพิ่มแถวใหม่ในชีท)
  const saveAvgPerHead = async (item) => {
    const pid = item.productId;
    const raw = avgDraft[pid];
    const clearDraft = () => setAvgDraft(d => { const n = { ...d }; delete n[pid]; return n; });
    if (raw === undefined) return;                 // ไม่ได้แก้อะไร
    const trimmed = String(raw).trim();
    if (trimmed === '') { clearDraft(); return; }  // ปล่อยว่าง = ยกเลิก คืนค่าเดิม
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num < 0) { toast.error('ค่าเฉลี่ยต่อหัวไม่ถูกต้อง'); clearDraft(); return; }
    if (item.avgPerHead !== undefined && num === item.avgPerHead) { clearDraft(); return; } // ไม่เปลี่ยน
    if (!effectiveBranch) { toast.error('กรุณาเลือกสาขาก่อน'); return; }

    setSavingAvg(s => ({ ...s, [pid]: true }));
    try {
      const res = await apiCall('saveAvgPerHead', {
        branch: String(effectiveBranch).toLowerCase(),
        code: pid,
        name: item.name || '',
        value: num,
      });
      if (res.status === 'success') {
        setItems(prev => prev.map(it => it.productId === pid ? { ...it, avgPerHead: num } : it));
        clearDraft();
        toast.success(res.message || 'บันทึกค่าเฉลี่ยต่อหัวแล้ว');
      } else {
        toast.error(res.message || 'บันทึกค่าเฉลี่ยต่อหัวไม่สำเร็จ');
      }
    } catch (e) {
      toast.error('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ');
    } finally {
      setSavingAvg(s => { const n = { ...s }; delete n[pid]; return n; });
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

        {/* ใบเบิกค้าง: ดูได้ทั้งสาขาปกติและ 'all' (ทุกสาขารวมกัน) — ปุ่มอื่น (สั่งของ/บันทึก) เป็น write action ซ่อนไว้เฉพาะ 'all' */}
        <div className="flex gap-2">
          {!isAll && (
            <>
              <button
                onClick={() => { setOrderResult(null); setShowOrderModal(true); }}
                disabled={!effectiveBranch}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-sky-600 text-white rounded-xl font-medium hover:bg-sky-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-sky-200"
              >
                <FileText className="w-4 h-4" />
                <span className="text-sm">สั่งของ</span>
              </button>
              <button
                onClick={() => { setManualOrderResults(null); setManualConfirmStep(false); setShowManualOrderModal(true); }}
                disabled={!effectiveBranch}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-teal-600 text-white rounded-xl font-medium hover:bg-teal-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-teal-200"
              >
                <ClipboardList className="w-4 h-4" />
                <span className="text-sm">สั่งสินค้าแพลน/สั่งเพิ่มเติม</span>
              </button>
            </>
          )}
          <button
            onClick={fetchPendingOrders}
            disabled={isLoadingPending}
            className="flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 text-white rounded-xl font-medium hover:bg-amber-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-amber-200"
          >
            {isLoadingPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />}
            <span className="text-sm">ใบเบิกค้าง{isAll ? ' (ทุกสาขา)' : ''}</span>
          </button>
          {!isAll && (
            <button
              onClick={handleSave}
              disabled={isSaving || isSubmittingOrder || !effectiveBranch}
              className="flex items-center justify-center gap-2 px-6 py-2.5 bg-purple-600 text-white rounded-xl font-medium hover:bg-purple-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-purple-200"
            >
              {(isSaving || isSubmittingOrder) ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
              <span>{isSubmittingOrder ? 'กำลังส่งใบเบิก...' : isSaving ? 'กำลังบันทึก...' : 'บันทึกข้อมูล'}</span>
            </button>
          )}
        </div>

      </div>

      {/* พนักงานนับสต๊อก — ย้ายมาไว้ด้านบนสุด เพราะต้องเลือกก่อนเริ่มทำงาน */}
      {!isAll && (
        <div className="bg-white rounded-2xl shadow-sm border border-purple-100 p-4 flex items-center gap-3">
          <label className="text-purple-900 font-medium whitespace-nowrap text-sm">👤 พนักงานนับสต๊อก <span className="text-red-500">*</span> :</label>
          <select value={counterName} onChange={(e) => setCounterName(e.target.value)}
            className="px-4 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-gray-700 bg-white max-w-sm w-full text-sm">
            <option value="">-- เลือกพนักงาน --</option>
            {employees.map((emp, idx) => <option key={idx} value={emp.name}>{emp.name}</option>)}
          </select>
        </div>
      )}

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
          {/* Date range + usage/received fetch — ยังอยู่บนสุดเหมือนเดิม (ช่องค้นหาย้ายไปอยู่ติดตารางแทน) */}
          <div className="flex flex-col md:flex-row gap-4 mb-4">
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
                  <label className="text-amber-900 font-medium whitespace-nowrap text-sm">🧮 คำนวณยอดเบิกอัตโนมัติ  ใช้ยอดเบิกถึงวันที่:</label>
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
                    ⚙️ ตั้งค่าจำนวนหัวลูกค้าคาดการณ์รายวัน ({specialPcts.length})
                  </button>
                </div>

                <div className="text-[11px] text-gray-500 leading-relaxed">
                  สูตร: (ค่าเฉลี่ยยอดใช้ต่อหัว × ผลรวมจำนวนหัวลูกค้าคาดการณ์แต่ละวัน ตั้งแต่วันนับล่าสุดถึงวันใช้ของ) - สต๊อกคงเหลือล่าสุด
                </div>

                <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 flex items-start gap-1.5">
                  <span>⚠️</span>
                  <span>ถ้านับสต๊อกตอนเช้า ให้เลือก "วันที่ใช้ของ" เพิ่มอีก 1 วัน จากวันที่ต้องการใช้ของจริง</span>
                </div>

                {showPctPanel && (
                  <div className="bg-white border border-amber-200 rounded-xl p-4 mt-2 max-w-2xl space-y-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">⚙️ ตั้งค่าจำนวนหัวลูกค้าคาดการณ์รายวัน (สาขา {effectiveBranch})</h4>
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

                    <div className="text-[10px] text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 leading-relaxed space-y-1">
                      {isLoadingBuckets ? (
                        <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> กำลังคำนวณค่าเฉลี่ยจากเดือนที่แล้ว...</span>
                      ) : coverBuckets ? (
                        <>
                          <div>
                            <span className="font-semibold text-gray-600">ค่าเฉลี่ยหัวลูกค้ารวมจากเดือนที่แล้ว ({coverBucketsLabel}):</span>{' '}
                            วันธรรมดา(จ-พฤ) {fmtBucketLine(coverBuckets.buckets.weekday)}
                            {' | '}วันศุกร์ {fmtBucketLine(coverBuckets.buckets.friday)}
                            {' | '}เสาร์-อาทิตย์ {fmtBucketLine(coverBuckets.buckets.weekend)}
                          </div>
                          {coverBuckets.hasTwoTier && (
                            <>
                              <div className="pt-1 border-t border-gray-200">
                                <span className="font-semibold text-sky-700">แยกราคา 259:</span>{' '}
                                วันธรรมดา {fmtBucketLine(coverBuckets.buckets259.weekday)}
                                {' | '}ศุกร์ {fmtBucketLine(coverBuckets.buckets259.friday)}
                                {' | '}เสาร์-อาทิตย์ {fmtBucketLine(coverBuckets.buckets259.weekend)}
                              </div>
                              <div>
                                <span className="font-semibold text-rose-700">แยกราคา 359:</span>{' '}
                                วันธรรมดา {fmtBucketLine(coverBuckets.buckets359.weekday)}
                                {' | '}ศุกร์ {fmtBucketLine(coverBuckets.buckets359.friday)}
                                {' | '}เสาร์-อาทิตย์ {fmtBucketLine(coverBuckets.buckets359.weekend)}
                              </div>
                            </>
                          )}
                        </>
                      ) : (
                        <span>ยังไม่มีข้อมูลค่าเฉลี่ยจากเดือนที่แล้ว</span>
                      )}
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
                            const isTwoTier = !!coverBuckets?.hasTwoTier;
                            const val = pctInputMap[ymdStr] !== undefined ? pctInputMap[ymdStr] : '';
                            const suggestedVal = coverBucketFor(dayObj.date, coverBuckets?.buckets);
                            // สาขาที่มีหัว 2 ราคา (Buffet 259 + Premium 359) — กรอกแยกได้จริง (มีผลกับสูตรคำนวณยอดเบิก
                            // ของสินค้าพรีเมียม 359 โดยตรง) ไม่ใช่แค่แสดงผลเฉยๆ เหมือนก่อนหน้านี้
                            const suggested259 = isTwoTier ? coverBucketFor(dayObj.date, coverBuckets.buckets259) : null;
                            const suggested359 = isTwoTier ? coverBucketFor(dayObj.date, coverBuckets.buckets359) : null;
                            const val259 = pct259InputMap[ymdStr] !== undefined ? pct259InputMap[ymdStr] : '';
                            const val359 = pct359InputMap[ymdStr] !== undefined ? pct359InputMap[ymdStr] : '';

                            const orig = specialPcts.find(p => p.date === ymdStr);
                            let isModified;
                            if (isTwoTier) {
                              const cur259Num = val259 === '' ? 0 : Number(val259);
                              const cur359Num = val359 === '' ? 0 : Number(val359);
                              const orig259Num = Number(orig?.percent259) || 0;
                              const orig359Num = Number(orig?.percent359) || 0;
                              isModified = dayObj.isCurrentMonth && (cur259Num !== orig259Num || cur359Num !== orig359Num);
                            } else {
                              const currentValNum = val === '' ? 0 : Number(val);
                              const originalValNum = orig?.percent === undefined ? 0 : Number(orig.percent);
                              isModified = dayObj.isCurrentMonth && (currentValNum !== originalValNum);
                            }

                            return (
                              <div
                                key={dayObj.key}
                                className={`p-1.5 border rounded-lg flex flex-col justify-between ${isTwoTier ? 'min-h-[92px]' : 'min-h-[64px]'} transition-colors ${
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

                                {isTwoTier ? (
                                  <div className="mt-1 space-y-0.5">
                                    <div className={`flex items-center bg-white border rounded px-1 py-0.5 focus-within:ring-1 ${
                                      isModified ? 'border-amber-300 focus-within:ring-amber-500' : 'border-sky-200 focus-within:ring-sky-500'
                                    }`}>
                                      <span className="text-[8px] text-sky-600 font-bold shrink-0 mr-0.5">259</span>
                                      <input
                                        type="number" min="0" step="1"
                                        placeholder={String(suggested259)}
                                        value={val259}
                                        onChange={(e) => handleTemp259Change(ymdStr, e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                                        disabled={isSavingAllPcts}
                                        title={val259 === '' ? 'ค่าเฉลี่ยจากเดือนที่แล้ว (แก้ไขได้)' : undefined}
                                        className="w-full text-right text-[11px] bg-transparent border-none outline-none font-bold text-gray-700 p-0 placeholder:text-gray-400 placeholder:font-semibold [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                      />
                                    </div>
                                    <div className={`flex items-center bg-white border rounded px-1 py-0.5 focus-within:ring-1 ${
                                      isModified ? 'border-amber-300 focus-within:ring-amber-500' : 'border-rose-200 focus-within:ring-rose-500'
                                    }`}>
                                      <span className="text-[8px] text-rose-600 font-bold shrink-0 mr-0.5">359</span>
                                      <input
                                        type="number" min="0" step="1"
                                        placeholder={String(suggested359)}
                                        value={val359}
                                        onChange={(e) => handleTemp359Change(ymdStr, e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                                        disabled={isSavingAllPcts}
                                        title={val359 === '' ? 'ค่าเฉลี่ยจากเดือนที่แล้ว (แก้ไขได้)' : undefined}
                                        className="w-full text-right text-[11px] bg-transparent border-none outline-none font-bold text-gray-700 p-0 placeholder:text-gray-400 placeholder:font-semibold [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                      />
                                    </div>
                                  </div>
                                ) : (
                                  <div className={`mt-1 flex items-center bg-white border rounded px-1 py-0.5 focus-within:ring-1 ${
                                    isModified
                                      ? 'border-amber-300 focus-within:ring-amber-500 focus-within:border-amber-500'
                                      : 'border-gray-200 focus-within:ring-purple-500 focus-within:border-purple-500'
                                  }`}>
                                    <input
                                      type="number"
                                      min="0"
                                      step="1"
                                      placeholder={String(suggestedVal)}
                                      value={val}
                                      onChange={(e) => handleTempPctChange(ymdStr, e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.target.blur();
                                        }
                                      }}
                                      disabled={isSavingAllPcts}
                                      title={val === '' ? `ค่าเฉลี่ยจากเดือนที่แล้ว (แก้ไขได้)` : undefined}
                                      className="w-full text-right text-xs bg-transparent border-none outline-none font-bold text-gray-700 p-0 placeholder:text-gray-400 placeholder:font-semibold [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                    />
                                    <span className="text-[9px] text-gray-400 font-semibold shrink-0">คน</span>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        
                        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-4 pt-3 border-t border-gray-100">
                          <div className="text-[10px] text-gray-400 flex items-center gap-1.5">
                            <span>💡 ตัวเลขสีเทาคือค่าคาดการณ์ที่คำนวณจากเดือนที่แล้วให้อัตโนมัติ (ใช้ในการคำนวณยอดเบิกได้เลยแม้ไม่บันทึก) พิมพ์ทับเพื่อปรับเฉพาะวัน (ช่องที่แก้ไขจะมีจุดสีส้ม <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />) แล้วกดปุ่มบันทึกด้านขวาเพื่อบันทึกค่าที่ปรับทั้งหมด</span>
                          </div>
                          <button
                            type="button"
                            onClick={handleSaveAllPcts}
                            disabled={isSavingAllPcts}
                            className="w-full sm:w-auto px-5 py-2.5 bg-amber-500 text-white text-xs font-semibold rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-sm shadow-amber-200 shrink-0 cursor-pointer"
                          >
                            {isSavingAllPcts ? <Loader2 className="w-3 h-3 animate-spin" /> : '💾'}
                            <span>{isSavingAllPcts ? 'กำลังบันทึก...' : 'บันทึกจำนวนหัวลูกค้าที่ปรับ'}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ช่องค้นหา/กรองหมวด/เรียงลำดับ — อยู่ติดกับตารางด้านล่างนี้ */}
            <div className="p-4 border-b border-gray-100 flex flex-col md:flex-row gap-2">
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
                className="border border-gray-200 rounded-xl px-3 py-3 bg-white text-sm focus:outline-none focus:ring-1 focus:ring-purple-500 text-gray-700 md:max-w-[200px]"
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
                  <thead className="bg-gray-50 sticky top-0 z-20 shadow-sm">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-28">รหัส</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ชื่อสินค้า</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-28">หมวดจัดเก็บ</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-16">หน่วย</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-fuchsia-600 uppercase w-28 bg-fuchsia-50/60" title="จากชีท ค่าเฉลี่ยยอดใช้ต่อหัว">ค่าเฉลี่ย/หัว</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-teal-600 uppercase w-32 bg-teal-50/60">ยอดยกมาเดือนที่แล้ว</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-purple-600 uppercase w-32 bg-purple-50/60">ยอดนับก่อนหน้า</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-indigo-600 uppercase w-36 bg-indigo-50/60">คงเหลือล่าสุด</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-orange-600 uppercase w-36 bg-orange-50/60">สินค้ารอเข้า</th>
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
                        <td colSpan={13} className="px-6 py-12 text-center text-gray-400">
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

                          {/* ค่าเฉลี่ยยอดใช้ต่อหัว — แก้ไขได้ บันทึกลงชีท 'ค่าเฉลี่ยยอดใช้ต่อหัว' อัตโนมัติ (ไม่มีค่าเดิม = เพิ่มใหม่) */}
                          <td className="px-4 py-3 text-center bg-fuchsia-50/30">
                            <div className="flex items-center justify-center gap-1">
                              <input
                                type="number" min="0" step="any" inputMode="decimal"
                                disabled={savingAvg[item.productId] || !effectiveBranch}
                                value={avgDraft[item.productId] !== undefined ? avgDraft[item.productId] : (item.avgPerHead === undefined ? '' : item.avgPerHead)}
                                onChange={(e) => setAvgDraft(d => ({ ...d, [item.productId]: e.target.value }))}
                                onFocus={(e) => e.target.select()}
                                onBlur={() => saveAvgPerHead(item)}
                                onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                                placeholder="-"
                                title={item.avgPerHead === undefined ? 'ยังไม่มีค่าในชีท — กรอกแล้วบันทึกใหม่อัตโนมัติ' : 'ค่าเฉลี่ยต่อหัว (แก้ไขแล้วบันทึกลงชีทอัตโนมัติ)'}
                                className="w-20 text-center text-sm font-semibold text-fuchsia-700 bg-transparent border border-transparent hover:border-fuchsia-200 focus:border-fuchsia-400 focus:bg-white rounded-md px-1 py-1 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:opacity-50 placeholder:text-fuchsia-300 placeholder:font-normal"
                              />
                              {savingAvg[item.productId] && <Loader2 className="w-3 h-3 animate-spin text-fuchsia-400 shrink-0" />}
                            </div>
                          </td>

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

                          {/* สินค้ารอเข้า — จำนวนตามใบเบิกที่ยังไม่รับ วันรับใกล้ที่สุด */}
                          <td className="px-4 py-3 text-center bg-orange-50/30">
                            <div className="font-semibold text-orange-600 text-sm">
                              {item.incomingQty !== '' && item.incomingQty !== undefined ? item.incomingQty : '-'}
                            </div>
                            {item.incomingDate && (
                              <div className="text-[10px] text-gray-400 mt-0.5" title={`ใบเบิกเลขที่ ${item.incomingOrderNo || '-'}`}>
                                {item.incomingDate}
                                {item.incomingOrderNo && <span className="ml-1 text-orange-400">· #{item.incomingOrderNo}</span>}
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
          <div className={`bg-white rounded-xl shadow-2xl w-full ${isAll ? 'max-w-3xl' : 'max-w-2xl'} overflow-hidden`} onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b bg-amber-50 flex justify-between items-center">
              <h3 className="font-bold text-amber-800 flex items-center gap-2">
                <FileText className="w-5 h-5" />
                ใบเบิกที่ยังไม่ได้รับของ{isAll ? ' · ทุกสาขา' : ''}
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
                      {isAll && <th className="px-4 py-2 text-left text-amber-800 font-semibold">สาขา</th>}
                      <th className="px-4 py-2 text-left text-amber-800 font-semibold">เลขที่ใบเบิก</th>
                      <th className="px-4 py-2 text-left text-amber-800 font-semibold">วันที่สั่ง</th>
                      <th className="px-4 py-2 text-left text-amber-800 font-semibold">วันที่รับ</th>
                      <th className="px-4 py-2 text-right text-amber-800 font-semibold">รายการ</th>
                      <th className="px-4 py-2 text-center text-amber-800 font-semibold">สถานะ</th>
                      <th className="px-4 py-2 text-center text-amber-800 font-semibold">Export</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {pendingOrders.map((order, idx) => {
                      const no = order.no || order.No || order.Ord_No || '-';
                      const ordDate = order.orderDate || '-';
                      const date = order.deldate || order.DelDate || order.Ord_DelDate || order.date || '-';
                      const key = pendingKey(order);
                      const isOpen = expandedPendingNo === key;
                      const colCount = isAll ? 7 : 6;
                      const statusKey = orderStatusKey(order, effectiveBranch);
                      const isCancelled = cancelledOrderKeys.has(statusKey);
                      const isReceived = matchesOrderKey(receivedOrderKeys, order, effectiveBranch);
                      const isPreparing = matchesOrderKey(preparingOrderKeys, order, effectiveBranch);
                      const isPulled = pulledOrderKeys.has(statusKey);
                      // ลำดับความสำคัญ: ยกเลิก > รับของสำเร็จ > กำลังจัดส่ง > ดึงข้อมูลแล้ว > ส่งใบเบิกแล้ว (ขั้นแรก)
                      const rawStatus = order.status || order.Status || order.Ord_Status || '';
                      const status = isCancelled ? 'ยกเลิกแล้ว'
                        : isReceived ? 'รับของสำเร็จ'
                        : isPreparing ? 'กำลังจัดส่ง'
                        : isPulled ? 'ดึงข้อมูลแล้ว'
                        : (rawStatus && rawStatus !== 'รอรับของ' ? rawStatus : 'ส่งใบเบิกแล้ว');
                      // ยกเลิกได้เฉพาะใบที่ยัง "ส่งใบเบิกแล้ว" (ขั้นแรก) เท่านั้น — ถ้ามีการอัปเดตสถานะอื่นแล้วยกเลิกไม่ได้
                      const canCancel = status === 'ส่งใบเบิกแล้ว';
                      const statusClass = isCancelled
                        ? 'bg-gray-200 text-gray-600 line-through'
                        : isReceived
                          ? 'bg-emerald-100 text-emerald-700'
                          : isPreparing
                            ? 'bg-indigo-100 text-indigo-700'
                            : isPulled
                              ? 'bg-sky-100 text-sky-700'
                              : 'bg-amber-100 text-amber-700';
                      return (
                        <React.Fragment key={idx}>
                          <tr className={`hover:bg-amber-50/50 cursor-pointer transition-colors ${isCancelled ? 'opacity-50' : ''}`} onClick={() => togglePendingExpand(order)}>
                            {isAll && <td className="px-4 py-3 text-gray-700 font-medium">{order.branchName || '-'}</td>}
                            <td className="px-4 py-3 font-mono font-semibold text-amber-700">
                              <span className="inline-block w-3 text-amber-400">{isOpen ? '▾' : '▸'}</span> {no}
                            </td>
                            <td className="px-4 py-3 text-gray-600">{String(ordDate).split('T')[0]}</td>
                            <td className="px-4 py-3 text-gray-600">{String(date).split('T')[0]}</td>
                            <td className="px-4 py-3 text-right text-gray-600">
                              {order.itemCount != null ? `${order.itemCount} รายการ` : '-'}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusClass}`}>{status}</span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                                <button
                                  onClick={() => exportPendingOrderToPDF(order)}
                                  title="ดาวน์โหลด PDF"
                                  className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 transition-colors"
                                >
                                  <FileDown className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => exportPendingOrderToExcel(order)}
                                  title="ดาวน์โหลด Excel"
                                  className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 transition-colors"
                                >
                                  <FileSpreadsheet className="w-4 h-4" />
                                </button>
                                {!isCancelled && (
                                  canCancel ? (
                                    <button
                                      onClick={() => cancelPendingOrder(order)}
                                      disabled={cancellingKey === statusKey}
                                      title="ยกเลิกใบเบิกนี้"
                                      className="p-1.5 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-40"
                                    >
                                      {cancellingKey === statusKey ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                                    </button>
                                  ) : (
                                    <button
                                      disabled
                                      title={`ยกเลิกไม่ได้ — ใบเบิกมีการอัปเดตสถานะแล้ว (${status})`}
                                      className="p-1.5 rounded-lg text-gray-300 opacity-40 cursor-not-allowed"
                                    >
                                      <X className="w-4 h-4" />
                                    </button>
                                  )
                                )}
                              </div>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="bg-gray-50/70">
                              <td colSpan={colCount} className="px-4 py-3">
                                {isLoadingPendingItems && !pendingItemsCache[key] ? (
                                  <div className="flex items-center justify-center py-4 text-amber-600">
                                    <Loader2 className="w-5 h-5 animate-spin" />
                                  </div>
                                ) : (
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
                                      {(pendingItemsCache[key] || []).map((it, i) => (
                                        <tr key={i} className="hover:bg-amber-50/40">
                                          <td className="px-3 py-2 font-mono text-gray-500">{it.itemCode}</td>
                                          <td className="px-3 py-2 text-gray-800">{it.itemName}</td>
                                          <td className="px-3 py-2 text-right font-semibold text-amber-700">{it.qty}</td>
                                          <td className="px-3 py-2 text-gray-500">{it.unit}</td>
                                          <td className="px-3 py-2 text-right text-gray-600">{it.unitPrice}</td>
                                          <td className="px-3 py-2 text-right text-gray-700">{it.amount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
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
                      <th className="px-4 py-2 text-center text-sky-800 font-semibold">Export</th>
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
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                                <button
                                  onClick={() => exportDocToPDF(doc)}
                                  title="ดาวน์โหลด PDF"
                                  className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 transition-colors"
                                >
                                  <FileDown className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => exportDocToExcel(doc)}
                                  title="ดาวน์โหลด Excel"
                                  className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 transition-colors"
                                >
                                  <FileSpreadsheet className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="bg-gray-50/70">
                              <td colSpan="6" className="px-4 py-3">
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

      {/* Modal สั่งของ — พรีวิวรายการที่จะเบิก + เลือกวันรับ แล้วยิง insert_order (แยกใบตามหมวดใน SPLIT_ORDER_CATEGORIES) */}
      {showOrderModal && (() => {
        const requestedItems = items.filter(i => Number(i.requested) > 0);
        const orderItems = requestedItems.filter(i => !i.planOnly).sort(byStoreCat);
        const planOnlyExcluded = requestedItems.filter(i => i.planOnly);
        const totalQty = orderItems.reduce((s, i) => s + (Number(i.requested) || 0), 0);
        const orderGroups = partitionOrderGroups(orderItems);
        return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={() => !isOrdering && setShowOrderModal(false)}>
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[88vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 bg-sky-600 text-white flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-base font-bold flex items-center gap-2"><FileText className="w-5 h-5" /> สั่งของ (ส่งใบเบิก)</h3>
                <p className="text-xs text-sky-100 mt-0.5">
                  สาขา {effectiveBranch} • {orderItems.length} รายการ
                  {orderGroups.length > 1 && ` • แยกเป็น ${orderGroups.length} ใบ`}
                </p>
              </div>
              <button onClick={() => !isOrdering && setShowOrderModal(false)} className="text-sky-100 hover:text-white text-xl leading-none">&times;</button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {planOnlyExcluded.length > 0 && (
                <div className="text-xs bg-amber-50 border border-amber-200 text-amber-700 rounded-lg px-3 py-2">
                  <p className="font-semibold">⚠️ {planOnlyExcluded.length} รายการไม่ถูกส่ง — สั่งได้เฉพาะปุ่ม "สั่งสินค้าแพลน/สั่งเพิ่มเติม" เท่านั้น</p>
                  <p className="mt-0.5 text-amber-600">{planOnlyExcluded.map(i => i.name).join(', ')}</p>
                </div>
              )}

              {/* พรีวิวรายการที่ขอเบิก — แยกเป็นการ์ดตามใบเบิก (ปกติมีใบเดียว ยกเว้นมีหมวดที่ต้องแยกใบ) */}
              <div className="space-y-3">
                {orderItems.length === 0 ? (
                  <div className="py-8 text-center text-amber-600 text-sm bg-amber-50 border border-amber-200 rounded-xl">
                    ยังไม่มีรายการที่กรอก "ขอเบิก" — กรุณากรอกจำนวนในช่องขอเบิกก่อน
                  </div>
                ) : orderGroups.map((g, gi) => {
                  const gQty = g.items.reduce((s, i) => s + (Number(i.requested) || 0), 0);
                  let prevCat = null;
                  const gResult = orderResult?.[gi];
                  return (
                    <div key={g.label} className="border border-gray-100 rounded-xl overflow-hidden">
                      <div className="px-3 py-1.5 bg-sky-50 border-b border-sky-100 text-xs font-semibold text-sky-800 flex items-center justify-between">
                        <span>{g.label} • {g.items.length} รายการ</span>
                        {gResult && (
                          gResult.ok
                            ? <span className="text-emerald-600">✓ ส่งแล้ว เลขที่ {gResult.no}</span>
                            : <span className="text-rose-600">✕ ส่งไม่สำเร็จ</span>
                        )}
                      </div>
                      <table className="w-full text-xs border-collapse max-h-[30vh]">
                        <thead className="sticky top-0">
                          <tr className="text-gray-600 bg-gray-50">
                            <th className="px-3 py-2 text-left">รหัส</th>
                            <th className="px-3 py-2 text-left">ชื่อสินค้า</th>
                            <th className="px-3 py-2 text-center">หน่วย</th>
                            <th className="px-3 py-2 text-right">ขอเบิก</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 text-gray-700">
                          {g.items.map((it) => {
                            const cat = String(it.storeCat || '').trim();
                            const showGroupHeader = g.cat === null && cat !== prevCat;
                            prevCat = cat;
                            return (
                            <React.Fragment key={it.productId}>
                              {showGroupHeader && (
                                <tr className="bg-sky-50/50">
                                  <td colSpan={4} className="px-3 py-1 text-[10px] font-bold text-sky-700 uppercase tracking-wide">
                                    {cat || 'ยังไม่ระบุหมวด'}
                                  </td>
                                </tr>
                              )}
                              <tr className="hover:bg-sky-50/40">
                              <td className="px-3 py-1.5 font-mono text-gray-400">{it.productId}</td>
                              <td className="px-3 py-1.5 font-medium text-gray-800">{it.name}</td>
                              <td className="px-3 py-1.5 text-center text-gray-500">{it.unit || '-'}</td>
                              <td className="px-3 py-1.5 text-right font-mono font-semibold text-sky-700">{Number(it.requested).toLocaleString('th-TH', { maximumFractionDigits: 2 })}</td>
                              </tr>
                            </React.Fragment>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="bg-gray-50 font-bold text-gray-800">
                            <td className="px-3 py-2" colSpan={3}>รวม {g.items.length} รายการ</td>
                            <td className="px-3 py-2 text-right font-mono">{Number(gQty).toLocaleString('th-TH', { maximumFractionDigits: 2 })}</td>
                          </tr>
                        </tfoot>
                      </table>
                      {gResult && !gResult.ok && (
                        <div className="px-3 py-1.5 bg-rose-50 text-rose-700 text-[11px] border-t border-rose-100 whitespace-pre-line">
                          {gResult.message}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* วันที่รับ */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">วันรับสินค้า <span className="text-red-500">*</span></label>
                <input type="date" value={orderDelDate} onChange={(e) => setOrderDelDate(e.target.value)}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-sky-500 outline-none" />
                <p className="text-[11px] text-gray-400 mt-1">
                  ระบบจะรันเลขที่ใบเบิกต่อจากใบล่าสุดของสาขาให้อัตโนมัติ
                  {orderGroups.length > 1 && ' — ทุกใบใช้วันที่รับเดียวกัน'}
                </p>
              </div>

              {orderResult && orderResult.every(r => r.ok) && (
                <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 px-4 py-3 text-center">
                  <p className="text-xs font-medium text-emerald-600">ส่งใบเบิกสำเร็จ • เลขที่ใบเบิก</p>
                  <p className="text-2xl font-bold font-mono text-emerald-700 my-1 tracking-wide">
                    {orderResult.map(r => r.no).join(' , ')}
                  </p>
                  <p className="text-xs text-emerald-600">รับวันที่ {orderResult[0]?.deldate}</p>
                  <p className="text-[11px] text-emerald-500 mt-1.5">บันทึกไว้ในใบเบิกค้างแล้ว</p>
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2 shrink-0">
              <button onClick={() => setShowOrderModal(false)} disabled={isOrdering}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">ปิด</button>
              <button onClick={submitOrder} disabled={isOrdering || !orderDelDate || orderItems.length === 0}
                className="px-5 py-2 rounded-xl text-sm font-semibold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 flex items-center gap-2">
                {isOrdering ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                {isOrdering ? 'กำลังส่ง…' : orderGroups.length > 1 ? `ยืนยันสั่งของ (${orderGroups.length} ใบ)` : `ยืนยันสั่งของ (${orderItems.length})`}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Modal สั่งสินค้าแพลน/สั่งเพิ่มเติม — เลือกสินค้า/จำนวน/วันรับเองทีละรายการ สะสมเป็นตะกร้า ส่งได้หลายวันในรอบเดียว */}
      {showManualOrderModal && (() => {
        const cartByDate = {};
        manualCart.forEach(r => { (cartByDate[r.delDate] = cartByDate[r.delDate] || []).push(r); });
        const dateKeys = Object.keys(cartByDate).sort();

        return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={() => !isManualOrdering && setShowManualOrderModal(false)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 bg-teal-600 text-white flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-base font-bold flex items-center gap-2"><ClipboardList className="w-5 h-5" /> สั่งสินค้าแพลน/สั่งเพิ่มเติม</h3>
                <p className="text-xs text-teal-100 mt-0.5">สาขา {effectiveBranch} • เลือกสินค้า/จำนวน/วันรับเองอิสระ ใส่ได้หลายรายการ</p>
              </div>
              <button onClick={() => !isManualOrdering && setShowManualOrderModal(false)} className="text-teal-100 hover:text-white text-xl leading-none">&times;</button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {manualConfirmStep && (
                <div className="bg-amber-50 border-2 border-amber-300 rounded-xl px-4 py-3 flex items-start gap-2">
                  <span className="text-lg">🔎</span>
                  <div>
                    <p className="text-sm font-bold text-amber-800">ตรวจสอบรายการก่อนส่งจริง</p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      รวม {manualCart.length} รายการ • {dateKeys.length} ใบเบิก (แยกตามวันที่รับ) — กด "ย้อนกลับแก้ไข" ถ้าต้องการปรับ หรือ "ยืนยันส่งจริง" เพื่อบันทึกเข้าระบบ
                    </p>
                  </div>
                </div>
              )}

              {/* ── ฟอร์มเพิ่มรายการ (ซ่อนตอนอยู่หน้าตรวจสอบรอบสุดท้าย) ── */}
              {!manualConfirmStep && (
              <div className="bg-teal-50/50 border border-teal-100 rounded-xl p-3 space-y-2.5">
                <div className="relative">
                  <label className="block text-xs font-medium text-gray-600 mb-1">ค้นหาสินค้า (รหัสหรือชื่อ)</label>
                  {manualPickedItem ? (
                    <div className="flex items-center justify-between px-3 py-2 bg-white border border-teal-300 rounded-lg">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate">{manualPickedItem.name}</p>
                        <p className="text-[11px] text-gray-400">{manualPickedItem.productId} • หน่วย {manualPickedItem.unit || '-'}</p>
                      </div>
                      <button onClick={() => { setManualPickedItem(null); setManualSearchTerm(''); }} className="text-gray-400 hover:text-rose-600 shrink-0 ml-2"><X className="w-4 h-4" /></button>
                    </div>
                  ) : (
                    <>
                      <input
                        type="text" value={manualSearchTerm}
                        onChange={(e) => setManualSearchTerm(e.target.value)}
                        placeholder="พิมพ์รหัสหรือชื่อสินค้า..."
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 outline-none"
                      />
                      {manualSearchResults.length > 0 && (
                        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                          {manualSearchResults.map((it) => (
                            <button
                              key={it.productId}
                              type="button"
                              onClick={() => { setManualPickedItem(it); setManualSearchTerm(''); }}
                              className="w-full text-left px-3 py-2 hover:bg-teal-50 border-b border-gray-50 last:border-b-0"
                            >
                              <p className="text-sm text-gray-800 truncate">{it.name}</p>
                              <p className="text-[11px] text-gray-400">{it.productId} • หน่วย {it.unit || '-'}</p>
                            </button>
                          ))}
                        </div>
                      )}
                      {manualSearchTerm.trim().length > 0 && manualSearchResults.length === 0 && (
                        <p className="text-[11px] text-gray-400 mt-1">ไม่พบสินค้าที่ตรงกับ "{manualSearchTerm}"</p>
                      )}
                    </>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">จำนวน</label>
                    <input
                      type="number" min="0" step="any" value={manualPickQty}
                      onChange={(e) => setManualPickQty(e.target.value)}
                      placeholder="0"
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-right focus:ring-2 focus:ring-teal-500 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">วันที่รับ</label>
                    <input
                      type="date" value={manualPickDate}
                      onChange={(e) => setManualPickDate(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 outline-none"
                    />
                  </div>
                </div>

                <button
                  type="button" onClick={addManualCartRow}
                  disabled={!manualPickedItem || !manualPickQty || !manualPickDate}
                  className="w-full py-2 rounded-lg bg-teal-600 text-white text-sm font-semibold hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-4 h-4" /> เพิ่มรายการลงตะกร้า
                </button>
              </div>
              )}

              {/* ── ตะกร้ารายการ แบ่งกลุ่มตามวันที่รับ ── */}
              <div>
                <p className="text-sm font-semibold text-gray-700 mb-2">
                  รายการในตะกร้า ({manualCart.length}) {dateKeys.length > 1 && `• ${dateKeys.length} วันที่รับ → จะแยกเป็น ${dateKeys.length} ใบเบิก`}
                </p>
                {manualCart.length === 0 ? (
                  <div className="py-8 text-center text-gray-400 text-sm bg-gray-50 border border-gray-100 rounded-xl">
                    ยังไม่มีรายการ — ค้นหาสินค้าด้านบนแล้วกด "เพิ่มรายการลงตะกร้า"
                  </div>
                ) : (
                  <div className="space-y-3">
                    {dateKeys.map((date) => {
                      const rows = cartByDate[date];
                      const dateResult = manualOrderResults?.find(r => r.deldate === date);
                      return (
                        <div key={date} className="border border-gray-100 rounded-xl overflow-hidden">
                          <div className="px-3 py-1.5 bg-teal-50 border-b border-teal-100 text-xs font-semibold text-teal-800 flex items-center justify-between">
                            <span>รับวันที่ {date} • {rows.length} รายการ</span>
                            {dateResult && (
                              dateResult.ok
                                ? <span className="text-emerald-600">✓ ส่งแล้ว เลขที่ {dateResult.no}</span>
                                : <span className="text-rose-600">✕ ส่งไม่สำเร็จ</span>
                            )}
                          </div>
                          <table className="w-full text-xs border-collapse">
                            <tbody className="divide-y divide-gray-100 text-gray-700">
                              {rows.map((r) => (
                                <tr key={r.key} className="hover:bg-gray-50/50">
                                  <td className="px-3 py-1.5 font-mono text-gray-400">{r.itemCode}</td>
                                  <td className="px-3 py-1.5 font-medium text-gray-800">{r.itemName}</td>
                                  <td className="px-3 py-1.5 text-center text-gray-500">{r.unit || '-'}</td>
                                  <td className="px-3 py-1.5 text-right font-mono font-semibold text-teal-700">{r.qty.toLocaleString('th-TH', { maximumFractionDigits: 2 })}</td>
                                  {!manualConfirmStep && (
                                    <td className="px-2 py-1.5 text-right">
                                      <button onClick={() => removeManualCartRow(r.key)} disabled={isManualOrdering} className="text-gray-300 hover:text-rose-600 disabled:opacity-30"><Trash2 className="w-3.5 h-3.5" /></button>
                                    </td>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {dateResult && !dateResult.ok && (
                            <div className="px-3 py-1.5 bg-rose-50 text-rose-700 text-[11px] border-t border-rose-100 whitespace-pre-line">
                              {dateResult.message}
                              {Array.isArray(dateResult.missing) && dateResult.missing.length > 0 && `\n${dateResult.missing.slice(0, 5).join('\n')}`}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2 shrink-0">
              {manualConfirmStep ? (
                <>
                  <button onClick={() => setManualConfirmStep(false)} disabled={isManualOrdering}
                    className="px-4 py-2 rounded-xl text-sm font-medium bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">← ย้อนกลับแก้ไข</button>
                  <button onClick={submitManualOrder} disabled={isManualOrdering || manualCart.length === 0}
                    className="px-5 py-2 rounded-xl text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2">
                    {isManualOrdering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    {isManualOrdering ? 'กำลังส่ง…' : `ยืนยันส่งจริง (${dateKeys.length} ใบ)`}
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => setShowManualOrderModal(false)} disabled={isManualOrdering}
                    className="px-4 py-2 rounded-xl text-sm font-medium bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">ปิด</button>
                  <button onClick={() => setManualConfirmStep(true)} disabled={isManualOrdering || manualCart.length === 0}
                    className="px-5 py-2 rounded-xl text-sm font-semibold bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50 flex items-center gap-2">
                    <ClipboardList className="w-4 h-4" />
                    {`ตรวจสอบก่อนส่ง (${dateKeys.length} ใบ)`}
                  </button>
                </>
              )}
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
