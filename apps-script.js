// --- ตั้งค่า ID ของ Spreadsheet ข้อมูลยอดขาย/เป้าหมาย ---
var SALES_DATA_SPREADSHEET_ID = '1kxVqX_hp5B0YTNSPj7mhyFl1OLbnhN-dIWm9ywzHA60';

// --- Cache: ชีท "ข้อมูลนับสตอค" มี 25,000+ แถวสะสมไม่มีวันหมด อ่านทั้งชีทกิน ~20 วินาทีทุกครั้ง
//   แคชผลลัพธ์ที่อ่านแล้วไว้ต่อสาขา กันคนกดเข้าหน้าเดิมซ้ำๆ ในช่วงเวลาใกล้กันต้องรอนาน
//   CacheService จำกัดค่าละ 100KB จึงต้อง gzip+base64 ก่อนเก็บ แล้วยังตัดเป็นชิ้นๆ (chunk) เผื่อสาขาที่มีข้อมูลเยอะเกิน
var STOCK_ITEMS_CACHE_TTL = 90;    // วินาที — getStockItems (หน้านับสต๊อก)
var CLOSING_ITEMS_CACHE_TTL = 300; // วินาที — getClosingItems อ่านแค่ชีท item ที่แทบไม่เปลี่ยนระหว่างวัน แคชได้นานกว่า
var MONTH_END_CACHE_TTL = 120;     // วินาที — getMonthEndClosing (ล้างแคชทันทีเมื่อมีการบันทึกใหม่ จึงไม่เห็นข้อมูลเก่าค้าง)
var CACHE_CHUNK_SIZE = 90000;      // ตัวอักษรต่อชิ้น — เผื่อขอบเขตให้ห่างจากลิมิต 100KB ของ CacheService

// --- Helper: ต่อท้ายชีทหลายแถวด้วยการเขียนครั้งเดียว ---
// appendRow() เขียนชีท 1 ครั้งต่อ 1 แถว และยิ่งชีทยาวยิ่งช้า การบันทึกที่มี 100-800 แถว
// (นับสต๊อก / ตารางงานทั้งสัปดาห์) จึงใช้เวลาเกิน timeout ฝั่งเว็บจนผู้ใช้เห็นว่า "บันทึกไม่ไป"
// setValues เขียนทีเดียวจบ แต่ไม่ขยายกริดให้เอง ต้อง insertRowsAfter เองถ้าแถวไม่พอ
function appendRowsBatch(sheet, rows) {
  if (!rows || !rows.length) return 0;
  var startRow = sheet.getLastRow() + 1;
  var needRows = startRow + rows.length - 1;
  if (needRows > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), needRows - sheet.getMaxRows());
  }
  sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
  return startRow;
}

// อ่านค่าที่แคชไว้ (คืน null ถ้าไม่มี/หมดอายุ/อ่านพลาด — ให้ผู้เรียกไปอ่านสดแทน)
function getCachedJson(cacheKey) {
  try {
    var cache = CacheService.getScriptCache();
    var chunkCount = parseInt(cache.get(cacheKey + '_meta'), 10);
    if (!chunkCount) return null;
    var parts = [];
    for (var i = 0; i < chunkCount; i++) {
      var part = cache.get(cacheKey + '_' + i);
      if (part === null) return null; // ชิ้นไหนหาย (หมดอายุไม่พร้อมกัน) ถือว่า cache miss ทั้งชุด
      parts.push(part);
    }
    var compressedBytes = Utilities.base64Decode(parts.join(''));
    var jsonStr = Utilities.ungzip(Utilities.newBlob(compressedBytes, 'application/x-gzip')).getDataAsString();
    return JSON.parse(jsonStr);
  } catch (e) {
    return null; // แคชอ่านพลาด ไม่เป็นไร ไปอ่านสดแทน
  }
}

function putCachedJson(cacheKey, value, ttlSeconds) {
  try {
    var cache = CacheService.getScriptCache();
    var jsonStr = JSON.stringify(value);
    var gzipped = Utilities.gzip(Utilities.newBlob(jsonStr, 'application/json'));
    var b64 = Utilities.base64Encode(gzipped.getBytes());
    var chunkCount = Math.ceil(b64.length / CACHE_CHUNK_SIZE) || 1;
    for (var i = 0; i < chunkCount; i++) {
      cache.put(cacheKey + '_' + i, b64.substring(i * CACHE_CHUNK_SIZE, (i + 1) * CACHE_CHUNK_SIZE), ttlSeconds);
    }
    cache.put(cacheKey + '_meta', String(chunkCount), ttlSeconds);
  } catch (e) {
    // แคชเขียนพลาดไม่เป็นไร แค่รอบถัดไปจะไม่เร็วขึ้น ไม่กระทบผลลัพธ์หลัก
  }
}

// ล้างแคชของ key นั้น — เรียกหลังบันทึกข้อมูลใหม่ เพื่อไม่ให้ผู้ใช้เห็นค่าเก่าค้างจนกว่าแคชจะหมดอายุ
function clearCachedJson(cacheKey) {
  try {
    var cache = CacheService.getScriptCache();
    var chunkCount = parseInt(cache.get(cacheKey + '_meta'), 10) || 0;
    var keys = [cacheKey + '_meta'];
    for (var i = 0; i < chunkCount; i++) keys.push(cacheKey + '_' + i);
    cache.removeAll(keys);
  } catch (e) {
    // ล้างไม่สำเร็จก็ยังปลอดภัย แค่รออีกไม่เกิน TTL ค่าใหม่จะขึ้นเอง
  }
}

function getStockItemsFromCache(reqBranch) {
  return getCachedJson('stockItems_' + reqBranch);
}
function putStockItemsToCache(reqBranch, itemsArray) {
  putCachedJson('stockItems_' + reqBranch, itemsArray, STOCK_ITEMS_CACHE_TTL);
}

// --- Helper: เปรียบเทียบวันที่อย่างปลอดภัย ---
function isSameDate(date1, date2) {
  if (!date1 || !date2) return false;
  var d1 = new Date(date1);
  var d2 = new Date(date2);
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return false;
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  return d1.getTime() === d2.getTime();
}

// --- Helper: gen รหัส HR รูปแบบ YYMMNNN (ปี ค.ศ. 2 หลัก + เดือน 2 หลัก + เลขรัน 3 หลัก) ---
// ตรวจสอบเลขซ้ำจากคอลัมน์ C ของชีท DATA แล้ววิ่งเลขถัดไปให้อัตโนมัติ
function generateNextHrCode(sheet) {
  var now = new Date();
  var prefix = Utilities.formatDate(now, "Asia/Bangkok", "yyMM");

  var existing = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 0) {
    var hrValues = sheet.getRange(1, 3, lastRow).getValues();
    for (var r = 0; r < hrValues.length; r++) {
      var v = hrValues[r][0];
      if (v) existing[String(v).trim()] = true;
    }
  }

  var running = 1;
  var hrCode;
  do {
    hrCode = prefix + ("00" + running).slice(-3);
    running++;
  } while (existing[hrCode]);

  return hrCode;
}

// --- Helper: แปลงค่าวันที่ (Date object หรือ string dd/mm/yyyy พ.ศ./ค.ศ.) ให้เป็น Date object ---
function parseFlexibleDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  var s = String(val).trim();
  if (!s) return null;
  if (s.indexOf('/') !== -1) {
    var parts = s.split('/');
    if (parts.length === 3) {
      var y = parseInt(parts[2], 10);
      if (y > 2500) y -= 543;
      var d = new Date(y, parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
      return isNaN(d.getTime()) ? null : d;
    }
  }
  var d2 = new Date(s);
  if (!isNaN(d2.getTime())) {
    if (d2.getFullYear() > 2500) d2.setFullYear(d2.getFullYear() - 543);
    return d2;
  }
  return null;
}

// --- Helper: คำนวณระยะเวลาทำงานทั้งหมด เป็นข้อความภาษาไทย (ปี/เดือน/วัน) ---
function formatDurationThai(startVal, endVal) {
  var start = parseFlexibleDate(startVal);
  var end = parseFlexibleDate(endVal) || new Date();
  if (!start) return '-';

  var years = end.getFullYear() - start.getFullYear();
  var months = end.getMonth() - start.getMonth();
  var days = end.getDate() - start.getDate();

  if (days < 0) {
    months--;
    days += 30;
  }
  if (months < 0) {
    years--;
    months += 12;
  }

  var parts = [];
  if (years > 0) parts.push(years + ' ปี');
  if (months > 0) parts.push(months + ' เดือน');
  if (years === 0 && days > 0) parts.push(days + ' วัน');

  return parts.length === 0 ? '0 วัน' : parts.join(' ');
}

function setupPermissions() {
  // บังคับให้ Google รู้ว่าเราต้องการสิทธิ์ "เขียน" ไฟล์ลง Drive
  var folder = DriveApp.getFolderById("1i-8K4E97vwcghQyT1yJ_TpFTt0irbZtR");
  var testFile = folder.createFile("test_permission.txt", "OK");
  testFile.setTrashed(true); // สร้างเสร็จแล้วสั่งลบทิ้งทันที จะได้ไม่รก
}

