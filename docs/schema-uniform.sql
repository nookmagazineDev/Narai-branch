/* ============================================================================
   ยูนิฟอร์มพนักงาน — ตาราง UniformBranch บนฐานข้อมูล InventoryNarai
   (ฐานเดียวกับหน้านับสต๊อก เพราะรายการไอเทมอ่านจาก dbo.stock_item และปุ่ม "เบิก"
    ลง dbo.stock_request ตารางเดียวกับใบเบิกของสต๊อกทุกประการ)

   รันไฟล์นี้ครั้งเดียวก่อนเปิดใช้ปุ่มยูนิฟอร์มในหน้ารายชื่อพนักงาน

   วิธีรัน (บนเครื่องฐานข้อมูล) — เลือกทางใดทางหนึ่ง:
     ก) สคริปต์ที่สร้าง+ตรวจให้ครบในคำสั่งเดียว (แนะนำ ไม่ต้องมี sqlcmd)
        cd office-server
        node scripts/setup-uniform-db.mjs
     ข) sqlcmd -S localhost\SQLEXPRESS -U sa -P '<รหัสผ่าน>' -i docs\schema-uniform.sql
     ค) เปิดใน SQL Server Management Studio แล้วกด Execute
   ขั้นตอนทั้งหมดพร้อมวิธีแก้ปัญหาที่เจอบ่อย: docs/uniform-sql-migration.md

   1 แถว = 1 ไอเทมที่จ่ายให้พนักงาน 1 คน 1 ครั้ง
   (กดบันทึกครั้งเดียวที่มี 3 ไอเทม = 3 แถว issued_at เดียวกัน)

   ที่ตั้งใจให้เป็นแบบนี้
   ---------------------------------------------------------------------------
   1) เก็บ item_name / emp_name ซ้ำลงไปในแถวด้วย ทั้งที่ join เอาได้
      เพราะชื่อสินค้ากับชื่อพนักงานเปลี่ยนได้ทีหลัง ประวัติที่จ่ายไปแล้วต้องไม่เปลี่ยนตาม
   2) item_key = รหัสที่ normalize แล้ว (ตัด 0 นำหน้า + ตัวพิมพ์เล็ก) เหมือนทุกตารางของสต๊อก
      ถ้าเทียบด้วย item_code ตรงๆ จะจับคู่กับ stock_item ไม่เจอในบางรหัส
   3) สาขาเก็บเป็นตัวพิมพ์เล็กเสมอ (crm, hrs, zjp) กติกาเดียวกับตารางสต๊อก
   4) ไม่มี FK ไป stock_item — ทะเบียนสินค้าถูก sync ทับจากชีท BOM เป็นรอบ ๆ
      ถ้าผูก FK ไว้ การ sync ที่ลบสินค้าเก่าทิ้งจะล้มทั้งชุดเพราะมีประวัติอ้างอยู่
============================================================================ */

USE InventoryNarai;
GO

IF OBJECT_ID(N'dbo.UniformBranch', N'U') IS NULL
CREATE TABLE dbo.UniformBranch (
    uniform_id  INT IDENTITY(1,1) NOT NULL,   -- คีย์หลัก
    branch      NVARCHAR(50)   NOT NULL,      -- รหัสสาขา (ตัวพิมพ์เล็ก)
    hr_code     NVARCHAR(50)   NOT NULL,      -- รหัส HR ของพนักงาน
    emp_name    NVARCHAR(255)  NULL,          -- ชื่อพนักงาน ณ วันที่บันทึก
    item_key    NVARCHAR(50)   NOT NULL,      -- รหัสไอเทมที่ normalize แล้ว
    item_code   NVARCHAR(50)   NOT NULL,      -- รหัสไอเทมตามที่แสดง (ขึ้นต้น 800000)
    item_name   NVARCHAR(255)  NULL,          -- ชื่อไอเทม ณ วันที่บันทึก
    unit        NVARCHAR(50)   NULL,          -- หน่วย (ตัว / ผืน / ใบ)
    size        NVARCHAR(20)   NULL,          -- ไซซ์เสื้อ S / M / L / XL / 2XL / 3XL หรือ NULL
    qty         DECIMAL(18,2)  NOT NULL,      -- จำนวนที่จ่าย
    note        NVARCHAR(500)  NULL,          -- หมายเหตุ
    issued_at   DATETIME2(0)   NOT NULL,      -- วันที่จ่ายของ (เลือกเองได้ตอนบันทึก)
    saved_at    DATETIME2(0)   NOT NULL
                CONSTRAINT DF_UniformBranch_saved_at DEFAULT (SYSDATETIME()),
    saved_by    NVARCHAR(255)  NULL,          -- ผู้ใช้ที่กดบันทึก
    CONSTRAINT PK_UniformBranch PRIMARY KEY CLUSTERED (uniform_id)
);
GO

/* เปิดกล่องของพนักงาน 1 คน = อ่านด้วย hr_code + สาขา เรียงจากใหม่ไปเก่า */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE object_id = OBJECT_ID(N'dbo.UniformBranch') AND name = N'IX_UniformBranch_emp')
CREATE INDEX IX_UniformBranch_emp
    ON dbo.UniformBranch (hr_code, branch, issued_at DESC);
GO

/* สรุปยอดรายสาขา/รายเดือน (ใครเบิกอะไรไปเท่าไหร่) */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE object_id = OBJECT_ID(N'dbo.UniformBranch') AND name = N'IX_UniformBranch_branch_date')
CREATE INDEX IX_UniformBranch_branch_date
    ON dbo.UniformBranch (branch, issued_at DESC)
    INCLUDE (item_key, qty);
GO

/* ---- สิทธิ์ ----
   ถ้าใช้ login เดียวกับที่ office-server ใช้อยู่แล้ว (narai_app) ไม่ต้องทำอะไรเพิ่ม
   สิทธิ์ระดับฐานข้อมูลที่ให้ไว้ตอนตั้ง schema-stock.sql ครอบตารางใหม่นี้ให้เอง
   ตรวจได้ด้วย:
     SELECT * FROM dbo.UniformBranch;   -- ต้องไม่ error (ตอนนี้ยังว่าง)
*/

PRINT N'สร้างตาราง dbo.UniformBranch เรียบร้อย (ตรวจซ้ำได้ด้วย node scripts/setup-uniform-db.mjs --check ที่โฟลเดอร์ office-server)';
GO
