import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { Loader2, ChevronLeft, ChevronRight, Save, Clock } from 'lucide-react';
import toast from 'react-hot-toast';

export default function ScheduleWeekly() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState([]);
  const [weekStartDate, setWeekStartDate] = useState(getStartOfWeek(new Date()));
  const [scheduleData, setScheduleData] = useState({});
  const [isSaving, setIsSaving] = useState(false);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeCell, setActiveCell] = useState(null); // { hrCode, date, name, position }
  const [cellData, setCellData] = useState({
    checkIn: '',
    checkOut: '',
    breakTime: '1',
    status: 'มาทำงาน',
    note: ''
  });

  // Utility to get Monday of current week
  function getStartOfWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
  }

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await apiCall('getScheduleEmployees', { branch: user?.branch });
      if (res.status === 'success') {
        setEmployees(res.data);
      } else {
        toast.error('ไม่สามารถดึงข้อมูลพนักงานได้');
      }
      
      // TODO: Load existing schedule data for this week from backend
      // For now, we start with empty scheduleData or fetch from a new endpoint later
    } catch (err) {
      toast.error('เกิดข้อผิดพลาดในการดึงข้อมูล');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [user?.branch]);

  const changeWeek = (offset) => {
    const newDate = new Date(weekStartDate);
    newDate.setDate(newDate.getDate() + (offset * 7));
    setWeekStartDate(newDate);
  };

  const getDaysOfWeek = () => {
    const days = [];
    const dayNames = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสฯ', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStartDate);
      d.setDate(d.getDate() + i);
      days.push({
        date: d,
        dateStr: d.toISOString().split('T')[0],
        dayName: dayNames[i],
        shortDate: `${d.getDate()}/${d.getMonth() + 1}`
      });
    }
    return days;
  };

  const daysOfWeek = getDaysOfWeek();

  const handleCellClick = (emp, dateStr) => {
    const key = `${emp.hrCode}_${dateStr}`;
    const existingData = scheduleData[key] || {
      checkIn: '', checkOut: '', breakTime: '1', status: 'มาทำงาน', note: ''
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

  const handleSaveSchedule = async () => {
    if (Object.keys(scheduleData).length === 0) {
      toast.error('ยังไม่มีข้อมูลให้บันทึก');
      return;
    }

    setIsSaving(true);
    try {
      const logs = [];
      Object.entries(scheduleData).forEach(([key, data]) => {
        const [hrCode, dateStr] = key.split('_');
        const emp = employees.find(e => e.hrCode === hrCode);
        if (emp && (data.checkIn || data.status !== 'มาทำงาน')) {
          logs.push({
            workDate: dateStr,
            branch: emp.branch,
            hrCode: emp.hrCode,
            name: emp.name,
            position: emp.position,
            checkIn: data.checkIn,
            checkOut: data.checkOut,
            breakTime: data.breakTime,
            ot: '0', // simplified
            wage: '0', // simplified
            status: data.status,
            empType: emp.type || '',
            note: data.note
          });
        }
      });

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
            <p className="text-sm text-gray-500 mt-1">สาขา: <span className="font-semibold text-purple-600">{user?.branch}</span></p>
          </div>

          <div className="flex items-center gap-4">
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
              disabled={isSaving}
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
                      <div className="font-medium text-gray-900">{emp.name}</div>
                      <div className="text-xs text-gray-500">{emp.position}</div>
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
                            cell.status === 'หยุด' ? 'bg-red-50 text-red-600 border-red-100' :
                            'bg-green-50 text-green-700 border-green-100'
                          }`}>
                            {!cell ? (
                              <span>-</span>
                            ) : cell.status === 'หยุด' ? (
                              <span className="font-medium">หยุด</span>
                            ) : (
                              <>
                                <span className="font-bold">{cell.checkIn || '?'} - {cell.checkOut || '?'}</span>
                                {cell.note && <span className="text-[10px] text-gray-500 truncate w-full text-center">{cell.note}</span>}
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
            
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">สถานะ</label>
                <select 
                  className="w-full border border-gray-300 rounded-lg p-2 focus:ring-purple-500 focus:border-purple-500"
                  value={cellData.status}
                  onChange={(e) => setCellData({...cellData, status: e.target.value})}
                >
                  <option value="มาทำงาน">มาทำงาน</option>
                  <option value="หยุด">หยุด / ลา</option>
                </select>
              </div>

              {cellData.status === 'มาทำงาน' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">เวลาเข้า</label>
                    <input 
                      type="time" 
                      className="w-full border border-gray-300 rounded-lg p-2 focus:ring-purple-500 focus:border-purple-500"
                      value={cellData.checkIn}
                      onChange={(e) => setCellData({...cellData, checkIn: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">เวลาออก</label>
                    <input 
                      type="time" 
                      className="w-full border border-gray-300 rounded-lg p-2 focus:ring-purple-500 focus:border-purple-500"
                      value={cellData.checkOut}
                      onChange={(e) => setCellData({...cellData, checkOut: e.target.value})}
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">หมายเหตุ / ลา</label>
                <input 
                  type="text" 
                  placeholder="เช่น ป่วย, ลากิจ..."
                  className="w-full border border-gray-300 rounded-lg p-2 focus:ring-purple-500 focus:border-purple-500"
                  value={cellData.note}
                  onChange={(e) => setCellData({...cellData, note: e.target.value})}
                />
              </div>
            </div>

            <div className="p-4 border-t border-gray-100 bg-gray-50 flex justify-end gap-2">
              <button 
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 text-gray-600 hover:bg-gray-200 rounded-lg transition-colors font-medium"
              >
                ยกเลิก
              </button>
              <button 
                onClick={saveCellData}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium"
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
