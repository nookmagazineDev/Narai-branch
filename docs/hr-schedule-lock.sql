/* ============================================================================
   ล็อกตารางงานรายสาขา (ฐาน narai_hr) — ออฟฟิศตั้งจากหน้า "ดูสแกนหน้า"
   "ล็อกถึงวันที่ X" = สาขาแก้ตารางงานของวันที่ <= X ไม่ได้ (สิทธิ์ all แก้ได้)
   ดูตรรกะทั้งหมดที่ office-server/schedule-lock.js

   office-server สร้างตารางให้เองตอนตั้งล็อกครั้งแรก ถ้า login ของ service มีสิทธิ์สร้างตาราง
   ถ้าไม่มี (เช่นได้แค่ db_datareader/db_datawriter) ให้รันไฟล์นี้ใน SSMS ด้วย sa ครั้งเดียว
   รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */
USE narai_hr;
GO

IF OBJECT_ID(N'dbo.hr_schedule_lock', N'U') IS NULL
CREATE TABLE dbo.hr_schedule_lock (
    branch        NVARCHAR(50)  NOT NULL,   -- รหัสสาขา ตัวพิมพ์เล็ก
    locked_until  DATE          NOT NULL,   -- แก้ไม่ได้ตั้งแต่อดีตจนถึงวันนี้ (รวมวันนี้)
    note          NVARCHAR(255) NULL,
    locked_by     NVARCHAR(100) NULL,
    locked_at     DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_schedule_lock_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_hr_schedule_lock PRIMARY KEY (branch)
);
GO

/* ประวัติการตั้ง/ปลดล็อก (ต่อท้ายอย่างเดียว) — locked_until NULL = ปลดล็อก */
IF OBJECT_ID(N'dbo.hr_schedule_lock_log', N'U') IS NULL
CREATE TABLE dbo.hr_schedule_lock_log (
    log_id        BIGINT        IDENTITY(1,1) NOT NULL,
    logged_at     DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_schedule_lock_log_at DEFAULT (SYSDATETIME()),
    branch        NVARCHAR(50)  NOT NULL,
    locked_until  DATE          NULL,
    actor         NVARCHAR(100) NULL,
    note          NVARCHAR(255) NULL,
    CONSTRAINT PK_hr_schedule_lock_log PRIMARY KEY (log_id)
);
GO
