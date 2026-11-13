/* ============================================================================
   พนักงาน: ข้อมูลส่วนตัว + ประวัติพนักงานเข้า-ออก (ดู office-server/employee-hr.js)

   ย้ายจาก Google Sheet มาเก็บที่ SQL — รายชื่อพนักงานตัวหลักคือ narai_hr.dbo.hr_employee
   (ตารางเดิม) ส่วนสองตารางนี้อยู่ที่ InventoryNarai เพราะตัวรัน migration ของ
   update-office-server.bat รันลงฐานนั้น

   dbo.hr_employee_profile   1 แถว = พนักงาน 1 คน
     ข้อมูลส่วนตัวจากฟอร์มเพิ่มพนักงาน (เดิมชีท DATA คอลัมน์ M/Q/S/BP/BQ)
     อ่าน/แก้ได้เฉพาะออฟฟิศ — สาขาเขียนได้ตอนเพิ่มพนักงานเท่านั้น อ่านกลับไม่ได้

   dbo.hr_employee_movement  1 แถว = เหตุการณ์ 1 ครั้ง (kind = in เข้า / out ลาออก)
     เดิมคือชีท "พนักงานเข้า" กับ "พนักงานออก" — เก็บสำเนาข้อมูล ณ วันที่บันทึกไว้ในแถว
     ไม่ join กลับไปหา hr_employee เพราะชื่อ/สาขาเปลี่ยนได้ภายหลัง
     source = web (บันทึกจากหน้าเว็บ) / import (นำเข้าจากชีทเดิม — นำเข้าซ้ำจะลบชุด import เดิมก่อน)

   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.hr_employee_profile', N'U') IS NULL
CREATE TABLE dbo.hr_employee_profile (
    hr_code       NVARCHAR(30)   NOT NULL,
    id_card       NVARCHAR(30)   NULL,          -- เลขประจำตัวประชาชน
    address       NVARCHAR(500)  NULL,
    birthday      DATE           NULL,
    phone         NVARCHAR(50)   NULL,
    line_id       NVARCHAR(100)  NULL,
    nationality   NVARCHAR(30)   NULL,          -- ไทย / ต่างชาติ (ตามฟอร์มเพิ่มพนักงาน)
    documents     NVARCHAR(1000) NULL,          -- เอกสารที่ยื่นตอนรับเข้า (ข้อความรวม)
    attachments   NVARCHAR(MAX)  NULL,          -- JSON [{ name, path }] ไฟล์แนบบนเครื่องออฟฟิศ หรือ { name, url } ลิงก์ Drive เดิม
    updated_by    NVARCHAR(255)  NULL,
    updated_at    DATETIME2(0)   NOT NULL
                  CONSTRAINT DF_hr_employee_profile_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_hr_employee_profile PRIMARY KEY CLUSTERED (hr_code)
);
GO

IF OBJECT_ID(N'dbo.hr_employee_movement', N'U') IS NULL
CREATE TABLE dbo.hr_employee_movement (
    movement_id   INT IDENTITY(1,1) NOT NULL,
    kind          NVARCHAR(3)    NOT NULL,      -- in / out
    hr_code       NVARCHAR(30)   NULL,
    full_name     NVARCHAR(150)  NULL,
    branch        NVARCHAR(50)   NULL,
    emp_type      NVARCHAR(30)   NULL,
    position      NVARCHAR(100)  NULL,
    nationality   NVARCHAR(30)   NULL,
    start_date    DATE           NULL,
    resign_date   DATE           NULL,
    reason        NVARCHAR(500)  NULL,
    duration_text NVARCHAR(100)  NULL,          -- อายุงาน ณ วันลาออก เช่น '1 ปี 4 เดือน'
    recorded_by   NVARCHAR(255)  NULL,
    recorded_at   DATETIME2(0)   NOT NULL
                  CONSTRAINT DF_hr_employee_movement_recorded_at DEFAULT (SYSDATETIME()),
    source        NVARCHAR(10)   NOT NULL
                  CONSTRAINT DF_hr_employee_movement_source DEFAULT (N'web'),
    CONSTRAINT PK_hr_employee_movement PRIMARY KEY CLUSTERED (movement_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_hr_employee_movement_kind_date'
                 AND object_id = OBJECT_ID(N'dbo.hr_employee_movement'))
CREATE INDEX IX_hr_employee_movement_kind_date
    ON dbo.hr_employee_movement (kind, recorded_at) INCLUDE (branch, hr_code);
GO
