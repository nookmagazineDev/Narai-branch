/* ============================================================================
   ฐานข้อมูล HR (ตารางงาน) บน Microsoft SQL Server — เครื่อง 203.154.185.48
   รันไฟล์นี้ครั้งเดียวก่อนใช้งาน /api/schedule

   วิธีรัน (บนเครื่องฐานข้อมูล):
     sqlcmd -S localhost -U sa -P '<รหัสผ่าน>' -i docs\schema-hr.sql
   หรือเปิดใน SQL Server Management Studio แล้วกด Execute

   หมายเหตุการออกแบบที่ต่างจากชีทเดิม
   ---------------------------------------------------------------------------
   1) ชีทเดิมเป็น log แบบ "ต่อท้ายอย่างเดียว" — กดบันทึกซ้ำวันเดิมก็ได้แถวใหม่
      แล้วตอนอ่านค่อยหยิบแถวล่าสุดต่อ (วันที่+พนักงาน) มาใช้ ทำให้ชีทบวมและอ่านช้าขึ้นเรื่อยๆ
      ตารางนี้เก็บ "หนึ่งแถวต่อพนักงานต่อวัน" (PK = work_date + branch + hr_code)
      บันทึกซ้ำ = UPDATE ทับ, ล้างข้อมูล = DELETE จริง
      ส่วนประวัติว่าใครแก้อะไรเมื่อไหร่ ย้ายไปเก็บที่ hr_timesheet_log แทน
   2) เวลาเข้า/ออก เก็บเป็นข้อความ 'HH:mm' ไม่ใช่ชนิด TIME
      เพราะระบบเดิมใช้ค่า '24:00' ได้ (กะที่จบเที่ยงคืนพอดี) ซึ่ง TIME เก็บไม่ได้
   3) ทุกคอลัมน์ข้อความใช้ NVARCHAR เพราะข้อมูลเป็นภาษาไทย
============================================================================ */

/* ---- สร้างฐานข้อมูล (ข้ามได้ถ้าสร้างไว้แล้ว) ---- */
IF DB_ID(N'narai_hr') IS NULL
    CREATE DATABASE narai_hr;
GO

USE narai_hr;
GO

/* ============================ สาขา + เป้าขาย ============================ */
IF OBJECT_ID(N'dbo.hr_branch', N'U') IS NULL
CREATE TABLE dbo.hr_branch (
    branch          NVARCHAR(50)   NOT NULL,   -- รหัสสาขาที่เว็บใช้ (ตรงกับ user.branch)
    branch_name     NVARCHAR(150)  NULL,       -- ชื่อเต็มไว้แสดงผล
    outlet_id       INT            NULL,       -- รหัสสาขาฝั่ง POS (ถ้ามี)
    daily_target    DECIMAL(14,2)  NOT NULL CONSTRAINT DF_hr_branch_daily_target DEFAULT (0),
    monthly_target  DECIMAL(14,2)  NOT NULL CONSTRAINT DF_hr_branch_monthly_target DEFAULT (0),
    max_wage        DECIMAL(14,2)  NOT NULL CONSTRAINT DF_hr_branch_max_wage DEFAULT (0),
    is_active       BIT            NOT NULL CONSTRAINT DF_hr_branch_is_active DEFAULT (1),
    updated_at      DATETIME2(0)   NOT NULL CONSTRAINT DF_hr_branch_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_hr_branch PRIMARY KEY (branch)
);
GO

/* ========================= ผู้ใช้เว็บ (หน้าล็อกอิน) ========================= */
/* ย้ายมาจากชีท User — คอลัมน์ A/B/C/D เดิมคือ username / password / สาขา / outlet id
   ต่างจากชีทหนึ่งอย่างที่สำคัญ: ไม่เก็บรหัสผ่านเป็นข้อความล้วนอีกแล้ว
   คอลัมน์ password_hash เก็บค่าที่ย้อนกลับไม่ได้ (scrypt — ดู office-server/hr-password.js)
   ข้อมูลตารางนี้หลุดออกไปก็เอาไปล็อกอินไม่ได้ ต่างจากชีทที่ใครเปิดได้ก็อ่านรหัสได้ทุกสาขา

   ไม่ต้องกรอกเองทีละคน: ครั้งแรกที่ใครล็อกอินแล้วยังไม่มีชื่อในตารางนี้
   ระบบจะไปถามชีทให้ตามเดิม แล้วคัดลอกเข้ามาพร้อมเข้ารหัสรหัสผ่านให้เอง
   (ดูหัวข้อ "การล็อกอิน" ใน docs/hr-sql-migration.md)

   branch = 'all' คือผู้ใช้ที่เห็นได้ทุกสาขา ใช้กติกาเดียวกับ hr-session.js */
