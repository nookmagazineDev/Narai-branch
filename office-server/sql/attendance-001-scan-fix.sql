/* ============================================================================
   หน้าสแกนเข้า-ออก: เวลาที่สาขา/แอดมินแก้ไขแทนเวลาสแกนจริง (ดู office-server/attendance.js)

   dbo.attendance_scan_fix  1 แถว = พนักงาน 1 คน x 1 วัน
     ใช้ตอนพนักงานลืมสแกน เครื่องสแกนเสีย หรือสแกนผิดรอบ — สาขากรอกเวลาที่ถูกต้องพร้อมเหตุผล
     หน้าเว็บจะใช้เวลาที่แก้แทนเวลาสแกนในช่องที่กรอกไว้ แล้วไม่แจ้งเตือนวันนั้นอีก

   ไม่แตะข้อมูลของเครื่องสแกน (ZKBio9 iclock_transaction) เลย — เวลาสแกนดิบยังดูได้ครบ
   ในแท็บ "ทุกครั้งที่สแกน" การแก้ไขจึงตรวจย้อนได้เสมอว่าเดิมสแกนจริงกี่โมง

   emp_code = รหัสที่หน้าสแกนใช้ระบุแถว (รหัสจากเครื่องสแกน หรือรหัส HR ของวันที่ไม่ได้สแกนเลย)
   เวลาเก็บเป็นข้อความ 'HH:mm' แบบเดียวกับ hr_timesheet ช่องที่ไม่ได้แก้เป็น NULL

   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.attendance_scan_fix', N'U') IS NULL
CREATE TABLE dbo.attendance_scan_fix (
    fix_id      INT IDENTITY(1,1) NOT NULL,
    branch      NVARCHAR(50)   NOT NULL,      -- รหัสสาขา (ตัวพิมพ์เล็ก)
    work_date   DATE           NOT NULL,
    emp_code    NVARCHAR(64)   NOT NULL,
    emp_name    NVARCHAR(255)  NULL,          -- ชื่อ ณ วันที่แก้
    time_in     NVARCHAR(5)    NULL,          -- เข้างาน 'HH:mm'
    break_out   NVARCHAR(5)    NULL,          -- ออกเบรค
    break_in    NVARCHAR(5)    NULL,          -- เข้าเบรค
    time_out    NVARCHAR(5)    NULL,          -- ออกงาน
    reason      NVARCHAR(100)  NOT NULL,      -- ลืมสแกน / เครื่องสแกนเสีย / ...
    note        NVARCHAR(500)  NULL,
    saved_by    NVARCHAR(255)  NULL,
    saved_at    DATETIME2(0)   NOT NULL
                CONSTRAINT DF_attendance_scan_fix_saved_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_attendance_scan_fix PRIMARY KEY CLUSTERED (fix_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_attendance_scan_fix_day'
                 AND object_id = OBJECT_ID(N'dbo.attendance_scan_fix'))
CREATE UNIQUE INDEX UX_attendance_scan_fix_day
    ON dbo.attendance_scan_fix (branch, work_date, emp_code);
GO
