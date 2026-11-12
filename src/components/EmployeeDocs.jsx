import { useState } from 'react';
import { Bell, X, Pencil, Loader2, Globe2, AlertTriangle, Clock, Check, Link2, Trash2 } from 'lucide-react';
import {
  DOC_WARN_DAYS, DOC_URGENT_DAYS, COUNTRIES,
  daysLeft, docLevel, docLevelText, formatDocDate, docIssues, isForeign, emptyDoc, normName,
} from '../utils/employeeDocs';

/* ส่วนของหน้ารายชื่อพนักงานที่เกี่ยวกับสัญชาติ + เอกสารพนักงานต่างชาติ
   (ข้อมูล: dbo.employee_doc ผ่าน office-server/employee-doc.js · ตรรกะวันหมดอายุ: utils/employeeDocs.js)
     NatBadge / DocStatusBadge  ป้ายในตาราง
     DocAlertPanel              กล่องแจ้งเตือนด้านบน (ล่วงหน้า 120 วัน)
     EmployeeDocModal           กล่องข้อมูลเมื่อกดที่ชื่อ — ดู/แก้ไข/ตั้งไทย-ต่างชาติ */

const CHIP = {
  expired: 'bg-red-100 text-red-800',
  urgent: 'bg-orange-100 text-orange-800',
  warn: 'bg-amber-100 text-amber-800',
  ok: 'bg-emerald-100 text-emerald-800',
  none: 'bg-gray-100 text-gray-500',
};
const CARD = {
  expired: 'border-t-red-600 bg-red-50/40',
  urgent: 'border-t-orange-500 bg-orange-50/40',
  warn: 'border-t-amber-400 bg-amber-50/40',
  ok: 'border-t-emerald-500 bg-white',
  none: 'border-t-gray-300 bg-gray-50/60',
};
const ALERT_ITEM = {
  expired: 'border-red-200 border-l-red-600',
  urgent: 'border-orange-200 border-l-orange-500',
  warn: 'border-amber-200 border-l-amber-400',
};

export function NatBadge({ doc }) {
  if (!isForeign(doc)) {
    return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">ไทย</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-200">
      <Globe2 className="w-3 h-3" /> ต่างชาติ{doc.country ? ` · ${doc.country}` : ''}
    </span>
  );
}

export function DocStatusBadge({ doc }) {
  if (!isForeign(doc)) return <span className="text-xs text-gray-300">—</span>;
  const issues = docIssues(doc);
  if (issues.length === 0) {
    return <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${CHIP.ok}`}><Check className="w-3 h-3" /> ปกติ</span>;
  }
  const level = docLevel(issues[0].days);
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${CHIP[level]}`}>
      {level === 'expired' ? <AlertTriangle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
      {level === 'expired' ? 'หมดอายุ' : 'ใกล้หมด'} {issues.length} รายการ
    </span>
  );
}

/**
 * กล่องแจ้งเตือนเอกสารที่หมดอายุแล้ว/เหลือไม่เกิน 120 วัน
 * @param {{ entries: { key: string, name: string, branch: string, doc: object, unlinked?: boolean }[],
 *           showBranch: boolean, onOpen: (entry) => void }} props
 */