function doPost(e) {
  var response = {
    status: 'error',
    message: 'Unknown error'
  };

  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action;

    var ss = SpreadsheetApp.openById("1Abot2hKLUO6_z8NRW6c9A0m0ggra3ZE7Yq10kcUPr7Y");

    if (action === 'login') {
      var sheet = ss.getSheetByName('User');
      if (!sheet) {
        throw new Error("Sheet 'User' not found.");
      }

      var username = data.username;
      var password = data.password;

      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();

      // Skip header row if exists, but we'll just search all
      var loggedIn = false;
      var branch = "";
      var outletId = "";

      for (var i = 0; i < values.length; i++) {
        // Col A = 0, Col B = 1, Col C = 2, Col D = 3
        if (values[i][0] == username && values[i][1] == password) {
          loggedIn = true;
          branch = values[i][2]; // สาขา
          outletId = values[i][3]; // Outlet ID
          break;
        }
      }

      if (loggedIn) {
        response.status = 'success';
        response.data = {
          username: username,
          branch: branch,
          outletId: outletId
        };
      } else {
        response.status = 'error';
        response.message = 'Invalid credentials';
      }

    } else if (action === 'addEmployee') {
      var sheet = ss.getSheetByName('DATA');
      if (!sheet) {
        sheet = ss.insertSheet('DATA');
      }

      // รหัส HR ถูก gen ขึ้นเองโดยระบบ (YYMMNNN) ห้ามแก้ไขจากฝั่ง client
      // ตรวจสอบซ้ำกับคอลัมน์ C ของชีท DATA อีกครั้งกันกรณีชนกัน (race condition) แล้ววิ่งเลขถัดไปให้
      var hrCodeToCheck = data.hrCode;
      var lastRow = sheet.getLastRow();
      var hrTaken = false;
      if (hrCodeToCheck && lastRow > 0) {
        var hrValues = sheet.getRange(1, 3, lastRow).getValues();
        for (var r = 0; r < hrValues.length; r++) {
          if (hrValues[r][0] == hrCodeToCheck) {
            hrTaken = true;
            break;
          }
        }
      }
      if (!hrCodeToCheck || hrTaken) {
        data.hrCode = generateNextHrCode(sheet);
      }
      var sheet2 = ss.getSheetByName('พนักงานเข้า');
      if (!sheet2) {
        sheet2 = ss.insertSheet('พนักงานเข้า');
        var headers = [
          "Timestamp", "ผู้บันทึก", "รหัส HR", "ชื่อ - สกุล", "สังกัด",
          "ประเภท", "ตำแหน่ง", "เลขประจำตัวประชาชน", "ที่อยู่", "วันเกิด",
          "เบอร์โทร", "ID LINE", "LOGA", "สัญชาติ", "เอกสารที่มี",
          "ลิงก์ไฟล์แนบ", "วันที่เริ่มงาน"
        ];
        sheet2.appendRow(headers);
        // Make headers bold
        sheet2.getRange("A1:Q1").setFontWeight("bold");
      }

      var row = new Array(75);
      for (var i = 0; i < 75; i++) {
        row[i] = "";
      }

      var now = new Date();
      var formattedDate = Utilities.formatDate(now, "Asia/Bangkok", "dd/MM/yyyy HH:mm:ss");

      // Mapping:
      // C (index 2): รหัส HR
      // D (index 3): ชื่อ - สกุล
      // E (index 4): สังกัด
      // F (index 5): ประเภท
      // H (index 7): วันที่เริ่มทำงาน
      // I (index 8): ตำแหน่ง
      // M (index 12): เลขประจำตัวประชาชน
      // Q (index 16): ที่อยู่
      // S (index 18): วันเกิด
      // BP (index 67): เบอร์โทร
      // BQ (index 68): IDLINE
      // BR (index 69): LOGA

      row[2] = data.hrCode || "";
      row[3] = data.fullName || "";
      row[4] = data.department || "";
      row[5] = data.type || "";
      row[6] = "ทำงาน";            // คอลัมน์ G (สถานะ) — พนักงานใหม่ตั้งเป็น "ทำงาน"
      row[7] = data.startDate || ""; // คอลัมน์ H (วันที่เริ่มทำงาน) ใช้วันที่บันทึกตรงกับฟอร์ม
      row[8] = data.position || "";
      row[12] = data.idCard || "";
      row[16] = data.address || "";
      row[18] = data.birthday || "";
      row[67] = data.phone || "";
      row[68] = data.lineId || "";
      row[69] = data.loga || "";

      row[70] = data.nationality || "";
      var docList = [];
      if (data.documents) {
        data.documents.forEach(function (doc) {
          var exp = (data.documentExpiry && data.documentExpiry[doc]) ? data.documentExpiry[doc] : "";
          if (exp) {
            if (doc === 'สมุดบัญชีธนาคาร') {
              docList.push(doc + " (บัญชี: " + exp + ")");
            } else {
              docList.push(doc + " (หมดอายุ: " + exp + ")");
            }
          } else {
            docList.push(doc);
          }
        });
      }
      row[71] = docList.join(", ");

      var fileUrls = [];
      if (data.files && data.files.length > 0) {
        try {
          var folder = DriveApp.getFolderById("1i-8K4E97vwcghQyT1yJ_TpFTt0irbZtR");
          for (var f = 0; f < data.files.length; f++) {
            var fileObj = data.files[f];
            // Remove data URI prefix if present
            var base64Data = fileObj.base64.split(',')[1] || fileObj.base64;
            var decoded = Utilities.base64Decode(base64Data);
            var blob = Utilities.newBlob(decoded, fileObj.mimeType, fileObj.name);
            var driveFile = folder.createFile(blob);
            // Optional: set sharing permission so anyone with link can view
            driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            fileUrls.push(driveFile.getUrl());
          }
        } catch (e) {
          // If file upload fails, we log it in the URL column
          fileUrls.push("Error uploading files: " + e.message);
        }
      }
      row[72] = fileUrls.join(", ");

      var row2 = [
        formattedDate,
        data.recorder || "Unknown",
        data.hrCode || "",
        data.fullName || "",
        data.department || "",
        data.type || "",
        data.position || "",
        data.idCard || "",
        data.address || "",
        data.birthday || "",
        data.phone || "",
        data.lineId || "",
        data.loga || "",
        data.nationality || "",
        docList.join(", "),
        fileUrls.join(", "),
        data.startDate || ""
      ];

      sheet.appendRow(row);
      sheet2.appendRow(row2);

      response.status = 'success';
      response.message = 'Employee added successfully';
      response.data = { hrCode: data.hrCode };
    } else if (action === 'getNextHrCode') {
      var sheetHr = ss.getSheetByName('DATA');
      if (!sheetHr) {
        sheetHr = ss.insertSheet('DATA');
      }
      response.status = 'success';
      response.data = { hrCode: generateNextHrCode(sheetHr) };
    } else if (action === 'getEmployees') {
      var sheet = ss.getSheetByName('DATA');
      if (!sheet) {
        response.status = 'success';
        response.data = [];
        return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
      }

      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();
      var employees = [];
      var requestBranch = data.branch || '';

      // Skip header row
      for (var i = 1; i < values.length; i++) {
        var row = values[i];
        if (!row[0] && !row[2]) continue; // Skip completely empty rows

        var empBranch = row[4] ? row[4].toString().toLowerCase() : ''; // คอลัมน์ E (สาขา)
        var reqBranch = requestBranch.toLowerCase();
        var isMatch = false;

        if (reqBranch === 'all') {
          isMatch = true;
        } else {
          if (empBranch.indexOf(reqBranch) !== -1 || reqBranch.indexOf(empBranch) !== -1) {
            isMatch = true;
          }
        }

        if (isMatch) {
          employees.push({
            hrCode: row[2] || '',       // คอลัมน์ C
            fullName: row[3] || '',     // คอลัมน์ D
            branch: row[4] || '',       // คอลัมน์ E (สาขา)
            type: row[5] || '',         // คอลัมน์ F (ประเภท)
            status: row[6] || '',       // คอลัมน์ G (การทำงาน)
            startDate: row[7] || '',    // คอลัมน์ H (วันเริ่มงาน)
            position: row[8] || '',     // คอลัมน์ I (ตำแหน่ง)
            loga: row[69] || '',        // คอลัมน์ BR (เลขที่ LOGA)
            newCode: row[71] || '',     // คอลัมน์ BT (รหัสใหม่ / ใช้ตั้งชื่อไฟล์รูป)
            photoUrl: row[72] || ''     // คอลัมน์ BU (ลิงก์รูป)
          });
        }
      }

      response.status = 'success';
      response.data = employees;

    } else if (action === 'uploadEmployeePhoto') {
      var sheet = ss.getSheetByName('DATA');
      if (!sheet) throw new Error('Sheet DATA not found');
      var hrCode = data.hrCode;
      if (!hrCode) throw new Error('ไม่มีรหัสพนักงาน');
      if (!data.base64) throw new Error('ไม่มีไฟล์รูป');

      // หาแถวของพนักงานจากรหัส HR (คอลัมน์ C = index 2)
      var values = sheet.getDataRange().getValues();
      var rowIndex = -1;
      for (var i = 1; i < values.length; i++) {
        if (String(values[i][2]).trim() == String(hrCode).trim()) { rowIndex = i + 1; break; }
      }
      if (rowIndex === -1) throw new Error('ไม่พบรหัสพนักงานนี้ในระบบ');

      // รหัสสำหรับตั้งชื่อไฟล์ = คอลัมน์ C (index 2 = รหัส HR); ตัดนามสกุลไฟล์ที่อาจติดมาออก, ถ้าว่างใช้รหัส HR ที่ส่งมาแทน
      var cVal = String(values[rowIndex - 1][2] || '').trim();
      var newCode = cVal.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '').trim() || String(hrCode).trim();
      var ext = String(data.ext || (data.fileName ? data.fileName.split('.').pop() : '') || 'jpg').toLowerCase();
      var fileName = newCode + '.' + ext;

      var folder = DriveApp.getFolderById("1i-8K4E97vwcghQyT1yJ_TpFTt0irbZtR");
      // ลบไฟล์เก่าที่ชื่อขึ้นต้นด้วยรหัสใหม่ หรือรหัส HR เดิม (กันไฟล์ซ้ำ)
      var existing = folder.getFiles();
      while (existing.hasNext()) {
        var ef = existing.next();
        var en = ef.getName();
        if (en === fileName || en.indexOf(newCode + '.') === 0 || en.indexOf(String(hrCode) + '.') === 0) ef.setTrashed(true);
      }

      var base64Data = data.base64.split(',')[1] || data.base64;
      var decoded = Utilities.base64Decode(base64Data);
      var blob = Utilities.newBlob(decoded, data.mimeType || 'image/jpeg', fileName);
      var driveFile = folder.createFile(blob);
      driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      var url = driveFile.getUrl();

      // เก็บลิงก์รูปไว้ที่คอลัมน์ BU (คอลัมน์ที่ 73) สำหรับแสดงรูปบนหน้าจอ
      // ไม่เขียนทับคอลัมน์ BT (72) อีกต่อไป เพราะ BT = รหัสใหม่ที่ใช้ตั้งชื่อไฟล์
      sheet.getRange(rowIndex, 73).setValue(url);

      response.status = 'success';
      response.message = 'อัปโหลดรูปสำเร็จ';
      response.data = { url: url, fileName: fileName };

    } else if (action === 'resignEmployee') {
      var sheet = ss.getSheetByName('DATA');
      if (!sheet) throw new Error('Sheet DATA not found');
      var hrCode = data.hrCode;
      if (!hrCode) throw new Error('ไม่มีรหัสพนักงาน');
      if (!data.resignDate) throw new Error('กรุณาระบุวันที่ลาออก');

      var values = sheet.getDataRange().getValues();
      var found = false;
      var empRow = null;
      for (var i = 1; i < values.length; i++) {
        if (values[i][2] == hrCode) {
          empRow = values[i];
          sheet.getRange(i + 1, 7).setValue('ลาออก'); // Column G is index 6, so column 7
          found = true;
          break;
        }
      }

      if (!found) {
        response.status = 'error';
        response.message = 'ไม่พบรหัสพนักงานนี้';
      } else {
        var sheetOut = ss.getSheetByName('พนักงานออก');
        if (!sheetOut) {
          sheetOut = ss.insertSheet('พนักงานออก');
          var outHeaders = [
            'Timestamp', 'รหัส HR', 'ชื่อ - สกุล', 'สังกัด', 'ประเภท',
            'วันที่เข้าทำงาน', 'วันที่ลาออก', 'สาเหตุ', 'ระยะเวลาที่ทำงานทั้งหมด', 'ผู้บันทึก'
          ];
          sheetOut.appendRow(outHeaders);
          sheetOut.getRange('A1:J1').setFontWeight('bold');
        }

        var now = new Date();
        var formattedNow = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
        var startDate = empRow[7]; // คอลัมน์ H (วันเริ่มงาน)
        var durationText = formatDurationThai(startDate, data.resignDate);

        sheetOut.appendRow([
          formattedNow,
          empRow[2] || '',          // รหัส HR
          empRow[3] || '',          // ชื่อ - สกุล
          empRow[4] || '',          // สังกัด
          empRow[5] || '',          // ประเภท
          startDate || '',          // วันที่เข้าทำงาน
          data.resignDate || '',    // วันที่ลาออก
          data.reason || '',        // สาเหตุ
          durationText,             // ระยะเวลาที่ทำงานทั้งหมด
          data.recorder || 'Unknown'
        ]);

        response.status = 'success';
        response.message = 'แจ้งลาออกสำเร็จ';
      }

    } else if (action === 'updateEmployeeLoga') {
      // บันทึกเลขที่ LOGA กลับไปที่คอลัมน์ BR (column 70) ของแถวพนักงานนั้น
      var sheet = ss.getSheetByName('DATA');
      if (!sheet) throw new Error('Sheet DATA not found');
      var hrCode = data.hrCode;
      var values = sheet.getDataRange().getValues();
      var found = false;
      for (var i = 1; i < values.length; i++) {
        if (values[i][2] == hrCode) {
          sheet.getRange(i + 1, 70).setValue(data.loga || ''); // column 70 = BR = LOGA
          found = true;
          break;
        }
      }
      if (found) {
        response.status = 'success';
        response.message = 'บันทึกเลขที่ LOGA เรียบร้อย';
      } else {
        response.status = 'error';
        response.message = 'ไม่พบรหัสพนักงานนี้';
      }

    } else if (action === 'getScheduleEmployees') {
      var sheet = ss.getSheetByName('DATA');
      if (!sheet) throw new Error('Sheet DATA not found');
      var values = sheet.getDataRange().getValues();
      var reqBranch = (data.branch || '').toLowerCase();
      var employees = [];
      for (var i = 1; i < values.length; i++) {
        var row = values[i];
        if (!row[0] && !row[2]) continue;
        var empBranch = row[4] ? row[4].toString().toLowerCase() : '';
        var isMatch = reqBranch === 'all' || empBranch.indexOf(reqBranch) !== -1 || reqBranch.indexOf(empBranch) !== -1;
        if (isMatch && row[6] === 'ทำงาน') {
          employees.push({
            hrCode: row[2] || '',
            name: row[3] || '',
            branch: row[4] || '',
            type: row[5] || '',
            status: row[6] || '',
            position: row[8] || '',
            dailyWage: row[9] || ''
          });
        }
      }
      // Simple sort by position
      const posPriority = { 'ผู้จัดการ': 1, 'ผช.ผู้จัดการ': 2, 'ซุปเปอร์ไวเซอร์': 3, 'แคชเชียร์': 4, 'บริการ': 5, 'กุ๊ก': 6, 'ล้างจาน': 7 };
      employees.sort((a, b) => (posPriority[a.position] || 99) - (posPriority[b.position] || 99));
      response.status = 'success';
      response.data = employees;
    } else if (action === 'saveTimesheet') {
      var destSs = SpreadsheetApp.openById('1bGSENQjSmmYv8V84aInyqk-K7r4niSXFlPqv0zEFQ1U');
      var sheet = destSs.getSheetByName('ลงตารางงาน');
      if (!sheet) {
        sheet = destSs.insertSheet('ลงตารางงาน');
        sheet.appendRow([
          'Timestamp', 'วันที่ลงงาน', 'สาขา', 'รหัส HR', 'ชื่อ-สกุล', 'ตำแหน่ง',
          'เวลาเข้า', 'เวลาออก', 'เวลาเบรค', 'OT (ชม.)', 'ค่าแรง (บาท)', 'สถานะ',
          'ลา/หมายเหตุ (รับค่าแรง)', 'ประเภท', 'หยุดไม่รับค่าแรง', 'ชั่วโมงสะสม',
          'ลารายชั่วโมง (ชม.)', 'หมายเหตุเพิ่มเติม', 'ช่วงเวลาเบรค', 'จุดปฏิบัติงาน', 'ผู้อนุมัติ OT', 'ใช้ชั่วโมงสะสม'
        ]);
      }
      var logs = data.logs || [];
      var timestamp = new Date();
      // สร้างแถวทั้งหมดก่อนแล้วเขียนทีเดียวด้วย setValues
      // เดิมใช้ appendRow ทีละแถว = กดบันทึกตารางงาน 1 สัปดาห์ (พนักงาน 20 คน x 7 วัน) เขียนชีท 140 ครั้ง
      // ยิ่งชีท 'ลงตารางงาน' ยาวขึ้นทุกวัน แต่ละครั้งยิ่งช้า จนเกิน timeout ฝั่งเว็บ -> ผู้ใช้เห็นว่า "บันทึกไม่ไป"
      // ทั้งที่ GAS ยังเขียนต่อจนจบ กลายเป็นข้อมูลค้างครึ่งๆ กลางๆ (คำสั่งบันทึกไม่ลองใหม่อัตโนมัติ)
      var tsRows = logs.map(function (item) {
        return [
          timestamp, item.workDate, item.branch, item.hrCode, item.name, item.position,
          item.checkIn || '', item.checkOut || '', item.breakTime || '', item.ot || '', item.wage || '',
          item.status || '', item.leaveNote || '', item.empType || '', item.unpaidLeave || '',
          item.otAccumulated || '', item.hourlyLeave || '', item.otherNote || item.note || '',
          item.breakTimeRange || '', item.workStation || '', '', item.useAccumulatedHours || ''
        ];
      });
      if (tsRows.length) {
        appendRowsBatch(sheet, tsRows);
        SpreadsheetApp.flush();
      }
      response.status = 'success';
      response.message = 'บันทึกสำเร็จ ' + tsRows.length + ' รายการ';
    } else if (action === 'getHistoryData') {
      var destSs = SpreadsheetApp.openById('1bGSENQjSmmYv8V84aInyqk-K7r4niSXFlPqv0zEFQ1U');
      var sheet = destSs.getSheetByName('ลงตารางงาน');
      if (!sheet) {
        response.status = 'success';
        response.data = [];
      } else {
        var values = sheet.getDataRange().getValues();
        var reqBranch = (data.branch || '').toLowerCase();
        var reqDate = data.date || '';
        var history = [];
        for (var i = 1; i < values.length; i++) {
          var row = values[i];
          var empBranch = row[2] ? row[2].toString().toLowerCase() : ''; // สาขา (Col C)
          var isMatchBranch = reqBranch === 'all' || empBranch.indexOf(reqBranch) !== -1 || reqBranch.indexOf(empBranch) !== -1;

          var rowDate = '';
          if (row[1] instanceof Date) { rowDate = Utilities.formatDate(row[1], Session.getScriptTimeZone(), 'yyyy-MM-dd'); } else { rowDate = String(row[1]); }

          var isMatchDate = true;
          if (data.startDate && data.endDate) {
            isMatchDate = (rowDate >= data.startDate && rowDate <= data.endDate);
          } else {
            isMatchDate = !reqDate || rowDate.indexOf(reqDate) !== -1;
          }

          if (isMatchBranch && isMatchDate) {
            var checkInVal = row[6];
            if (checkInVal instanceof Date) { checkInVal = Utilities.formatDate(checkInVal, "Asia/Bangkok", "HH:mm"); } else { checkInVal = String(checkInVal || ''); }

            var checkOutVal = row[7];
            if (checkOutVal instanceof Date) { checkOutVal = Utilities.formatDate(checkOutVal, "Asia/Bangkok", "HH:mm"); } else { checkOutVal = String(checkOutVal || ''); }

            history.push({
              timestamp: row[0],
              workDate: rowDate,
              branch: row[2],
              hrCode: row[3],
              name: row[4],
              position: row[5],
              checkIn: checkInVal,
              checkOut: checkOutVal,
              breakTime: row[8],
              ot: row[9],
              wage: row[10],
              status: row[11],
              leaveNote: row[12],
              empType: row[13],
              unpaidLeave: row[14],
              otAccumulated: row[15],
              hourlyLeave: row[16],
              otherNote: row[17],
              breakTimeRange: row[18],
              workStation: row[19],
              otApprover: row[20],
              useAccumulatedHours: row[21]
            });
          }
        }
        // ล่าสุดอยู่ล่างสุด ดังนั้นเวลาเรียงควรจะเอาอันล่าสุดก่อนไหม? แต่เดิม script ให้ sort by position.
        // Simple sort by position
        const posPriority = { 'ผู้จัดการ': 1, 'ผช.ผู้จัดการ': 2, 'ซุปเปอร์ไวเซอร์': 3, 'แคชเชียร์': 4, 'บริการ': 5, 'กุ๊ก': 6, 'ล้างจาน': 7 };
        history.sort((a, b) => (posPriority[a.position] || 99) - (posPriority[b.position] || 99));
        response.status = 'success';
        response.data = history;
      }
    } else if (action === 'getBranches') {
      // ดึงรายชื่อสาขาจากชีท User (ชีทหลัก) คอลัมน์ C
      var userSheet = ss.getSheetByName('User');
      var branches = [];
      if (userSheet) {
        var uData = userSheet.getDataRange().getValues();
        var branchSet = {};
        for (var r = 1; r < uData.length; r++) { // เริ่มที่ 1 เพื่อข้ามแถว header (ชื่อสาขา/รหัสสาขา)
          var br = uData[r][2]; // Column C = Branch
          var oId = uData[r][3]; // Column D = Outlet ID
          if (br && String(br).toLowerCase() !== 'all' && !branchSet[String(br).toLowerCase()]) {
            branchSet[String(br).toLowerCase()] = true;
            branches.push({ name: br, outletId: oId || '' });
          }
        }
      }
      response.status = 'success';
      // Sort by name
      response.data = branches.sort(function (a, b) {
        return a.name.localeCompare(b.name);
      });
    } else if (action === 'getStockItems') {
      // ชั่วคราว: จับเวลาแต่ละขั้นตอนเพื่อหาสาเหตุที่หน้านับสต๊อกโหลดช้า (ลบออกได้เมื่อหาสาเหตุเจอแล้ว)
      var _debug = !!data.debug;
      var _t0 = new Date().getTime();
      var _timing = {};
      var reqBranch = (data.branch || '').toLowerCase();
      var cachedItems = data.debug ? null : getStockItemsFromCache(reqBranch); // debug:true ข้าม cache เสมอ กันเทสเวลาเพี้ยน
      _timing.cacheHit = !!cachedItems;
      if (cachedItems) {
        response.status = 'success';
        response.data = cachedItems;
        if (_debug) response._timing = _timing;
      } else {
      var stockSs = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ');
      _timing.openStockSs = new Date().getTime() - _t0;

      var balanceMap = {};
      var balanceSheet = stockSs.getSheetByName('ยอดยกมา');

      // Helper function to normalize ID (remove leading zeros for safe matching)
      var normalizeId = function (id) {
        if (id === null || id === undefined) return '';
        return String(id).replace(/^0+/, '').toLowerCase();
      };

      if (balanceSheet) {
        var balValues = balanceSheet.getDataRange().getValues();
        for (var b = 1; b < balValues.length; b++) {
          var bRow = balValues[b];
          var bProductId = normalizeId(bRow[0]);
          var bBranch = bRow[2] ? bRow[2].toString().toLowerCase() : '';
          var bBalance = bRow[3];
          var bDate = bRow[4];
          if (bProductId && bBranch === reqBranch) {
            balanceMap[bProductId] = {
              balance: bBalance,
              date: bDate instanceof Date ? Utilities.formatDate(bDate, "Asia/Bangkok", "dd/MM/yyyy HH:mm") : bDate
            };
          }
        }
      }
      _timing.readBalanceSheet = new Date().getTime() - _t0;

      // Build lastStock map from ข้อมูลนับสตอค sheet — keep full history per product
      var lastStockMap = {};
      var previousStockMap = {}; // second-to-last = ยอดยกมา
      var stockHistoryMap = {}; // all entries sorted oldest-first
      var countSheetR = stockSs.getSheetByName('ข้อมูลนับสตอค');
      if (_debug && countSheetR) {
        _timing.countSheetDims = {
          lastRow: countSheetR.getLastRow(), lastCol: countSheetR.getLastColumn(),
          maxRows: countSheetR.getMaxRows(), maxCols: countSheetR.getMaxColumns()
        };
      }
      _timing.beforeCountRead = new Date().getTime() - _t0;
      if (countSheetR && countSheetR.getLastRow() > 1) {
        var csValues = countSheetR.getDataRange().getValues();
        for (var cs = 1; cs < csValues.length; cs++) {
          var csRow = csValues[cs];
          var csBranch = csRow[2] ? csRow[2].toString().toLowerCase() : '';
          var csPid = normalizeId(csRow[3]);
          var csDate = csRow[0];
          var csRemaining = csRow[6];
          var csCounter = csRow[1];
          var csDateStr = csDate instanceof Date ? Utilities.formatDate(csDate, "Asia/Bangkok", "dd/MM/yyyy HH:mm") : csDate;
          if (csPid && csBranch === reqBranch) {
            if (lastStockMap[csPid]) {
              previousStockMap[csPid] = lastStockMap[csPid];
            }
            lastStockMap[csPid] = {
              remaining: csRemaining,
              date: csDateStr,
              counter: csCounter
            };
            if (!stockHistoryMap[csPid]) stockHistoryMap[csPid] = [];
            stockHistoryMap[csPid].push({
              remaining: csRemaining,
              date: csDateStr,
              counter: csCounter
            });
          }
        }
      }
      _timing.readCountSheet = new Date().getTime() - _t0;

      // Build lastRequest map from ข้อมูลเบิก sheet (latest request per product per branch)
      var lastRequestMap = {};
      var reqSheetR = stockSs.getSheetByName('ข้อมูมูลเบิก');
      if (!reqSheetR) reqSheetR = stockSs.getSheetByName('ข้อมูลเบิก');
      if (reqSheetR && reqSheetR.getLastRow() > 1) {
        var rqValues = reqSheetR.getDataRange().getValues();
        // A=reqNo, B=date, C=productId, D=name, E=unit, F=qty, G=requestDate, H=requester, I=branch
        for (var rq = 1; rq < rqValues.length; rq++) {
          var rqRow = rqValues[rq];
          var rqPid = normalizeId(rqRow[2]);
          var rqBranch = rqRow[8] ? rqRow[8].toString().toLowerCase() : '';
          // Fallback: parse branch from reqNo prefix (e.g. CRM-2605-0001 -> crm)
          if (!rqBranch && rqRow[0]) {
            rqBranch = rqRow[0].toString().substring(0, 3).toLowerCase();
          }
          var rqQty = rqRow[5];
          var rqDate = rqRow[1];
          var rqRequester = rqRow[7];
          if (rqPid && rqBranch === reqBranch) {
            lastRequestMap[rqPid] = {
              qty: rqQty,
              date: rqDate instanceof Date ? Utilities.formatDate(rqDate, "Asia/Bangkok", "dd/MM/yyyy HH:mm") : rqDate,
              requester: rqRequester
            };
          }
        }
      }

      var categoryMap = {};
      var categorySheet = stockSs.getSheetByName('หมวดจัดเก็บสาขา');
      if (categorySheet) {
        var catValues = categorySheet.getDataRange().getValues();
        for (var c = 1; c < catValues.length; c++) {
          var cRow = catValues[c];
          var cProductId = normalizeId(cRow[0]);
          var cBranch = cRow[2] ? cRow[2].toString().toLowerCase() : '';
          var cCategory = cRow[3];
          if (cProductId && cBranch === reqBranch) {
            categoryMap[cProductId] = cCategory;
          }
        }
      }
      _timing.readCategorySheet = new Date().getTime() - _t0;

      // รายการสินค้า: อ่านจากชีท "item" ในไฟล์ BOM แทน แล้วกรองเฉพาะสาขานี้ (คอลัมน์ J = สาขาที่ใช้)
      //   A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ ... J(index9)=สาขาที่ใช้ (คั่นด้วย , เช่น "CRM,HRS,XHH") K(index10)=itemid L(index11)=หน่วยเบิก N(index13)=หมวดสโตร์ O(index14)=Plan (true=สั่งได้เฉพาะปุ่ม "สั่งสินค้าแพลน/สั่งเพิ่มเติม" เท่านั้น)
      var itemSs = SpreadsheetApp.openById('1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw');
      _timing.openItemSs = new Date().getTime() - _t0;
      var sheet = itemSs.getSheetByName('item');
      if (!sheet) throw new Error('Sheet "item" not found');
      var values = sheet.getDataRange().getValues();
      _timing.readItemSheet = new Date().getTime() - _t0;
      // สาขาในชีทเป็นตัวใหญ่ (SJP,CRM..) เว็บใช้ zjp = SJP ในชีท
      var itemBranchAlias = { 'zjp': 'sjp', 'zip': 'sjp' };
      var reqBranchU = (itemBranchAlias[reqBranch] || reqBranch).toUpperCase();
      var items = [];
      for (var i = 1; i < values.length; i++) {
        var row = values[i];
        if (!row[0] && !row[1]) continue;
        // กรองสาขา: คอลัมน์ J (index 9) ต้องมีรหัสสาขานี้
        var brStr = String(row[9] == null ? '' : row[9]).toUpperCase();
        var brArr = brStr.split(/[,\s]+/);
        if (brArr.indexOf(reqBranchU) === -1) continue;
        // ข้ามสินค้าที่ปิดการใช้งาน (คอลัมน์ E)
        if (String(row[4] || '').trim() === 'ปิดการใช้งาน') continue;
        var pId = row[0] || '';
        var normId = normalizeId(pId);
        items.push({
          productId: pId,
          itemId: row[10] || '',         // K = itemid (ใช้ตอนส่งใบสั่งของเข้า POS)
          name: row[1] || '',
          unit: row[3] || '',            // D = หน่วย
          price: row[2] || '',           // C = ราคา
          status: row[4] || '',          // E = สถานะ
          storeCat: row[13] || '',       // N = หมวดสโตร์ (ใช้จัดกลุ่มตอนสั่งของ)
          planOnly: /^(true|ture)$/i.test(String(row[14] || '').trim()), // O = Plan (สั่งได้เฉพาะปุ่ม "สั่งสินค้าแพลน" เท่านั้น)
          storageCat: categoryMap[normId] !== undefined ? categoryMap[normId] : '',
          rdCat: '',
          previousBalance: previousStockMap[normId] ? previousStockMap[normId].remaining : (balanceMap[normId] ? balanceMap[normId].balance : ''),
          previousBalanceDate: previousStockMap[normId] ? previousStockMap[normId].date : (balanceMap[normId] ? balanceMap[normId].date : ''),
          lastStock: lastStockMap[normId] ? lastStockMap[normId].remaining : '',
          lastStockDate: lastStockMap[normId] ? lastStockMap[normId].date : '',
          lastStockCounter: lastStockMap[normId] ? lastStockMap[normId].counter : '',
          stockHistory: stockHistoryMap[normId] ? stockHistoryMap[normId] : [],
          lastRequest: lastRequestMap[normId] ? lastRequestMap[normId].qty : '',
          lastRequestDate: lastRequestMap[normId] ? lastRequestMap[normId].date : '',
          lastRequester: lastRequestMap[normId] ? lastRequestMap[normId].requester : ''
        });
      }
      _timing.buildItems = new Date().getTime() - _t0;
      response.status = 'success';
      response.data = items;
      putStockItemsToCache(reqBranch, items);
      if (_debug) response._timing = _timing;
      } // ปิด if (!cachedItems)
    } else if (action === 'getClosingItems') {
      // รายการสินค้าแบบเบา สำหรับหน้า "ปิดยอดสิ้นเดือน" ที่ใช้แค่ รหัส/ชื่อ/หน่วย/ราคา
      // ต่างจาก getStockItems ตรงที่ไม่แตะไฟล์สต๊อกเลย จึงไม่ต้องอ่านชีท "ข้อมูลนับสตอค" 25,000+ แถว
      // (getStockItems กินเวลา ~20 วิ จนหน้าปิดยอดหมดเวลารอ ทั้งที่ข้อมูล 90% ที่อ่านมาไม่ได้ใช้)
      var ciBranch = (data.branch || '').toLowerCase();
      var ciCacheKey = 'closingItems_' + ciBranch;
      var ciCached = data.debug ? null : getCachedJson(ciCacheKey);
      if (ciCached) {
        response.status = 'success';
        response.data = ciCached;
      } else {
        var ciSs = SpreadsheetApp.openById('1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw');
        var ciSheet = ciSs.getSheetByName('item');
        if (!ciSheet) throw new Error('Sheet "item" not found');
        var ciLastRow = ciSheet.getLastRow();
        var ciItems = [];
        if (ciLastRow > 1) {
          // อ่านแค่คอลัมน์ A–J (ที่ใช้จริง) แทน getDataRange() ที่ลากมาทุกคอลัมน์
          // A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ J=สาขาที่ใช้
          var ciValues = ciSheet.getRange(2, 1, ciLastRow - 1, 10).getValues();
          var ciAlias = { 'zjp': 'sjp', 'zip': 'sjp' }; // เว็บใช้ zjp แต่ในชีทเป็น SJP
          var ciBranchU = (ciAlias[ciBranch] || ciBranch).toUpperCase();
          for (var ci = 0; ci < ciValues.length; ci++) {
            var ciRow = ciValues[ci];
            if (!ciRow[0] && !ciRow[1]) continue;
            var ciBrArr = String(ciRow[9] == null ? '' : ciRow[9]).toUpperCase().split(/[,\s]+/);
            if (ciBrArr.indexOf(ciBranchU) === -1) continue;
            if (String(ciRow[4] || '').trim() === 'ปิดการใช้งาน') continue;
            ciItems.push({
              productId: ciRow[0] || '',
              name: ciRow[1] || '',
              unit: ciRow[3] || '',
              price: ciRow[2] || ''
            });
          }
        }
        response.status = 'success';
        response.data = ciItems;
        putCachedJson(ciCacheKey, ciItems, CLOSING_ITEMS_CACHE_TTL);
      }
    } else if (action === 'getStockTotal') {
      var endDateStr = data.endDate || '';
      var endDateObj = null;
      if (endDateStr) {
        var parts = endDateStr.split('-');
        endDateObj = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59);
      }

      var stockSs = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ');

      var normalizeId = function (id) {
        if (id === null || id === undefined) return '';
        return String(id).replace(/^0+/, '').toLowerCase();
      };

      // 1. Read ยอดยกมา
      var balancesMap = {}; // { pid: { branch: { balance, date } } }
      var balanceSheet = stockSs.getSheetByName('ยอดยกมา');
      if (balanceSheet) {
        var balValues = balanceSheet.getDataRange().getValues();
        for (var b = 1; b < balValues.length; b++) {
          var bRow = balValues[b];
          var bProductId = normalizeId(bRow[0]);
          var bBranch = bRow[2] ? bRow[2].toString().toLowerCase() : '';
          var bBalance = parseFloat(bRow[3]);
          var bDate = bRow[4];
          if (bProductId && bBranch && !isNaN(bBalance)) {
            if (!balancesMap[bProductId]) balancesMap[bProductId] = {};
            balancesMap[bProductId][bBranch] = {
              balance: bBalance,
              date: bDate instanceof Date ? bDate : null
            };
          }
        }
      }

      // 2. Read ข้อมูลนับสตอค and get the LATEST count <= endDate for each branch
      var latestCountMap = {}; // { pid: { branch: { remaining, date } } }
      var countSheetR = stockSs.getSheetByName('ข้อมูลนับสตอค');
      if (countSheetR && countSheetR.getLastRow() > 1) {
        var csValues = countSheetR.getDataRange().getValues();
        for (var cs = 1; cs < csValues.length; cs++) {
          var csRow = csValues[cs];
          var csDate = csRow[0];
          var csCounter = csRow[1];
          var csBranch = csRow[2] ? csRow[2].toString().toLowerCase() : '';
          var csPid = normalizeId(csRow[3]);
          var csRemaining = parseFloat(csRow[6]);

          if (csPid && csBranch && !isNaN(csRemaining)) {
            var rowDateObj = csDate instanceof Date ? csDate : new Date(csDate);
            // Check if within endDate
            if (!endDateObj || rowDateObj <= endDateObj) {
              if (!latestCountMap[csPid]) latestCountMap[csPid] = {};
              // Keep the latest date
              if (!latestCountMap[csPid][csBranch] || rowDateObj > latestCountMap[csPid][csBranch].dateObj) {
                latestCountMap[csPid][csBranch] = {
                  remaining: csRemaining,
                  dateObj: rowDateObj,
                  dateStr: Utilities.formatDate(rowDateObj, "Asia/Bangkok", "dd/MM/yyyy HH:mm")
                };
              }
            }
          }
        }
      }

      var categoryMap = {};
      var categorySheet = stockSs.getSheetByName('หมวดจัดเก็บสาขา');
      if (categorySheet) {
        var catValues = categorySheet.getDataRange().getValues();
        for (var c = 1; c < catValues.length; c++) {
          var cRow = catValues[c];
          var cProductId = normalizeId(cRow[0]);
          var cBranch = cRow[2] ? cRow[2].toString().toLowerCase() : '';
          var cCategory = cRow[3];
          if (cProductId && cBranch) {
            // we'll just take the first encountered category for "all" since it varies by branch
            if (!categoryMap[cProductId]) {
              categoryMap[cProductId] = cCategory;
            }
          }
        }
      }

      var sheet = stockSs.getSheetByName('รายการสินค้า');
      if (!sheet) throw new Error('Sheet "รายการสินค้า" not found');
      var values = sheet.getDataRange().getValues();
      var items = [];

      for (var i = 1; i < values.length; i++) {
        var row = values[i];
        if (!row[0] && !row[1]) continue;
        var pId = row[0] || '';
        var normId = normalizeId(pId);

        // Calculate Total Remaining
        var totalRemaining = 0;
        var branchesAccounted = {};
        var maxDateObj = null;
        var hasAnyStock = false;
        var branchDetails = [];

        // Add from latest count first
        if (latestCountMap[normId]) {
          for (var br in latestCountMap[normId]) {
            totalRemaining += latestCountMap[normId][br].remaining;
            branchesAccounted[br] = true;
            hasAnyStock = true;
            if (!maxDateObj || latestCountMap[normId][br].dateObj > maxDateObj) {
              maxDateObj = latestCountMap[normId][br].dateObj;
            }
            branchDetails.push({
              branch: br,
              remaining: latestCountMap[normId][br].remaining,
              date: latestCountMap[normId][br].dateStr,
              type: 'นับล่าสุด'
            });
          }
        }

        // Add from balances if no count exists for that branch
        if (balancesMap[normId]) {
          for (var br in balancesMap[normId]) {
            if (!branchesAccounted[br]) {
              totalRemaining += balancesMap[normId][br].balance;
              hasAnyStock = true;
              var bDateStr = '';
              if (balancesMap[normId][br].date) {
                if (!maxDateObj || balancesMap[normId][br].date > maxDateObj) {
                  maxDateObj = balancesMap[normId][br].date;
                }
                bDateStr = Utilities.formatDate(balancesMap[normId][br].date, "Asia/Bangkok", "dd/MM/yyyy HH:mm");
              }
              branchDetails.push({
                branch: br,
                remaining: balancesMap[normId][br].balance,
                date: bDateStr,
                type: 'ยอดยกมา'
              });
            }
          }
        }

        items.push({
          productId: pId,
          name: row[1] || '',
          unit: row[2] || '',
          storeCat: row[3] || '',
          storageCat: categoryMap[normId] !== undefined ? categoryMap[normId] : (row[4] || ''),
          rdCat: row[5] || '',
          totalRemaining: hasAnyStock ? Number(totalRemaining.toFixed(2)) : '',
          lastDate: maxDateObj ? Utilities.formatDate(maxDateObj, "Asia/Bangkok", "dd/MM/yyyy HH:mm") : '',
          branchDetails: branchDetails
        });
      }
      response.status = 'success';
      response.data = items;
    } else if (action === 'saveSupCost') {
      // กรอกรายจ่าย (ต้นทุนจาก Supplier): บันทึกลงชีท "ต้นทุนจากsup"
      // ราคา/หน่วยอ่านสดจากชีท 8.2 (ไฟล์สต๊อก) ฝั่ง server — client ส่งมาแค่ code/qty
      var supSs = SpreadsheetApp.openById('1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw');
      var supSheet = supSs.getSheetByName('ต้นทุนจากsup');
      if (!supSheet) {
        supSheet = supSs.insertSheet('ต้นทุนจากsup');
        supSheet.appendRow(['วันที่', 'สาขา', 'รหัส', 'ชื่อรายการ', 'หน่วย', 'จำนวน', 'ราคา/หน่วย', 'มูลค่ารวม', 'ผู้บันทึก', 'เวลาบันทึก']);
        supSheet.getRange('A1:J1').setFontWeight('bold');
      }

      var supNorm = function (id) { return String(id == null ? '' : id).replace(/^0+/, '').trim(); };
      // ราคาจากชีท 8.2: [0]=รหัส [2]=ราคา
      var priceMap82 = {};
      var priceSheet = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ').getSheetByName('8.2');
      if (priceSheet) {
        var pv = priceSheet.getDataRange().getValues();
        for (var pi = 1; pi < pv.length; pi++) {
          var pCode = supNorm(pv[pi][0]);
          var pPrice = parseFloat(pv[pi][2]);
          if (pCode && !isNaN(pPrice)) priceMap82[pCode] = pPrice;
        }
      }

      var supItems = data.items || [];
      var supBranch = (data.branch || '').toLowerCase();
      var supDate = data.date || '';
      var supRecorder = data.recorder || 'Unknown';
      if (!supBranch) throw new Error('ไม่ระบุสาขา');
      if (!supDate) throw new Error('ไม่ระบุวันที่');
      if (!supItems.length) throw new Error('ไม่มีรายการที่กรอกจำนวน');

      // header คอลัมน์ K = เวลาแก้ไข (เติมให้ถ้ายังไม่มี)
      if (String(supSheet.getRange(1, 11).getValue() || '') === '') {
        supSheet.getRange(1, 11).setValue('เวลาแก้ไข').setFontWeight('bold');
      }

      // แปลงวันที่ในชีทเป็น YYYY-MM-DD (รองรับทั้ง Date object และข้อความ)
      var supToYmd = function (v) {
        if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
        var s = String(v == null ? '' : v).trim();
        var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
        return s;
      };

      // หาแถวเดิมของ (วันที่+สาขา+รหัส) — ถ้ามีจะแก้ทับ cell เดิมแทนการเพิ่มแถวใหม่ (ซ้ำหลายแถวเอาแถวหลังสุด)
      var existRow = {}; // codeN -> row number (1-based)
      var supVals = supSheet.getDataRange().getValues();
      for (var sv = 1; sv < supVals.length; sv++) {
        if (String(supVals[sv][1] || '').toLowerCase().trim() !== supBranch) continue;
        if (supToYmd(supVals[sv][0]) !== supDate) continue;
        existRow[supNorm(supVals[sv][2])] = sv + 1;
      }

      var supNow = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
      var supTotal = 0, supNew = 0, supUpd = 0;
      var supNewRows = []; // เก็บแถวใหม่ไว้เขียนทีเดียวท้ายสุด แทน appendRow ทีละรายการ
      supItems.forEach(function (it) {
        var q = parseFloat(it.qty);
        if (isNaN(q) || q <= 0) return;
        var codeN = supNorm(it.code);
        // รายการที่กรอกราคาเอง (manualPrice เช่น น้ำแข็ง 11100100) ใช้ราคาที่ user กรอกเสมอ
        // รายการปกติใช้ราคาจากชีท 8.2 (ถ้าไม่มีจึงใช้ราคาที่ส่งมา)
        var unitPrice;
        if (it.manualPrice) {
          unitPrice = parseFloat(it.price) || 0;
        } else {
          unitPrice = priceMap82[codeN] !== undefined ? priceMap82[codeN] : (parseFloat(it.price) || 0);
        }
        var amount = Math.round(q * unitPrice * 100) / 100;
        if (existRow[codeN]) {
          // แก้ทับแถวเดิม: จำนวน/ราคา/มูลค่า (คอลัมน์ F,G,H) + เวลาแก้ไข (คอลัมน์ K)
          var rowN = existRow[codeN];
          supSheet.getRange(rowN, 6, 1, 3).setValues([[q, unitPrice, amount]]);
          supSheet.getRange(rowN, 11).setValue(supNow);
          supUpd++;
        } else {
          supNewRows.push([supDate, supBranch, /^\d+$/.test(codeN) ? Number(codeN) : codeN, it.name || '', it.unit || '', q, unitPrice, amount, supRecorder, supNow, '']);
          supNew++;
        }
        supTotal += amount;
      });
      if (supNewRows.length) {
        appendRowsBatch(supSheet, supNewRows);
        SpreadsheetApp.flush();
      }

      response.status = 'success';
      response.message = 'บันทึกแล้ว ' + (supNew + supUpd) + ' รายการ (ใหม่ ' + supNew + ' / แก้ไข ' + supUpd + ') รวม ฿' + supTotal.toFixed(2);
      response.data = { count: supNew + supUpd, updated: supUpd, total: Math.round(supTotal * 100) / 100 };

    } else if (action === 'getSupCost') {
      // ดึงรายจ่ายที่บันทึกไว้ของ (สาขา+วันที่) มาแก้ไขในหน้ากรอกรายจ่าย
      var gscSs = SpreadsheetApp.openById('1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw');
      var gscSheet = gscSs.getSheetByName('ต้นทุนจากsup');
      var gscBranch = (data.branch || '').toLowerCase().trim();
      var gscDate = String(data.date || '').trim();
      var gscNorm = function (id) { return String(id == null ? '' : id).replace(/^0+/, '').trim(); };
      var gscToYmd = function (v) {
        if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
        var s = String(v == null ? '' : v).trim();
        var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
        return s;
      };
      var gscOut = {};
      if (gscSheet && gscSheet.getLastRow() > 1 && gscBranch && gscDate) {
        var gscVals = gscSheet.getDataRange().getValues();
        for (var gi = 1; gi < gscVals.length; gi++) {
          var gr = gscVals[gi];
          if (String(gr[1] || '').toLowerCase().trim() !== gscBranch) continue;
          if (gscToYmd(gr[0]) !== gscDate) continue;
          // ซ้ำหลายแถว (วัน+สาขา+รหัสเดียวกัน) เอาแถวหลังสุด
          gscOut[gscNorm(gr[2])] = { qty: gr[5], price: gr[6], amount: gr[7] };
        }
      }
      response.status = 'success';
      response.data = gscOut;

    } else if (action === 'saveMonthEndClosing') {
      // ปิดยอดสิ้นเดือน: บันทึกยอดคงเหลือ ณ วันที่ปิดยอด + มูลค่าต่อหน่วย/มูลค่ารวม
      // ลงชีท "ปิดรอบสิ้นเดือน" ในไฟล์สต๊อก — บันทึกใหม่ทุกครั้งแบบเพิ่มแถว (ไม่ทับของเดิม)
      // เพื่อให้เห็นประวัติการบันทึกทั้งหมด ค่าล่าสุด (แถวท้ายสุดของวันที่+สาขา+รหัสเดียวกัน) ถือเป็นค่าปัจจุบัน
      var mecSs = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ');
      var mecSheet = mecSs.getSheetByName('ปิดรอบสิ้นเดือน');
      if (!mecSheet) {
        mecSheet = mecSs.insertSheet('ปิดรอบสิ้นเดือน');
        mecSheet.appendRow(['วันที่ปิดยอด', 'สาขา', 'รหัสสินค้า', 'ชื่อสินค้า', 'หน่วย', 'ยอดคงเหลือสิ้นเดือน', 'มูลค่า/หน่วย', 'มูลค่ารวม', 'ผู้บันทึก', 'เวลาบันทึก']);
        mecSheet.getRange('A1:J1').setFontWeight('bold');
      } else if (mecSheet.getLastRow() < 1 || String(mecSheet.getRange(1, 1).getValue() || '') === '') {
        mecSheet.getRange(1, 1, 1, 10).setValues([['วันที่ปิดยอด', 'สาขา', 'รหัสสินค้า', 'ชื่อสินค้า', 'หน่วย', 'ยอดคงเหลือสิ้นเดือน', 'มูลค่า/หน่วย', 'มูลค่ารวม', 'ผู้บันทึก', 'เวลาบันทึก']]);
        mecSheet.getRange('A1:J1').setFontWeight('bold');
      }

      var mecNorm = function (id) { return String(id == null ? '' : id).replace(/^0+/, '').trim(); };

      var mecItems = data.items || [];
      var mecBranch = (data.branch || '').toLowerCase().trim();
      var mecDate = String(data.date || '').trim();
      var mecRecorder = data.recorder || 'Unknown';
      if (!mecBranch) throw new Error('ไม่ระบุสาขา');
      if (!mecDate) throw new Error('ไม่ระบุวันที่ปิดยอด');
      if (!mecItems.length) throw new Error('ไม่มีรายการที่กรอกยอดคงเหลือ');

      var mecNow = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
      var mecCount = 0, mecTotal = 0;
      // สร้างแถวทั้งหมดก่อนแล้วเขียนทีเดียวด้วย setValues
      // เดิมใช้ appendRow ทีละรายการ = เขียนชีท 200+ ครั้งต่อการกดบันทึกหนึ่งครั้ง ช้าจนหมดเวลารอ
      // และเพราะคำสั่งบันทึกไม่ลองใหม่อัตโนมัติ ถ้าหมดเวลากลางคันจะเหลือข้อมูลค้างครึ่งๆ กลางๆ ในชีท
      var mecRows = [];
      mecItems.forEach(function (it) {
        var q = parseFloat(it.qty);
        if (isNaN(q) || q < 0) return;
        var codeN = mecNorm(it.productId);
        var unitPrice = parseFloat(it.price) || 0;
        var amount = Math.round(q * unitPrice * 100) / 100;
        mecTotal += amount;
        mecRows.push([mecDate, mecBranch, /^\d+$/.test(codeN) ? Number(codeN) : codeN, it.name || '', it.unit || '', q, unitPrice, amount, mecRecorder, mecNow]);
        mecCount++;
      });
      if (mecRows.length) {
        // appendRow ต่อแถวให้เองอัตโนมัติ แต่ setValues ไม่ทำ — ต้องขยายกริดเองก่อนถ้าแถวไม่พอ
        var mecStartRow = mecSheet.getLastRow() + 1;
        var mecNeedRows = mecStartRow + mecRows.length - 1;
        if (mecNeedRows > mecSheet.getMaxRows()) {
          mecSheet.insertRowsAfter(mecSheet.getMaxRows(), mecNeedRows - mecSheet.getMaxRows());
        }
        mecSheet.getRange(mecStartRow, 1, mecRows.length, 10).setValues(mecRows);
        SpreadsheetApp.flush();
      }
      clearCachedJson('monthEnd_' + mecBranch); // เพิ่งบันทึกใหม่ ต้องให้ดึงของสดรอบหน้า ไม่ใช่ค่าเก่าในแคช

      response.status = 'success';
      response.message = 'บันทึกปิดยอดสิ้นเดือนแล้ว ' + mecCount + ' รายการ รวมมูลค่า ฿' + mecTotal.toFixed(2);
      response.data = { count: mecCount, total: Math.round(mecTotal * 100) / 100 };

    } else if (action === 'getMonthEndClosing') {
      // ดึงยอดปิดสิ้นเดือนของสาขานี้มาแสดง — โชว์ "ค่าล่าสุดที่มีบันทึกไว้เสมอ" ไม่ว่าจะเลือกวันที่ไหนอยู่ในหน้าเว็บ
      // (ไม่กรองตามวันที่ที่ส่งมาแล้ว เพราะอยากให้เห็นตัวเลขอ้างอิงล่าสุดตลอด ไม่ใช่ต้องตรงวันที่เป๊ะถึงจะเห็น)
      // วันที่ที่ส่งมา (data.date) ยังใช้ตอนบันทึกใหม่ (saveMonthEndClosing) อยู่ตามเดิม แค่ไม่ใช้กรองตอนดึงมาโชว์แล้ว
      // คืนทั้งค่าล่าสุด (พร้อมวันที่ของค่านั้น) และประวัติการบันทึกทั้งหมดทุกวันที่ของแต่ละรหัสสินค้า
      var gmeSs = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ');
      var gmeSheet = gmeSs.getSheetByName('ปิดรอบสิ้นเดือน');
      var gmeBranch = (data.branch || '').toLowerCase().trim();
      var gmeNorm = function (id) { return String(id == null ? '' : id).replace(/^0+/, '').trim(); };
      var gmeToYmd = function (v) {
        if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
        var s = String(v == null ? '' : v).trim();
        var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
        return s;
      };
      // แคชต่อสาขา: ชีทนี้เขียนต่อท้ายอย่างเดียว ไม่เคยทับของเดิม แถวจึงสะสมขึ้นทุกเดือน
      // และช่วงวันที่ 25–5 ทุกสาขาเข้ามาพร้อมกัน อ่านสดทุกครั้งจะชนกันเองจนหมดเวลารอ
      // แคชถูกล้างทันทีที่มีการบันทึกใหม่ของสาขานั้น (ดู saveMonthEndClosing) จึงไม่มีปัญหาเห็นค่าเก่าค้าง
      var gmeCacheKey = 'monthEnd_' + gmeBranch;
      var gmeCached = gmeBranch ? getCachedJson(gmeCacheKey) : null;
      if (gmeCached) {
        response.status = 'success';
        response.data = gmeCached;
        return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
      }
      var gmeOut = {};
      if (gmeSheet && gmeSheet.getLastRow() > 1 && gmeBranch) {
        // อ่านเฉพาะคอลัมน์ A–J ที่ใช้จริง แทน getDataRange() ที่ลากทุกคอลัมน์ในชีทมาด้วย
        // (เผื่อกรณีมีคนลบคอลัมน์ท้ายๆ ทิ้ง ขอไม่เกินจำนวนคอลัมน์ที่มีจริง กัน getRange พังทั้งคำสั่ง)
        var gmeVals = gmeSheet.getRange(1, 1, gmeSheet.getLastRow(), Math.min(10, gmeSheet.getMaxColumns())).getValues();
        for (var gm = 1; gm < gmeVals.length; gm++) {
          var gmr = gmeVals[gm];
          if (String(gmr[1] || '').toLowerCase().trim() !== gmeBranch) continue;
          var gmeCode = gmeNorm(gmr[2]);
          var gmeRowDate = gmeToYmd(gmr[0]);
          if (!gmeOut[gmeCode]) gmeOut[gmeCode] = { qty: gmr[5], price: gmr[6], amount: gmr[7], date: gmeRowDate, history: [] };
          // เจอแถวใหม่ที่ตำแหน่งหลังกว่า (แถวถัดลงมา) ถือเป็นค่าล่าสุด แทนที่ qty/price/amount/date ปัจจุบันเสมอ (ไม่สนวันที่)
          gmeOut[gmeCode].qty = gmr[5];
          gmeOut[gmeCode].price = gmr[6];
          gmeOut[gmeCode].amount = gmr[7];
          gmeOut[gmeCode].date = gmeRowDate;
          gmeOut[gmeCode].history.push({
            date: gmeRowDate, qty: gmr[5], price: gmr[6], amount: gmr[7],
            recorder: gmr[8] || '', time: gmr[9] || ''
          });
        }
        putCachedJson(gmeCacheKey, gmeOut, MONTH_END_CACHE_TTL); // เก็บไว้ให้คนถัดไปในช่วง 2 นาทีไม่ต้องอ่านชีทซ้ำ
      }
      response.status = 'success';
      response.data = gmeOut;

    } else if (action === 'savePlanOrderLog') {
      // บันทึกใบสั่งจากปุ่ม "สั่งสินค้าแพลน/สั่งเพิ่มเติม" ลงชีท "plan" (gid=571271047)
      // เขียนคู่กับตอนที่ /api/insert_order บันทึกลง MySQL แล้ว (SQL คือ source of truth ชีทนี้คือสำเนาไว้ดู)
      var planSs = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ');
      var planSheet = null;
      var planAllSheets = planSs.getSheets();
      for (var psi = 0; psi < planAllSheets.length; psi++) {
        if (planAllSheets[psi].getSheetId() === 571271047) { planSheet = planAllSheets[psi]; break; }
      }
      if (!planSheet) throw new Error('ไม่พบชีท plan (gid=571271047)');

      var planHeader = ['วันที่สั่ง', 'เวลาบันทึก', 'สาขา', 'รหัสสาขา', 'เลขที่ใบสั่ง', 'ลำดับ', 'วันที่รับ', 'itemId', 'รหัสสินค้า', 'ชื่อสินค้า', 'จำนวน', 'หน่วย', 'ราคา/หน่วย', 'มูลค่ารวม', 'ประเภท', 'ผู้บันทึก'];
      if (planSheet.getLastRow() < 1 || String(planSheet.getRange(1, 1).getValue() || '') === '') {
        planSheet.getRange(1, 1, 1, planHeader.length).setValues([planHeader]);
        planSheet.getRange(1, 1, 1, planHeader.length).setFontWeight('bold');
      }

      var planItems = data.items || [];
      if (!planItems.length) throw new Error('ไม่มีรายการที่สั่ง');
      var planNow = new Date();
      var planDateStr = Utilities.formatDate(planNow, 'Asia/Bangkok', 'dd/MM/yyyy');
      var planTimeStr = Utilities.formatDate(planNow, 'Asia/Bangkok', 'HH:mm:ss');
      var planRows = [];
      planItems.forEach(function (it, idx) {
        var pQty = Number(it.qty) || 0;
        var pPrice = Number(it.price) || 0;
        planRows.push([
          planDateStr, planTimeStr, data.branch || '', data.outletId || '',
          data.orderNo || '', idx + 1, data.deldate || '',
          it.itemId || '', it.itemCode || '', it.itemName || '',
          pQty, it.unit || '', pPrice, Math.round(pQty * pPrice * 100) / 100,
          'TRF', data.requester || ''
        ]);
      });
      planSheet.getRange(planSheet.getLastRow() + 1, 1, planRows.length, planHeader.length).setValues(planRows);

      response.status = 'success';
      response.data = { count: planRows.length };

    } else if (action === 'saveWaste') {
      // บันทึกของเสีย (WASTE) — ลงชีท "waste" (gid=1493705916) แบบเพิ่มแถวใหม่ทุกครั้ง (log ต่อเนื่อง ไม่ใช่ยอดสรุป)
      var wsSs = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ');
      var wsSheet = null;
      var wsAllSheets = wsSs.getSheets();
      for (var wsi = 0; wsi < wsAllSheets.length; wsi++) {
        if (wsAllSheets[wsi].getSheetId() === 1493705916) { wsSheet = wsAllSheets[wsi]; break; }
      }
      if (!wsSheet) throw new Error('ไม่พบชีท waste (gid=1493705916)');

      var wsHeader = ['วันที่ของเสีย', 'สาขา', 'รหัสสินค้า', 'ชื่อสินค้า', 'หน่วย', 'จำนวนที่เสีย', 'ผู้บันทึก', 'เวลาที่คีย์'];
      if (String(wsSheet.getRange(1, 1).getValue() || '') !== wsHeader[0]) {
        wsSheet.getRange(1, 1, 1, wsHeader.length).setValues([wsHeader]);
        wsSheet.getRange(1, 1, 1, wsHeader.length).setFontWeight('bold');
      }

      var wsBranch = data.branch || '';
      var wsRecorder = data.recorder || 'Unknown';
      var wsItems = data.items || [];
      if (!wsBranch) throw new Error('ไม่ระบุสาขา');
      if (!wsItems.length) throw new Error('ไม่มีรายการที่กรอกจำนวนที่เสีย');

      // วันที่ของเสีย: เลือกได้จากหน้าเว็บ (ค่าเริ่มต้นวันนี้) — เผื่อบันทึกย้อนหลัง แยกจากเวลาที่คีย์จริงซึ่งใช้เวลา ณ ตอนกดบันทึก
      var wsDateStr = String(data.date || '').trim(); // YYYY-MM-DD
      var wsDateDisp = wsDateStr;
      var wsDm = wsDateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (wsDm) wsDateDisp = wsDm[3] + '/' + wsDm[2] + '/' + wsDm[1];
      if (!wsDateDisp) wsDateDisp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy');
      var wsKeyedAt = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
      var wsNorm = function (id) { return String(id == null ? '' : id).replace(/^0+/, '').trim(); };
      var wsRows = [];
      wsItems.forEach(function (it) {
        var q = parseFloat(it.qty);
        if (isNaN(q) || q <= 0) return;
        var codeN = wsNorm(it.productId);
        wsRows.push([wsDateDisp, wsBranch, /^\d+$/.test(codeN) ? Number(codeN) : codeN, it.name || '', it.unit || '', q, wsRecorder, wsKeyedAt]);
      });
      if (!wsRows.length) throw new Error('ไม่มีรายการที่กรอกจำนวนที่เสียถูกต้อง');
      wsSheet.getRange(wsSheet.getLastRow() + 1, 1, wsRows.length, wsHeader.length).setValues(wsRows);

      response.status = 'success';
      response.message = 'บันทึกของเสียแล้ว ' + wsRows.length + ' รายการ';
      response.data = { count: wsRows.length };

    } else if (action === 'cancelPendingOrder') {
      // ยกเลิกใบเบิกค้าง — แค่บันทึก log ลงชีท "ยกเลิกใบเบิก" (gid=1431574396) เพื่อให้ทีมที่เกี่ยวข้องไปดำเนินการต่อ
      // ไม่ได้ไปลบ/แก้ข้อมูลใบสั่งจริงใน MySQL (POS) เลย
      var cpoSs = SpreadsheetApp.openById('1bxohT8wK4ySAJgqGHEg9JHp0KJJKG7SVUEhJksBgBSI');
      var cpoSheet = null;
      var cpoAllSheets = cpoSs.getSheets();
      for (var cpoi = 0; cpoi < cpoAllSheets.length; cpoi++) {
        if (cpoAllSheets[cpoi].getSheetId() === 1431574396) { cpoSheet = cpoAllSheets[cpoi]; break; }
      }
      if (!cpoSheet) throw new Error('ไม่พบชีท ยกเลิกใบเบิก (gid=1431574396)');

      var cpoHeader = ['วันที่สั่ง', 'สาขา', 'เลขที่ใบเบิก', 'วันที่รับ', 'จำนวนรายการ', 'ผู้บันทึก', 'เวลาที่ยกเลิก'];
      if (String(cpoSheet.getRange(1, 1).getValue() || '') !== cpoHeader[0]) {
        cpoSheet.getRange(1, 1, 1, cpoHeader.length).setValues([cpoHeader]);
        cpoSheet.getRange(1, 1, 1, cpoHeader.length).setFontWeight('bold');
      }

      var cpoBranch = String(data.branch || '').trim();
      var cpoOrderNo = data.orderNo;
      if (!cpoBranch) throw new Error('ไม่ระบุสาขา');
      if (!cpoOrderNo) throw new Error('ไม่ระบุเลขที่ใบเบิก');

      cpoSheet.appendRow([
        data.orderDate || '', cpoBranch, cpoOrderNo, data.deldate || '',
        data.itemCount != null ? data.itemCount : '', data.recorder || 'Unknown',
        Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss')
      ]);

      response.status = 'success';
      response.message = 'บันทึกยกเลิกใบเบิกเลขที่ ' + cpoOrderNo + ' เรียบร้อยแล้ว';

    } else if (action === 'getPendingOrderStatus') {
      // เช็คสถานะพิเศษของใบเบิกค้าง 4 อย่าง จาก 4 ชีทในไฟล์เดียวกัน:
      //   pulled    = ดึงข้อมูลใบเบิก (ทีมอื่นดึงข้อมูลไปแล้ว)
      //   cancelled = ยกเลิกใบเบิก (กดยกเลิกจากหน้าเว็บ)
      //   preparing = จัดของ (โกดังกำลังจัดของ/จัดส่งแล้ว)
      //   received  = รับของ (สาขายืนยันรับของแล้ว จากหน้า "รับสินค้า")
      // คืนเป็น key แบบ "สาขา-เลขที่ใบเบิก" (ตัวพิมพ์เล็ก) ให้ฝั่งเว็บเช็คแบบ Set ได้เลย
      // (จัดของ/รับของ บางแถวไม่มีสาขานำหน้าเลขที่ใบเบิก จึงคืนค่าดิบของคอลัมน์นั้นไปด้วย เผื่อต้องเทียบแบบเลขอย่างเดียว)
      var posSs = SpreadsheetApp.openById('1bxohT8wK4ySAJgqGHEg9JHp0KJJKG7SVUEhJksBgBSI');
      var posSheets = posSs.getSheets();
      var pulledSheet = null, cancelledSheet = null, preparingSheet = null, receivedSheet = null;
      for (var posi = 0; posi < posSheets.length; posi++) {
        var posId = posSheets[posi].getSheetId();
        if (posId === 2045386486) pulledSheet = posSheets[posi];
        if (posId === 1431574396) cancelledSheet = posSheets[posi];
        if (posId === 0) preparingSheet = posSheets[posi];
        if (posId === 1358423318) receivedSheet = posSheets[posi];
      }

      var pulled = [];
      if (pulledSheet && pulledSheet.getLastRow() > 1) {
        // คอลัมน์ C = เลขที่ใบเบิก รูปแบบ "HRS-4889" (สาขา-เลขที่) มาจากทีมอื่น ไม่ใช่ตัวเลขล้วน
        var pulledValues = pulledSheet.getRange(2, 3, pulledSheet.getLastRow() - 1, 1).getValues();
        for (var pv = 0; pv < pulledValues.length; pv++) {
          var pvStr = String(pulledValues[pv][0] || '').trim();
          if (pvStr) pulled.push(pvStr.toLowerCase());
        }
      }

      var cancelled = [];
      if (cancelledSheet && cancelledSheet.getLastRow() > 1) {
        var cnValues = cancelledSheet.getRange(2, 1, cancelledSheet.getLastRow() - 1, 3).getValues(); // A=วันที่สั่ง B=สาขา C=เลขที่ใบเบิก
        for (var cv = 0; cv < cnValues.length; cv++) {
          var cvBranch = String(cnValues[cv][1] || '').trim();
          var cvNo = String(cnValues[cv][2] || '').trim();
          if (cvBranch && cvNo) cancelled.push((cvBranch + '-' + cvNo).toLowerCase());
        }
      }

      var preparing = [];
      if (preparingSheet && preparingSheet.getLastRow() > 1) {
        var jdVals = preparingSheet.getRange(2, 7, preparingSheet.getLastRow() - 1, 1).getValues(); // G = เลขที่ใบเบิก
        for (var jdv = 0; jdv < jdVals.length; jdv++) {
          var jdStr = String(jdVals[jdv][0] || '').trim();
          if (jdStr) preparing.push(jdStr.toLowerCase());
        }
      }

      var received = [];
      if (receivedSheet && receivedSheet.getLastRow() > 1) {
        var rcVals = receivedSheet.getRange(2, 3, receivedSheet.getLastRow() - 1, 1).getValues(); // C = เลขที่ใบเบิก
        for (var rcv = 0; rcv < rcVals.length; rcv++) {
          var rcStr = String(rcVals[rcv][0] || '').trim();
          if (rcStr) received.push(rcStr.toLowerCase());
        }
      }

      response.status = 'success';
      response.data = { pulled: pulled, cancelled: cancelled, preparing: preparing, received: received };

    } else if (action === 'getGoodsToReceive') {
      // หน้า "รับสินค้า" — ดึงรายการจากชีท จัดของ (gid=0) เฉพาะสาขาที่ขอมา จัดกลุ่มตามเลขที่ใบเบิก
      var gtrSs = SpreadsheetApp.openById('1bxohT8wK4ySAJgqGHEg9JHp0KJJKG7SVUEhJksBgBSI');
      var gtrSheets = gtrSs.getSheets();
      var jadongSheet = null, rabkongSheet = null;
      for (var gtri = 0; gtri < gtrSheets.length; gtri++) {
        var gtrId = gtrSheets[gtri].getSheetId();
        if (gtrId === 0) jadongSheet = gtrSheets[gtri];
        if (gtrId === 1358423318) rabkongSheet = gtrSheets[gtri];
      }
      if (!jadongSheet) throw new Error('ไม่พบชีท จัดของ');

      var gtrBranch = String(data.branch || '').toLowerCase().trim();
      var groups = {}; // เลขที่ใบเบิก -> { orderNo, date, items:[] }
      if (jadongSheet.getLastRow() > 1) {
        // A=วันที่ B=สาขา C=รหัส D=ชื่อ E=จำนวนเบิก F=จำนวนส่ง G=เลขที่ใบเบิก H=สถานะฝั่งstore I=เวลาบันทึก
        var jdAll = jadongSheet.getRange(2, 1, jadongSheet.getLastRow() - 1, 9).getValues();
        for (var ja = 0; ja < jdAll.length; ja++) {
          var jRow = jdAll[ja];
          var jBranch = String(jRow[1] || '').toLowerCase().trim();
          if (gtrBranch && jBranch !== gtrBranch) continue;
          var jOrderNo = String(jRow[6] || '').trim();
          if (!jOrderNo) continue;
          if (!groups[jOrderNo]) {
            groups[jOrderNo] = {
              orderNo: jOrderNo,
              branch: jRow[1] || '',
              date: jRow[0] instanceof Date ? Utilities.formatDate(jRow[0], 'Asia/Bangkok', 'yyyy-MM-dd') : String(jRow[0] || ''),
              items: []
            };
          }
          groups[jOrderNo].items.push({
            code: jRow[2] || '',
            name: jRow[3] || '',
            qtyRequested: jRow[4],
            qtySent: jRow[5],
            storeStatus: jRow[7] || ''
          });
        }
      }

      // เช็คว่าใบไหน/รายการไหนสาขายืนยันรับของแล้ว (มีข้อมูลอยู่ในชีท รับของ)
      var receivedNos = {};
      var receivedItemKeys = {};
      if (rabkongSheet && rabkongSheet.getLastRow() > 1) {
        var rbVals = rabkongSheet.getRange(2, 1, rabkongSheet.getLastRow() - 1, 4).getValues(); // A..D: วันที่รับ,สาขา,เลขที่ใบเบิก,รหัส
        for (var rb = 0; rb < rbVals.length; rb++) {
          var rbNo = String(rbVals[rb][2] || '').trim();   // C = เลขที่ใบเบิก
          var rbCode = String(rbVals[rb][3] || '').trim(); // D = รหัส
          if (rbNo) receivedNos[rbNo] = true;
          if (rbNo && rbCode) receivedItemKeys[rbNo + '|' + rbCode] = true;
        }
      }

      var orders = [];
      for (var key in groups) {
        var g = groups[key];
        g.received = !!receivedNos[key];
        for (var gi = 0; gi < g.items.length; gi++) {
          var giItem = g.items[gi];
          // true if this specific item already has a row in ชีท รับของ — either from a full
          // order save, or from a previous per-item "ยืนยันแก้ไข" confirm
          giItem.alreadyReceived = !!receivedItemKeys[key + '|' + String(giItem.code || '').trim()];
        }
        orders.push(g);
      }
      orders.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });

      response.status = 'success';
      response.data = orders;

    } else if (action === 'saveGoodsReceived') {
      // บันทึกผลรับของจากหน้า "รับสินค้า" ลงชีท รับของ (gid=1358423316) แบบ 1 แถวต่อ 1 รายการสินค้า
      // เก็บทั้งจำนวนที่ส่งมา (อ้างอิง) และจำนวนที่รับจริง + สถานะ (ยืนยัน/แก้ไข) ต่อรายการ
      // รายการที่สถานะ "แก้ไข" บังคับมีหมายเหตุ + รูปภาพแนบเสมอ (เช็คซ้ำฝั่ง server กันข้าม validation ฝั่งเว็บ)
      var sgSs = SpreadsheetApp.openById('1bxohT8wK4ySAJgqGHEg9JHp0KJJKG7SVUEhJksBgBSI');
      var sgSheet = null;
      var sgAllSheets = sgSs.getSheets();
      for (var sgi = 0; sgi < sgAllSheets.length; sgi++) {
        if (sgAllSheets[sgi].getSheetId() === 1358423318) { sgSheet = sgAllSheets[sgi]; break; }
      }
      if (!sgSheet) throw new Error('ไม่พบชีท รับของ (gid=1358423318)');

      var sgHeader = ['วันที่รับ', 'สาขา', 'เลขที่ใบเบิก', 'รหัส', 'ชื่อ', 'จำนวนเบิก', 'จำนวนส่ง', 'จำนวนที่รับจริง', 'สถานะ', 'หมายเหตุ', 'รูปภาพ', 'ผู้บันทึก', 'เวลาบันทึก'];
      if (String(sgSheet.getRange(1, 1).getValue() || '') !== sgHeader[0]) {
        sgSheet.getRange(1, 1, 1, sgHeader.length).setValues([sgHeader]);
        sgSheet.getRange(1, 1, 1, sgHeader.length).setFontWeight('bold');
      }

      var sgBranch = String(data.branch || '').trim();
      var sgOrderNo = String(data.orderNo || '').trim();
      var sgItems = data.items || [];
      var sgRecorder = data.recorder || 'Unknown';
      if (!sgBranch) throw new Error('ไม่ระบุสาขา');
      if (!sgOrderNo) throw new Error('ไม่ระบุเลขที่ใบเบิก');
      if (!sgItems.length) throw new Error('ไม่มีรายการที่รับของ');

      // เช็คก่อนบันทึกจริง: รายการที่แก้ไขต้องมีหมายเหตุ + รูปภาพครบทุกตัว
      for (var sgc = 0; sgc < sgItems.length; sgc++) {
        var sgCheck = sgItems[sgc];
        if (sgCheck.status === 'แก้ไข') {
          if (!String(sgCheck.note || '').trim()) throw new Error('รายการ "' + (sgCheck.name || sgCheck.code) + '" แก้ไขจำนวนแล้วต้องใส่หมายเหตุด้วย');
          if (!sgCheck.photoBase64) throw new Error('รายการ "' + (sgCheck.name || sgCheck.code) + '" แก้ไขจำนวนแล้วต้องแนบรูปภาพด้วย');
        }
      }

      // โฟลเดอร์เก็บรูปหลักฐานการแก้ไข — หาโฟลเดอร์เดิมในไดรฟ์เดียวกับไฟล์ชีทนี้ ถ้าไม่มีค่อยสร้างใหม่
      var sgPhotoFolder = null;
      var sgNeedFolder = sgItems.some(function (it) { return it.status === 'แก้ไข' && it.photoBase64; });
      if (sgNeedFolder) {
        var sgParents = DriveApp.getFileById('1bxohT8wK4ySAJgqGHEg9JHp0KJJKG7SVUEhJksBgBSI').getParents();
        var sgParentFolder = (sgParents && sgParents.hasNext()) ? sgParents.next() : DriveApp.getRootFolder();
        var sgExistingFolders = sgParentFolder.getFoldersByName('รูปแก้ไขรับของ');
        sgPhotoFolder = sgExistingFolders.hasNext() ? sgExistingFolders.next() : sgParentFolder.createFolder('รูปแก้ไขรับของ');
      }

      var sgNow = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
      var sgToday = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
      var sgRows = sgItems.map(function (it) {
        var sgPhotoUrl = '';
        if (it.status === 'แก้ไข' && it.photoBase64 && sgPhotoFolder) {
          try {
            var sgBase64Data = it.photoBase64.split(',')[1] || it.photoBase64;
            var sgDecoded = Utilities.base64Decode(sgBase64Data);
            var sgExt = (it.photoMimeType && it.photoMimeType.indexOf('png') !== -1) ? 'png' : 'jpg';
            var sgFileName = sgOrderNo + '_' + (it.code || 'item') + '_' + new Date().getTime() + '.' + sgExt;
            var sgBlob = Utilities.newBlob(sgDecoded, it.photoMimeType || 'image/jpeg', sgFileName);
            var sgDriveFile = sgPhotoFolder.createFile(sgBlob);
            sgDriveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            sgPhotoUrl = sgDriveFile.getUrl();
          } catch (sgErr) {
            sgPhotoUrl = 'อัปโหลดรูปไม่สำเร็จ: ' + sgErr.message;
          }
        }
        return [
          sgToday, sgBranch, sgOrderNo, it.code || '', it.name || '',
          it.qtyRequested != null ? it.qtyRequested : '', it.qtySent != null ? it.qtySent : '',
          it.qtyReceived != null ? it.qtyReceived : '', it.status || 'ยืนยัน',
          it.note || '', sgPhotoUrl,
          sgRecorder, sgNow
        ];
      });
      sgSheet.getRange(sgSheet.getLastRow() + 1, 1, sgRows.length, sgHeader.length).setValues(sgRows);

      response.status = 'success';
      response.message = 'บันทึกรับของใบเบิกเลขที่ ' + sgOrderNo + ' เรียบร้อยแล้ว (' + sgRows.length + ' รายการ)';
      response.data = { count: sgRows.length };

    } else if (action === 'confirmReceivedItem') {
      // ยืนยันรายการเดียวที่โกดังแก้ไขจำนวน (storeStatus = แก้ไข ในชีทจัดของ, จำนวนส่ง != จำนวนเบิก)
      // สาขากดรับทราบ/ยอมรับจำนวนที่โกดังส่งมาจริง โดยไม่ต้องกรอกจำนวนรับเอง — บันทึก 1 แถวลงชีท รับของ
      // จำนวนที่รับจริง = จำนวนส่ง (ยอมรับตามที่โกดังส่งมา) และสถานะบันทึกเป็น "ยืนยัน" เสมอ (ไม่ใช่ "แก้ไข")
      var criSs = SpreadsheetApp.openById('1bxohT8wK4ySAJgqGHEg9JHp0KJJKG7SVUEhJksBgBSI');
      var criSheet = null;
      var criAllSheets = criSs.getSheets();
      for (var crii = 0; crii < criAllSheets.length; crii++) {
        if (criAllSheets[crii].getSheetId() === 1358423318) { criSheet = criAllSheets[crii]; break; }
      }
      if (!criSheet) throw new Error('ไม่พบชีท รับของ (gid=1358423318)');

      var criHeader = ['วันที่รับ', 'สาขา', 'เลขที่ใบเบิก', 'รหัส', 'ชื่อ', 'จำนวนเบิก', 'จำนวนส่ง', 'จำนวนที่รับจริง', 'สถานะ', 'หมายเหตุ', 'รูปภาพ', 'ผู้บันทึก', 'เวลาบันทึก'];
      if (String(criSheet.getRange(1, 1).getValue() || '') !== criHeader[0]) {
        criSheet.getRange(1, 1, 1, criHeader.length).setValues([criHeader]);
        criSheet.getRange(1, 1, 1, criHeader.length).setFontWeight('bold');
      }

      var criBranch = String(data.branch || '').trim();
      var criOrderNo = String(data.orderNo || '').trim();
      var criCode = String(data.code || '').trim();
      var criName = data.name || '';
      var criQtyRequested = data.qtyRequested != null ? data.qtyRequested : '';
      var criQtySent = data.qtySent != null ? data.qtySent : '';
      var criRecorder = data.recorder || 'Unknown';
      if (!criBranch) throw new Error('ไม่ระบุสาขา');
      if (!criOrderNo) throw new Error('ไม่ระบุเลขที่ใบเบิก');
      if (!criCode) throw new Error('ไม่ระบุรหัสสินค้า');

      var criToday = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
      var criNow = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

      criSheet.getRange(criSheet.getLastRow() + 1, 1, 1, criHeader.length).setValues([[
        criToday, criBranch, criOrderNo, criCode, criName,
        criQtyRequested, criQtySent, criQtySent,
        'ยืนยัน',
        'ยืนยันรับตามที่โกดังจัดของส่งมา (โกดังแก้ไขจำนวนจากที่เบิก)',
        '', criRecorder, criNow
      ]]);

      response.status = 'success';
      response.message = 'ยืนยันรับรายการ "' + criName + '" เรียบร้อยแล้ว';

    } else if (action === 'saveStock') {
      var stockSs = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ');

      var countSheet = stockSs.getSheetByName('ข้อมูลนับสตอค');
      if (!countSheet) {
        countSheet = stockSs.insertSheet('ข้อมูลนับสตอค');
        countSheet.appendRow(['วันที่ลงข้อมูล', 'ชื่อพนักงานนับสต๊อก', 'สาขา', 'รหัสสินค้า', 'ชื่อสินค้า', 'หน่วย', 'จำนวนคงเหลือ']);
        countSheet.getRange("A1:G1").setFontWeight("bold");
      }

      var requestSheet = stockSs.getSheetByName('ข้อมูลเบิก');
      if (!requestSheet) {
        requestSheet = stockSs.insertSheet('ข้อมูลเบิก');
        requestSheet.appendRow(['เลขที่ใบเบิก', 'วันที่เวลาบันทึก', 'รหัส', 'ชื่อ', 'หน่วย', 'จำนวน', 'วันที่เบิก', 'ชื่อผู้เบิก', 'สาขา']);
        requestSheet.getRange("A1:I1").setFontWeight("bold");
      }

      var balanceSheet = stockSs.getSheetByName('ยอดยกมา');
      if (!balanceSheet) {
        balanceSheet = stockSs.insertSheet('ยอดยกมา');
        balanceSheet.appendRow(['รหัสสินค้า', 'ชื่อสินค้า', 'สาขา', 'ยอดยกมา', 'วันที่อัปเดต']);
        balanceSheet.getRange("A1:E1").setFontWeight("bold");
      }

      var items = data.items || [];
      var branch = data.branch || '';
      var username = data.username || 'Unknown';
      var counterName = data.counterName || username;
      var requestDate = data.requestDate || '';
      var requesterName = data.requesterName || '';
      var dateNow = new Date();
      var formattedDate = Utilities.formatDate(dateNow, "Asia/Bangkok", "dd/MM/yyyy HH:mm:ss");

      var normalizeId = function (id) {
        if (id === null || id === undefined) return '';
        return String(id).replace(/^0+/, '').toLowerCase();
      };

      // Load current balances to update them
      var balValues = balanceSheet.getDataRange().getValues();
      var balRowMap = {};
      var reqBranch = branch.toLowerCase();
      for (var b = 1; b < balValues.length; b++) {
        var bId = normalizeId(balValues[b][0]);
        var bBranch = balValues[b][2] ? balValues[b][2].toString().toLowerCase() : '';
        if (bId && bBranch === reqBranch) {
          balRowMap[bId] = b + 1; // 1-based index
        }
      }

      // Filter requested items to check if we need a requisition number
      var reqItems = items.filter(function (i) { return i.requested > 0; });
      var reqNumber = "";

      if (reqItems.length > 0) {
        var yy = Utilities.formatDate(dateNow, "Asia/Bangkok", "yy");
        var mm = Utilities.formatDate(dateNow, "Asia/Bangkok", "MM");
        var branchPrefix = branch.toString().substring(0, 3).toUpperCase();
        var prefix = branchPrefix + yy + mm; // e.g. BKK2605

        // Find next running number
        var lastNum = 0;
        if (requestSheet.getLastRow() > 1) {
          var reqValues = requestSheet.getDataRange().getValues();
          for (var r = reqValues.length - 1; r >= 1; r--) {
            var exNo = reqValues[r][0]; // คอลัมน์ A: เลขที่ใบเบิก
            if (exNo && exNo.toString().indexOf(prefix) === 0) {
              var suffix = exNo.toString().replace(prefix, '');
              var parsed = parseInt(suffix, 10);
              if (!isNaN(parsed) && parsed > lastNum) {
                lastNum = parsed;
              }
            }
          }
        }
        lastNum += 1;
        var runningStr = ("000" + lastNum).slice(-3);
        reqNumber = prefix + runningStr;
      }

      // รหัสสินค้า: เก็บเป็นตัวเลขถ้าเป็นเลขล้วน (ให้ชนิดข้อมูลตรงกับแถวเดิม — ถ้าเก็บเป็นข้อความปนกัน
      // gviz จะคืนค่า null ทำให้หน้ามูลค่าสต๊อกจับคู่รหัสไม่ได้) เลข 0 นำหน้าตัดได้ เพราะทุกจุด normalize อยู่แล้ว
      var pidValue = function (pid) {
        var s = String(pid == null ? '' : pid).trim();
        return /^\d+$/.test(s) ? Number(s) : s;
      };

      // รวบรวมทุกแถวไว้ในหน่วยความจำก่อน แล้วค่อยเขียนชีทครั้งเดียวต่อชีท
      // เดิมวนเขียนทีละรายการ: นับสต๊อก 200 รายการ = appendRow 200 ครั้ง (ข้อมูลนับสตอค)
      //   + setValue 400 ครั้ง (ยอดยกมา คอลัมน์ D และ E แยกกัน) + appendRow อีกไม่เกิน 200 ครั้ง (ข้อมูลเบิก)
      //   รวม ~800 ครั้งต่อการกดบันทึกหนึ่งครั้ง และยิ่งชีทสะสมยาวขึ้นยิ่งช้าลงเรื่อยๆ
      //   จนเกิน timeout ฝั่งเว็บ ผู้ใช้เห็นว่า "ส่งข้อมูลบันทึกไม่ไป" ทั้งที่ GAS ยังเขียนค้างอยู่
      var countRows = [];
      var requestRows = [];
      var balNewRows = [];
      // แถวยอดยกมาที่ต้องแก้ (คอลัมน์ D=ยอด, E=วันที่อัปเดต) เก็บไว้เขียนรวดเดียวท้ายสุด
      var balUpdates = {}; // rowIndex -> [ยอดคงเหลือ, วันที่อัปเดต]
      var balPendingNew = {}; // normId -> ตำแหน่งใน balNewRows (กันรหัสซ้ำในชุดเดียวกันถูก append สองแถว)

      items.forEach(function (item) {
        // Save remaining stock
        if (item.remaining !== null && item.remaining !== undefined && item.remaining !== '') {
          countRows.push([formattedDate, counterName, branch, pidValue(item.productId), item.name, item.unit, item.remaining]);

          // Update balance sheet
          var normId = normalizeId(item.productId);
          if (balRowMap[normId]) {
            balUpdates[balRowMap[normId]] = [item.remaining, formattedDate];
          } else if (balPendingNew[normId] !== undefined) {
            // รหัสเดียวกันมาซ้ำในชุดนี้ — ทับค่าแถวใหม่ที่เตรียมไว้ ไม่สร้างแถวซ้ำ
            balNewRows[balPendingNew[normId]][3] = item.remaining;
            balNewRows[balPendingNew[normId]][4] = formattedDate;
          } else {
            balPendingNew[normId] = balNewRows.length;
            balNewRows.push(["'" + item.productId, item.name, branch, item.remaining, formattedDate]);
          }
        }
        // Save requested stock
        if (item.requested > 0) {
          requestRows.push([reqNumber, formattedDate, "'" + item.productId, item.name, item.unit, item.requested, requestDate, requesterName, branch]);
        }
      });

      appendRowsBatch(countSheet, countRows);
      appendRowsBatch(requestSheet, requestRows);

      // แก้ยอดยกมาแถวเดิม: เขียนคอลัมน์ D:E ครั้งเดียว แทนการ setValue ทีละช่อง (เดิม 2 ครั้งต่อรายการ)
      // จำกัดช่วงที่เขียนไว้แค่แถวแรกถึงแถวสุดท้ายที่มีการแก้จริง แถวนอกช่วงไม่ถูกแตะเลย
      // แถวที่อยู่ในช่วงแต่ไม่ได้แก้ (เช่นของสาขาอื่น) เขียนค่าเดิมกลับลงไปเหมือนเดิม ค่าจึงไม่เปลี่ยน
      var balUpdateRows = Object.keys(balUpdates).map(Number);
      if (balUpdateRows.length) {
        var balFirst = Math.min.apply(null, balUpdateRows);
        var balLast = Math.max.apply(null, balUpdateRows);
        var balDE = [];
        for (var u = balFirst; u <= balLast; u++) {
          var upd = balUpdates[u];
          balDE.push(upd ? upd : [balValues[u - 1][3], balValues[u - 1][4]]);
        }
        balanceSheet.getRange(balFirst, 4, balDE.length, 2).setValues(balDE);
      }
      appendRowsBatch(balanceSheet, balNewRows);
      SpreadsheetApp.flush();

      response.status = 'success';
      response.message = 'บันทึกข้อมูลเรียบร้อยแล้ว' + (reqNumber ? ' (เลขที่ใบเบิก: ' + reqNumber + ')' : '');
    } else if (action === 'updateStorageCategory') {
      var stockSs = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ');
      var categorySheet = stockSs.getSheetByName('หมวดจัดเก็บสาขา');
      if (!categorySheet) {
        categorySheet = stockSs.insertSheet('หมวดจัดเก็บสาขา');
        categorySheet.appendRow(['รหัสสินค้า', 'ชื่อสินค้า', 'สาขา', 'หมวดจัดเก็บ']);
        categorySheet.getRange("A1:D1").setFontWeight("bold");
      }

      var productId = data.productId;
      var name = data.name || '';
      var branch = data.branch || '';
      var category = data.category || '';

      var normalizeId = function (id) {
        if (id === null || id === undefined) return '';
        return String(id).replace(/^0+/, '').toLowerCase();
      };
      var normIdToUpdate = normalizeId(productId);
      var reqBranch = branch.toLowerCase();

      var catValues = categorySheet.getDataRange().getValues();
      var foundIndex = -1;
      for (var c = 1; c < catValues.length; c++) {
        var cId = normalizeId(catValues[c][0]);
        var cBranch = catValues[c][2] ? catValues[c][2].toString().toLowerCase() : '';
        if (cId === normIdToUpdate && cBranch === reqBranch) {
          foundIndex = c + 1;
          break;
        }
      }

      if (foundIndex !== -1) {
        categorySheet.getRange(foundIndex, 4).setValue(category);
      } else {
        categorySheet.appendRow(["'" + productId, name, branch, category]);
      }

      response.status = 'success';
      response.message = 'อัปเดตหมวดจัดเก็บเรียบร้อยแล้ว';
    } else if (action === 'saveAvgPerHead') {
      // แก้ไข/เพิ่ม "ค่าเฉลี่ยยอดใช้ต่อหัว" ของสาขา+รหัส ลงชีท 'ค่าเฉลี่ยยอดใช้ต่อหัว' (ไฟล์ BOM)
      // คอลัมน์: A=สาขา B=รหัส C=ชื่อ D=ค่าเฉลี่ยต่อหัว — ถ้ายังไม่มีแถวให้ append ใหม่
      var aphSs = SpreadsheetApp.openById('1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw');
      var aphSheet = null;
      var aphAll = aphSs.getSheets();
      for (var aphSi = 0; aphSi < aphAll.length; aphSi++) {
        if (aphAll[aphSi].getSheetId() === 1722427042) { aphSheet = aphAll[aphSi]; break; }
      }
      if (!aphSheet) aphSheet = aphSs.getSheetByName('ค่าเฉลี่ยยอดใช้ต่อหัว');
      if (!aphSheet) throw new Error('ไม่พบชีทค่าเฉลี่ยยอดใช้ต่อหัว');

      var aphBranch = String(data.branch || '').toLowerCase().trim();
      var aphCode = data.code;
      var aphName = data.name || '';
      var aphValue = parseFloat(data.value);
      if (!aphBranch) throw new Error('ไม่ระบุสาขา');
      if (aphCode === undefined || aphCode === null || String(aphCode).trim() === '') throw new Error('ไม่ระบุรหัสสินค้า');
      if (isNaN(aphValue) || aphValue < 0) throw new Error('ค่าเฉลี่ยต่อหัวไม่ถูกต้อง');

      var aphNorm = function (id) { return String(id == null ? '' : id).replace(/^0+/, '').toLowerCase().trim(); };
      // เว็บใช้ zjp แทน sjp ในบางชีท — เทียบทั้งสอง alias เวลาหาแถวเดิม
      var aphAliases = {};
      aphAliases[aphBranch] = true;
      if (aphBranch === 'zjp') aphAliases['sjp'] = true;
      if (aphBranch === 'sjp') aphAliases['zjp'] = true;
      var aphCodeNorm = aphNorm(aphCode);

      var aphVals = aphSheet.getDataRange().getValues();
      var aphFound = -1;
      for (var ai = 1; ai < aphVals.length; ai++) {
        var rBranch = String(aphVals[ai][0] || '').toLowerCase().trim();
        var rCode = aphNorm(aphVals[ai][1]);
        if (aphAliases[rBranch] && rCode === aphCodeNorm) { aphFound = ai + 1; break; }
      }

      var aphCreated = false;
      if (aphFound !== -1) {
        aphSheet.getRange(aphFound, 4).setValue(aphValue);
        // เติมชื่อให้ถ้าช่องว่างและ client ส่งชื่อมา
        if (aphName && !String(aphVals[aphFound - 1][2] || '').trim()) aphSheet.getRange(aphFound, 3).setValue(aphName);
      } else {
        var aphCodeCell = /^\d+$/.test(String(aphCode)) ? Number(aphCode) : aphCode;
        aphSheet.appendRow([aphBranch, aphCodeCell, aphName, aphValue]);
        aphCreated = true;
      }

      response.status = 'success';
      response.message = aphCreated ? 'บันทึกค่าเฉลี่ยต่อหัวใหม่ลงชีทแล้ว' : 'อัปเดตค่าเฉลี่ยต่อหัวในชีทแล้ว';
      response.data = { branch: aphBranch, code: String(aphCode), value: aphValue, created: aphCreated };
    } else if (action === 'saveBranchPercentagesBulk') {
      var supSs = SpreadsheetApp.openById('1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw');
      var sheet = supSs.getSheetByName('เปอร์เซ็นการเบิกของแต่ละสาขา');
      if (!sheet) {
        sheet = supSs.insertSheet('เปอร์เซ็นการเบิกของแต่ละสาขา');
        sheet.appendRow(['วันที่', 'ชื่อสาขา', 'เปอร์เซ็น', 'จำนวน259', 'จำนวน359']);
        sheet.getRange('A1:E1').setFontWeight('bold');
      } else if (String(sheet.getRange(1, 4).getValue() || '') === '') {
        // ชีทเดิมมีแค่ 3 คอลัมน์ (วันที่/สาขา/เปอร์เซ็น) — เพิ่มคอลัมน์แยกราคา 259/359 โดยไม่กระทบข้อมูลเดิม
        sheet.getRange(1, 4, 1, 2).setValues([['จำนวน259', 'จำนวน359']]);
        sheet.getRange(1, 4, 1, 2).setFontWeight('bold');
      }

      var pBranch = String(data.branch || '').toLowerCase().trim();
      var updates = data.updates || []; // array of { date, percent, percent259?, percent359? }

      if (!pBranch) throw new Error('ไม่ระบุสาขา');

      var values = sheet.getDataRange().getValues();
      var toYmd = function (v) {
        if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
        var s = String(v == null ? '' : v).trim();
        var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
        return s;
      };

      // Create a map of existing dates to row numbers (1-based)
      var dateRowMap = {};
      for (var i = 1; i < values.length; i++) {
        var rowDate = toYmd(values[i][0]);
        var rowBranch = String(values[i][1] || '').toLowerCase().trim();
        if (rowBranch === pBranch) {
          dateRowMap[rowDate] = i + 1;
        }
      }

      var rowsToDelete = [];
      var rowsToUpdate = []; // Array of { row, percent, p259, p359 }
      var rowsToAppend = []; // Array of { date, percent, p259, p359 }

      updates.forEach(function (upd) {
        var pDate = upd.date;
        if (!pDate) return;
        // สาขามีหัว 2 ราคา ส่ง percent259/percent359 มาแยก — รวมเป็นยอดรวม (percent) ให้อัตโนมัติ
        // สาขาราคาเดียวส่งแค่ percent เหมือนเดิม (p259/p359 เป็น null ไม่เขียนทับคอลัมน์นั้น)
        var has259or359 = upd.percent259 !== undefined || upd.percent359 !== undefined;
        var p259 = has259or359 ? (parseFloat(upd.percent259) || 0) : null;
        var p359 = has259or359 ? (parseFloat(upd.percent359) || 0) : null;
        var pPercent = has259or359 ? (p259 + p359) : (parseFloat(upd.percent) || 0);

        if (pPercent <= 0) {
          if (dateRowMap[pDate]) {
            rowsToDelete.push(dateRowMap[pDate]);
          }
        } else {
          if (dateRowMap[pDate]) {
            rowsToUpdate.push({ row: dateRowMap[pDate], percent: pPercent, p259: p259, p359: p359 });
          } else {
            var parts = pDate.split('-');
            var dateObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
            rowsToAppend.push({ date: dateObj, percent: pPercent, p259: p259, p359: p359 });
          }
        }
      });

      // 1. Update existing rows
      rowsToUpdate.forEach(function (upd) {
        sheet.getRange(upd.row, 3).setValue(upd.percent);
        if (upd.p259 !== null) sheet.getRange(upd.row, 4, 1, 2).setValues([[upd.p259, upd.p359]]);
      });

      // 2. Append new rows — เขียนทีเดียว แทน appendRow ทีละวัน (บันทึกทั้งเดือนคือ 30 ครั้ง)
      appendRowsBatch(sheet, rowsToAppend.map(function (app) {
        return [app.date, pBranch, app.percent, app.p259 !== null ? app.p259 : '', app.p359 !== null ? app.p359 : ''];
      }));

      // 3. Delete rows in descending order
      rowsToDelete.sort(function (a, b) { return b - a; });
      rowsToDelete.forEach(function (rowIndex) {
        sheet.deleteRow(rowIndex);
      });

      response.status = 'success';
      response.message = 'บันทึกเปอร์เซ็นต์พิเศษสำเร็จ';
    } else if (action === 'saveBranchPercentage') {
      var supSs = SpreadsheetApp.openById('1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw');
      var sheet = supSs.getSheetByName('เปอร์เซ็นการเบิกของแต่ละสาขา');
      if (!sheet) {
        sheet = supSs.insertSheet('เปอร์เซ็นการเบิกของแต่ละสาขา');
        sheet.appendRow(['วันที่', 'ชื่อสาขา', 'เปอร์เซ็น']);
        sheet.getRange('A1:C1').setFontWeight('bold');
      }

      var pDate = data.date; // YYYY-MM-DD
      var pBranch = String(data.branch || '').toLowerCase().trim();
      var pPercent = parseFloat(data.percent) || 0;

      if (!pDate || !pBranch) throw new Error('ข้อมูลไม่ครบถ้วน');

      var parts = pDate.split('-');
      var dateObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));

      var values = sheet.getDataRange().getValues();
      var foundRow = -1;

      var toYmd = function (v) {
        if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
        var s = String(v == null ? '' : v).trim();
        var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
        return s;
      };

      for (var i = 1; i < values.length; i++) {
        var rowDate = toYmd(values[i][0]);
        var rowBranch = String(values[i][1] || '').toLowerCase().trim();
        if (rowDate === pDate && rowBranch === pBranch) {
          foundRow = i + 1;
          break;
        }
      }

      if (foundRow !== -1) {
        sheet.getRange(foundRow, 3).setValue(pPercent);
      } else {
        sheet.appendRow([dateObj, pBranch, pPercent]);
      }

      response.status = 'success';
      response.message = 'บันทึกเปอร์เซ็นเรียบร้อยแล้ว';

    } else if (action === 'deleteBranchPercentage') {
      var supSs = SpreadsheetApp.openById('1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw');
      var sheet = supSs.getSheetByName('เปอร์เซ็นการเบิกของแต่ละสาขา');
      if (!sheet) throw new Error('ไม่พบชีท เปอร์เซ็นการเบิกของแต่ละสาขา');

      var pDate = data.date; // YYYY-MM-DD
      var pBranch = String(data.branch || '').toLowerCase().trim();

      if (!pDate || !pBranch) throw new Error('ข้อมูลไม่ครบถ้วน');

      var values = sheet.getDataRange().getValues();
      var toYmd = function (v) {
        if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
        var s = String(v == null ? '' : v).trim();
        var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
        return s;
      };

      var deletedCount = 0;
      for (var i = values.length - 1; i >= 1; i--) {
        var rowDate = toYmd(values[i][0]);
        var rowBranch = String(values[i][1] || '').toLowerCase().trim();
        if (rowDate === pDate && rowBranch === pBranch) {
          sheet.deleteRow(i + 1);
          deletedCount++;
        }
      }

      response.status = 'success';
      response.message = 'ลบข้อมูลเรียบร้อยแล้ว (' + deletedCount + ' รายการ)';

    } else if (action === 'getUsageData') {
      var reqBranch = data.branch || '';
      var startDateStr = data.startDate || '';
      var endDateStr = data.endDate || '';

      if (!reqBranch || !startDateStr || !endDateStr) {
        throw new Error('ระบุสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน');
      }

      var branchMap = {
        'sjp': '7', 'crm': '12', 'xcm': '19', 'slr': '37', 'sum': '51',
        'xum': '59', 'scs': '61', 'smp': '63', 'xsb': '67', 'xhh': '72',
        'hrs': '78', 'clk': '79', 'p90': '80', 'hps': '109', 'zbw': '400',
        'zpt': '401', 'npt': '500', 'wrm': '501', 'wmt': '503', 'ipr': '904',
        'zk3': '906'
      };
      var branchKey = String(reqBranch).toLowerCase().trim();
      var outletId = branchMap[branchKey] || branchKey;

      var url = "http://183.89.248.221:14369/api/trn_usg?outletid=" + encodeURIComponent(outletId);
      var fetchOptions = {
        'method': 'get',
        'muteHttpExceptions': true
      };

      var fetchResponse = UrlFetchApp.fetch(url, fetchOptions);
      var responseCode = fetchResponse.getResponseCode();

      if (responseCode === 200) {
        var apiData = JSON.parse(fetchResponse.getContentText());
        if (Array.isArray(apiData)) {
          var usageMap = {};
          var start = new Date(startDateStr);
          start.setHours(0, 0, 0, 0);
          var end = new Date(endDateStr);
          end.setHours(23, 59, 59, 999);

          apiData.forEach(function (item) {
            if (item.Usg_Date) {
              var d = new Date(item.Usg_Date);
              if (d >= start && d <= end) {
                var itmCode = item.Itm_Code;
                if (itmCode) {
                  var normId = String(itmCode).replace(/^0+/, '').toLowerCase();
                  var qty = parseFloat(item.Qty) || 0;
                  if (!usageMap[normId]) usageMap[normId] = 0;
                  usageMap[normId] += qty;
                }
              }
            }
          });
          response.status = 'success';
          response.data = usageMap;
        } else {
          response.status = 'error';
          response.message = apiData.message || 'API ตอบกลับในรูปแบบที่ไม่ถูกต้อง';
        }
      } else {
        response.status = 'error';
        response.message = 'API Error: ' + responseCode;
      }
    } else if (action === 'updateOTApprovalBulk') {
      var resOT = updateOTApprovalBulk(data.dateStr, data.branch, data.updates, data.approverName);
      response.status = resOT.success ? 'success' : 'error';
      response.message = resOT.message;
    } else if (action === 'getBranchStats') {
      var resStats = getBranchStats(data.branch);
      if (resStats.success) {
        response.status = 'success';
        response.data = resStats;
      } else {
        response.status = 'error';
        response.message = resStats.message;
      }
    } else if (action === 'getDailySales') {
      var resSales = getDailySales(data.searchDateStr, data.searchBranch);
      if (resSales.success) {
        response.status = 'success';
        response.data = resSales;
      } else {
        response.status = 'error';
        response.message = resSales.message;
      }
    } else if (action === 'getOTNotifications') {
      var resNotif = getOTNotifications(data.branch);
      if (resNotif.success) {
        response.status = 'success';
        response.data = resNotif.data;
      } else {
        response.status = 'error';
        response.message = resNotif.message;
      }
    } else {
      response.status = 'error';
      response.message = 'Invalid action';
    }

  } catch (error) {
    response.status = 'error';
    response.message = error.toString();
  }

  return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
}

