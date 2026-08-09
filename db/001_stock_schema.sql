/* ============================================================================
   โครงฐานข้อมูลสำหรับย้ายข้อมูล "หน้านับสต๊อกและขอเบิก" ออกจาก Google Sheets
   ปลายทาง: Microsoft SQL Server 2019 Express — NARAI-PIZZARIA\SQLEXPRESS
            203.154.185.48 พอร์ต 14322 ฐาน InventoryNarai

   ทำไมต้องย้าย: Google Sheets ไม่มี index — จะเอาข้อมูลสาขาเดียวก็ต้องลากทั้งชีท
   ออกมาก่อนเสมอ (ชีท ข้อมูลนับสตอค มี 25,000+ แถวและโตทุกวัน) getStockItems จึงใช้
   เวลา ~20 วิ และจะช้าลงเรื่อยๆ ตามอายุการใช้งาน ส่วน SQL มี index กรองที่ฐานข้อมูล
   ส่งกลับมาเฉพาะแถวที่ใช้จริง (~300 แถว) เวลาจึงคงที่ไม่โตตามข้อมูลเก่า

   ตารางในนี้ 1 ตาราง = 1 ชีทเดิม เพื่อให้ย้ายทีละส่วนได้และเทียบกับของเดิมง่าย
     stock_count            <- ชีท "ข้อมูลนับสตอค"
     stock_request          <- ชีท "ข้อมูลเบิก"
     stock_balance          <- ชีท "ยอดยกมา"
     stock_storage_category <- ชีท "หมวดจัดเก็บสาขา"
     stock_doc_counter      <- (ใหม่) ตัวนับเลขที่ใบเบิก แทนการไล่หาเลขล่าสุดจากทั้งชีท

   ไม่รวมรายการสินค้า (ชีท "item" ในไฟล์ BOM) เพราะทีมอื่นดูแล ยังอ่านจากชีทต่อไปก่อน

   วิธีรัน: เปิดไฟล์นี้ใน SQL Server Management Studio แล้วกด Execute (F5)
   รันซ้ำได้ปลอดภัย — ทุกคำสั่งเช็คก่อนว่ามีของเดิมอยู่แล้วหรือยัง ไม่ลบไม่ทับข้อมูล
   ============================================================================ */

IF DB_ID(N'InventoryNarai') IS NULL
    CREATE DATABASE [InventoryNarai];
GO

USE [InventoryNarai];
GO

/* ----------------------------------------------------------------------------
   หมายเหตุเรื่อง "รหัสสินค้า" ที่ใช้ทั่วทั้งระบบ
   โค้ดเดิมเทียบรหัสด้วย String(id).replace(/^0+/, '').toLowerCase() ทุกจุด
   (เพราะบางชีทเก็บ "007" บางชีทเก็บ 7) จึงเก็บสองคอลัมน์:
     product_code = รหัสตามที่ผู้ใช้เห็น/ที่มาจากต้นทาง เอาไว้แสดงผล
     code_norm    = รหัสที่ normalize แล้ว เอาไว้ทำ index/จับคู่ — ทุกคำสั่ง WHERE ใช้ตัวนี้

   ทุกคอลัมน์ข้อความใช้ NVARCHAR (ไม่ใช่ VARCHAR) เพราะข้อมูลเป็นภาษาไทย
   VARCHAR ของ SQL Server ผูกกับ codepage ของ collation ถ้า collation ไม่ใช่ไทยจะได้ ???
   ---------------------------------------------------------------------------- */

/* ชีท "ข้อมูลนับสตอค" — ประวัติการนับทุกครั้ง เพิ่มแถวใหม่เสมอ ไม่ทับของเดิม
   A=วันที่ลงข้อมูล B=ชื่อพนักงานนับสต๊อก C=สาขา D=รหัสสินค้า E=ชื่อสินค้า F=หน่วย G=จำนวนคงเหลือ */
