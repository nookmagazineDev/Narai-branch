import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { Loader2, ChevronLeft, ChevronRight, Save, Clock, Download, Printer } from 'lucide-react';
import html2canvas from 'html2canvas';
import toast from 'react-hot-toast';

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

  // Helpers for options
  const hrOpts = Array.from({length: 17}, (_, i) => String(i + 8).padStart(2, '0'));
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
  const [cellData, setCellData] = useState({
    isStop: false,
    checkInHr: '', checkInMin: '',
    checkOutHr: '', checkOutMin: '',
    breakDur: '', breakStartHr: '', breakStartMin: '',
    ot: '', otAccum: '',
    leave1: '', leave2: '',
    hrLeave: '', useAccum: '',
    otherNote: ''
  });

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


  const exportScheduleToImage = async () => {
    const b = effectiveBranch;
    if (!b || employees.length === 0) {
      toast.error('กรุณาเลือกสาขาและรอระบบโหลดข้อมูลให้เสร็จก่อน');
      return;
    }

    const tableEl = document.getElementById('weekly-schedule-table-container');
    if (!tableEl) return;
    
    const loadingToast = toast.loading('กำลังสร้างรูปภาพ...');
    
    try {
      const originalMaxHeight = tableEl.style.maxHeight;
      const originalOverflow = tableEl.style.overflow;
      const originalWidth = tableEl.style.width;
      
      tableEl.style.maxHeight = 'none';
      tableEl.style.overflow = 'visible';
      tableEl.style.width = tableEl.scrollWidth + 'px';
      
      const titleEl = document.createElement('h4');
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
        windowHeight: tableEl.scrollHeight
      });
      
      tableEl.style.maxHeight = originalMaxHeight;
      tableEl.style.overflow = originalOverflow;
      tableEl.style.width = originalWidth;
      titleEl.remove();
      
      const link = document.createElement('a');
      link.download = `ตารางงาน_${b}_${weekStr.replace(/ /g, '_')}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      
      toast.success('บันทึกรูปภาพสำเร็จ', { id: loadingToast });
    } catch (err) {
      console.error(err);
      toast.error('เกิดข้อผิดพลาดในการสร้างรูปภาพ', { id: loadingToast });
    }
  };

  const changeWeek = (weeks) => {
    const newDate = new Date(weekStartDate);
    newDate.setDate(newDate.getDate() + (weeks * 7));
    setWeekStartDate(newDate);
  };

  const daysOfWeek = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStartDate);
    d.setDate(d.getDate() + i);
    const dateStr = formatDateLocal(d);
    return {
      dateStr,
      dayName: d.toLocaleDateString('th-TH', { weekday: 'short' }),
      shortDate: `${d.getDate()} ${d.toLocaleDateString('th-TH', { month: 'short' })}`
    };
  });

  // โหลดรายชื่อสาขาสำหรับ user สิทธิ์ all (ใช้ในฟิลเตอร์เลือกสาขา)
  useEffect(() => {
    if (isAll && branches.length === 0) {
      apiCall('getBranches', {})
        .then(res => { if (res.status === 'success') setBranches(res.data || []); })
        .catch(() => {});
    }
  }, [isAll]);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {

        // Fetch Branch Stats
        const statsRes = await apiCall('getBranchStats', { branch: effectiveBranch || '' });
        if (statsRes.status === 'success') {
          const dTarget = parseFloat(String(statsRes.data.dailyTarget).replace(/,/g, '')) || 0;
          const dMax = parseFloat(String(statsRes.data.maxWage).replace(/,/g, '')) || 0;
          setWeeklyTarget(dTarget * 7);
          setWeeklyMaxWage(dMax * 7);
        }

        // Fetch employees
        const empRes = await apiCall('getScheduleEmployees', { branch: effectiveBranch || '' });
        if (empRes.status === 'success') {
          setEmployees(empRes.data);
        } else {
          toast.error('ไม่สามารถโหลดข้อมูลพนักงานได้');
        }

        // Fetch schedule data for the week
        const start = new Date(weekStartDate);
        const end = new Date(weekStartDate);
        end.setDate(end.getDate() + 6);
        
        const schedRes = await apiCall('getHistoryData', {
          branch: effectiveBranch || '',
          startDate: formatDateLocal(start),
          endDate: formatDateLocal(end)
        });

        if (schedRes.status === 'success') {
          const newScheduleData = {};
          const sortedHistory = schedRes.data.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

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
        }

      } catch (err) {
        toast.error('เกิดข้อผิดพลาดในการโหลดข้อมูล');
      } finally {
        setLoading(false);
      }
    };
    if (effectiveBranch) {
      fetchData();
    } else {
      // user สิทธิ์ all ที่ยังไม่ได้เลือกสาขา — เคลียร์ข้อมูล รอเลือกสาขาก่อน
      setEmployees([]);
      setScheduleData({});
      setLoading(false);
    }
  }, [effectiveBranch, weekStartDate]);

  const handleCellClick = (emp, dateStr) => {
    const key = `${emp.hrCode}_${dateStr}`;
    const existingData = scheduleData[key] || {
      isStop: false,
      checkInHr: '', checkInMin: '',
      checkOutHr: '', checkOutMin: '',
      breakDur: '', breakStartHr: '', breakStartMin: '',
      ot: '', otAccum: '',
      leave1: '', leave2: '',
      hrLeave: '', useAccum: '',
      otherNote: ''
    };
    setActiveCell({ ...emp, dateStr, key });
    setCellData(existingData);
    setIsModalOpen(true);
  };

  const saveCellData = () => {
    setScheduleData(prev => ({
      ...prev,
      [activeCell.key]: cellData
    }));
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
    const ua = data.useAccum || '';
    const ota = data.otAccum || '0';
    const noteInput = data.otherNote || '';
    const finalStop = data.isStop || (l1 !== '') || (l2 !== '');
    const brDur = data.breakDur;
    
    let isCleared = false;
    if (!ci && !co && !finalStop && !l1 && !l2 && (!ota || ota === '0') && !hl && !ua && !noteInput) {
      isCleared = true;
    }

    if (isCleared) {
      if (empType === 'F/T') wage = rate; else wage = 0;
    } else {
      if (l2 !== '') {
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

  // Calculate Summary dynamically
  const summary = React.useMemo(() => {
    let totalWage = 0;
    const workingEmpSet = new Set();
    
    Object.entries(scheduleData).forEach(([key, data]) => {
      const emp = employees.find(e => key.startsWith(e.hrCode + '_'));
      if (emp) {
        const w = calculateCellWage(emp, data);
        totalWage += w;
        
        const isStop = data.isStop || data.leave1 || data.leave2;
        if (!isStop || w > 0) {
          workingEmpSet.add(emp.hrCode);
        }
      }
    });
    
    return {
      totalWage,
      workingCount: workingEmpSet.size,
      wagePercent: weeklyTarget > 0 ? ((totalWage / weeklyTarget) * 100).toFixed(2) : '0.00'
    };
  }, [scheduleData, employees, weeklyTarget]);

  const handleSaveSchedule = async () => {
    if (Object.keys(scheduleData).length === 0) {
      toast.error('ยังไม่มีข้อมูลให้บันทึก');
      return;
    }

    setIsSaving(true);
    try {
      const logs = [];
      Object.entries(scheduleData).forEach(([key, data]) => {
        // Find the employee by matching the start of the key, since key is hrCode + '_' + dateStr
        const emp = employees.find(e => key.startsWith(e.hrCode + '_'));
        const dateStr = emp ? key.replace(emp.hrCode + '_', '') : '';
        
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

          let isCleared = false;
          if (!ci && !co && !finalStop && !l1 && !l2 && (!ota || ota === '0') && !hl && !ua && !noteInput) {
            isCleared = true;
          }

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
            empType: empType || '',
            leaveNote: l1,
            unpaidLeave: l2,
            hourlyLeave: hl,
            useAccumulatedHours: ua,
            otherNote: isCleared ? 'ล้างข้อมูล' : noteInput,
            isStop: finalStop
          });
        }
      });

      // Filter out 'ล้างข้อมูล' if there's no existing entry we are actually clearing
      // In this case we just send everything because apps-script will handle 'ล้างข้อมูล' correctly (actually apps-script appending won't delete old data right now, but it matches the new structure)
      
      if (logs.length === 0) {
        toast.error('รหัสพนักงานไม่ตรงกัน หรือไม่พบข้อมูลที่จะบันทึก');
        setIsSaving(false);
        return;
      }

      const res = await apiCall('saveTimesheet', { logs });
      if (res.status === 'success') {
        toast.success('บันทึกตารางงานเรียบร้อยแล้ว');
      } else {
        toast.error('บันทึกไม่สำเร็จ: ' + res.message);
      }
    } catch (err) {
      toast.error('เกิดข้อผิดพลาดในการบันทึก');
    } finally {
      setIsSaving(false);
    }
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
                onChange={(e) => setSelectedBranch(e.target.value)}
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
              onClick={handleSaveSchedule}
              disabled={isSaving || !effectiveBranch}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
              บันทึกตาราง
            </button>
          </div>
        </div>
      </div>

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
          <div className="overflow-auto flex-1">
            <table className="w-full text-sm text-left border-collapse">
              <thead className="text-xs text-gray-700 uppercase bg-gray-50 sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="px-4 py-3 border-b border-r bg-gray-50 min-w-[200px] sticky left-0 z-20">พนักงาน</th>
                  {daysOfWeek.map(d => (
                    <th key={d.dateStr} className="px-2 py-3 border-b border-r text-center min-w-[120px]">
                      <div className="font-bold">{d.dayName}</div>
                      <div className="text-gray-500 font-normal">{d.shortDate}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {employees.map(emp => (
                  <tr key={emp.hrCode} className="border-b hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2 border-r bg-white sticky left-0 z-10 shadow-[1px_0_0_0_#f3f4f6]">
                      <div className="text-xs text-purple-600 font-bold mb-0.5">{emp.hrCode}</div>
                      <div className="font-medium text-gray-900 leading-tight">{emp.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{emp.position}</div>
                    </td>
                    {daysOfWeek.map(d => {
                      const key = `${emp.hrCode}_${d.dateStr}`;
                      const cell = scheduleData[key];
                      
                      return (
                        <td 
                          key={d.dateStr} 
                          className="p-1 border-r cursor-pointer hover:bg-purple-50"
                          onClick={() => handleCellClick(emp, d.dateStr)}
                        >
                          <div className={`h-14 rounded border border-transparent p-1 flex flex-col justify-center items-center text-xs ${
                            !cell ? 'bg-gray-50 text-gray-400 border-dashed border-gray-200' :
                            cell.isStop || cell.leave2 ? 'bg-red-50 text-red-600 border-red-100' :
                            'bg-green-50 text-green-700 border-green-100'
                          }`}>
                            {!cell ? (
                              <span>-</span>
                            ) : cell.isStop || cell.leave2 ? (
                              <>
                                <span className="font-medium">{cell.leave2 || 'หยุด'}</span>
                                {cell.otherNote && <span className="text-[10px] text-red-500 truncate w-full text-center" title={cell.otherNote}>{cell.otherNote}</span>}
                              </>
                            ) : (
                              <>
                                {(cell.checkInHr || cell.checkOutHr) ? (
                                  <span className="font-bold">
                                    {cell.checkInHr ? `${cell.checkInHr}:${cell.checkInMin || '00'}` : '?'} - {cell.checkOutHr ? `${cell.checkOutHr}:${cell.checkOutMin || '00'}` : '?'}
                                  </span>
                                ) : (
                                  <span className="font-bold text-gray-400">? - ?</span>
                                )}
                                {(() => {
                                  const notes = [];
                                  if (cell.ot && cell.ot !== '0') notes.push(`OT ${cell.ot}`);
                                  if (cell.otAccum && cell.otAccum !== '0') notes.push(`+สะสม ${cell.otAccum}`);
                                  if (cell.leave1) notes.push(cell.leave1);
                                  if (cell.hrLeave && cell.hrLeave !== '0') notes.push(`ลา ${cell.hrLeave}ชม.`);
                                  if (cell.useAccum && cell.useAccum !== '0') notes.push(`ใช้สะสม ${cell.useAccum}ชม.`);
                                  if (cell.otherNote) notes.push(cell.otherNote);
                                  
                                  if (notes.length === 0) return null;
                                  return (
                                    <span className="text-[10px] text-blue-600 font-medium leading-tight truncate w-full text-center" title={notes.join(', ')}>
                                      {notes.join(', ')}
                                    </span>
                                  );
                                })()}
                              </>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Cell Modal */}
      {isModalOpen && activeCell && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
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
                          {hrOpts.map(h => <option key={h} value={h}>{h}</option>)}
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
                        <option value="วันหยุดธรรมดา">⚪ วันหยุดธรรมดา</option>
                        <option value="ลากิจ">🟠 ลากิจ</option>
                        <option value="ลาป่วย">🔴 ลาป่วย</option>
                        <option value="ลารายชั่วโมง">⏱ ลารายชั่วโมง</option>
                        <option value="ใช้ Extra">⭐ ใช้ Extra (หยุดชดเชย)</option>
                        <option value="พักร้อน">🔵 พักร้อน</option>
                        <option value="ใช้สะสม">🟣 ใช้สะสม</option>
                        <option value="ประชุม">🟤 ประชุม</option>
                        <option value="อบรม">🔵 อบรม</option>
                        <option value="คลอด">💖 คลอด</option>
                        <option value="ชดเชย 8 ชั่วโมง">ชดเชย 8 ชั่วโมง</option>
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
                        <option value="วันหยุดธรรมดา">⚪ วันหยุดธรรมดา</option>
                        <option value="ป่วยไม่มีใบรับรอง">🤒 ป่วยไม่มีใบรับรอง</option>
                        <option value="ลากิจ">🏃 ลากิจ</option>
                        <option value="ขาดงาน">❌ ขาดงาน</option>
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
