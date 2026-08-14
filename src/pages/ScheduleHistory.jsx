import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall, errMessage } from '../services/api';
import { Loader2, Search, CheckCircle, ChevronLeft, ChevronRight, Calendar, Users, DollarSign, TrendingUp } from 'lucide-react';
import toast from 'react-hot-toast';

// แถวหนึ่งของประวัติ = พนักงานหนึ่งคน ยึด hrCode เป็นหลัก
// เดิมใช้ "ชื่อ" เป็นคีย์ พนักงานชื่อซ้ำกันจะติ๊กอนุมัติ OT พร้อมกันทั้งคู่
const rowKey = (item) => String(item.hrCode || item.name || '');

export default function ScheduleHistory() {
  const { user } = useAuth();
  const isAll = user?.branch?.toLowerCase() === 'all';
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  
  const [historyDate, setHistoryDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState(user?.branch || '');
  
  const [historyData, setHistoryData] = useState([]);
  const [dailySales, setDailySales] = useState(0);
  
  // Track changes to OT approvals
  // Record hrCode to boolean
  const [otApprovals, setOtApprovals] = useState({});

  // โหลดรายชื่อสาขาเฉพาะ user สิทธิ์ all — สาขาอื่นถูกล็อกไว้ที่สาขาตัวเอง
  // เดิมทุกคนเลือกสาขาไหนก็ได้ = เปิดดูค่าแรง/OT ของสาขาอื่นได้
  useEffect(() => {
    if (!isAll) {
      setSelectedBranch(user?.branch || '');
      return;
    }
    // ใช้ getBranches ให้ตรงกับหน้าอื่นทั้งระบบ (เดิมหน้านี้เรียก getBranchList อยู่หน้าเดียว)
    apiCall('getBranches', {})
      .then(res => {
        const list = (res.data || [])
          .map(b => (typeof b === 'string' ? b : String(b?.name || '')).trim())
          .filter(Boolean);
        setBranches([...new Set(list)].sort());
      })
      // เดิมไม่มี catch — apiCall throw แล้วกลายเป็น unhandled rejection ดรอปดาวน์ว่างโดยไม่มีอะไรแจ้ง
      .catch(err => toast.error(errMessage(err, 'โหลดรายชื่อสาขาไม่สำเร็จ')));
  }, [isAll, user?.branch]);

  const adjustDate = (days) => {
    const d = new Date(historyDate);
    d.setDate(d.getDate() + days);
    setHistoryDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  };

  const setToday = () => {
    const d = new Date();
    setHistoryDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  };

  const searchHistory = async () => {
    if (!historyDate || !selectedBranch) {
      toast.error('กรุณาเลือกวันที่และสาขา');
      return;
    }
    
    setLoading(true);
    // ยอดขายเป็นข้อมูลเสริม ถ้าล้มต้องไม่ทำให้ประวัติทั้งหน้าหาย จึงแยกผลลัพธ์กัน
    const [histResult, salesResult] = await Promise.allSettled([
      apiCall('getHistoryData', { searchDate: historyDate, branch: selectedBranch }),
      apiCall('getDailySales', { searchDateStr: historyDate, searchBranch: selectedBranch })
    ]);

    setDailySales(salesResult.status === 'fulfilled' ? (salesResult.value.data?.sales || 0) : 0);

    if (histResult.status === 'fulfilled') {
      // Filter out records that are completely empty / 'ล้างข้อมูล'
      const validData = (histResult.value.data || []).filter(r => r.otherNote !== 'ล้างข้อมูล');

      // ติ๊กไว้ล่วงหน้าถ้ามีชื่อผู้อนุมัติอยู่แล้ว
      const initialApprovals = {};
      validData.forEach(item => { initialApprovals[rowKey(item)] = !!item.otApprover; });

      setHistoryData(validData);
      setOtApprovals(initialApprovals);
    } else {
      // แสดงสาเหตุจริงจากเซิร์ฟเวอร์ ไม่ใช่ 'การเชื่อมต่อขัดข้อง' รวมๆ ที่กลบต้นเหตุ
      toast.error(errMessage(histResult.reason, 'เกิดข้อผิดพลาดในการดึงประวัติ'));
      setHistoryData([]);
    }
    setLoading(false);
  };

  const saveOTApproval = async () => {
    if (historyData.length === 0) return;
    
    // Check if there are any OT records to approve
    const hasOT = historyData.some(item => parseFloat(item.ot) > 0);
    if (!hasOT) {
      toast.error('ไม่มีรายการ OT ให้บันทึกในวันนี้');
      return;
    }

    setSaving(true);
    try {
      const updates = historyData
        .filter(item => parseFloat(item.ot) > 0)
        .map(item => ({
          hrCode: item.hrCode || '',
          name: item.name,
          isApproved: !!otApprovals[rowKey(item)]
        }));

      // ชื่อผู้อนุมัติมาจาก user ที่ล็อกอินไว้ (apiCall แนบไปให้) ไม่ได้ส่งจากหน้าเว็บแล้ว
      await apiCall('updateOTApprovalBulk', {
        dateStr: historyDate,
        branch: selectedBranch,
        updates: updates
      });

      toast.success('บันทึกการอนุมัติ OT เรียบร้อย');
      searchHistory(); // Refresh
    } catch (err) {
      toast.error(errMessage(err, 'บันทึกการอนุมัติ OT ไม่สำเร็จ'));
    } finally {
      setSaving(false);
    }
  };

  const toggleApproval = (key) => {
    setOtApprovals(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  // Summary Calcs
  const totalEmployees = historyData.length;
  const totalWage = historyData.reduce((sum, item) => sum + (parseFloat(item.wage) || 0), 0);

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
      
      {/* Control Panel */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 md:p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">เลือกวันที่ต้องการดู:</label>
            <input 
              type="date" 
              className="w-full border border-gray-300 rounded-lg p-2.5 text-sm mb-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              value={historyDate}
              onChange={(e) => setHistoryDate(e.target.value)}
            />
            <div className="flex gap-2">
              <button 
                onClick={() => adjustDate(-1)}
                className="flex-1 flex justify-center items-center gap-1 py-1.5 px-3 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <ChevronLeft className="w-4 h-4"/> ย้อนกลับ
              </button>
              <button 
                onClick={setToday}
                className="flex-1 flex justify-center items-center gap-1 py-1.5 px-3 border border-blue-200 bg-blue-50 rounded-lg text-sm text-blue-700 font-medium hover:bg-blue-100 transition-colors"
              >
                <Calendar className="w-4 h-4"/> วันนี้
              </button>
              <button 
                onClick={() => adjustDate(1)}
                className="flex-1 flex justify-center items-center gap-1 py-1.5 px-3 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                ถัดไป <ChevronRight className="w-4 h-4"/>
              </button>
            </div>
          </div>
          
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2">เลือกสาขา:</label>
            {isAll ? (
              <select
                className="w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                value={selectedBranch}
                onChange={(e) => setSelectedBranch(e.target.value)}
              >
                <option value="">-- เลือกสาขา --</option>
                {branches.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            ) : (
              <div className="w-full border border-gray-200 bg-gray-50 rounded-lg p-2.5 text-sm text-gray-700 font-medium">
                {user?.branch || '-'}
              </div>
            )}
          </div>
          
          <div className="flex flex-col gap-3 justify-end">
            <button 
              onClick={searchHistory}
              disabled={loading}
              className="w-full flex justify-center items-center gap-2 bg-blue-600 text-white p-2.5 rounded-lg font-bold hover:bg-blue-700 transition-colors shadow-sm disabled:bg-blue-400"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin"/> : <Search className="w-5 h-5"/>}
              ค้นหาข้อมูล
            </button>
            <button 
              onClick={saveOTApproval}
              disabled={saving || historyData.length === 0}
              className="w-full flex justify-center items-center gap-2 bg-green-600 text-white p-2.5 rounded-lg font-bold hover:bg-green-700 transition-colors shadow-sm disabled:bg-green-400 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-5 h-5 animate-spin"/> : <CheckCircle className="w-5 h-5"/>}
              บันทึกอนุมัติ OT
            </button>
          </div>
        </div>
      </div>

      {/* Summary Panel */}
      {historyData.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-700 flex items-center gap-4">
            <div className="p-3 bg-gray-700 rounded-lg text-white">
              <Users className="w-6 h-6"/>
            </div>
            <div>
              <h5 className="text-gray-300 text-sm font-medium m-0">จำนวนพนักงาน</h5>
              <div className="text-white text-2xl font-bold">{totalEmployees} <span className="text-sm font-normal text-gray-400">คน</span></div>
            </div>
          </div>
          <div className="bg-blue-600 p-4 rounded-xl shadow-sm border border-blue-700 flex items-center gap-4">
            <div className="p-3 bg-blue-500 rounded-lg text-white">
              <DollarSign className="w-6 h-6"/>
            </div>
            <div>
              <h5 className="text-blue-100 text-sm font-medium m-0">รวมค่าแรง</h5>
              <div className="text-white text-2xl font-bold">{totalWage.toLocaleString()} <span className="text-sm font-normal text-blue-200">บาท</span></div>
            </div>
          </div>
          <div className="bg-yellow-100 p-4 rounded-xl shadow-sm border border-yellow-200 flex items-center gap-4">
            <div className="p-3 bg-yellow-200 rounded-lg text-yellow-800">
              <TrendingUp className="w-6 h-6"/>
            </div>
            <div>
              <h5 className="text-yellow-800 text-sm font-medium m-0">ยอดขายของวัน</h5>
              <div className="text-yellow-900 text-2xl font-bold">{parseFloat(dailySales || 0).toLocaleString()} <span className="text-sm font-normal text-yellow-700">บาท</span></div>
            </div>
          </div>
        </div>
      )}

      {/* Data Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-blue-50 text-blue-900 text-xs uppercase border-b border-gray-200">
              <tr>
                <th className="px-3 py-3 text-center w-12">#</th>
                <th className="px-4 py-3 min-w-[150px]">ชื่อ-สกุล</th>
                <th className="px-3 py-3 text-center">ตำแหน่ง</th>
                <th className="px-3 py-3 text-center">ประเภท</th>
                <th className="px-3 py-3 text-center">สถานะ</th>
                <th className="px-3 py-3 text-center">เข้า</th>
                <th className="px-3 py-3 text-center">ออก</th>
                <th className="px-3 py-3 text-center">OT (ชม.)</th>
                <th className="px-3 py-3 text-center">ชั่วโมงสะสม</th>
                <th className="px-3 py-3 text-center bg-green-100 text-green-800">อนุมัติ OT</th>
                <th className="px-3 py-3 text-right">ค่าแรง</th>
                <th className="px-3 py-3 text-center text-blue-700">ลา(จ่าย)</th>
                <th className="px-3 py-3 text-center text-red-600">หยุด(ไม่จ่าย)</th>
                <th className="px-3 py-3 text-center">ใช้สะสม</th>
                <th className="px-3 py-3 text-center">ลาชม.</th>
                <th className="px-3 py-3 text-center">ช่วงเบรค</th>
                <th className="px-4 py-3 min-w-[150px]">หมายเหตุ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {historyData.length === 0 ? (
                <tr>
                  <td colSpan="17" className="px-6 py-12 text-center text-gray-500 bg-gray-50">
                    {loading ? (
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                        <span>กำลังดึงข้อมูล...</span>
                      </div>
                    ) : 'กรุณาเลือกวันที่และสาขาเพื่อค้นหาประวัติ'}
                  </td>
                </tr>
              ) : (
                historyData.map((item, index) => {
                  const hasOT = parseFloat(item.ot) > 0;
                  const key = rowKey(item);
                  const isApproved = otApprovals[key] || false;

                  return (
                    <tr key={key || index} className="hover:bg-gray-50 transition-colors">
                      <td className="px-3 py-2 text-center text-gray-500">{index + 1}</td>
                      <td className="px-4 py-2 font-medium text-gray-900">{item.name}</td>
                      <td className="px-3 py-2 text-center text-gray-600">{item.position}</td>
                      <td className="px-3 py-2 text-center text-gray-600">{item.empType}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${item.status === 'มาทำงาน' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {item.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center font-medium">{item.checkIn || '-'}</td>
                      <td className="px-3 py-2 text-center font-medium">{item.checkOut || '-'}</td>
                      <td className="px-3 py-2 text-center">
                        {hasOT ? <span className="font-bold text-orange-600">{item.ot}</span> : '-'}
                      </td>
                      <td className="px-3 py-2 text-center text-indigo-600 font-medium">{item.otAccumulated > 0 ? `+${item.otAccumulated}` : '-'}</td>
                      
                      {/* OT Approval Column */}
                      <td className={`px-3 py-2 text-center ${hasOT ? 'bg-green-50 border-l border-r border-green-100' : ''}`}>
                        {hasOT && (
                          <input 
                            type="checkbox"
                            checked={isApproved}
                            onChange={() => toggleApproval(key)}
                            className={`w-5 h-5 rounded cursor-pointer transition-all ${
                              isApproved 
                                ? 'text-green-600 focus:ring-green-500' 
                                : 'text-red-500 bg-red-100 border-red-300 focus:ring-red-500'
                            }`}
                          />
                        )}
                      </td>
                      
                      <td className="px-3 py-2 text-right font-bold text-blue-700">{parseFloat(item.wage || 0).toLocaleString()}</td>
                      <td className="px-3 py-2 text-center text-blue-600 text-xs">{item.leaveNote || '-'}</td>
                      <td className="px-3 py-2 text-center text-red-500 text-xs">{item.unpaidLeave || '-'}</td>
                      <td className="px-3 py-2 text-center text-gray-600 text-xs">{item.useAccumulatedHours > 0 ? `${item.useAccumulatedHours} ชม.` : '-'}</td>
                      <td className="px-3 py-2 text-center text-gray-600 text-xs">{item.hourlyLeave > 0 ? `${item.hourlyLeave} ชม.` : '-'}</td>
                      <td className="px-3 py-2 text-center text-gray-500 text-xs">{item.breakTimeRange || '-'}</td>
                      <td className="px-4 py-2 text-gray-600 text-xs">{item.otherNote || '-'}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      
    </div>
  );
}
