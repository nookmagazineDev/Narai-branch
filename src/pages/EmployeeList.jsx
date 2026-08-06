import { useState, useEffect } from 'react';
import { apiCall } from '../services/api';
import toast from 'react-hot-toast';
import { Users, Loader2, Search, Gift, Camera, Image as ImageIcon, Pencil, Check, X, LogOut, Fingerprint } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { fetchAttendance } from '../services/dashboardApi';
import { hhmm, summarizeDaily } from '../utils/attendance';

export default function EmployeeList() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [uploadingHr, setUploadingHr] = useState(null);
  const [logaEdits, setLogaEdits] = useState({});   // hrCode -> ค่าที่กำลังแก้
  const [savingLoga, setSavingLoga] = useState(null);
  const [editingLoga, setEditingLoga] = useState(null);   // hrCode ที่กำลังเปิดช่องแก้ไขอยู่
  const [resignTarget, setResignTarget] = useState(null); // { hrCode, fullName } พนักงานที่กำลังจะแจ้งลาออก
  const [resignDate, setResignDate] = useState('');
  const [resignReason, setResignReason] = useState('');
  const [resignSubmitting, setResignSubmitting] = useState(false);

  // ---- ดูสแกนเข้า-ออกทั้งสาขา รายวัน (ข้อมูลจากเครื่องสแกนหน้า ZKBio ผ่าน office-server) ----
  const [scanOpen, setScanOpen] = useState(false);
  const [scanDate, setScanDate] = useState('');
  const [scanBranch, setScanBranch] = useState('');
  const [scanRows, setScanRows] = useState(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanSearch, setScanSearch] = useState('');

  // ใช้วันที่แบบเวลาท้องถิ่น — toISOString() เป็น UTC ทำให้ช่วงเที่ยงคืนถึง 7 โมงเช้าได้วันที่ย้อนไป 1 วัน
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const isAdmin = String(user?.branch || '').toLowerCase() === 'all';

  const openScanModal = () => {
    // แอดมินเลือกสาขาในกล่องได้ ถ้ากรองสาขาไว้อยู่แล้วให้ใช้อันนั้นเป็นค่าตั้งต้น
    const initial = isAdmin ? (branchFilter || '') : (user?.branch || '');
    setScanBranch(initial);
    setScanDate(ymd(new Date()));
    setScanRows(null);
    setScanError('');
    setScanSearch('');
    setScanOpen(true);
  };

  const loadScans = async (branch = scanBranch, date = scanDate) => {
    if (!branch) { toast.error('กรุณาเลือกสาขา'); return; }
    if (!date) { toast.error('กรุณาเลือกวันที่'); return; }
    setScanLoading(true);
    setScanError('');
    try {
      // วันเดียว: start = end = วันที่ที่เลือก
      const res = await fetchAttendance({ branch, startDate: date, endDate: date });
      if (res?.status !== 'success') throw new Error(res?.message || 'ดึงข้อมูลไม่สำเร็จ');
      setScanRows(res.data || []);
    } catch (err) {
      // เก็บสาเหตุจริงไว้โชว์ใน modal — ถ้าเซ็ตเป็นค่าว่างเฉยๆ error จะหน้าตาเหมือน "ไม่มีข้อมูล"
      setScanError(err.message || 'ดึงข้อมูลสแกนไม่สำเร็จ');
      setScanRows([]);
    } finally {
      setScanLoading(false);
    }
  };

  // เปิดกล่องแล้วดึงให้เลยถ้ารู้สาขาอยู่แล้ว (สาขาทั่วไป) — แอดมินต้องเลือกสาขาก่อน
  useEffect(() => {
    if (scanOpen && scanBranch && scanRows === null && !scanLoading) loadScans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanOpen]);

  // สแกนวันเดียว -> 1 คน = 1 แถว เรียงตามเวลาเข้าก่อน-หลัง
  const scanDaily = (scanRows ? summarizeDaily(scanRows) : [])
    .filter((d) => {
      const q = scanSearch.trim().toLowerCase();
      if (!q) return true;
      return String(d.empCode).toLowerCase().includes(q) || String(d.name || '').toLowerCase().includes(q);
    })
    .sort((a, b) => String(a.first).localeCompare(String(b.first)));

  const handleSaveLoga = async (emp) => {
    if (!emp.hrCode) { toast.error('พนักงานคนนี้ไม่มีรหัส HR'); return; }
    const value = logaEdits[emp.hrCode] !== undefined ? logaEdits[emp.hrCode] : (emp.loga || '');
    setSavingLoga(emp.hrCode);
    const toastId = toast.loading('กำลังบันทึกเลขที่ LOGA...');
    try {
      const res = await apiCall('updateEmployeeLoga', { hrCode: emp.hrCode, loga: value });
      if (res.status === 'success') {
        toast.success('บันทึกเลขที่ LOGA สำเร็จ', { id: toastId });
        setEmployees(prev => prev.map(e => e.hrCode === emp.hrCode ? { ...e, loga: value } : e));
        setLogaEdits(prev => { const n = { ...prev }; delete n[emp.hrCode]; return n; });
        setEditingLoga(null);
      } else {
        toast.error(res.message || 'บันทึกไม่สำเร็จ', { id: toastId });
      }
    } catch (err) {
      toast.error(err.message || 'การเชื่อมต่อขัดข้อง', { id: toastId });
    } finally {
      setSavingLoga(null);
    }
  };

  const handlePhotoUpload = async (emp, file) => {
    if (!file) return;
    if (!emp.hrCode) { toast.error('พนักงานคนนี้ไม่มีรหัส HR'); return; }
    if (!file.type.startsWith('image/')) { toast.error('กรุณาเลือกไฟล์รูปภาพ'); return; }
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const reader = new FileReader();
    reader.onload = async () => {
      setUploadingHr(emp.hrCode);
      const toastId = toast.loading('กำลังอัปโหลดรูป...');
      try {
        const res = await apiCall('uploadEmployeePhoto', {
          hrCode: emp.hrCode,
          ext,
          mimeType: file.type,
          base64: reader.result,
        });
        if (res.status === 'success') {
          toast.success('อัปโหลดรูปสำเร็จ', { id: toastId });
          fetchEmployees();
        } else {
          toast.error(res.message || 'อัปโหลดไม่สำเร็จ', { id: toastId });
        }
      } catch (err) {
        toast.error(err.message || 'การเชื่อมต่อขัดข้อง', { id: toastId });
      } finally {
        setUploadingHr(null);
      }
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    fetchEmployees();
  }, []);

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      const response = await apiCall('getEmployees', { branch: user?.branch || 'all' });
      if (response.status === 'success') {
        setEmployees(response.data || []);
      }
    } catch (error) {
      toast.error(error.message || 'เกิดข้อผิดพลาดในการดึงข้อมูลพนักงาน');
    } finally {
      setLoading(false);
    }
  };

  const openResignModal = (hrCode, fullName) => {
    setResignTarget({ hrCode, fullName });
    setResignDate(new Date().toISOString().slice(0, 10));
    setResignReason('');
  };

  const closeResignModal = () => {
    setResignTarget(null);
    setResignDate('');
    setResignReason('');
  };

  const handleResignSubmit = async () => {
    if (!resignTarget) return;
    if (!resignDate) { toast.error('กรุณาระบุวันที่ลาออก'); return; }
    if (!resignReason.trim()) { toast.error('กรุณาระบุสาเหตุการลาออก'); return; }

    setResignSubmitting(true);
    const toastId = toast.loading('กำลังบันทึกข้อมูล...');
    try {
      const response = await apiCall('resignEmployee', {
        hrCode: resignTarget.hrCode,
        resignDate,
        reason: resignReason.trim(),
        recorder: user?.username || 'Unknown'
      });
      if (response.status === 'success') {
        toast.success('แจ้งลาออกสำเร็จ', { id: toastId });
        closeResignModal();
        fetchEmployees();
      } else {
        toast.error(response.message || 'เกิดข้อผิดพลาด', { id: toastId });
      }
    } catch (err) {
      toast.error('การเชื่อมต่อขัดข้อง', { id: toastId });
    } finally {
      setResignSubmitting(false);
    }
  };

  const parseThaiDate = (dateStr) => {
    if (!dateStr) return null;
    let d = new Date(dateStr);
    
    if (typeof dateStr === 'string' && dateStr.includes('/')) {
      const parts = dateStr.split('/');
      if (parts.length === 3) {
        let year = parseInt(parts[2], 10);
        if (year > 2500) year -= 543;
        d = new Date(year, parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
      }
    } else if (!isNaN(d.getTime())) {
      if (d.getFullYear() > 2500) {
        d.setFullYear(d.getFullYear() - 543);
      }
    }
    
    return isNaN(d.getTime()) ? null : d;
  };

  const calculateDuration = (startDateStr) => {
    const start = parseThaiDate(startDateStr);
    if (!start) return '-';

    const now = new Date();
    
    let years = now.getFullYear() - start.getFullYear();
    let months = now.getMonth() - start.getMonth();
    let days = now.getDate() - start.getDate();
    
    if (days < 0) {
      months--;
      days += 30; // rough estimate
    }
    if (months < 0) {
      years--;
      months += 12;
    }
    
    let result = [];
    if (years > 0) result.push(`${years} ปี`);
    if (months > 0) result.push(`${months} เดือน`);
    if (years === 0 && days > 0) result.push(`${days} วัน`);
    
    if (result.length === 0) return 'เริ่มงานวันนี้';
    return result.join(' ');
  };

  const formatDate = (dateStr) => {
    const d = parseThaiDate(dateStr);
    if (!d) return dateStr || '-';
    return d.toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const uniqueStatuses = ['ทำงาน', 'ลาออก'];
  const uniqueTypes = [...new Set(employees.map(emp => emp.type || '-'))].filter(Boolean);
  const uniqueBranches = user?.branch === 'all' ? [...new Set(employees.map(emp => emp.branch || '-'))].filter(Boolean) : [];

  const filteredEmployees = employees.filter(emp => {
    const hrCode = emp.hrCode ? String(emp.hrCode).toLowerCase() : '';
    const fullName = emp.fullName ? String(emp.fullName).toLowerCase() : '';
    const position = emp.position ? String(emp.position).toLowerCase() : '';
    const search = searchTerm.toLowerCase();

    const matchesSearch = hrCode.includes(search) ||
      fullName.includes(search) ||
      position.includes(search);

    const matchesStatus = statusFilter ? String(emp.status).toLowerCase() === statusFilter.toLowerCase() : true;
    const matchesType = typeFilter ? emp.type === typeFilter : true;
    const matchesBranch = branchFilter ? emp.branch === branchFilter : true;

    return matchesSearch && matchesStatus && matchesType && matchesBranch;
  }).sort((a, b) => {
    if (a.status === 'ทำงาน' && b.status !== 'ทำงาน') return -1;
    if (a.status !== 'ทำงาน' && b.status === 'ทำงาน') return 1;
    return 0;
  });

  const getAnniversaryEmployees = () => {
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    
    return employees.filter(emp => {
      if (emp.status !== 'ทำงาน' || !emp.startDate) return false;
      
      const start = parseThaiDate(emp.startDate);
      if (!start) return false;
      
      const startMonth = start.getMonth();
      const startYear = start.getFullYear();
      const yearsWorked = currentYear - startYear;
      
      return startMonth === currentMonth && yearsWorked >= 1;
    }).map(emp => {
      const start = parseThaiDate(emp.startDate);
      const yearsWorked = currentYear - start.getFullYear();
      return { ...emp, yearsWorked };
    });
  };

  const anniversaryEmployees = getAnniversaryEmployees();

  return (
    <div className="max-w-7xl mx-auto">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 md:p-8 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-purple-100 text-purple-600 rounded-xl">
              <Users className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-gray-800">รายชื่อพนักงาน</h2>
              <p className="text-sm text-gray-500 mt-1">จัดการรายชื่อและข้อมูลพนักงานทั้งหมดในสาขา</p>
            </div>
          </div>
          <div className="bg-purple-50 text-purple-700 px-4 py-2 rounded-lg font-medium text-sm border border-purple-100 shadow-sm">
            พนักงานทั้งหมด {filteredEmployees.length} คน
          </div>
        </div>

        {/* Anniversary Alert Box */}
        {anniversaryEmployees.length > 0 && (
          <div className="bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-100 rounded-2xl p-6 m-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="p-3 bg-white shadow-sm text-purple-600 rounded-xl flex-shrink-0">
                <Gift className="w-6 h-6" />
              </div>
              <div className="w-full">
                <h3 className="text-lg font-bold text-purple-900 mb-1">🎉 ยินดีด้วย! เดือนนี้มีพนักงานทำงานครบรอบปี {anniversaryEmployees.length} คน</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
                  {anniversaryEmployees.map(emp => (
                    <div key={emp.hrCode} className="bg-white/80 backdrop-blur rounded-lg p-3 border border-purple-100 shadow-sm flex flex-col hover:shadow-md transition-shadow">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold text-gray-800 truncate pr-2">{emp.fullName}</span>
                        <span className="text-[11px] font-bold bg-purple-100 text-purple-700 px-2 py-1 rounded-full whitespace-nowrap">ครบ {emp.yearsWorked} ปี</span>
                      </div>
                      <div className="text-xs text-gray-500">รหัส: <span className="font-medium text-gray-700">{emp.hrCode}</span></div>
                      <div className="text-xs text-gray-500 truncate">ตำแหน่ง: {emp.position}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="p-6 border-b border-gray-100 flex flex-wrap items-center gap-3">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="ค้นหาชื่อ, รหัส, ตำแหน่ง..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="block w-full md:w-80 pl-10 pr-3 py-2 border border-gray-200 rounded-xl leading-5 bg-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 sm:text-sm transition-colors"
            />
          </div>
          <button
            onClick={openScanModal}
            className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-xl text-sm font-semibold hover:bg-teal-700 transition-colors shadow-sm"
          >
            <Fingerprint className="w-4 h-4" /> ดูสแกนเข้า-ออก
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-1"><span>ลำดับ</span></div>
                </th>
                <th scope="col" className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-1"><span>รหัส HR</span></div>
                </th>
                <th scope="col" className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-1"><span>ชื่อ - นามสกุล</span></div>
                </th>
                {user?.branch === 'all' && (
                  <th scope="col" className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    <div className="flex flex-col gap-2">
                      <span>สาขา</span>
                      <select 
                        className="block w-full text-xs py-1 px-2 border border-gray-200 rounded-lg bg-white focus:ring-purple-500 focus:border-purple-500 font-normal"
                        value={branchFilter}
                        onChange={(e) => setBranchFilter(e.target.value)}
                      >
                        <option value="">ทั้งหมด</option>
                        {uniqueBranches.map(b => <option key={b} value={b}>{b}</option>)}
                      </select>
                    </div>
                  </th>
                )}
                <th scope="col" className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-2">
                    <span>สถานะ</span>
                    <select
                      className="block w-full text-xs py-1 px-2 border border-gray-200 rounded-lg bg-white focus:ring-purple-500 focus:border-purple-500 font-normal"
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                    >
                      <option value="">ทั้งหมด</option>
                      {uniqueStatuses.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </th>
                <th scope="col" className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-2">
                    <span>ประเภท</span>
                    <select
                      className="block w-full text-xs py-1 px-2 border border-gray-200 rounded-lg bg-white focus:ring-purple-500 focus:border-purple-500 font-normal"
                      value={typeFilter}
                      onChange={(e) => setTypeFilter(e.target.value)}
                    >
                      <option value="">ทั้งหมด</option>
                      {uniqueTypes.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </th>
                <th scope="col" className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-1"><span>ตำแหน่ง</span></div>
                </th>
                <th scope="col" className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-1"><span>วันเริ่มทำงาน</span></div>
                </th>
                <th scope="col" className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-1"><span>ระยะเวลาทำงาน</span></div>
                </th>
                <th scope="col" className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-1"><span>เลขที่ LOGA</span></div>
                </th>
                <th scope="col" className="px-2 py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-1"><span>จัดการ</span></div>
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={user?.branch === 'all' ? 11 : 10} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center justify-center text-gray-500">
                      <Loader2 className="w-8 h-8 animate-spin text-purple-500 mb-2" />
                      <p>กำลังโหลดข้อมูล...</p>
                    </div>
                  </td>
                </tr>
              ) : filteredEmployees.length === 0 ? (
                <tr>
                  <td colSpan={user?.branch === 'all' ? 11 : 10} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center justify-center text-gray-500">
                      <Users className="w-12 h-12 text-gray-300 mb-3" />
                      <p className="text-lg font-medium text-gray-900">ไม่พบข้อมูลพนักงาน</p>
                      <p className="text-sm mt-1">ยังไม่มีพนักงานในสาขานี้ หรือไม่พบข้อมูลที่ค้นหา</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredEmployees.map((emp, index) => (
                  <tr key={index} className="hover:bg-gray-50 transition-colors">
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-gray-500 text-center font-medium">{index + 1}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm font-medium text-purple-600">{emp.hrCode || '-'}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-gray-900 font-medium">{emp.fullName || '-'}</td>
                    {user?.branch === 'all' && (
                      <td className="px-2 py-2 whitespace-nowrap text-sm font-medium text-indigo-600">{emp.branch || '-'}</td>
                    )}
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      {emp.status === 'ลาออก' ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                          {emp.status}
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
                          {emp.status || 'ทำงาน'}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-gray-500">
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        {emp.type || '-'}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-gray-500">{emp.position || '-'}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-gray-500">{formatDate(emp.startDate)}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-gray-900 font-medium">{calculateDuration(emp.startDate)}</td>
                    {/* เลขที่ LOGA (คอลัมน์ BR) — แสดงเลข + ปุ่มแก้ไข, กดแก้ไขถึงจะกรอกได้ (เฉพาะพนักงานที่ยังทำงาน) */}
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      {emp.status === 'ลาออก' ? (
                        <span className="text-gray-500 font-mono">{emp.loga || '-'}</span>
                      ) : editingLoga === emp.hrCode ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            autoFocus
                            value={logaEdits[emp.hrCode] !== undefined ? logaEdits[emp.hrCode] : (emp.loga || '')}
                            onChange={(e) => setLogaEdits(prev => ({ ...prev, [emp.hrCode]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveLoga(emp);
                              if (e.key === 'Escape') { setEditingLoga(null); setLogaEdits(prev => { const n = { ...prev }; delete n[emp.hrCode]; return n; }); }
                            }}
                            placeholder="กรอกเลข LOGA"
                            className="w-24 px-2 py-1 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-purple-500"
                          />
                          <button
                            onClick={() => handleSaveLoga(emp)}
                            disabled={savingLoga === emp.hrCode}
                            className="p-1 bg-purple-50 text-purple-600 border border-purple-200 rounded-lg hover:bg-purple-100 disabled:opacity-50"
                            title="บันทึก"
                          >
                            {savingLoga === emp.hrCode ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={() => { setEditingLoga(null); setLogaEdits(prev => { const n = { ...prev }; delete n[emp.hrCode]; return n; }); }}
                            disabled={savingLoga === emp.hrCode}
                            className="p-1 bg-gray-50 text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-100 disabled:opacity-50"
                            title="ยกเลิก"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-gray-900 min-w-[3.5rem]">{emp.loga || '-'}</span>
                          <button
                            onClick={() => setEditingLoga(emp.hrCode)}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-purple-50 text-purple-600 border border-purple-200 rounded-lg text-xs font-medium hover:bg-purple-100"
                            title="แก้ไขเลขที่ LOGA"
                          >
                            <Pencil className="w-3 h-3" /> แก้ไข
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-center">
                      <div className="flex items-center justify-center gap-2">
                        <label className={`cursor-pointer inline-flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium border transition-colors ${uploadingHr === emp.hrCode ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-wait' : 'bg-purple-50 text-purple-600 hover:bg-purple-100 border-purple-200'}`}>
                          {uploadingHr === emp.hrCode ? (
                            <><Loader2 className="w-3 h-3 animate-spin" /> กำลังอัป...</>
                          ) : (
                            <><Camera className="w-3 h-3" /> {emp.photoUrl ? 'เปลี่ยนรูป' : 'เพิ่มรูป'}</>
                          )}
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            disabled={uploadingHr === emp.hrCode}
                            onChange={(e) => { handlePhotoUpload(emp, e.target.files[0]); e.target.value = ''; }}
                          />
                        </label>
                        {emp.photoUrl && (
                          <a href={emp.photoUrl} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-emerald-600 hover:text-emerald-800" title="ดูรูป">
                            <ImageIcon className="w-3.5 h-3.5" />
                          </a>
                        )}
                        {emp.status !== 'ลาออก' && (
                          <button
                            onClick={() => openResignModal(emp.hrCode, emp.fullName)}
                            className="px-3 py-1 bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 rounded-md text-xs font-medium transition-colors"
                          >
                            แจ้งลาออก
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal: สแกนเข้า-ออกทั้งสาขา ของวันที่เลือก */}
      {scanOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setScanOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2.5 bg-teal-100 text-teal-600 rounded-xl shrink-0">
                  <Fingerprint className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-gray-800">สแกนเข้า-ออก</h3>
                  <p className="text-sm text-gray-500">
                    เวลาสแกนหน้าของพนักงานทั้งสาขา ในวันที่เลือก
                    {scanRows && !scanError ? ` · ${scanDaily.length} คน` : ''}
                  </p>
                </div>
              </div>
              <button onClick={() => setScanOpen(false)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 shrink-0">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* เลือกวันที่ (+ สาขา สำหรับแอดมิน) */}
            <div className="px-6 py-3 border-b border-gray-100 bg-gray-50 flex flex-wrap items-center gap-2">
              {isAdmin && (
                <select
                  value={scanBranch}
                  onChange={(e) => { setScanBranch(e.target.value); setScanRows(null); setScanError(''); }}
                  className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-teal-500 outline-none"
                >
                  <option value="">เลือกสาขา…</option>
                  {uniqueBranches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              )}
              <input
                type="date"
                value={scanDate}
                max={ymd(new Date())}
                onChange={(e) => setScanDate(e.target.value)}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 outline-none"
              />
              <button onClick={() => loadScans()} disabled={scanLoading}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50">
                {scanLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                ดึงข้อมูล
              </button>
              <button
                onClick={() => { const t = ymd(new Date()); setScanDate(t); loadScans(scanBranch, t); }}
                className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 text-gray-600 hover:bg-white">วันนี้</button>
              {scanRows && scanRows.length > 0 && (
                <input
                  value={scanSearch}
                  onChange={(e) => setScanSearch(e.target.value)}
                  placeholder="ค้นหาชื่อ/รหัส…"
                  className="ml-auto px-3 py-1.5 border border-gray-200 rounded-lg text-sm w-44 focus:ring-2 focus:ring-teal-500 outline-none"
                />
              )}
            </div>

            <div className="flex-1 overflow-auto">
              {scanLoading ? (
                <div className="py-16 flex flex-col items-center text-gray-500">
                  <Loader2 className="w-8 h-8 animate-spin text-teal-500 mb-2" />
                  <p className="text-sm">กำลังโหลด...</p>
                </div>
              ) : scanError ? (
                <div className="py-14 px-6 text-center text-sm space-y-2">
                  <p className="text-red-600 font-medium">ดึงข้อมูลไม่สำเร็จ</p>
                  <p className="text-gray-600 text-xs max-w-md mx-auto break-words">{scanError}</p>
                  <button onClick={() => loadScans()}
                    className="mt-2 px-4 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200">
                    ลองใหม่
                  </button>
                </div>
              ) : scanRows === null ? (
                <div className="py-16 px-6 text-center text-sm text-gray-400">
                  {isAdmin && !scanBranch ? 'เลือกสาขาแล้วกด "ดึงข้อมูล"' : 'กด "ดึงข้อมูล" เพื่อดูเวลาสแกน'}
                </div>
              ) : scanDaily.length === 0 ? (
                <div className="py-16 px-6 text-center text-sm space-y-1">
                  <p className="text-amber-600 font-medium">
                    {scanSearch ? 'ไม่พบพนักงานที่ค้นหา' : 'ไม่พบการสแกนในวันที่เลือก'}
                  </p>
                  {!scanSearch && (
                    <p className="text-gray-400 text-xs">ลองเปลี่ยนวันที่ หรือตรวจว่าเครื่องสแกนของสาขาส่งข้อมูลเข้าระบบแล้วหรือยัง</p>
                  )}
                </div>
              ) : (
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="text-gray-600 text-xs">
                      <th className="px-4 py-2.5 text-left sticky top-0 bg-gray-50 border-b border-gray-200">รหัส</th>
                      <th className="px-4 py-2.5 text-left sticky top-0 bg-gray-50 border-b border-gray-200">ชื่อ</th>
                      <th className="px-4 py-2.5 text-center sticky top-0 bg-gray-50 border-b border-gray-200">เข้า</th>
                      <th className="px-4 py-2.5 text-center sticky top-0 bg-gray-50 border-b border-gray-200">ออกเบรค</th>
                      <th className="px-4 py-2.5 text-center sticky top-0 bg-gray-50 border-b border-gray-200">เข้าเบรค</th>
                      <th className="px-4 py-2.5 text-center sticky top-0 bg-gray-50 border-b border-gray-200">ออก</th>
                      <th className="px-4 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">รวม</th>
                      <th className="px-4 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">พัก</th>
                      <th className="px-4 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">สุทธิ</th>
                      <th className="px-4 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">สแกน</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 text-gray-700">
                    {scanDaily.map((d) => (
                      <tr key={d.empCode} className="hover:bg-teal-50/40">
                        <td className="px-4 py-2 font-mono text-xs text-gray-500">{d.empCode}</td>
                        <td className="px-4 py-2 whitespace-nowrap">{d.name || <span className="text-gray-300">—</span>}</td>
                        <td className="px-4 py-2 text-center font-mono font-semibold text-emerald-700">{hhmm(d.first)}</td>
                        <td className="px-4 py-2 text-center font-mono text-amber-600">
                          {d.breakOut ? hhmm(d.breakOut) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-2 text-center font-mono text-amber-600">
                          {d.breakIn ? hhmm(d.breakIn) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-2 text-center font-mono font-semibold text-rose-700">
                          {d.last ? hhmm(d.last) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-gray-500">{d.hours != null ? d.hours.toFixed(2) : '-'}</td>
                        <td className="px-4 py-2 text-right font-mono text-gray-400">{d.breakHours != null ? d.breakHours.toFixed(2) : '-'}</td>
                        <td className="px-4 py-2 text-right font-mono font-bold text-gray-800">{d.netHours != null ? d.netHours.toFixed(2) : '-'}</td>
                        <td className="px-4 py-2 text-right font-mono text-gray-400">{d.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="px-6 py-3 border-t border-gray-100 bg-gray-50 text-xs text-gray-400">
              อ่านจากลำดับการสแกน 4 รอบ: เข้างาน → ออกเบรค → เข้าเบรค → ออกงาน ·
              <span className="font-medium"> สุทธิ</span> = ชั่วโมงรวมหักเวลาพักแล้ว · ช่องที่เป็น — คือวันนั้นสแกนไม่ครบ 4 รอบ
            </div>
          </div>
        </div>
      )}

      {/* Resign Modal */}
      {resignTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2.5 bg-red-100 text-red-600 rounded-xl">
                <LogOut className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-800">แจ้งลาออก</h3>
                <p className="text-sm text-gray-500">{resignTarget.fullName} ({resignTarget.hrCode})</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">วันที่ลาออก</label>
                <input
                  type="date"
                  value={resignDate}
                  onChange={(e) => setResignDate(e.target.value)}
                  className="block w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-red-500 focus:border-red-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">สาเหตุ</label>
                <textarea
                  value={resignReason}
                  onChange={(e) => setResignReason(e.target.value)}
                  rows={3}
                  placeholder="ระบุสาเหตุการลาออก..."
                  className="block w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-red-500 focus:border-red-500"
                  required
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={closeResignModal}
                disabled={resignSubmitting}
                className="px-4 py-2 bg-gray-100 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-200 disabled:opacity-50"
              >
                ยกเลิก
              </button>
              <button
                onClick={handleResignSubmit}
                disabled={resignSubmitting}
                className="px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
              >
                {resignSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                ยืนยันแจ้งลาออก
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