// --- 8. อัปเดตสถานะการอนุมัติ OT ---
function updateOTApprovalBulk(dateStr, branch, updates, approverName) {
  try {
    var ss = SpreadsheetApp.openById("1bGSENQjSmmYv8V84aInyqk-K7r4niSXFlPqv0zEFQ1U");
    var sheet = ss.getSheetByName('ลงตารางงาน');
    if (!sheet) return { success: false, message: 'ไม่พบ Sheet ข้อมูล' };

    var data = sheet.getDataRange().getValues();
    var updateMap = {};
    updates.forEach(function (u) { updateMap[String(u.name).trim()] = u.isApproved; });
    var searchB = String(branch).trim();

    for (var i = 1; i < data.length; i++) {
      if (isSameDate(data[i][1], dateStr) && String(data[i][2]).trim() === searchB) {
        var rowName = String(data[i][4]).trim();
        if (updateMap.hasOwnProperty(rowName)) {
          var isAppr = updateMap[rowName];
          var val = isAppr ? approverName : '';
          sheet.getRange(i + 1, 21).setValue(val); // Col U (Index 20 / Column 21)
        }
      }
    }
    return { success: true, message: 'บันทึกการอนุมัติ OT เรียบร้อย' };
  } catch (e) { return { success: false, message: e.message }; }
}

