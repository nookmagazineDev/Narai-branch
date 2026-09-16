# ย้ายหน้า "รับสินค้า" จาก Google Sheets ไป SQL Server

## สรุป

หน้า "รับสินค้า" เคยอ่านชีท `จัดของ` และเขียนชีท `รับของ` ผ่าน Apps Script ตอนนี้ย้ายมาที่
`InventoryNarai` แล้ว — ตาราง `dbo.store_fulfillment` (โกดังจัดของ) และ `dbo.store_receiving`
(สาขารับของ) ซึ่งแอป [storefct](https://github.com/nookmagazineDev/narai-storefct) ใช้ร่วมกัน

เดิมสองแอปคุยกันผ่านสเปรดชีตเป็นตัวกลาง และ storefct ต้องคอยซิงก์ชีทตามตลอด **ตอนนี้ทั้งสองฝั่ง
อ่านเขียนแถวเดียวกัน ไม่มีตัวกลางแล้ว**

## รูปภาพยังอยู่ที่ Google Drive

SQL Server เขียน Drive ไม่ได้ รูปหลักฐานการแก้ไขจึงยังขึ้น Drive เหมือนเดิม แต่แยกเป็น action
ใหม่ที่ **อัปโหลดอย่างเดียว ไม่เขียนชีท**

```
หน้าเว็บ ──1── uploadReceivePhotos (Apps Script) ──► Drive ──► คืน URL
        └─2── saveGoodsReceived (office-server) ──► dbo.store_receiving (เก็บ URL)
```

อัปโหลดล้มเหลว = ไม่บันทึกอะไรเลย ดีกว่าได้แถว "แก้ไข" ที่ไม่มีหลักฐานแนบ

## ⚠️ ต้อง deploy ตามลำดับ ไม่งั้นสาขาจะมองไม่เห็นใบเบิก

`SQL_ACTIONS` ใน `src/services/api.js` เป็นรายการตายตัว ไม่มีสวิตช์ — deploy แล้วสลับทันที
ส่วน storefct มีสวิตช์ `STORE_SOURCE` ที่ตั้งต้นเป็น `sheet`

ถ้า deploy repo นี้ก่อน `getGoodsToReceive` จะไปอ่าน `store_fulfillment` ที่ยังว่างอยู่
(เพราะ storefct ยังเขียนชีท) → **สาขาจะไม่เห็นใบที่โกดังจัดไว้เลย**

ลำดับที่ถูกต้อง

| # | ทำอะไร | ที่ไหน |
|---|---|---|
| 1 | รัน `docs/schema-store-sqlserver.sql` (อยู่ใน repo storefct) | เครื่อง SQL Server |
| 2 | merge + deploy PR ของ repo นี้ **เฉพาะฝั่ง office-server** แล้ว `Restart-Service NaraiUsageAPI` | เครื่อง IT-Narai |
| 3 | วาง action `uploadReceivePhotos` ใน Apps Script editor แล้ว **Deploy ใหม่** | Apps Script |
| 4 | `node scripts/import-store-sql.mjs` (repo storefct) ย้ายข้อมูลเก่า | ที่ไหนก็ได้ |
| 5 | ตั้ง `STORE_SOURCE=sql` บน Vercel ของ storefct แล้ว redeploy | Vercel |
| 6 | deploy หน้าเว็บของ repo นี้ | Vercel |

ข้อ 3 ต้องทำเอง — ไฟล์ `apps-script.js` ใน repo เป็นสำเนา ไม่ได้ deploy อัตโนมัติ

## ถอยกลับ

ถอน `getGoodsToReceive` / `saveGoodsReceived` / `confirmReceivedItem` ออกจาก `SQL_ACTIONS`
แล้ว deploy — จะกลับไปใช้ Apps Script กับชีทเหมือนเดิม (โค้ดฝั่งนั้นยังอยู่ครบ ไม่ได้ลบ)
ต้องตั้ง `STORE_SOURCE=sheet` ที่ storefct กลับด้วย ไม่งั้นข้อมูลจะแยกกันอยู่คนละที่

**ข้อมูลที่เขียนลง SQL ระหว่างนั้นจะไม่ตามกลับไปที่ชีท**

## สิ่งที่ยังไม่ได้ทดสอบ

เขียนในสภาพแวดล้อมที่ต่อ SQL Server, office-server, Google Sheets และ Drive ไม่ได้เลย
ผ่านเฉพาะ `node --check` และการตรวจการจับคู่แท็ก JSX ด้วยการนับ

**ยังไม่เคยรันจริง**: T-SQL ทุกบรรทัด, MERGE, การอัปโหลดรูป และการจับคู่สาขาข้ามกลุ่มรหัส
(`zjp`/`sjp`) ซึ่งเป็นจุดที่พังได้เงียบที่สุด — ตอนทดสอบ ให้ลองสาขาที่อยู่ในกลุ่มนั้นด้วย

กรุณารัน `npm run lint && npm run build` ก่อน merge
