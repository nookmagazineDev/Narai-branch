import { useState, useEffect } from 'react';
import { apiCall } from '../services/api';
import toast from 'react-hot-toast';
import { Users, Loader2, Search, Gift } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export default function EmployeeList() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');

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

  const handleResign = async (hrCode, fullName) => {
    if (!window.confirm(`คุณแน่ใจหรือไม่ว่าต้องการแจ้งลาออกสำหรับพนักงาน: ${fullName} (${hrCode})?`)) {
      return;
    }
    const toastId = toast.loading('กำลังบันทึกข้อมูล...');
    try {
      const response = await apiCall('resignEmployee', { hrCode });
      if (response.status === 'success') {
        toast.success('แจ้งลาออกสำเร็จ', { id: toastId });
        fetchEmployees();
      } else {
        toast.error(response.message || 'เกิดข้อผิดพลาด', { id: toastId });
      }
    } catch (err) {
      toast.error('การเชื่อมต่อขัดข้อง', { id: toastId });
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
    <div className="max-w-6xl mx-auto">
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

        <div className="p-6 border-b border-gray-100">
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
                <th scope="col" className="px-2 py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-1"><span>จัดการ</span></div>
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={user?.branch === 'all' ? 10 : 9} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center justify-center text-gray-500">
                      <Loader2 className="w-8 h-8 animate-spin text-purple-500 mb-2" />
                      <p>กำลังโหลดข้อมูล...</p>
                    </div>
                  </td>
                </tr>
              ) : filteredEmployees.length === 0 ? (
                <tr>
                  <td colSpan={user?.branch === 'all' ? 10 : 9} className="px-6 py-12 text-center">
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
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-center">
                      {emp.status !== 'ลาออก' && (
                        <button
                          onClick={() => handleResign(emp.hrCode, emp.fullName)}
                          className="px-3 py-1 bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 rounded-md text-xs font-medium transition-colors"
                        >
                          แจ้งลาออก
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