IF OBJECT_ID(N'dbo.hr_user', N'U') IS NULL
CREATE TABLE dbo.hr_user (
    username      NVARCHAR(100) NOT NULL,       -- ชื่อผู้ใช้ที่กรอกหน้าล็อกอิน (ชีทคอลัมน์ A)
    password_hash NVARCHAR(255) NOT NULL,       -- scrypt$... — ห้ามเก็บรหัสจริง
    branch        NVARCHAR(50)  NOT NULL,       -- รหัสสาขา หรือ 'all' (ชีทคอลัมน์ C)
    outlet_id     NVARCHAR(50)  NULL,           -- รหัสสาขาฝั่ง POS (ชีทคอลัมน์ D)
    display_name  NVARCHAR(150) NULL,           -- ชื่อที่แสดง (ชีทเดิมไม่มี ปล่อยว่างได้)
    is_active     BIT           NOT NULL CONSTRAINT DF_hr_user_is_active DEFAULT (1),
    last_login_at DATETIME2(0)  NULL,
    created_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_user_created_at DEFAULT (SYSDATETIME()),
    updated_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_user_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_hr_user PRIMARY KEY (username)
);
GO

/* ============================== พนักงาน ================================ */
IF OBJECT_ID(N'dbo.hr_employee', N'U') IS NULL
CREATE TABLE dbo.hr_employee (
    hr_code     NVARCHAR(30)  NOT NULL,        -- รหัสพนักงาน (คีย์หลักที่เว็บใช้อ้างอิง)
    full_name   NVARCHAR(150) NOT NULL,
    branch      NVARCHAR(50)  NOT NULL,
    emp_type    NVARCHAR(20)  NULL,            -- F/T, DAY, DAY9, P/T
    position    NVARCHAR(100) NULL,
    daily_wage  DECIMAL(12,2) NOT NULL CONSTRAINT DF_hr_employee_daily_wage DEFAULT (0),
    status      NVARCHAR(20)  NOT NULL CONSTRAINT DF_hr_employee_status DEFAULT (N'ทำงาน'), -- ทำงาน / ลาออก
    resign_date DATE          NULL,
    updated_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_employee_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_hr_employee PRIMARY KEY (hr_code)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_hr_employee_branch' AND object_id = OBJECT_ID(N'dbo.hr_employee'))
    CREATE INDEX IX_hr_employee_branch ON dbo.hr_employee (branch, status) INCLUDE (full_name, position, emp_type, daily_wage);
GO

/* ====================== ตารางงาน (หนึ่งแถวต่อคนต่อวัน) ====================== */
IF OBJECT_ID(N'dbo.hr_timesheet', N'U') IS NULL
CREATE TABLE dbo.hr_timesheet (
    work_date             DATE          NOT NULL,
    branch                NVARCHAR(50)  NOT NULL,
    hr_code               NVARCHAR(30)  NOT NULL,

    /* คัดลอกไว้ ณ วันที่ลง เพื่อให้ประวัติย้อนหลังไม่เพี้ยนเมื่อพนักงานย้ายสาขา/ปรับค่าแรง */
    emp_name              NVARCHAR(150) NULL,
    position              NVARCHAR(100) NULL,
    emp_type              NVARCHAR(20)  NULL,

    check_in              VARCHAR(5)    NULL,   -- 'HH:mm' (รองรับ '24:00')
    check_out             VARCHAR(5)    NULL,
    break_time            NVARCHAR(20)  NULL,   -- 'ไม่เบรค' หรือ '1 ชม.'
    break_range           VARCHAR(20)   NULL,   -- 'HH:mm-HH:mm'

    ot_hours              DECIMAL(5,2)  NOT NULL CONSTRAINT DF_hr_ts_ot DEFAULT (0),
    ot_accumulated        DECIMAL(5,2)  NOT NULL CONSTRAINT DF_hr_ts_ot_acc DEFAULT (0),
    use_accumulated_hours DECIMAL(5,2)  NOT NULL CONSTRAINT DF_hr_ts_use_acc DEFAULT (0),
    hourly_leave          DECIMAL(5,2)  NOT NULL CONSTRAINT DF_hr_ts_hourly_leave DEFAULT (0),

    wage                  DECIMAL(12,2) NOT NULL CONSTRAINT DF_hr_ts_wage DEFAULT (0),
    status                NVARCHAR(20)  NOT NULL CONSTRAINT DF_hr_ts_status DEFAULT (N'มาทำงาน'), -- มาทำงาน / หยุด
    leave_note            NVARCHAR(100) NULL,   -- ลา (รับค่าแรง)
    unpaid_leave          NVARCHAR(100) NULL,   -- หยุด (ไม่รับค่าแรง)
    other_note            NVARCHAR(255) NULL,
    work_station          NVARCHAR(100) NULL,   -- จุดปฏิบัติงาน
    ot_approver           NVARCHAR(100) NULL,   -- ว่าง = ยังไม่อนุมัติ

    created_at            DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_ts_created_at DEFAULT (SYSDATETIME()),
    updated_at            DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_ts_updated_at DEFAULT (SYSDATETIME()),
    updated_by            NVARCHAR(100) NULL,

    CONSTRAINT PK_hr_timesheet PRIMARY KEY (work_date, branch, hr_code)
);
GO

/* หน้าลงตารางอ่านเป็นช่วงสัปดาห์ของสาขาเดียว — index นี้คือเส้นทางหลัก */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_hr_timesheet_branch_date' AND object_id = OBJECT_ID(N'dbo.hr_timesheet'))
    CREATE INDEX IX_hr_timesheet_branch_date ON dbo.hr_timesheet (branch, work_date);
GO

/* หน้ารายงานรายคน (ดูย้อนหลังของพนักงานคนเดียว) */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_hr_timesheet_emp_date' AND object_id = OBJECT_ID(N'dbo.hr_timesheet'))
    CREATE INDEX IX_hr_timesheet_emp_date ON dbo.hr_timesheet (hr_code, work_date);
GO

/* ==================== ประวัติการแก้ไข (ต่อท้ายอย่างเดียว) ==================== */
/* แทนที่พฤติกรรม "ทุกครั้งที่กดบันทึกได้แถวใหม่" ของชีทเดิม โดยไม่ทำให้ตารางหลักบวม */
IF OBJECT_ID(N'dbo.hr_timesheet_log', N'U') IS NULL
CREATE TABLE dbo.hr_timesheet_log (
    log_id     BIGINT         IDENTITY(1,1) NOT NULL,
    logged_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_hr_ts_log_at DEFAULT (SYSDATETIME()),
    action     VARCHAR(10)    NOT NULL,        -- save / clear / ot
    work_date  DATE           NOT NULL,
    branch     NVARCHAR(50)   NOT NULL,
    hr_code    NVARCHAR(30)   NOT NULL,
    actor      NVARCHAR(100)  NULL,            -- ผู้ใช้ที่กดบันทึก
    payload    NVARCHAR(MAX)  NULL,            -- ค่าที่บันทึก (JSON) ไว้ตรวจย้อนหลัง
    CONSTRAINT PK_hr_timesheet_log PRIMARY KEY (log_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_hr_timesheet_log_key' AND object_id = OBJECT_ID(N'dbo.hr_timesheet_log'))
    CREATE INDEX IX_hr_timesheet_log_key ON dbo.hr_timesheet_log (work_date, branch, hr_code);
GO

/* ============================ ยอดขายรายวัน ============================= */
IF OBJECT_ID(N'dbo.hr_daily_sales', N'U') IS NULL
CREATE TABLE dbo.hr_daily_sales (
    sale_date  DATE          NOT NULL,
    branch     NVARCHAR(50)  NOT NULL,
    sales      DECIMAL(14,2) NOT NULL CONSTRAINT DF_hr_daily_sales_sales DEFAULT (0),
    updated_at DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_daily_sales_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_hr_daily_sales PRIMARY KEY (sale_date, branch)
);
GO

/* ==========================================================================
   สิทธิ์: แนะนำให้สร้าง login แยกสำหรับเว็บ ไม่ใช้ sa
   (รันบน master ก่อน แล้วค่อยกลับมาที่ narai_hr)

     USE master;
     CREATE LOGIN narai_web WITH PASSWORD = N'<ตั้งรหัสผ่านที่คาดเดายาก>';
     USE narai_hr;
     CREATE USER narai_web FOR LOGIN narai_web;
     ALTER ROLE db_datareader ADD MEMBER narai_web;
     ALTER ROLE db_datawriter ADD MEMBER narai_web;

   แล้วตั้ง HR_DB_USER=narai_web, HR_DB_PASSWORD=... บน Vercel
========================================================================== */
