import { useState } from 'react';
import { apiCall } from '../services/api';
import toast from 'react-hot-toast';
import { UserPlus, Save } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export default function AddEmployee() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    hrCode: '',
    fullName: '',
    department: '',
    type: '',
    position: '',
    idCard: '',
    address: '',
    birthday: '',
    phone: '',
    lineId: '',
    loga: '',
    nationality: 'thai',
    documents: [],
    documentExpiry: {},
    startDate: ''
  });
  const [files, setFiles] = useState([]);

  const thaiDocs = ['บัตรประชาชน', 'ทะเบียนบ้าน', 'วุฒิการศึกษา', 'สมุดบัญชีธนาคาร'];
  const foreignerDocs = [
    'หนังสือเดินทาง หรือ Passport', 
    'วีซ่า (Visa) ที่ยังไม่หมดอายุ', 
    'ใบอนุญาตทำงาน (Work Permit)', 
    'บัตรสีชมพู',
    'ใบลงทะเบียนเข้าประเทศ',
    'ใบรับรองแพทย์',
    'ประกันสุขภาพหรือประกันสังคม สำหรับแรงงานต่างด้าว',
    'ใบแจ้งออกจากนายจ้างเดิม',
    'สมุดบัญชีธนาคาร'
  ];

  const getBase64 = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result);
      reader.onerror = error => reject(error);
    });
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      let fileDataArray = [];
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const base64 = await getBase64(file);
          fileDataArray.push({
            name: file.name,
            mimeType: file.type,
            base64: base64
          });
        }
      }

      const payload = {
        ...formData,
        files: fileDataArray,
        recorder: user?.username || 'Unknown',
        recorderBranch: user?.branch || 'Unknown'
      };
      const response = await apiCall('addEmployee', payload);
      if (response.status === 'success') {
        toast.success('เพิ่มพนักงานสำเร็จ');
        // Reset form
        setFormData({
          hrCode: '', fullName: '', department: '', type: '', position: '',
          idCard: '', address: '', birthday: '', phone: '', lineId: '', loga: '',
          nationality: 'thai', documents: [], documentExpiry: {}, startDate: ''
        });
        setFiles([]);
      }
    } catch (error) {
      toast.error(error.message || 'เกิดข้อผิดพลาดในการเพิ่มพนักงาน');
    } finally {
      setLoading(false);
    }
  };

  const inputClasses = "block w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-colors";
  const labelClasses = "block text-sm font-semibold text-gray-700 mb-1";

  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 md:p-8 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-purple-100 text-purple-600 rounded-xl">
              <UserPlus className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-gray-800">เพิ่มพนักงาน</h2>
              <p className="text-sm text-gray-500 mt-1">กรอกข้อมูลพนักงานเพื่อบันทึกลงในระบบ (Sheet DATA)</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 md:p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            <div className="space-y-4 md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
               <div>
                <label className={labelClasses}>รหัส HR</label>
                <input type="text" name="hrCode" value={formData.hrCode} onChange={handleChange} className={inputClasses} placeholder="HR-XXXX" required />
              </div>
              <div>
                <label className={labelClasses}>ชื่อ - สกุล</label>
                <input type="text" name="fullName" value={formData.fullName} onChange={handleChange} className={inputClasses} placeholder="นาย/นาง/นางสาว ..." required />
              </div>
            </div>

            {/* Nationality Selection */}
            <div className="md:col-span-2">
              <label className={labelClasses}>สัญชาติ</label>
              <div className="flex gap-4 mt-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="nationality" value="thai" checked={formData.nationality === 'thai'} onChange={handleChange} className="w-4 h-4 text-purple-600 focus:ring-purple-500" />
                  <span className="text-gray-700">คนไทย</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="nationality" value="foreigner" checked={formData.nationality === 'foreigner'} onChange={handleChange} className="w-4 h-4 text-purple-600 focus:ring-purple-500" />
                  <span className="text-gray-700">คนต่างชาติ</span>
                </label>
              </div>
            </div>

            {/* Document Checklist */}
            <div className="md:col-span-2 bg-gray-50 p-5 rounded-xl border border-gray-200">
              <label className={labelClasses}>เอกสารที่มี</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 mt-3">
                {(formData.nationality === 'thai' ? thaiDocs : foreignerDocs).map(doc => {
                  const isChecked = formData.documents.includes(doc);
                  return (
                    <div key={doc} className="flex flex-col gap-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input 
                          type="checkbox" 
                          checked={isChecked}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setFormData(prev => {
                              const newDocs = checked 
                                ? [...prev.documents, doc]
                                : prev.documents.filter(d => d !== doc);
                              
                              const newExpiry = { ...prev.documentExpiry };
                              if (!checked) {
                                delete newExpiry[doc];
                              }

                              return {
                                ...prev,
                                documents: newDocs,
                                documentExpiry: newExpiry
                              };
                            });
                          }}
                          className="w-4 h-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                        />
                        <span className="text-sm text-gray-700 font-medium">{doc}</span>
                      </label>
                      
                      {isChecked && (
                        <div className="ml-6 mt-1">
                          {doc === 'สมุดบัญชีธนาคาร' ? (
                            <>
                              <label className="text-xs text-gray-500 mb-1 block">เลขที่บัญชี และ ธนาคาร</label>
                              <input 
                                type="text" 
                                placeholder="เช่น 123-4-56789-0 กสิกรไทย"
                                className="block w-full px-3 py-1.5 text-sm bg-white border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                                value={formData.documentExpiry[doc] || ''}
                                onChange={(e) => {
                                  setFormData(prev => ({
                                    ...prev,
                                    documentExpiry: {
                                      ...prev.documentExpiry,
                                      [doc]: e.target.value
                                    }
                                  }));
                                }}
                              />
                            </>
                          ) : (
                            <>
                              <label className="text-xs text-gray-500 mb-1 block">วันหมดอายุ (ถ้ามี)</label>
                              <input 
                                type="date" 
                                className="block w-full px-3 py-1.5 text-sm bg-white border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                                value={formData.documentExpiry[doc] || ''}
                                onChange={(e) => {
                                  setFormData(prev => ({
                                    ...prev,
                                    documentExpiry: {
                                      ...prev.documentExpiry,
                                      [doc]: e.target.value
                                    }
                                  }));
                                }}
                              />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <label className={labelClasses}>สังกัด</label>
              <input type="text" name="department" value={formData.department} onChange={handleChange} className={inputClasses} placeholder="เช่น สาขา..." required />
            </div>

            <div>
              <label className={labelClasses}>ประเภท</label>
              <input type="text" name="type" value={formData.type} onChange={handleChange} className={inputClasses} placeholder="เช่น พนักงานประจำ, พาร์ทไทม์" required />
            </div>

            <div>
              <label className={labelClasses}>ตำแหน่ง</label>
              <input type="text" name="position" value={formData.position} onChange={handleChange} className={inputClasses} placeholder="เช่น พนักงานขาย" required />
            </div>

            <div>
              <label className={labelClasses}>เลขประจำตัวประชาชน/เลขที่ภาษี 13 หลัก</label>
              <input type="text" name="idCard" value={formData.idCard} onChange={handleChange} className={inputClasses} placeholder="X-XXXX-XXXXX-XX-X" />
            </div>

            <div className="md:col-span-2">
              <label className={labelClasses}>ที่อยู่</label>
              <textarea name="address" value={formData.address} onChange={handleChange} className={`${inputClasses} resize-none h-24`} placeholder="ที่อยู่ปัจจุบัน..."></textarea>
            </div>

            <div>
              <label className={labelClasses}>วันที่เริ่มงาน</label>
              <input type="date" name="startDate" value={formData.startDate} onChange={handleChange} className={inputClasses} required />
            </div>

            <div>
              <label className={labelClasses}>วันเกิด</label>
              <input type="date" name="birthday" value={formData.birthday} onChange={handleChange} className={inputClasses} />
            </div>

            <div>
              <label className={labelClasses}>เบอร์โทร</label>
              <input type="tel" name="phone" value={formData.phone} onChange={handleChange} className={inputClasses} placeholder="08X-XXX-XXXX" />
            </div>

            <div>
              <label className={labelClasses}>ID LINE</label>
              <input type="text" name="lineId" value={formData.lineId} onChange={handleChange} className={inputClasses} placeholder="LINE ID" />
            </div>

            <div>
              <label className={labelClasses}>LOGA</label>
              <input type="text" name="loga" value={formData.loga} onChange={handleChange} className={inputClasses} placeholder="LOGA ID / Code" />
            </div>

            {/* File Upload */}
            <div className="md:col-span-2">
              <label className={labelClasses}>แนบเอกสาร (อัพโหลดไฟล์ PDF, รูปภาพ ฯลฯ)</label>
              <input 
                type="file" 
                multiple
                onChange={(e) => {
                  const newFiles = Array.from(e.target.files);
                  setFiles(prev => [...prev, ...newFiles]);
                  e.target.value = null; // Clear input so same file can be re-selected if removed
                }}
                className="mt-2 block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-purple-50 file:text-purple-700 hover:file:bg-purple-100 transition-colors cursor-pointer"
              />
              {files.length > 0 && (
                <div className="mt-3 space-y-2">
                  <p className="text-sm font-medium text-gray-700">ไฟล์ที่เลือก ({files.length} ไฟล์):</p>
                  <ul className="space-y-2">
                    {files.map((file, index) => (
                      <li key={index} className="flex items-center justify-between bg-white px-4 py-2 border border-gray-200 rounded-xl text-sm shadow-sm">
                        <span className="text-gray-600 truncate max-w-[80%]">{file.name}</span>
                        <button 
                          type="button"
                          onClick={() => setFiles(prev => prev.filter((_, i) => i !== index))}
                          className="text-red-500 hover:text-red-700 font-medium px-2 py-1 rounded hover:bg-red-50 transition-colors"
                        >
                          ลบ
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

          </div>

          <div className="mt-10 flex justify-end">
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 py-3 px-8 border border-transparent rounded-xl shadow-md text-sm font-semibold text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              <Save className="w-5 h-5" />
              {loading ? 'กำลังบันทึก...' : 'บันทึกข้อมูลพนักงาน'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
