/* ============================================================================
   ฐานข้อมูล HR (ตารางงาน) บน MySQL — เครื่องเดียวกับ inventory.dyndns.tv
   รันไฟล์นี้ครั้งเดียวก่อนใช้งาน /api/schedule

   วิธีรัน (บนเครื่องฐานข้อมูล):
     mysql -u root -p < docs\schema-hr-mysql.sql

   ไฟล์นี้คือฉบับ MySQL ของ docs/schema-hr.sql (ของเดิมเป็น MS SQL Server)
   scripts/mssql-to-mysql.mjs ฝัง DDL ชุดเดียวกันนี้ไว้ข้างในด้วย เพื่อให้รันจาก
   เครื่องที่มีแค่ไฟล์ .mjs ไฟล์เดียวได้ — แก้ที่ไหนต้องแก้ให้ตรงกันทั้งสองที่

   หมายเหตุการออกแบบ (เหมือนฉบับ SQL Server ทุกข้อ)
   ---------------------------------------------------------------------------
   1) เก็บ "หนึ่งแถวต่อพนักงานต่อวัน" (PK = work_date + branch + hr_code)
      บันทึกซ้ำ = เขียนทับ, ล้างข้อมูล = DELETE จริง
      ประวัติว่าใครแก้อะไรเมื่อไหร่อยู่ที่ hr_timesheet_log แยกต่างหาก
   2) เวลาเข้า/ออกเก็บเป็นข้อความ 'HH:mm' ไม่ใช่ชนิด TIME
      เพราะระบบเดิมใช้ค่า '24:00' ได้ (กะที่จบเที่ยงคืนพอดี) ซึ่ง TIME เก็บไม่ได้
   3) ทุกตารางใช้ utf8mb4 เพราะข้อมูลเป็นภาษาไทย (utf8 ตัวเก่าของ MySQL เก็บได้ไม่ครบ)

   ต่างจากฉบับ SQL Server 3 จุด
   ---------------------------------------------------------------------------
   - NVARCHAR -> VARCHAR (ชุดอักขระเป็น utf8mb4 อยู่แล้ว จึงเก็บไทยได้ทุกคอลัมน์)
   - BIT -> TINYINT(1), DATETIME2(0) -> DATETIME, IDENTITY -> AUTO_INCREMENT
   - MySQL ไม่มี CREATE INDEX IF NOT EXISTS จึงประกาศ index ไว้ใน CREATE TABLE เลย
     (ทั้งไฟล์รันซ้ำได้ เพราะทุกคำสั่งเป็น IF NOT EXISTS)
============================================================================ */

CREATE DATABASE IF NOT EXISTS narai_hr
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE narai_hr;

