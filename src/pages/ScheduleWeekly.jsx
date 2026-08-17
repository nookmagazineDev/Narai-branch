import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall, errMessage } from '../services/api';
import { Loader2, ChevronLeft, ChevronRight, Save, Clock, Download, Trash2 } from 'lucide-react';
import html2canvas from 'html2canvas';
import toast from 'react-hot-toast';
import { PAID_LEAVE, UNPAID_LEAVE, leaveText } from '../utils/leaveCodes';

function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  return new Date(d.setDate(diff));
}

function formatDateLocal(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// วันหยุดนักขัตฤกษ์
// เดิม hardcode ไว้เฉพาะปี 2026 พอขึ้นปีใหม่ดาวจะหายทั้งปีโดยไม่มีใครรู้
// - วันที่ตายตัวทุกปี เก็บเป็น MM-DD ใช้ได้ตลอดไม่ต้องแก้โค้ด
// - วันพระใหญ่ยึดจันทรคติ เลื่อนทุกปี ต้องเติมรายปีเอง ปีไหนยังไม่เติมก็แค่ไม่ขึ้นดาว ไม่พัง
const FIXED_HOLIDAYS_MMDD = [
  '01-01', '04-13', '04-14', '04-15', '05-01',
  '07-28', '08-12', '10-13', '10-23', '12-05', '12-31'
];
const LUNAR_HOLIDAYS_BY_YEAR = {
  2026: ['2026-03-03', '2026-06-03']
};

function isPublicHoliday(dateStr) {
  if (!dateStr || dateStr.length < 10) return false;
  if (FIXED_HOLIDAYS_MMDD.includes(dateStr.slice(5, 10))) return true;
  return (LUNAR_HOLIDAYS_BY_YEAR[dateStr.slice(0, 4)] || []).includes(dateStr);
}

const EMPTY_CELL = {
  isStop: false,
  checkInHr: '', checkInMin: '',
  checkOutHr: '', checkOutMin: '',
  breakDur: '', breakStartHr: '', breakStartMin: '',
  ot: '', otAccum: '',
  leave1: '', leave2: '',
  hrLeave: '', useAccum: '',
  otherNote: ''
};

// ช่องที่ไม่มีข้อมูลอะไรเหลือแล้ว = สั่งล้างข้อมูลของวันนั้น
function isCellCleared(data) {
  if (!data) return true;
  const ota = data.otAccum || '0';
  return !data.checkInHr && !data.checkOutHr && !data.isStop &&
    !data.leave1 && !data.leave2 && (!ota || ota === '0') &&
    !data.hrLeave && !data.useAccum && !data.otherNote;
}

function formatNumber(num) {
  const v = parseFloat(num);
  if (isNaN(v)) return '0';
  return v.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export default function ScheduleWeekly() {
  const { user } = useAuth();
  const isAll = user?.branch?.toLowerCase() === 'all';
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const effectiveBranch = isAll ? selectedBranch : user?.branch;
  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState([]);
  const [weeklyTarget, setWeeklyTarget] = useState(0);
  const [weeklyMaxWage, setWeeklyMaxWage] = useState(0);

  const [weekStartDate, setWeekStartDate] = useState(getStartOfWeek(new Date()));
  const [scheduleData, setScheduleData] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  // เก็บเฉพาะช่องที่ถูกแก้จริงในรอบนี้ — เดิมกดบันทึกทีเดียวส่งทั้งสัปดาห์ รวมช่องที่โหลดมาจากประวัติ
  // ทำให้ชีทมีแถวซ้ำเพิ่มขึ้นทุกครั้งที่กดบันทึก
  const [dirtyKeys, setDirtyKeys] = useState(() => new Set());
  const hasUnsaved = dirtyKeys.size > 0;

  // Helpers for options
  // เวลาเข้า/เบรค 00-23 และเวลาออกถึง 24 — เดิมมีแค่ 08-24 ทำให้กะที่เลิกหลังเที่ยงคืน
  // (ระบบคำนวณออกมาเป็น 01:20) ไม่ตรงกับ option ไหนเลย select เลยโชว์เป็นช่องว่าง
  const hrOpts = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const hrOutOpts = Array.from({ length: 25 }, (_, i) => String(i).padStart(2, '0'));
  const minOpts = ['00', '10', '20', '30', '40', '50'];
  const breakOpts = [
    { value: '0', label: 'ไม่เบรค' },
    ...Array.from({ length: 10 }, (_, i) => {
      const val = (i + 1) * 30;
      return { value: String(val), label: `${val / 60} ชั่วโมง` };
    })
  ];
  const otOpts = ['0', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5'];
  const hrLeaveOpts = ['0', '1', '2', '3', '4', '5', '6', '7', '8'];

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeCell, setActiveCell] = useState(null);
  const [cellData, setCellData] = useState(EMPTY_CELL);

  // Auto calculate checkOut time
  useEffect(() => {
    if (!activeCell || !cellData.checkInHr || !cellData.checkInMin) return;
    
    const empType = activeCell.type;
    if (empType === 'P/T') return; // Do not auto-calc for part-time

    const baseMin = (empType === 'DAY9') ? 540 : 480;
    
    const h = parseInt(cellData.checkInHr) || 0;
    const m = parseInt(cellData.checkInMin) || 0;
    
    let total = h * 60 + m + baseMin;
    total += parseInt(cellData.breakDur || '0');
    total += (parseFloat(cellData.ot || '0') * 60);
    total += (parseFloat(cellData.otAccum || '0') * 60);
    
    let eh = Math.floor(total / 60);
    let em = total % 60;
    
    if (eh >= 24) {
      if (eh === 24 && em === 0) {
        // Keep 24:00
      } else {
        eh = eh % 24;
      }
    }
    
    const hrStr = String(eh).padStart(2, '0');
    const minStr = String(em).padStart(2, '0');
    
    if (cellData.checkOutHr !== hrStr || cellData.checkOutMin !== minStr) {
      setCellData(prev => ({
        ...prev,
        checkOutHr: hrStr,
        checkOutMin: minStr
      }));
    }
  }, [
    activeCell?.type,
    cellData.checkInHr,
    cellData.checkInMin,
    cellData.breakDur,
    cellData.ot,
    cellData.otAccum
  ]);


  // ปิด modal ด้วยปุ่ม ESC
  useEffect(() => {
    if (!isModalOpen) return;
    const onKeyDown = (e) => { if (e.key === 'Escape') setIsModalOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isModalOpen]);

  // เตือนก่อนปิดแท็บ/รีเฟรช ถ้ายังมีช่องที่แก้แล้วไม่ได้กดบันทึก
  useEffect(() => {
    if (!hasUnsaved) return;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsaved]);

  // ยืนยันก่อนทิ้งข้อมูลที่ยังไม่บันทึก (ตอนเปลี่ยนสัปดาห์/เปลี่ยนสาขา)
  const confirmDiscard = () => {
    if (!hasUnsaved) return true;
    return window.confirm('ยังมีช่องที่แก้ไขแล้วแต่ยังไม่ได้กดบันทึกตาราง ถ้าไปต่อข้อมูลจะหาย ต้องการไปต่อหรือไม่?');
  };

  const exportScheduleToImage = async () => {
    const b = effectiveBranch;
    if (!b || employees.length === 0) {
      toast.error('กรุณาเลือกสาขาและรอระบบโหลดข้อมูลให้เสร็จก่อน');
      return;
    }

    const tableEl = document.getElementById('weekly-schedule-table-container');
    if (!tableEl) return;
    
    const loadingToast = toast.loading('กำลังสร้างรูปภาพ...');

    // การ์ดครอบตารางตั้ง overflow-hidden ไว้ ถ้าไม่ปลดด้วย ภาพที่ได้จะโดนตัดเท่าที่มองเห็นบนจอ
    const cardEl = tableEl.parentElement;
    const saved = [tableEl, cardEl].filter(Boolean).map(el => ({
      el,
      maxHeight: el.style.maxHeight,
      overflow: el.style.overflow,
      width: el.style.width,
    }));
    const restore = () => saved.forEach(s => {
      s.el.style.maxHeight = s.maxHeight;
      s.el.style.overflow = s.overflow;
      s.el.style.width = s.width;
    });

    let titleEl;
    try {
      saved.forEach(s => {
        s.el.style.maxHeight = 'none';
        s.el.style.overflow = 'visible';
      });
      tableEl.style.width = tableEl.scrollWidth + 'px';

      titleEl = document.createElement('h4');
      titleEl.className = 'text-center mb-3 mt-2 font-bold text-gray-800 text-lg';
      
      const end = new Date(weekStartDate);
      end.setDate(end.getDate() + 6);
      const weekStr = `${weekStartDate.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })} - ${end.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}`;
      
      titleEl.innerText = `ตารางงาน สาขา: ${b} | สัปดาห์: ${weekStr}`;
      tableEl.insertBefore(titleEl, tableEl.firstChild);
      
      const canvas = await html2canvas(tableEl, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        width: tableEl.scrollWidth,
        height: tableEl.scrollHeight,
        windowWidth: tableEl.scrollWidth,
        windowHeight: tableEl.scrollHeight,
        // Tailwind v4 กำหนดสีพื้นฐานของ body/html เป็น oklch() ซึ่ง html2canvas parse ไม่ได้ (throw error)
        // บังคับตั้งเป็น hex สีธรรมดาในเอกสารที่ clone ไว้ก่อนแคปเจอร์ ป้องกัน error ตอน export
        onclone: (clonedDoc) => {
          clonedDoc.documentElement.style.setProperty('background-color', '#ffffff', 'important');
          clonedDoc.body.style.setProperty('background-color', '#ffffff', 'important');
          clonedDoc.body.style.setProperty('color', '#111111', 'important');
        },
      });

      const link = document.createElement('a');
      link.download = `ตารางงาน_${b}_${weekStr.replace(/ /g, '_')}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();

      toast.success('บันทึกรูปภาพสำเร็จ', { id: loadingToast });
    } catch (err) {
      console.error(err);
      toast.error('เกิดข้อผิดพลาดในการสร้างรูปภาพ', { id: loadingToast });
    } finally {
      // ต้องคืนค่าสไตล์เสมอ ไม่งั้นถ้า html2canvas พัง ตารางจะค้างในสภาพกางเต็มหน้าจอ
      restore();
      if (titleEl) titleEl.remove();
    }
  };

  const changeWeek = (weeks) => {
    if (!confirmDiscard()) return;
    const newDate = new Date(weekStartDate);
    newDate.setDate(newDate.getDate() + (weeks * 7));
    setWeekStartDate(newDate);
  };

  const changeBranch = (branch) => {
    if (!confirmDiscard()) return;
    setSelectedBranch(branch);
  };

  const daysOfWeek = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStartDate);
    d.setDate(d.getDate() + i);
    const dateStr = formatDateLocal(d);
    return {
      dateStr,
      isHoliday: isPublicHoliday(dateStr),
      dayName: d.toLocaleDateString('th-TH', { weekday: 'short' }),
      shortDate: `${d.getDate()} ${d.toLocaleDateString('th-TH', { month: 'short' })}`
    };
  });

  // โหลดรายชื่อสาขาสำหรับ user สิทธิ์ all (ใช้ในฟิลเตอร์เลือกสาขา)
  useEffect(() => {
    if (isAll && branches.length === 0) {
      apiCall('getBranches', {})
        .then(res => setBranches(res.data || []))
        .catch(err => toast.error(errMessage(err, 'โหลดรายชื่อสาขาไม่สำเร็จ')));
    }
  }, [isAll]);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      const branch = effectiveBranch || '';

      // หมายเหตุ: apiCall จะ throw เมื่อเซิร์ฟเวอร์ตอบว่าไม่สำเร็จ (ไม่ได้ return status ให้เช็ค)
      // จึงต้องอ่านสาเหตุจริงจาก errMessage(err) ไม่ใช่โยนข้อความรวมๆ ทับจนหาต้นเหตุไม่เจอ

      // 1) พนักงาน (สำคัญสุด) — โหลดแยกอิสระ ไม่ให้ API อื่นล้มแล้วทำพนักงานหาย
      try {
        const empRes = await apiCall('getScheduleEmployees', { branch });
        setEmployees(empRes.data || []);
      } catch (err) {
        setEmployees([]);
        toast.error(errMessage(err, 'ไม่สามารถโหลดข้อมูลพนักงานได้'));
      }

      // 2) เป้าขาย / ค่าแรง Max — ไม่บังคับ ถ้าล้มต้องไม่บล็อกการแสดงตาราง
      try {
        const statsRes = await apiCall('getBranchStats', { branch });
        const dTarget = parseFloat(String(statsRes.data.dailyTarget).replace(/,/g, '')) || 0;
        const dMax = parseFloat(String(statsRes.data.maxWage).replace(/,/g, '')) || 0;
        setWeeklyTarget(dTarget * 7);
        setWeeklyMaxWage(dMax * 7);
      } catch (err) {
        setWeeklyTarget(0);
        setWeeklyMaxWage(0);
      }

      // 3) ข้อมูลกะของสัปดาห์
      try {
        const start = new Date(weekStartDate);
        const end = new Date(weekStartDate);
        end.setDate(end.getDate() + 6);

        const schedRes = await apiCall('getHistoryData', {
          branch,
          startDate: formatDateLocal(start),
          endDate: formatDateLocal(end)
        });

        const newScheduleData = {};
        const sortedHistory = (schedRes.data || []).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        sortedHistory.forEach(record => {
          if (record.otherNote === 'ล้างข้อมูล') {
            delete newScheduleData[`${record.hrCode}_${record.workDate}`];
            return;
          }

          let brDur = '';
          if (record.breakTime === 'ไม่เบรค') {
            brDur = '0';
          } else if (record.breakTime && String(record.breakTime).includes('ชม.')) {
            brDur = String(parseFloat(record.breakTime) * 60);
          }

          newScheduleData[`${record.hrCode}_${record.workDate}`] = {
            isStop: record.status === 'หยุด',
            checkInHr: record.checkIn ? record.checkIn.split(':')[0] : '',
            checkInMin: record.checkIn ? record.checkIn.split(':')[1] : '',
            checkOutHr: record.checkOut ? record.checkOut.split(':')[0] : '',
            checkOutMin: record.checkOut ? record.checkOut.split(':')[1] : '',
            breakDur: brDur,
            breakStartHr: record.breakTimeRange ? record.breakTimeRange.split('-')[0].split(':')[0] : '',
            breakStartMin: record.breakTimeRange ? record.breakTimeRange.split('-')[0].split(':')[1] : '',
            ot: String(record.ot || ''),
            otAccum: String(record.otAccumulated || ''),
            leave1: record.leaveNote || '',
            leave2: record.unpaidLeave || '',
            hrLeave: String(record.hourlyLeave || ''),
            useAccum: String(record.useAccumulatedHours || ''),
            otherNote: record.otherNote || ''
          };
        });

        setScheduleData(newScheduleData);
      } catch (err) {
        setScheduleData({});
        toast.error(errMessage(err, 'โหลดตารางของสัปดาห์นี้ไม่สำเร็จ'));
      } finally {
        setDirtyKeys(new Set());
        setLoading(false);
      }
    };
    if (effectiveBranch) {
      fetchData();
    } else {
      // user สิทธิ์ all ที่ยังไม่ได้เลือกสาขา — เคลียร์ข้อมูล รอเลือกสาขาก่อน
      setEmployees([]);
      setScheduleData({});
      setDirtyKeys(new Set());
      setLoading(false);
    }
  }, [effectiveBranch, weekStartDate]);

  const handleCellClick = (emp, dateStr) => {
    const key = `${emp.hrCode}_${dateStr}`;
    setActiveCell({ ...emp, dateStr, key });
    setCellData(scheduleData[key] || EMPTY_CELL);
    setIsModalOpen(true);
  };

  const markDirty = (key) => {
    setDirtyKeys(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const saveCellData = () => {
    // ป้ายบอกว่าเวลาเข้าจำเป็น แต่เดิมกดตกลงผ่านได้โดยไม่กรอก
    const cleared = isCellCleared(cellData);
    if (!cleared && !cellData.isStop && !cellData.leave1 && !cellData.leave2 && !cellData.checkInHr) {
      toast.error('กรุณาระบุเวลาเข้า หรือเลือกว่าเป็นวันหยุด/วันลา');
      return;
    }
    setScheduleData(prev => ({
      ...prev,
      [activeCell.key]: cellData
    }));
    markDirty(activeCell.key);
    setIsModalOpen(false);
  };

  // ล้างข้อมูลของช่องนี้ — เก็บช่องว่างไว้ใน state เพื่อให้ตอนบันทึกส่ง 'ล้างข้อมูล' ไปลบของเดิมในชีท
  const clearCellData = () => {
    setScheduleData(prev => ({
      ...prev,
      [activeCell.key]: { ...EMPTY_CELL }
    }));
    markDirty(activeCell.key);
    setIsModalOpen(false);
  };


  const calculateCellWage = (emp, data) => {
    let wage = 0;
    const rate = parseFloat(emp.dailyWage) || 0;
    const empType = emp.type;
    
    const ci = data.checkInHr ? `${data.checkInHr}:${data.checkInMin || '00'}` : '';
    const co = data.checkOutHr ? `${data.checkOutHr}:${data.checkOutMin || '00'}` : '';
    const l1 = data.leave1 || '';
    const l2 = data.leave2 || '';
    const hl = data.hrLeave || '';
    const finalStop = data.isStop || (l1 !== '') || (l2 !== '');
    const brDur = data.breakDur;

    if (isCellCleared(data)) {
      if (empType === 'F/T') wage = rate; else wage = 0;
    } else {
      if (l2 !== '') {
        // ตัวเลือก "หยุด (ไม่รับค่าแรง)" ชุดใหม่ (21 ป่วย / 22 กิจ / 23 ขาดงาน) ได้ค่าแรง 0 ทั้งหมด
        // เงื่อนไข 'วันหยุดธรรมดา' เก็บไว้เพื่อข้อมูลเก่าที่บันทึกด้วยตัวเลือกชุดก่อน
        // ถ้าเอาออก ยอดค่าแรงรวมของสัปดาห์ที่ผ่านมาแล้วจะเปลี่ยนย้อนหลัง
        if (l2 === 'วันหยุดธรรมดา' && empType === 'F/T') {
          wage = rate;
        } else {
          wage = 0;
        }
      } else if (l1 !== '') {
        if (empType === 'P/T') { wage = 0; } else { wage = rate; }
      } else {
        if (empType === 'F/T') {
          wage = rate;
          if (hl !== '') {
            let h = hl === 'ครึ่งวัน' ? 4 : hl === 'เต็มวัน' ? 8 : parseInt(hl) || 0;
            if (rate > 0) wage = rate - (rate / 8) * h;
          }
        } else if (empType === 'DAY' || empType === 'DAY9') {
          let baseHours = (empType === 'DAY9') ? 9 : 8;
          if (!finalStop && ci) {
            wage = rate;
            if (hl !== '') {
              let h = hl === 'ครึ่งวัน' ? (baseHours / 2) : hl === 'เต็มวัน' ? baseHours : parseInt(hl) || 0;
              if (rate > 0) wage = rate - (rate / baseHours) * h;
            }
          } else { wage = 0; }
        } else if (empType === 'P/T') {
          if (!finalStop && ci && co) {
            const [h1, m1] = ci.split(':').map(Number);
            const [h2, m2] = co.split(':').map(Number);
            let t1 = h1 * 60 + m1;
            let t2 = h2 * 60 + m2;
            if (t2 < t1) t2 += 1440;
            let dur = (t2 - t1) - (parseInt(brDur) || 0);
            if (dur > 0) wage = (dur / 60) * rate;
          } else { wage = 0; }
        }
      }
    }
    return parseFloat(wage.toFixed(2));
  };

  // Calculate Summary + per-day stats (เหมือนตัวเดิม: รวมค่าแรง F/T วันที่ยังไม่ลงด้วย)
  const summary = React.useMemo(() => {
    const dates = daysOfWeek.map(d => d.dateStr);
    const dailyWage = {};
    const dailyCount = {};
    dates.forEach(ds => { dailyWage[ds] = 0; dailyCount[ds] = 0; });

    let totalWage = 0;
    const workingEmpSet = new Set();

    employees.forEach(emp => {
      const baseWage = parseFloat(emp.dailyWage) || 0;
      dates.forEach(ds => {
        const data = scheduleData[`${emp.hrCode}_${ds}`];
        if (data && !isCellCleared(data)) {
          const w = calculateCellWage(emp, data);
          const isStop = data.isStop || data.leave1 || data.leave2;
          if (!isStop && data.checkInHr) {
            workingEmpSet.add(emp.hrCode);
            dailyCount[ds]++;
          }
          dailyWage[ds] += w;
          totalWage += w;
        } else if (emp.type === 'F/T') {
          dailyWage[ds] += baseWage;
          totalWage += baseWage;
        }
      });
    });

    return {
      totalWage,
      dailyWage,
      dailyCount,
      workingCount: workingEmpSet.size,
      wagePercent: weeklyTarget > 0 ? ((totalWage / weeklyTarget) * 100).toFixed(2) : '0.00'
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleData, employees, weeklyTarget, weekStartDate]);

  const handleSaveSchedule = async () => {
    if (dirtyKeys.size === 0) {
      toast.error('ยังไม่มีการแก้ไขที่ต้องบันทึก');
      return;
    }

    setIsSaving(true);
    try {
      const logs = [];
      // ส่งเฉพาะช่องที่แก้ในรอบนี้ ไม่ส่งช่องที่โหลดมาจากประวัติแล้วไม่ได้แตะ (กันแถวซ้ำในชีท)
      dirtyKeys.forEach(key => {
        const data = scheduleData[key];
        if (!data) return;
        // key = `${hrCode}_${YYYY-MM-DD}` — ตัดจากท้ายเสมอ
        // เดิมใช้ startsWith(hrCode + '_') ซึ่งจับผิดคนได้ถ้ามีรหัสที่เป็นคำนำหน้าของอีกรหัส (เช่น 12 กับ 123)
        const dateStr = key.slice(-10);
        const hrCode = key.slice(0, -11);
        const emp = employees.find(e => String(e.hrCode) === hrCode);

        if (emp) {
          const ci = data.checkInHr ? `${data.checkInHr}:${data.checkInMin || '00'}` : '';
          const co = data.checkOutHr ? `${data.checkOutHr}:${data.checkOutMin || '00'}` : '';
          
          const brDur = data.breakDur;
          const bs = data.breakStartHr ? `${data.breakStartHr}:${data.breakStartMin || '00'}` : '';
          const l1 = data.leave1 || '';
          const l2 = data.leave2 || '';
          const hl = data.hrLeave || '';
          const ua = data.useAccum || '';
          const ota = data.otAccum || '0';
          const noteInput = data.otherNote || '';
          const finalStop = data.isStop || (l1 !== '') || (l2 !== '');

          let brRange = '';
          if (bs && brDur && brDur !== '0') {
            const [h, m] = bs.split(':').map(Number);
            const t = h * 60 + m + parseInt(brDur);
            const eh = Math.floor(t / 60) % 24;
            const em = t % 60;
            brRange = `${bs}-${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
          }

          const isCleared = isCellCleared(data);

          let wage = calculateCellWage(emp, data);

          let brTxt = (brDur === '0') ? 'ไม่เบรค' : brDur ? `${parseInt(brDur) / 60} ชม.` : '';

          let status = finalStop ? 'หยุด' : 'มาทำงาน';

          logs.push({
            workDate: dateStr,
            branch: emp.branch,
            hrCode: emp.hrCode,
            name: emp.name,
            position: emp.position,
            checkIn: ci,
            checkOut: co,
            breakTime: brTxt,
            breakTimeRange: brRange,
            ot: data.ot || '0',
            otAccumulated: ota,
            wage: wage,
            status: status,
            empType: emp.type || '',
            leaveNote: l1,
            unpaidLeave: l2,
            hourlyLeave: hl,
            useAccumulatedHours: ua,
            otherNote: isCleared ? 'ล้างข้อมูล' : noteInput,
            isStop: finalStop
          });
        }
      });

      if (logs.length === 0) {
        toast.error('รหัสพนักงานไม่ตรงกัน หรือไม่พบข้อมูลที่จะบันทึก');
        setIsSaving(false);
        return;
      }

      // ไม่ต้องส่งชื่อคนบันทึกเอง — apiCall แนบ user ที่ล็อกอินไว้ไปให้อัตโนมัติ
      // แล้วฝั่ง SQL เก็บลง hr_timesheet_log ให้ (Apps Script เดิมไม่ได้เก็บไว้)
      await apiCall('saveTimesheet', { logs });
      toast.success(`บันทึกตารางงานเรียบร้อยแล้ว (${logs.length} รายการ)`);
      setDirtyKeys(new Set());
    } catch (err) {
      toast.error(errMessage(err, 'เกิดข้อผิดพลาดในการบันทึก'));
    } finally {
      setIsSaving(false);
    }
  };

  // สร้างการ์ดกะในแต่ละช่อง (เลียนแบบดีไซน์เดิม: badge ประเภทกะ/OT/ลา/นักขัตฤกษ์)
  const renderCell = (emp, dateStr) => {
    const cell = scheduleData[`${emp.hrCode}_${dateStr}`];
    const isHoliday = isPublicHoliday(dateStr);

    if (!cell || isCellCleared(cell)) {
      return (
        <div className="min-h-[55px] rounded-md border border-dashed border-gray-300 text-gray-400 flex items-center justify-center text-xs gap-1 hover:border-purple-400 hover:text-purple-600 transition-colors">
          <span className="text-base leading-none">+</span> เพิ่มกะ
        </div>
      );
    }

    if (cell.isStop || cell.leave2) {
      const reasons = [];
      if (cell.leave1) reasons.push(leaveText(cell.leave1));
      if (cell.leave2) reasons.push(leaveText(cell.leave2));
      if (cell.otherNote) reasons.push(cell.otherNote);
      return (
        <div className="min-h-[55px] rounded-md border-2 border-amber-100 border-l-4 border-l-amber-400 bg-amber-50/60 text-amber-600 flex flex-col items-center justify-center text-xs p-1 gap-1">
          <span className="font-bold">⊖ หยุด</span>
          {reasons.length > 0 && (
            <span className="bg-rose-500 text-white rounded px-1.5 py-0.5 text-[10px] leading-tight text-center" style={{ whiteSpace: 'normal' }}>
              {reasons.join(', ')}
            </span>
          )}
        </div>
      );
    }

    // กะทำงาน
    const badges = [];
    if (cell.ot && cell.ot !== '0') badges.push({ text: `OT ${cell.ot}`, cls: 'bg-blue-600 text-white' });
    const leaveTexts = [];
    if (cell.leave1) leaveTexts.push(leaveText(cell.leave1));
    if (cell.hrLeave && cell.hrLeave !== '0') leaveTexts.push(`ลาชม. ${cell.hrLeave}`);
    if (cell.useAccum && cell.useAccum !== '0') leaveTexts.push(`ใช้ชม.สะสม ${cell.useAccum}ชม.`);
    if (cell.otAccum && cell.otAccum !== '0') leaveTexts.push(`+สะสม ${cell.otAccum}`);
    if (cell.otherNote) leaveTexts.push(cell.otherNote);
    if (leaveTexts.length > 0) badges.push({ text: leaveTexts.join(', '), cls: 'bg-amber-400 text-gray-800' });
    if (isHoliday && cell.checkInHr) badges.push({ text: 'นักขัตฤกษ์ ⭐', cls: 'bg-rose-500 text-white' });

    let topBadges = badges;
    if (badges.length === 0) {
      const shiftName = emp.type === 'F/T' ? 'F/T' : emp.type === 'DAY9' ? 'DAY9' : emp.type === 'P/T' ? 'P/T' : 'DAY';
      topBadges = [{ text: shiftName, cls: 'bg-amber-400 text-gray-800' }];
    }

    const timeStr = cell.checkInHr
      ? `${cell.checkInHr}:${cell.checkInMin || '00'} - ${cell.checkOutHr ? `${cell.checkOutHr}:${cell.checkOutMin || '00'}` : '?'}`
      : '';

    return (
      <div className="min-h-[55px] rounded-md border-2 border-blue-100 border-l-4 border-l-blue-500 bg-blue-50/40 hover:bg-blue-50 transition-colors p-1.5 flex flex-col justify-center gap-1">
        <div className="flex flex-wrap gap-1">
          {topBadges.map((b, i) => (
            <span key={i} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-tight ${b.cls}`} style={{ whiteSpace: 'normal' }}>
              {b.text}
            </span>
          ))}
        </div>
        {timeStr && <div className="text-xs text-gray-600">{timeStr}</div>}
      </div>
    );
  };

  return (
    <div className="max-w-7xl mx-auto flex flex-col h-[calc(100vh-6rem)]">
      {/* Header & Controls */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-4 flex-shrink-0">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
              <Clock className="w-6 h-6 text-purple-600" />
              ลงตารางรายสัปดาห์
            </h1>
            <p className="text-sm text-gray-500 mt-1">สาขา: <span className="font-semibold text-purple-600">{effectiveBranch || (isAll ? 'ยังไม่ได้เลือกสาขา' : user?.branch)}</span></p>
          </div>

          <div className="flex items-center gap-4">
            {isAll && (
              <select
                value={selectedBranch}
                onChange={(e) => changeBranch(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm focus:ring-2 focus:ring-purple-400 outline-none text-gray-700 min-w-[160px]"
              >
                <option value="">-- เลือกสาขา --</option>
                {branches.map((br, idx) => (
                  <option key={idx} value={br.name}>{br.name}</option>
                ))}
              </select>
            )}
            <div className="flex items-center bg-gray-50 rounded-lg p-1 border border-gray-200">
              <button onClick={() => changeWeek(-1)} className="p-2 hover:bg-white rounded-md text-gray-600 transition-colors">
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div className="px-4 font-medium text-gray-800 text-sm">
                {daysOfWeek[0].shortDate} - {daysOfWeek[6].shortDate}
              </div>
              <button onClick={() => changeWeek(1)} className="p-2 hover:bg-white rounded-md text-gray-600 transition-colors">
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
            
            <button
              onClick={exportScheduleToImage}
              disabled={!effectiveBranch || employees.length === 0}
              title="บันทึกตารางเป็นรูปภาพ"
              className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium disabled:opacity-50"
            >
              <Download className="w-5 h-5" />
              บันทึกรูปภาพ
            </button>

            <button
              onClick={handleSaveSchedule}
              disabled={isSaving || !effectiveBranch}
              className="relative flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
              บันทึกตาราง
              {hasUnsaved && (
                <span className="ml-1 bg-white text-purple-700 rounded-full px-1.5 text-xs font-bold">{dirtyKeys.size}</span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Summary Panel */}
      {effectiveBranch && !loading && employees.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 flex-shrink-0">
          <div className="bg-cyan-500 text-white rounded-xl shadow-sm p-4">
            <h6 className="text-sm opacity-90 m-0">👥 พนักงานทั้งหมดที่เข้างาน</h6>
            <div className="mt-1"><span className="text-2xl font-bold">{summary.workingCount}</span> <span className="text-sm">คน</span></div>
          </div>
          <div className="bg-emerald-500 text-white rounded-xl shadow-sm p-4">
            <h6 className="text-sm opacity-90 m-0">💵 ค่าแรงสัปดาห์ / <span className="bg-white text-rose-500 px-1 rounded">Max</span></h6>
            <div className="mt-1">
              <span className="text-2xl font-bold">{formatNumber(summary.totalWage)}</span>
              <span className="mx-1">/</span>
              <span className="text-lg font-bold bg-white text-rose-500 px-1 rounded">{formatNumber(weeklyMaxWage)}</span>
            </div>
          </div>
          <div className="bg-rose-500 text-white rounded-xl shadow-sm p-4">
            <h6 className="text-sm opacity-90 m-0">📈 เป้าขายสัปดาห์ (ประเมิน)</h6>
            <div className="mt-1"><span className="text-lg font-bold">{weeklyTarget > 0 ? formatNumber(weeklyTarget) : '-'}</span></div>
          </div>
          <div className="bg-blue-500 text-white rounded-xl shadow-sm p-4">
            <h6 className="text-sm opacity-90 m-0">🥧 ค่าแรง / เป้าขาย (%)</h6>
            <div className="mt-1"><span className="text-lg font-bold">{summary.wagePercent}%</span></div>
          </div>
        </div>
      )}

      {/* Main Table Area */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 flex-1 overflow-hidden flex flex-col">
        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
            <Loader2 className="w-10 h-10 animate-spin text-purple-500 mb-4" />
            <p>กำลังโหลดข้อมูลพนักงาน...</p>
          </div>
        ) : (isAll && !selectedBranch) ? (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-2">
            <Clock className="w-10 h-10 text-gray-300" />
            <p>เลือกสาขาด้านบนเพื่อดูและแก้ไขตาราง</p>
          </div>
        ) : employees.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            ไม่พบข้อมูลพนักงานที่ทำงานในสาขานี้
          </div>
        ) : (
          <div id="weekly-schedule-table-container" className="overflow-auto flex-1 bg-white">
            <table className="w-full text-sm text-left border-collapse">
              <thead className="text-xs text-gray-700 uppercase bg-gray-50 sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="px-4 py-3 border-b border-r bg-gray-50 min-w-[200px] sticky left-0 z-20">พนักงาน | ตำแหน่ง</th>
                  {daysOfWeek.map(d => {
                    return (
                      <th key={d.dateStr} className="px-2 py-3 border-b border-r text-center min-w-[120px] align-top">
                        <div className="font-bold">{d.dayName}{d.isHoliday && <span title="วันนักขัตฤกษ์"> ⭐</span>}</div>
                        <div className="text-gray-500 font-normal">{d.shortDate}</div>
                        <div className="mt-1 inline-block bg-emerald-500 text-white rounded px-1.5 py-0.5 text-[11px] font-normal">฿ {formatNumber(summary.dailyWage?.[d.dateStr] || 0)}</div>
                        <div className="mt-1"><span className="inline-block bg-cyan-100 text-cyan-700 rounded px-1.5 py-0.5 text-[11px] font-normal">👤 {summary.dailyCount?.[d.dateStr] || 0} คน</span></div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {employees.map(emp => (
                  <tr key={emp.hrCode} className="border-b hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2 border-r bg-white sticky left-0 z-10 shadow-[1px_0_0_0_#f3f4f6]">
                      <div className="font-medium text-gray-900 leading-tight">{emp.name}</div>
                      <div className="text-[10px] text-gray-400 mt-0.5">รหัส: {emp.hrCode || '-'}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {emp.position}
                        {emp.type && <span className="ml-1 inline-block border border-gray-200 bg-gray-50 text-gray-600 rounded px-1 text-[10px]">{emp.type}</span>}
                      </div>
                    </td>
                    {daysOfWeek.map(d => (
                      <td
                        key={d.dateStr}
                        className="p-1 border-r cursor-pointer hover:bg-purple-50/50 align-middle"
                        onClick={() => handleCellClick(emp, d.dateStr)}
                      >
                        {renderCell(emp, d.dateStr)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Cell Modal */}
      {isModalOpen && activeCell && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          onClick={() => setIsModalOpen(false)}
        >
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
              <h3 className="font-bold text-gray-800">
                ลงเวลา: {activeCell.name}
              </h3>
              <div className="text-sm text-gray-500">{activeCell.dateStr}</div>
            </div>
            
            <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
              {/* Top Toggle */}
              <div className="flex items-center gap-2 pb-2 border-b border-gray-100">
                <input 
                  type="checkbox" 
                  id="modalIsStop" 
                  className="w-5 h-5 rounded border-gray-300 text-red-600 focus:ring-red-500"
                  checked={cellData.isStop}
                  onChange={(e) => setCellData({...cellData, isStop: e.target.checked})}
                />
                <label htmlFor="modalIsStop" className="font-bold text-red-600">กำหนดเป็นวันหยุด</label>
              </div>

              {!cellData.isStop && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">เวลาเข้า <span className="text-red-500">*</span></label>
                      <div className="flex items-center gap-1">
                        <select 
                          className="w-full border border-gray-300 rounded p-1 text-center text-sm"
                          value={cellData.checkInHr}
                          onChange={(e) => setCellData({...cellData, checkInHr: e.target.value})}
                        >
                          <option value="">-</option>
                          {hrOpts.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                        <span className="font-bold">:</span>
                        <select 
                          className="w-full border border-gray-300 rounded p-1 text-center text-sm"
                          value={cellData.checkInMin}
                          onChange={(e) => setCellData({...cellData, checkInMin: e.target.value})}
                        >
                          <option value="">-</option>
                          {minOpts.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">เวลาออก</label>
                      <div className="flex items-center gap-1">
                        <select 
                          className="w-full border border-gray-300 rounded p-1 text-center text-sm"
                          value={cellData.checkOutHr}
                          onChange={(e) => setCellData({...cellData, checkOutHr: e.target.value})}
                        >
                          <option value="">-</option>
                          {hrOutOpts.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                        <span className="font-bold">:</span>
                        <select 
                          className="w-full border border-gray-300 rounded p-1 text-center text-sm"
                          value={cellData.checkOutMin}
                          onChange={(e) => setCellData({...cellData, checkOutMin: e.target.value})}
                        >
                          <option value="">-</option>
                          {minOpts.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">เวลาเบรค</label>
                      <select 
                        className="w-full border border-gray-300 rounded p-1.5 text-sm"
                        value={cellData.breakDur}
                        onChange={(e) => setCellData({...cellData, breakDur: e.target.value})}
                      >
                        <option value="">-</option>
                        {breakOpts.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">เริ่มเบรค</label>
                      <div className="flex items-center gap-1">
                        <select 
                          className="w-full border border-gray-300 rounded p-1 text-center text-sm"
                          value={cellData.breakStartHr}
                          onChange={(e) => setCellData({...cellData, breakStartHr: e.target.value})}
                        >
                          <option value="">-</option>
                          {hrOpts.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                        <span className="font-bold">:</span>
                        <select 
                          className="w-full border border-gray-300 rounded p-1 text-center text-sm"
                          value={cellData.breakStartMin}
                          onChange={(e) => setCellData({...cellData, breakStartMin: e.target.value})}
                        >
                          <option value="">-</option>
                          {minOpts.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">OT (ชั่วโมง)</label>
                      <select 
                        className="w-full border border-gray-300 rounded p-1.5 text-sm"
                        value={cellData.ot}
                        onChange={(e) => setCellData({...cellData, ot: e.target.value})}
                      >
                        <option value="">-</option>
                        {otOpts.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">ชั่วโมงสะสม</label>
                      <select 
                        className="w-full border border-gray-300 rounded p-1.5 text-sm"
                        value={cellData.otAccum}
                        onChange={(e) => setCellData({...cellData, otAccum: e.target.value})}
                      >
                        <option value="">-</option>
                        {otOpts.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                  </div>

                  <hr className="my-2" />

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-blue-600 mb-1">ลา (รับค่าแรง)</label>
                      <select 
                        className="w-full border border-gray-300 rounded p-1.5 text-sm"
                        value={cellData.leave1}
                        onChange={(e) => setCellData({...cellData, leave1: e.target.value})}
                      >
                        <option value="">-</option>
                        {PAID_LEAVE.map(o => <option key={o.code} value={o.code}>{o.code} {o.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-red-600 mb-1">หยุด (ไม่รับค่าแรง)</label>
                      <select 
                        className="w-full border border-gray-300 rounded p-1.5 text-sm"
                        value={cellData.leave2}
                        onChange={(e) => setCellData({...cellData, leave2: e.target.value})}
                      >
                        <option value="">-</option>
                        {UNPAID_LEAVE.map(o => <option key={o.code} value={o.code}>{o.code} {o.label}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">ลารายชั่วโมง</label>
                      <select 
                        className="w-full border border-gray-300 rounded p-1.5 text-sm"
                        value={cellData.hrLeave}
                        onChange={(e) => setCellData({...cellData, hrLeave: e.target.value})}
                      >
                        <option value="">-</option>
                        {hrLeaveOpts.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">ใช้ชั่วโมงสะสม</label>
                      <select 
                        className="w-full border border-gray-300 rounded p-1.5 text-sm"
                        value={cellData.useAccum}
                        onChange={(e) => setCellData({...cellData, useAccum: e.target.value})}
                      >
                        <option value="">-</option>
                        {hrLeaveOpts.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1 mt-2">หมายเหตุเพิ่มเติม</label>
                <input 
                  type="text" 
                  placeholder="ระบุหมายเหตุ..."
                  className="w-full border border-gray-300 rounded p-1.5 text-sm"
                  value={cellData.otherNote}
                  onChange={(e) => setCellData({...cellData, otherNote: e.target.value})}
                />
              </div>

            </div>

            <div className="p-3 border-t border-gray-100 bg-gray-50 flex justify-end gap-2">
              <button
                onClick={clearCellData}
                title="ล้างข้อมูลของวันนี้"
                className="mr-auto flex items-center gap-1 px-3 py-1.5 text-red-600 hover:bg-red-50 rounded transition-colors text-sm font-medium"
              >
                <Trash2 className="w-4 h-4" />
                ล้างข้อมูลช่องนี้
              </button>
              <button
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-1.5 text-gray-600 hover:bg-gray-200 rounded transition-colors text-sm font-medium"
              >
                ยกเลิก
              </button>
              <button 
                onClick={saveCellData}
                className="px-6 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm font-medium"
              >
                ตกลง
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