// --- 5. ดึงข้อมูลสถิติสาขา ---
function getBranchStats(selectedBranch) {
  try {
    var ss = SpreadsheetApp.openById(SALES_DATA_SPREADSHEET_ID);
    var sheet = ss.getSheetByName('Details');
    if (!sheet) return { success: false, message: 'ไม่พบ Sheet Details' };
    var data = sheet.getDataRange().getDisplayValues();
    var searchBranch = String(selectedBranch).trim();

    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === searchBranch) {
        return {
          success: true, sales: data[i][1], dailyTarget: data[i][2],
          monthlyTarget: data[i][3], maxWage: data[i][5]
        };
      }
    }
    return { success: false, message: 'ไม่พบข้อมูลสาขานี้' };
  } catch (e) { return { success: false, message: e.message }; }
}

// --- 6. ดึงยอดขายรายวัน ---
function getDailySales(searchDateStr, searchBranch) {
  try {
    var ss = SpreadsheetApp.openById(SALES_DATA_SPREADSHEET_ID);
    var sheet = ss.getSheetByName('ยอดขายสาขา');
    if (!sheet) return { success: true, sales: 0, message: 'ไม่พบ Sheet' };
    var data = sheet.getDataRange().getValues();
    var searchB = String(searchBranch).trim();

    for (var i = 1; i < data.length; i++) {
      if (isSameDate(data[i][0], searchDateStr) && String(data[i][2]).trim() === searchB) {
        return { success: true, sales: data[i][3] };
      }
    }
    return { success: true, sales: 0 };
  } catch (e) { return { success: false, message: e.message }; }
}