/* ============================ สาขา + เป้าขาย ============================ */
CREATE TABLE IF NOT EXISTS hr_branch (
    branch          VARCHAR(50)    NOT NULL COMMENT 'รหัสสาขาที่เว็บใช้ (ตรงกับ user.branch)',
    branch_name     VARCHAR(150)   NULL     COMMENT 'ชื่อเต็มไว้แสดงผล',
    outlet_id       INT            NULL     COMMENT 'รหัสสาขาฝั่ง POS (ถ้ามี)',
    daily_target    DECIMAL(14,2)  NOT NULL DEFAULT 0,
    monthly_target  DECIMAL(14,2)  NOT NULL DEFAULT 0,
    max_wage        DECIMAL(14,2)  NOT NULL DEFAULT 0,
    is_active       TINYINT(1)     NOT NULL DEFAULT 1,
    updated_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (branch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ============================== พนักงาน ================================ */
CREATE TABLE IF NOT EXISTS hr_employee (
    hr_code     VARCHAR(30)   NOT NULL COMMENT 'รหัสพนักงาน (คีย์หลักที่เว็บใช้อ้างอิง)',
    full_name   VARCHAR(150)  NOT NULL,
    branch      VARCHAR(50)   NOT NULL,
    emp_type    VARCHAR(20)   NULL     COMMENT 'F/T, DAY, DAY9, P/T',
    position    VARCHAR(100)  NULL,
    daily_wage  DECIMAL(12,2) NOT NULL DEFAULT 0,
    status      VARCHAR(20)   NOT NULL DEFAULT 'ทำงาน' COMMENT 'ทำงาน / ลาออก',
    resign_date DATE          NULL,
    updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (hr_code),
    /* หน้าลงตารางอ่าน "คนที่ยังทำงานอยู่ของสาขานี้" เป็นหลัก */
    KEY IX_hr_employee_branch (branch, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ====================== ตารางงาน (หนึ่งแถวต่อคนต่อวัน) ====================== */
CREATE TABLE IF NOT EXISTS hr_timesheet (
    work_date             DATE          NOT NULL,
    branch                VARCHAR(50)   NOT NULL,
    hr_code               VARCHAR(30)   NOT NULL,

    /* คัดลอกไว้ ณ วันที่ลง เพื่อให้ประวัติย้อนหลังไม่เพี้ยนเมื่อพนักงานย้ายสาขา/ปรับค่าแรง */
    emp_name              VARCHAR(150)  NULL,
    position              VARCHAR(100)  NULL,
    emp_type              VARCHAR(20)   NULL,

    check_in              VARCHAR(5)    NULL COMMENT "'HH:mm' (รองรับ '24:00')",
    check_out             VARCHAR(5)    NULL,
    break_time            VARCHAR(20)   NULL COMMENT "'ไม่เบรค' หรือ '1 ชม.'",
    break_range           VARCHAR(20)   NULL COMMENT "'HH:mm-HH:mm'",

    ot_hours              DECIMAL(5,2)  NOT NULL DEFAULT 0,
    ot_accumulated        DECIMAL(5,2)  NOT NULL DEFAULT 0,
    use_accumulated_hours DECIMAL(5,2)  NOT NULL DEFAULT 0,
    hourly_leave          DECIMAL(5,2)  NOT NULL DEFAULT 0,

    wage                  DECIMAL(12,2) NOT NULL DEFAULT 0,
    status                VARCHAR(20)   NOT NULL DEFAULT 'มาทำงาน' COMMENT 'มาทำงาน / หยุด',
    leave_note            VARCHAR(100)  NULL COMMENT 'ลา (รับค่าแรง)',
    unpaid_leave          VARCHAR(100)  NULL COMMENT 'หยุด (ไม่รับค่าแรง)',
    other_note            VARCHAR(255)  NULL,
    work_station          VARCHAR(100)  NULL COMMENT 'จุดปฏิบัติงาน',
    ot_approver           VARCHAR(100)  NULL COMMENT 'ว่าง = ยังไม่อนุมัติ',

    created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by            VARCHAR(100)  NULL,

    PRIMARY KEY (work_date, branch, hr_code),
    /* หน้าลงตารางอ่านเป็นช่วงสัปดาห์ของสาขาเดียว — index นี้คือเส้นทางหลัก */
    KEY IX_hr_timesheet_branch_date (branch, work_date),
    /* หน้ารายงานรายคน (ดูย้อนหลังของพนักงานคนเดียว) */
    KEY IX_hr_timesheet_emp_date (hr_code, work_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ==================== ประวัติการแก้ไข (ต่อท้ายอย่างเดียว) ==================== */
/* แทนที่พฤติกรรม "ทุกครั้งที่กดบันทึกได้แถวใหม่" ของชีทเดิม โดยไม่ทำให้ตารางหลักบวม */
CREATE TABLE IF NOT EXISTS hr_timesheet_log (
    log_id     BIGINT        NOT NULL AUTO_INCREMENT,
    logged_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    action     VARCHAR(10)   NOT NULL COMMENT 'save / clear / ot',
    work_date  DATE          NOT NULL,
    branch     VARCHAR(50)   NOT NULL,
    hr_code    VARCHAR(30)   NOT NULL,
    actor      VARCHAR(100)  NULL COMMENT 'ผู้ใช้ที่กดบันทึก',
    payload    LONGTEXT      NULL COMMENT 'ค่าที่บันทึก (JSON) ไว้ตรวจย้อนหลัง',
    PRIMARY KEY (log_id),
    KEY IX_hr_timesheet_log_key (work_date, branch, hr_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ============================ ยอดขายรายวัน ============================= */
CREATE TABLE IF NOT EXISTS hr_daily_sales (
    sale_date  DATE          NOT NULL,
    branch     VARCHAR(50)   NOT NULL,
    sales      DECIMAL(14,2) NOT NULL DEFAULT 0,
    updated_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (sale_date, branch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ==========================================================================
   สิทธิ์: แนะนำให้สร้าง user แยกสำหรับเว็บ ไม่ใช้ root

     CREATE USER IF NOT EXISTS 'narai_web'@'%' IDENTIFIED BY '<ตั้งรหัสผ่านที่คาดเดายาก>';
     GRANT SELECT, INSERT, UPDATE, DELETE ON narai_hr.* TO 'narai_web'@'%';
     FLUSH PRIVILEGES;

   แล้วตั้ง HR_DB_USER=narai_web, HR_DB_PASSWORD=... บน Vercel
   (ถ้าไม่ตั้ง HR_DB_USER/HR_DB_PASSWORD ระบบจะถอยไปใช้ MYSQL_USER/MYSQL_PASSWORD
    ที่ตั้งไว้สำหรับฐานข้อมูล myfbdata อยู่แล้ว เพราะเป็นเครื่อง MySQL ตัวเดียวกัน)
========================================================================== */