export function DocAlertPanel({ entries, showBranch, onOpen }) {
  const [expanded, setExpanded] = useState(false);
  const items = entries
    .flatMap((en) => docIssues(en.doc).map((issue) => ({ ...issue, entry: en })))
    .sort((a, b) => a.days - b.days);
  if (items.length === 0) return null;

  const count = (fn) => items.filter((x) => fn(x.days)).length;
  const LIMIT = 9;
  const shown = expanded ? items : items.slice(0, LIMIT);

  return (
    <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-5 mx-6 mt-6 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="p-2.5 bg-white shadow-sm text-amber-600 rounded-xl flex-shrink-0">
          <Bell className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-bold text-amber-900">เอกสารพนักงานต่างชาติที่ต้องต่ออายุ {items.length} รายการ</h3>
          <p className="text-xs text-amber-800">แจ้งเตือนล่วงหน้า {DOC_WARN_DAYS} วันก่อนหมดอายุ · กดที่รายการเพื่อเปิดข้อมูลพนักงาน</p>
        </div>
        <div className="flex flex-wrap gap-2 md:ml-auto text-xs font-bold">
          <span className="px-3 py-1 rounded-full border bg-red-50 text-red-700 border-red-200">หมดอายุแล้ว {count((n) => n < 0)}</span>
          <span className="px-3 py-1 rounded-full border bg-orange-50 text-orange-700 border-orange-200">ภายใน {DOC_URGENT_DAYS} วัน {count((n) => n >= 0 && n <= DOC_URGENT_DAYS)}</span>
          <span className="px-3 py-1 rounded-full border bg-amber-50 text-amber-700 border-amber-200">ภายใน {DOC_WARN_DAYS} วัน {count((n) => n > DOC_URGENT_DAYS)}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5 mt-4">
        {shown.map((x) => (
          <button
            type="button"
            key={`${x.entry.key}-${x.key}`}
            onClick={() => onOpen(x.entry)}
            className={`text-left bg-white border border-l-4 rounded-lg px-3 py-2 hover:shadow-md transition-shadow ${ALERT_ITEM[docLevel(x.days)]}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm text-gray-800 truncate">{x.entry.name}</span>
              {showBranch && <span className="text-[11px] font-semibold text-indigo-600 uppercase shrink-0">{x.entry.branch}</span>}
              {x.entry.unlinked && <span className="text-[10px] font-semibold text-gray-500 bg-gray-100 rounded px-1.5 shrink-0">ยังไม่ผูก</span>}
            </div>
            <div className="flex items-center justify-between gap-2 mt-0.5">
              <span className="text-xs text-gray-600 truncate">{x.short} · {formatDocDate(x.date)}</span>
              <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold ${CHIP[docLevel(x.days)]}`}>{docLevelText(x.days)}</span>
            </div>
          </button>
        ))}
      </div>
      {items.length > LIMIT && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-3 text-xs font-semibold text-amber-800 hover:text-amber-950 underline underline-offset-2">
          {expanded ? 'ย่อรายการ' : `ดูทั้งหมด ${items.length} รายการ`}
        </button>
      )}
    </div>
  );
}

const INPUT = 'block w-full px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500';

/** ช่องข้อมูลหนึ่งช่อง — โหมดดูเป็นข้อความ โหมดแก้เป็น input */
function Field({ label, value, editing, onChange, type = 'text', mono = false, list }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-[13px] text-gray-500 shrink-0">{label}</span>
      {editing ? (
        <input type={type} value={value || ''} list={list} onChange={(e) => onChange(e.target.value)} className={`${INPUT} max-w-[190px]`} />
      ) : (
        <span className={`text-[13px] font-semibold text-gray-800 text-right break-all ${mono ? 'font-mono' : ''}`}>
          {type === 'date' ? formatDocDate(value) : (value || '-')}
        </span>
      )}
    </div>
  );
}