// --- ดึงข้อมูลการแจ้งเตือน OT ---
function getOTNotifications(searchBranch) {
  try {
    var ss = SpreadsheetApp.openById("1bGSENQjSmmYv8V84aInyqk-K7r4niSXFlPqv0zEFQ1U");
    var sheet = ss.getSheetByName('ลงตารางงาน');
    if (!sheet) return { success: false, message: 'ไม่พบตารางข้อมูล' };

    var data = sheet.getDataRange().getValues();
    var pending = [];
    var approved = [];

    var branchStr = String(searchBranch).trim();
    var isAdmin = (branchStr === 'All' || branchStr === 'Admin' || branchStr === '');

    // วนลูปจากล่างขึ้นบน เพื่อให้ได้ข้อมูลล่าสุดก่อน
    for (var i = data.length - 1; i >= 1; i--) {
      var row = data[i];
      var rowBranch = String(row[2]).trim(); // คอลัมน์ C: สาขา

      if (isAdmin || rowBranch === branchStr) {
        var otVal = parseFloat(row[9]); // คอลัมน์ J: OT (ชม.)
        if (!isNaN(otVal) && otVal > 0) {
          var approver = String(row[20] || '').trim(); // คอลัมน์ U: ผู้อนุมัติ OT
          var workDateStr = '';
          var workDateFormatted = '';

          // แก้ไขการแปลงวันที่ให้แม่นยำยิ่งขึ้น
          var d = new Date(row[1]);
          if (!isNaN(d.getTime())) {
            workDateStr = Utilities.formatDate(d, "Asia/Bangkok", 'yyyy-MM-dd');
            workDateFormatted = Utilities.formatDate(d, "Asia/Bangkok", 'dd/MM/yyyy');
          } else {
            workDateStr = String(row[1]);
            workDateFormatted = workDateStr;
          }

          var notifItem = {
            date: workDateStr,
            dateFormatted: workDateFormatted,
            branch: rowBranch,
            name: String(row[4] || '').trim(), // คอลัมน์ E: ชื่อพนักงาน
            ot: otVal,
            approver: approver
          };

          if (approver === '') {
            if (pending.length < 30) pending.push(notifItem); // แสดงรออนุมัติสูงสุด 30 รายการ
          } else {
            if (approved.length < 10) approved.push(notifItem); // แสดงอนุมัติแล้วล่าสุด 10 รายการ
          }
        }
      }

      // หยุดค้นหาเมื่อข้อมูลเต็ม เพื่อความรวดเร็ว
      if (pending.length >= 30 && approved.length >= 10) break;
    }

    return { success: true, data: { pending: pending, approved: approved } };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function doOptions(e) {
  // Return empty response with CORS headers for Preflight requests
  var response = { status: 'ok' };
  return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput("HR System Backend is running.");
}