IF OBJECT_ID(N'dbo.stock_count', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.stock_count (
        id           BIGINT IDENTITY(1,1) NOT NULL,
        branch       NVARCHAR(10)  NOT NULL,   -- รหัสสาขาตัวพิมพ์เล็ก เช่น crm, zjp
        product_code NVARCHAR(32)  NOT NULL,
        code_norm    NVARCHAR(32)  NOT NULL,   -- ตัด 0 นำหน้า + ตัวพิมพ์เล็ก
        product_name NVARCHAR(255) NOT NULL CONSTRAINT DF_sc_name    DEFAULT N'',
        unit         NVARCHAR(32)  NOT NULL CONSTRAINT DF_sc_unit    DEFAULT N'',
        qty          DECIMAL(14,3) NULL,       -- จำนวนคงเหลือที่นับได้
        counter_name NVARCHAR(120) NOT NULL CONSTRAINT DF_sc_counter DEFAULT N'',
        counted_at   DATETIME2(0)  NOT NULL,   -- เวลาที่กดบันทึก
        CONSTRAINT PK_stock_count PRIMARY KEY CLUSTERED (id)
    );

    /* getStockItems ต้องการประวัติรายสินค้าของสาขาเดียว เรียงตามเวลา
       INCLUDE ทำให้ index ตอบได้ครบโดยไม่ต้องวิ่งกลับไปอ่านตารางจริง (covering index) */
    CREATE INDEX IX_sc_branch_code_time ON dbo.stock_count (branch, code_norm, counted_at)
        INCLUDE (qty, counter_name, product_name, unit);

    /* หน้ามูลค่าสต๊อก/ปิดยอด ถามว่า "ยอดนับล่าสุดของสาขานี้ในช่วงวันที่" */
    CREATE INDEX IX_sc_branch_time ON dbo.stock_count (branch, counted_at)
        INCLUDE (code_norm, qty);
END
GO

/* ชีท "ข้อมูลเบิก" — รายการที่สาขาขอเบิก 1 แถว = 1 สินค้าในใบเบิก
   A=เลขที่ใบเบิก B=วันที่เวลาบันทึก C=รหัส D=ชื่อ E=หน่วย F=จำนวน G=วันที่เบิก H=ชื่อผู้เบิก I=สาขา */
IF OBJECT_ID(N'dbo.stock_request', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.stock_request (
        id           BIGINT IDENTITY(1,1) NOT NULL,
        doc_no       NVARCHAR(20)  NOT NULL,   -- เลขที่ใบเบิก เช่น CRM2608001
        branch       NVARCHAR(10)  NOT NULL,
        product_code NVARCHAR(32)  NOT NULL,
        code_norm    NVARCHAR(32)  NOT NULL,
        product_name NVARCHAR(255) NOT NULL CONSTRAINT DF_sr_name      DEFAULT N'',
        unit         NVARCHAR(32)  NOT NULL CONSTRAINT DF_sr_unit      DEFAULT N'',
        qty          DECIMAL(14,3) NOT NULL CONSTRAINT DF_sr_qty       DEFAULT 0,
        request_date DATE          NULL,       -- วันที่ต้องการรับสินค้า
        requester    NVARCHAR(120) NOT NULL CONSTRAINT DF_sr_requester DEFAULT N'',
        recorded_at  DATETIME2(0)  NOT NULL,   -- เวลาที่กดบันทึก
        CONSTRAINT PK_stock_request PRIMARY KEY CLUSTERED (id)
    );

    CREATE INDEX IX_sr_branch_code_time ON dbo.stock_request (branch, code_norm, recorded_at)
        INCLUDE (qty, requester, request_date);
    CREATE INDEX IX_sr_doc ON dbo.stock_request (doc_no);
    CREATE INDEX IX_sr_branch_time ON dbo.stock_request (branch, recorded_at);
END
GO

/* ชีท "ยอดยกมา" — 1 สาขา + 1 สินค้า มีได้แถวเดียว (ค่าล่าสุดเท่านั้น)
   ตั้ง PRIMARY KEY (branch, code_norm) เพื่อให้ saveStock ใช้ MERGE ได้เลย
   ไม่ต้องอ่านทั้งชีทมาหาว่าแถวไหนคือแถวที่ต้องแก้แบบโค้ดเดิม */
IF OBJECT_ID(N'dbo.stock_balance', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.stock_balance (
        branch       NVARCHAR(10)  NOT NULL,
        code_norm    NVARCHAR(32)  NOT NULL,
        product_code NVARCHAR(32)  NOT NULL,
        product_name NVARCHAR(255) NOT NULL CONSTRAINT DF_sb_name DEFAULT N'',
        qty          DECIMAL(14,3) NULL,
        updated_at   DATETIME2(0)  NOT NULL,
        CONSTRAINT PK_stock_balance PRIMARY KEY CLUSTERED (branch, code_norm)
    );
END
GO

/* ชีท "หมวดจัดเก็บสาขา" — 1 สาขา + 1 สินค้า มีได้แถวเดียว */
IF OBJECT_ID(N'dbo.stock_storage_category', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.stock_storage_category (
        branch       NVARCHAR(10)  NOT NULL,
        code_norm    NVARCHAR(32)  NOT NULL,
        product_code NVARCHAR(32)  NOT NULL,
        product_name NVARCHAR(255) NOT NULL CONSTRAINT DF_ssc_name DEFAULT N'',
        category     NVARCHAR(120) NOT NULL CONSTRAINT DF_ssc_cat  DEFAULT N'',
        updated_at   DATETIME2(0)  NOT NULL CONSTRAINT DF_ssc_upd  DEFAULT SYSDATETIME(),
        CONSTRAINT PK_stock_storage_category PRIMARY KEY CLUSTERED (branch, code_norm)
    );
END
GO

/* (ใหม่ ไม่มีในชีท) ตัวนับเลขที่ใบเบิกต่อสาขาต่อเดือน
   ของเดิมหาเลขถัดไปด้วยการไล่อ่านคอลัมน์ A ของทั้งชีทที่แถวสะสมทุกวัน — ยิ่งใช้ยิ่งช้า
   และถ้าสองคนกดพร้อมกันมีสิทธิ์ได้เลขซ้ำ ตารางนี้ + proc ด้านล่างจองเลขได้แบบไม่ชนกัน */
IF OBJECT_ID(N'dbo.stock_doc_counter', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.stock_doc_counter (
        branch  NVARCHAR(10) NOT NULL,
        ym      CHAR(4)      NOT NULL,   -- ปีเดือนแบบ yyMM เช่น 2608
        last_no INT          NOT NULL CONSTRAINT DF_sdc_last DEFAULT 0,
        CONSTRAINT PK_stock_doc_counter PRIMARY KEY CLUSTERED (branch, ym)
    );
END
GO

/* จองเลขที่ใบเบิกถัดไปแบบ atomic
   UPDLOCK/HOLDLOCK กันสองสาขาที่กดพร้อมกันอ่านค่าเดียวกันแล้วได้เลขซ้ำ
   เรียกใช้: DECLARE @n INT; EXEC dbo.sp_next_request_no N'crm', '2608', @n OUTPUT; */
CREATE OR ALTER PROCEDURE dbo.sp_next_request_no
    @branch NVARCHAR(10),
    @ym     CHAR(4),
    @next   INT OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;
        UPDATE dbo.stock_doc_counter WITH (UPDLOCK, HOLDLOCK)
           SET @next = last_no = last_no + 1
         WHERE branch = @branch AND ym = @ym;

        IF @@ROWCOUNT = 0
        BEGIN
            SET @next = 1;
            INSERT INTO dbo.stock_doc_counter (branch, ym, last_no) VALUES (@branch, @ym, 1);
        END
    COMMIT TRANSACTION;
END
GO

/* ============================================================================
   login สำหรับเว็บใช้ — แยกจาก administrator โดยเจตนา

   เว็บ (Vercel) ต่อเข้ามาจากอินเทอร์เน็ต ถ้าใช้บัญชี administrator แล้วรหัสหลุด
   = เสียทั้งเครื่อง บัญชีนี้จึงให้สิทธิ์แค่ที่ต้องใช้จริง: อ่าน/เพิ่ม/แก้ ในฐานนี้ฐานเดียว
   และ DENY DELETE ไว้ เพราะหน้านับสต๊อกไม่เคยต้องลบข้อมูลเลย

   >>> เปลี่ยน 'ตั้งรหัสผ่านใหม่ตรงนี้' เป็นรหัสจริงก่อนรัน แล้วเก็บไว้ใน
   >>> Environment Variables ของ Vercel เท่านั้น
   >>> ห้ามใส่รหัสจริงกลับมาในไฟล์นี้แล้ว commit ขึ้น git เด็ดขาด

   ต้องเปิด "SQL Server Authentication" (Mixed Mode) ที่ตัวเซิร์ฟเวอร์ด้วย
   เพราะ Vercel ใช้ Windows Authentication ไม่ได้
   (SSMS: คลิกขวาที่ชื่อเซิร์ฟเวอร์ -> Properties -> Security -> SQL Server and Windows
    Authentication mode -> ต้องรีสตาร์ท service)
   ============================================================================ */

/*
USE master;
GO
IF SUSER_ID(N'narai_app') IS NULL
    CREATE LOGIN [narai_app] WITH PASSWORD = N'ตั้งรหัสผ่านใหม่ตรงนี้',
        DEFAULT_DATABASE = [InventoryNarai], CHECK_POLICY = ON;
GO
USE [InventoryNarai];
GO
IF USER_ID(N'narai_app') IS NULL
    CREATE USER [narai_app] FOR LOGIN [narai_app];
GO
ALTER ROLE db_datareader ADD MEMBER [narai_app];
ALTER ROLE db_datawriter ADD MEMBER [narai_app];
DENY DELETE ON SCHEMA::dbo TO [narai_app];
GRANT EXECUTE ON dbo.sp_next_request_no TO [narai_app];
GO
*/

/* ============================================================================
   เช็คว่าสร้างครบไหม
   ============================================================================ */
-- SELECT name FROM sys.tables ORDER BY name;
-- SELECT t.name AS ตาราง, i.name AS ชื่อ_index, i.type_desc
--   FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id
--  WHERE i.name IS NOT NULL ORDER BY t.name, i.name;
