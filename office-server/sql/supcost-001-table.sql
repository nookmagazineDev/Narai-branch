/* ============================================================================
   กรอกรายจ่าย (ต้นทุนจาก Supplier + ผัก/ผลไม้) — ย้ายจากชีท "ต้นทุนจากsup"
   (สเปรดชีต 1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw) มาเก็บใน SQL

   หนึ่งแถว = (วันที่ + สาขา + สินค้า) เหมือนในชีท — บันทึกซ้ำวันเดิมจะแก้ทับแถวเดิม ไม่เพิ่มแถวใหม่
   (ในชีทกันซ้ำด้วยการหาแถวเดิมทุกครั้ง ที่นี่ใช้ unique key แทน)

   เขียนจาก saveSupCost ของ office-server/supcost.js
   อ่านจาก getSupCost (หน้ากรอกรายจ่าย) และ getSupCostRows (/api/stockcount: สรุปกำไร + ยอดรับในหน้านับสต๊อก)
   ข้อมูลเก่าจากชีท: node scripts/import-sup-cost.mjs --apply (source = 'sheet')

   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.stock_sup_cost', N'U') IS NULL
CREATE TABLE dbo.stock_sup_cost (
    sup_id        INT IDENTITY(1,1) NOT NULL,
    cost_date     DATE           NOT NULL,   -- วันที่ของรายจ่าย (A)
    branch        NVARCHAR(50)   NOT NULL,   -- สาขา ตัวพิมพ์เล็ก (B)
    item_key      NVARCHAR(50)   NOT NULL,   -- รหัสที่ normalize แล้ว (ตัด .0 ท้าย + 0 นำหน้า + ตัวพิมพ์เล็ก)
    item_code     NVARCHAR(50)   NOT NULL,   -- รหัสตามที่ส่งมา/ในชีท (C)
    item_name     NVARCHAR(255)  NULL,       -- (D)
    unit          NVARCHAR(50)   NULL,       -- (E)
    qty           DECIMAL(18,3)  NOT NULL,   -- (F) แก้เป็น 0 ได้ = ยกเลิกรายจ่ายรายการนั้น
    unit_price    DECIMAL(18,4)  NOT NULL CONSTRAINT DF_stock_sup_cost_price DEFAULT (0),   -- (G)
    amount        DECIMAL(18,2)  NOT NULL CONSTRAINT DF_stock_sup_cost_amount DEFAULT (0),  -- (H)
    recorder      NVARCHAR(255)  NULL,       -- ผู้บันทึกครั้งแรก (I)
    saved_at      DATETIME2(0)   NOT NULL CONSTRAINT DF_stock_sup_cost_saved_at DEFAULT (SYSDATETIME()), -- (J)
    updated_at    DATETIME2(0)   NULL,       -- เวลาแก้ไขล่าสุด (K)
    updated_by    NVARCHAR(255)  NULL,
    source        NVARCHAR(20)   NOT NULL CONSTRAINT DF_stock_sup_cost_source DEFAULT (N'web'), -- web | sheet (ย้ายมาจากชีท)
    CONSTRAINT PK_stock_sup_cost PRIMARY KEY (sup_id),
    CONSTRAINT UQ_stock_sup_cost UNIQUE (cost_date, branch, item_key)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_stock_sup_cost_branch_date'
                AND object_id = OBJECT_ID(N'dbo.stock_sup_cost'))
    CREATE INDEX IX_stock_sup_cost_branch_date ON dbo.stock_sup_cost (branch, cost_date)
        INCLUDE (item_key, item_code, item_name, unit, qty, unit_price, amount);
GO