function DocCard({ title, expiryKey, form, children }) {
  const n = expiryKey ? daysLeft(form[expiryKey]) : null;
  const level = docLevel(n);
  return (
    <div className={`border border-gray-200 border-t-4 rounded-xl px-3.5 py-3 ${CARD[level]}`}>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <h4 className="text-sm font-bold text-gray-800">{title}</h4>
        <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold ${CHIP[level]}`}>{docLevelText(n)}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * กล่องข้อมูลพนักงาน — เปิดเมื่อกดที่ชื่อ
 *
 * @param {object} props
 * @param {{ hrCode: string, fullName: string, position?: string, type?: string, branch: string, status?: string }|null} props.employee
 *        พนักงานในระบบ (null = แถวจาก Excel ที่ยังไม่ผูกกับใคร)
 * @param {object|null} props.doc        แถวเอกสารที่มีอยู่ (null = ยังไม่เคยบันทึก = คนไทย)
 * @param {(form: object) => Promise<boolean>} props.onSave  คืน true เมื่อบันทึกสำเร็จ
 * @param {{ hrCode: string, fullName: string }[]} [props.linkCandidates] พนักงานที่ผูกได้ (แถวที่ยังไม่ผูก)
 * @param {(hrCode: string) => Promise<boolean>} [props.onLink]
 * @param {() => Promise<boolean>} [props.onDelete]
 */
export function EmployeeDocModal({ employee, doc, onSave, onClose, linkCandidates = [], onLink, onDelete }) {
  const [form, setForm] = useState(() => ({ ...emptyDoc('thai'), ...(doc || {}) }));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState('');
  const [linkTo, setLinkTo] = useState('');

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const foreign = form.natType !== 'thai';
  const name = employee?.fullName || form.fullName;
  // ชื่อในระบบมักมีคำนำหน้าอยู่แล้ว ('นาย WIN POR') — ไม่ต่อคำนำหน้าจากเอกสารซ้ำอีกรอบ
  const title = form.prefix && !String(name || '').trim().startsWith(form.prefix) ? `${form.prefix} ${name}` : name;
  const initial = (normName(name) || '?').slice(0, 1).toUpperCase();
  const issues = docIssues(form);
  const unlinked = !employee;

  const save = async () => {
    setBusy('save');
    const ok = await onSave(form);
    setBusy('');
    if (ok) setEditing(false);
  };
  const cancel = () => { setForm({ ...emptyDoc('thai'), ...(doc || {}) }); setEditing(false); };

  const f = (key, label, extra = {}) => (
    <Field label={label} value={form[key]} editing={editing} onChange={set(key)} {...extra} />
  );

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={editing ? undefined : onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-xl font-bold shrink-0">
            {initial}
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-gray-800 truncate">{title}</h3>
            <p className="text-sm text-gray-500">
              {employee
                ? <>รหัส HR {employee.hrCode || '-'}{employee.position ? ` · ${employee.position}` : ''} · สาขา {String(employee.branch || '').toUpperCase()}{employee.type ? ` · ${employee.type}` : ''}</>
                : <>สาขา {String(form.branch || '').toUpperCase()} · <span className="text-amber-700 font-semibold">ยังไม่ได้ผูกกับพนักงานในระบบ</span></>}
              {issues.length > 0 && (
                <span className={`ml-2 px-2 py-0.5 rounded-full text-[11px] font-semibold ${CHIP[docLevel(issues[0].days)]}`}>ต้องดำเนินการ {issues.length} รายการ</span>
              )}
            </p>
          </div>
          <button onClick={onClose} aria-label="ปิด" className="ml-auto p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5 space-y-5">
          {/* แถวจาก Excel ที่หาพนักงานด้วยชื่อไม่เจอ — ให้เลือกผูกเอง */}
          {unlinked && onLink && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex flex-wrap items-center gap-2">
              <Link2 className="w-4 h-4 text-amber-700 shrink-0" />
              <span className="text-sm text-amber-900">ชื่อนี้ไม่ตรงกับพนักงานคนไหนในระบบ เลือกพนักงานที่เป็นคนเดียวกัน:</span>
              <select value={linkTo} onChange={(e) => setLinkTo(e.target.value)} className="px-2.5 py-1.5 border border-amber-200 rounded-lg text-sm bg-white min-w-[220px]">
                <option value="">เลือกพนักงาน…</option>
                {linkCandidates.map((c) => <option key={c.hrCode} value={c.hrCode}>{c.fullName} ({c.hrCode})</option>)}
              </select>
              <button
                disabled={!linkTo || !!busy}
                onClick={async () => { setBusy('link'); await onLink(linkTo); setBusy(''); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white rounded-lg text-sm font-semibold hover:bg-amber-700 disabled:opacity-50"
              >
                {busy === 'link' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} ผูกกับพนักงาน
              </button>
              {onDelete && (
                <button
                  disabled={!!busy}
                  onClick={async () => { if (!window.confirm(`ลบข้อมูลเอกสารของ "${name}" ?`)) return; setBusy('delete'); await onDelete(); setBusy(''); }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-red-600 border border-red-200 rounded-lg text-sm font-semibold hover:bg-red-50 disabled:opacity-50 ml-auto"
                >
                  {busy === 'delete' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} ลบรายการนี้
                </button>
              )}
            </div>
          )}

          <section>
            <h4 className="text-xs font-bold text-gray-500 tracking-wide mb-2">สัญชาติ</h4>
            <div className="flex flex-wrap items-center gap-3 bg-purple-50 border border-purple-100 rounded-xl px-4 py-3">
              <div className="inline-flex bg-white border border-purple-200 rounded-lg overflow-hidden">
                {[['thai', 'คนไทย'], ['foreign', 'ต่างชาติ']].map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    disabled={!editing}
                    onClick={() => set('natType')(value)}
                    className={`px-4 py-1.5 text-sm font-semibold transition-colors ${form.natType === value ? 'bg-purple-600 text-white' : 'text-gray-500'} ${editing ? 'hover:bg-purple-100 hover:text-purple-700' : 'cursor-default'} ${form.natType === value && editing ? 'hover:!bg-purple-600 hover:!text-white' : ''}`}
                  >{label}</button>
                ))}
              </div>
              {foreign ? (
                <>
                  <span className="text-sm text-gray-500">ประเทศ</span>
                  {editing ? (
                    <>
                      <input value={form.country || ''} list="employee-doc-countries" onChange={(e) => set('country')(e.target.value)} placeholder="เช่น พม่า" className={`${INPUT} w-36`} />
                      <datalist id="employee-doc-countries">{COUNTRIES.map((c) => <option key={c} value={c} />)}</datalist>
                    </>
                  ) : <span className="text-sm font-bold text-gray-800">{form.country || 'ยังไม่ระบุ'}</span>}
                </>
              ) : (
                <span className="text-sm text-gray-500">คนไทยไม่ต้องติดตามเอกสารต่างด้าว — ระบบจะไม่แจ้งเตือน</span>
              )}
              {!editing && <span className="text-xs text-gray-400 md:ml-auto">กด "แก้ไขข้อมูล" เพื่อเปลี่ยน</span>}
            </div>
          </section>

          {foreign && (
            <>
              <section>
                <h4 className="text-xs font-bold text-gray-500 tracking-wide mb-2">ข้อมูลติดต่อ</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 bg-gray-50 border border-gray-100 rounded-xl px-4 py-3">
                  {f('phone', 'โทรศัพท์')}
                  {f('email', 'Email / Gmail')}
                  {f('ssoNo', 'เลขประกันสังคม', { mono: true })}
                  {f('bankAccount', 'เลขบัญชีธนาคาร', { mono: true })}
                </div>
              </section>

              <section>
                <h4 className="text-xs font-bold text-gray-500 tracking-wide mb-2">
                  เอกสารและวันหมดอายุ <span className="font-medium text-gray-400">— แจ้งเตือนล่วงหน้า {DOC_WARN_DAYS} วัน</span>
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  <DocCard title="หนังสือเดินทาง (Passport)" expiryKey="passportExpiry" form={form}>
                    {f('passportNo', 'เลขที่', { mono: true })}
                    {f('passportExpiry', 'หมดอายุ', { type: 'date' })}
                  </DocCard>
                  <DocCard title="วีซ่า (Visa)" expiryKey="visaExpiry" form={form}>
                    {f('mou', 'MOU')}
                    {f('visaExpiry', 'หมดอายุ', { type: 'date' })}
                  </DocCard>
                  <DocCard title="ใบอนุญาตทำงาน (Work Permit)" expiryKey="wpExpiry" form={form}>
                    {f('wpIdNo', 'เลขประจำตัว', { mono: true })}
                    {f('wpPermitNo', 'เลขที่ใบอนุญาต', { mono: true })}
                    {f('wpExpiry', 'มติแรงงาน หมดอายุ', { type: 'date' })}
                  </DocCard>
                  <DocCard title="รายงานตัว 90 วัน" expiryKey="report90Date" form={form}>
                    {f('report90Date', 'ครบกำหนด', { type: 'date' })}
                  </DocCard>
                  <DocCard title="บัตรประจำตัวคนต่างด้าว (บัตรชมพู)" expiryKey="pinkExpiry" form={form}>
                    {f('pinkNo', 'เลขที่', { mono: true })}
                    {f('pinkExpiry', 'หมดอายุ', { type: 'date' })}
                  </DocCard>
                  <DocCard title="ปกค." expiryKey="pkkExpiry" form={form}>
                    {f('pkkExpiry', 'หมดอายุ', { type: 'date' })}
                  </DocCard>
                </div>
              </section>

              <section>
                <h4 className="text-xs font-bold text-gray-500 tracking-wide mb-2">ขาดเอกสาร / หมายเหตุ</h4>
                {editing ? (
                  <textarea value={form.missingDocs || ''} onChange={(e) => set('missingDocs')(e.target.value)} rows={2} className={INPUT} placeholder="เช่น วีซ่า+พาส / ชมพู / Gmail / ธนาคาร" />
                ) : form.missingDocs ? (
                  <div className="bg-red-50 border border-dashed border-red-300 text-red-800 rounded-xl px-4 py-2.5 text-sm">{form.missingDocs}</div>
                ) : <p className="text-sm text-gray-400">-</p>}
              </section>
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-gray-100 bg-gray-50 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-gray-400">
            {doc?.updatedAt ? `แก้ไขล่าสุด ${doc.updatedAt}${doc.updatedBy ? ` โดย ${doc.updatedBy}` : ''} · ` : ''}
            แดง = หมดอายุแล้ว · ส้ม = เหลือไม่เกิน {DOC_URGENT_DAYS} วัน · เหลือง = เหลือไม่เกิน {DOC_WARN_DAYS} วัน
          </span>
          <div className="flex gap-2 ml-auto">
            {editing ? (
              <>
                <button onClick={cancel} disabled={!!busy} className="px-4 py-2 bg-white text-gray-600 border border-gray-200 rounded-xl text-sm font-semibold hover:bg-gray-100 disabled:opacity-50">ยกเลิก</button>
                <button onClick={save} disabled={!!busy} className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-xl text-sm font-semibold hover:bg-purple-700 disabled:opacity-50">
                  {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} บันทึก
                </button>
              </>
            ) : (
              <>
                <button onClick={onClose} className="px-4 py-2 bg-white text-gray-600 border border-gray-200 rounded-xl text-sm font-semibold hover:bg-gray-100">ปิด</button>
                <button onClick={() => setEditing(true)} className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-xl text-sm font-semibold hover:bg-purple-700">
                  <Pencil className="w-4 h-4" /> แก้ไขข้อมูล
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
