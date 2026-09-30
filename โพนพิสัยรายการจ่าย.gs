/**
 * ฟังก์ชันจัดรูปแบบตัวเลข ใส่เครื่องหมายจุลภาค (Comma)
 * และแสดง '-' กรณีที่ไม่มีข้อมูลตัวเลข
 * (ประกาศไว้ด้านบนสุดตามข้อกำหนด)
 * 
 * @param {number|string} num - ตัวเลขที่ต้องการจัดรูปแบบ
 * @return {string} ตัวเลขที่มี Comma หรือ '-'
 */
function formatNumber(num) {
  if (num === null || num === undefined || num === '') {
    return '-';
  }
  const cleanStr = String(num).replace(/,/g, '').trim();
  const n = Number(cleanStr);
  if (isNaN(n)) {
    return '-';
  }
  // แสดงผลตัวเลขพร้อม Comma คั่นหลักพัน และทศนิยมสูงสุด 2 ตำแหน่ง
  return n.toLocaleString('th-TH', { maximumFractionDigits: 2 });
}

/**
 * ฟังก์ชันหลัก: สรุปรายงานรายการจ่ายประจำวัน (ของเมื่อวาน) ส่งเป็น LINE Flex Message
 * *** ให้เลือกเรียกใช้ฟังก์ชันนี้เสมอนะคะ ***
 */
function sendYesterdayLineReport() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const LINE_ACCESS_TOKEN = scriptProperties.getProperty('LINE_ACCESS_TOKEN');
  const TARGET_ID = scriptProperties.getProperty('TARGET_ID');
  const ACCOUNTANT_LINE_ID = scriptProperties.getProperty('ACCOUNTANT_LINE_ID');

  if (!LINE_ACCESS_TOKEN || !TARGET_ID) {
    Logger.log('⚠️ กรุณาตั้งค่า LINE_ACCESS_TOKEN และ TARGET_ID ใน Script Properties ก่อนนะคะ');
    return;
  }

  // 1. คำนวณวันที่ของ "เมื่อวาน" (Yesterday)
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  
  const yDay = yesterday.getDate();
  const yMonth = yesterday.getMonth() + 1; // 1 - 12
  const yYearCE = yesterday.getFullYear(); // ปี ค.ศ.

  // รูปแบบวันที่ d/M/yyyy สำหรับแสดงในหัวข้อรายงาน (เช่น 16/9/2026)
  const displayYesterdayStr = `${yDay}/${yMonth}/${yYearCE}`;

  // เดือนแบบไทยสำหรับค้นหาชีต เช่น "ก.ย."
  const THAI_MONTHS_FOR_SHEET = [
    'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
  ];
  const yMonthAbbr = THAI_MONTHS_FOR_SHEET[yMonth - 1] || '';

  // 2. เข้าถึง Google Sheets: เลือกชีตประจำเดือนเป้าหมาย
  //    (Trigger รันเบื้องหลังไม่มี "active sheet" -> getActiveSheet() อาจคืนชีตแรก เช่น "ตาราง Pivot 1")
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = findTargetSheet(ss, yMonthAbbr, yDay, yMonth, now);
  if (!sheet) {
    Logger.log('ไม่พบชีตประจำเดือนนี้ (' + yMonthAbbr + ') กรุณาตรวจสอบชื่อชีตใน Google Sheets ค่ะ');
    return;
  }
  const data = sheet.getDataRange().getValues();
  const sheetUrl = ss.getUrl();

  // ยอดค้างจ่ายทั้งหมดจาก Cell I1 (เช่น "ค้างจ่าย   511,105")
  // อ่านจากชีตที่ใช้รายงานก่อน หากว่างให้เช็คชีต "เดือนก่อนหน้า" อีก 1 ชีต (คาบเกี่ยวต้นเดือน)
  const prevMonthNum = yMonth === 1 ? 12 : yMonth - 1;
  const prevMonthAbbr = THAI_MONTHS_FOR_SHEET[prevMonthNum - 1];
  const outstandingData = findOutstandingWithSource(ss, sheet, prevMonthAbbr);

  let noteText = '-';
  let outstandingStr = '-';
  let outstandingLabel = '📌 ยอดค้างจ่ายทั้งหมด';
  if (outstandingData) {
    noteText = outstandingData.text;
    outstandingStr = '฿' + formatNumber(outstandingData.amount);
    outstandingLabel = '📌 ยอดค้างจ่ายทั้งหมด (' + outstandingData.source + ')';
  }

  // 3. แยกอาร์เรย์เก็บข้อมูล 2 กลุ่ม: จ่ายสด vs บัญชีอื่นๆ
  const cashItems = [];
  const otherItems = [];
  let totalCashPaid = 0;
  let totalOtherPaid = 0;

  // วนลูปอ่านข้อมูลตั้งแต่แถวที่ 2 (index 1) เป็นต้นไป
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const cellA = row[0]; // คอลัมน์ A: วันที่รับสินค้า
    const creditor = row[1]; // คอลัมน์ B: เจ้าหนี้
    const payment = row[4]; // คอลัมน์ E: ยอดชำระ
    const cellF = row[5]; // คอลัมน์ F: วันที่ชำระเงิน (จุดค้นหาหลัก)
    const accountName = row[6] ? String(row[6]).trim() : ''; // คอลัมน์ G: ชื่อบัญชี (จ่าย)
    const bank = row[7] ? String(row[7]).trim() : ''; // คอลัมน์ H: ธนาคาร

    // ตรวจสอบว่า คอลัมน์ F (วันที่ชำระเงิน) ตรงกับวันที่ "เมื่อวาน" หรือไม่
    const dateParsed = parseDateFlexible(cellF, yYearCE);

    if (dateParsed && dateParsed.day === yDay && dateParsed.month === yMonth) {
      // ตรวจสอบว่าแถวนี้มีข้อมูลธุรกรรม (มีเจ้าหนี้ หรือ มียอดชำระ)
      const hasContent = (creditor && String(creditor).trim() !== '') || 
                         (payment !== '' && payment !== null && !isNaN(Number(payment)));

      if (hasContent) {
        const creditorDisplay = creditor ? String(creditor).trim() : '-';
        const dateDisplay = formatCellDate(cellA, '-');
        const accountDisplay = accountName || '-';
        const bankDisplay = bank || '-';
        const paymentNum = Number(String(payment).replace(/,/g, '')) || 0;
        const paymentDisplay = formatNumber(payment);

        const itemObj = {
          creditor: creditorDisplay,
          date: dateDisplay,
          account: accountDisplay,
          bank: bankDisplay,
          paymentDisplay: paymentDisplay
        };

        // แยกหมวดหมู่ตามชื่อบัญชี (คำว่า "สด" เช่น จ่ายสด / เงินสด)
        if (accountName.includes('สด')) {
          cashItems.push(itemObj);
          totalCashPaid += paymentNum;
        } else {
          otherItems.push(itemObj);
          totalOtherPaid += paymentNum;
        }
      }
    }
  }

  const totalCount = cashItems.length + otherItems.length;

  // 4. ส่งข้อความเข้า LINE
  if (totalCount > 0) {
    // ---------------- กรณีพบข้อมูล: ส่ง LINE Flex Message ----------------
    const payloadData = {
      dateStr: displayYesterdayStr,
      cashItems: cashItems,
      otherItems: otherItems,
      totalCash: totalCashPaid,
      totalOther: totalOtherPaid,
      totalAll: totalCashPaid + totalOtherPaid,
      note: noteText,
      outstanding: outstandingStr,
      outstandingLabel: outstandingLabel,
      sheetUrl: sheetUrl
    };

    const flexBubble = createReportFlexBubble(payloadData);

    pushLineFlex(
      LINE_ACCESS_TOKEN, 
      TARGET_ID, 
      `📊 รายงานรายการจ่าย โพนพิสัย ประจำวันที่ ${displayYesterdayStr}`, 
      flexBubble
    );

  } else {
    // ---------------- กรณีไม่พบข้อมูล: ส่งข้อความแจ้งเตือน ----------------
    const alertMessage = `⚠️ แจ้งเตือนลงข้อมูลประจำวันค่ะ\n` +
                         `📌 [รายการจ่าย โพนพิสัย]\n` +
                         `━━━━━━━━━━━━━━━━━━\n` +
                         `ยังไม่พบข้อมูลรายการของวันที่ [${displayYesterdayStr}] ในระบบนะคะ ` +
                         `รบกวนทางฝ่ายบัญชีช่วยตรวจสอบและลงข้อมูลให้ด้วยนะคะ ขอบคุณค่ะ 🙏✨`;

    pushLineText(LINE_ACCESS_TOKEN, TARGET_ID, alertMessage);

    if (ACCOUNTANT_LINE_ID && ACCOUNTANT_LINE_ID !== TARGET_ID) {
      pushLineText(LINE_ACCESS_TOKEN, ACCOUNTANT_LINE_ID, alertMessage);
    }
  }
}

/**
 * สร้างโครงสร้าง Flex Message (Bubble Component) แยก 2 ส่วนชัดเจน
 * ป้องกันข้อผิดพลาดกรณี data เป็น undefined และตัด field ที่ LINE API ไม่รองรับออก
 */
function createReportFlexBubble(data) {
  const safeData = data || {};
  const cashItems = safeData.cashItems || [];
  const otherItems = safeData.otherItems || [];
  const totalAll = safeData.totalAll || 0;
  const totalCash = safeData.totalCash || 0;
  const totalOther = safeData.totalOther || 0;
  const dateStr = safeData.dateStr || '-';
  const note = safeData.note || '-';
  const outstanding = safeData.outstanding || '-';
  const outstandingLabel = safeData.outstandingLabel || '📌 ยอดค้างจ่ายทั้งหมด';
  const sheetUrl = safeData.sheetUrl || 'https://docs.google.com/spreadsheets';

  // ฟังก์ชันย่อยสำหรับสร้างแถวรายการ
  function buildItemRows(items, isCash) {
    return items.map(item => ({
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      margin: "sm",
      contents: [
        {
          type: "box",
          layout: "vertical",
          flex: 7,
          contents: [
            {
              type: "text",
              text: `• ${item.creditor}`,
              size: "xs",
              weight: "bold",
              color: "#1E293B",
              wrap: true
            },
            {
              type: "text",
              text: isCash 
                ? `  รับ: ${item.date} (${item.bank})` 
                : `  รับ: ${item.date} | ${item.account} (${item.bank})`,
              size: "xxs",
              color: "#64748B",
              wrap: true
            }
          ]
        },
        {
          type: "text",
          text: `฿${item.paymentDisplay}`,
          size: "xs",
          weight: "bold",
          color: isCash ? "#059669" : "#2563EB",
          align: "end",
          flex: 4
        }
      ]
    }));
  }

  // สร้างเนื้อหาภายใน Body
  const bodyContents = [
    // กล่องสรุปยอดรวม (Summary Box)
    {
      type: "box",
      layout: "vertical",
      backgroundColor: "#F8FAFC",
      cornerRadius: "10px",
      paddingAll: "12px",
      borderColor: "#E2E8F0",
      borderWidth: "1px",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          contents: [
            { type: "text", text: "💳 รวมจ่ายทั้งสิ้น", size: "sm", weight: "bold", color: "#334155" },
            { type: "text", text: `฿${formatNumber(totalAll)}`, size: "md", weight: "bold", color: "#DC2626", align: "end" }
          ]
        },
        { type: "separator", margin: "sm", color: "#CBD5E1" },
        {
          type: "box",
          layout: "horizontal",
          margin: "sm",
          contents: [
            { type: "text", text: "💵 เงินสดร้าน", size: "xs", color: "#64748B" },
            { type: "text", text: `฿${formatNumber(totalCash)}`, size: "xs", weight: "bold", color: "#059669", align: "end" }
          ]
        },
        {
          type: "box",
          layout: "horizontal",
          margin: "xs",
          contents: [
            { type: "text", text: "🏦 เงินโอน/บัญชี", size: "xs", color: "#64748B" },
            { type: "text", text: `฿${formatNumber(totalOther)}`, size: "xs", weight: "bold", color: "#2563EB", align: "end" }
          ]
        },
        { type: "separator", margin: "sm", color: "#CBD5E1" },
        {
          type: "box",
          layout: "horizontal",
          margin: "sm",
          contents: [
            { type: "text", text: `${outstandingLabel}`, size: "xs", weight: "bold", color: "#92400E", wrap: true },
            { type: "text", text: `${outstanding}`, size: "sm", weight: "bold", color: "#B45309", align: "end" }
          ]
        }
      ]
    },
    // แถบเตือนค้างจ่าย (Cell I1)
    {
      type: "box",
      layout: "horizontal",
      margin: "md",
      backgroundColor: "#FEF3C7",
      cornerRadius: "6px",
      paddingAll: "8px",
      contents: [
        { type: "text", text: "📝", size: "xxs", flex: 1 },
        { type: "text", text: `${note}`, size: "xxs", color: "#92400E", weight: "bold", flex: 9, wrap: true }
      ]
    }
  ];

  // ส่วนที่ 1: รายการจ่ายสดหน้าร้าน
  if (cashItems.length > 0) {
    bodyContents.push(
      { 
        type: "text", 
        text: `💵 รายการจ่ายสด (${cashItems.length} รายการ)`, 
        size: "xs", 
        weight: "bold", 
        color: "#059669", 
        margin: "lg" 
      },
      { type: "separator", margin: "xs", color: "#A7F3D0" },
      { type: "box", layout: "vertical", margin: "xs", contents: buildItemRows(cashItems, true) }
    );
  }

  // ส่วนที่ 2: รายการจ่ายผ่านบัญชี/เงินโอน
  if (otherItems.length > 0) {
    bodyContents.push(
      { 
        type: "text", 
        text: `🏦 รายการจ่ายผ่านบัญชี/เงินโอน (${otherItems.length} รายการ)`, 
        size: "xs", 
        weight: "bold", 
        color: "#2563EB", 
        margin: "lg" 
      },
      { type: "separator", margin: "xs", color: "#BFDBFE" },
      { type: "box", layout: "vertical", margin: "xs", contents: buildItemRows(otherItems, false) }
    );
  }

  return {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#1E3A8A",
      paddingAll: "14px",
      contents: [
        { 
          type: "text", 
          text: "โพนพิสัย — รายการจ่ายประจำวัน", 
          weight: "bold", 
          color: "#93C5FD", 
          size: "xxs"
        },
        { 
          type: "text", 
          text: `📅 ${dateStr}`, 
          weight: "bold", 
          color: "#FFFFFF", 
          size: "md", 
          margin: "xs" 
        }
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      contents: bodyContents
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "10px",
      contents: [
        {
          type: "button",
          style: "link",
          height: "sm",
          action: {
            type: "uri",
            label: "📊 เปิดดูใน Google Sheets",
            uri: sheetUrl
          }
        }
      ]
    }
  };
}

/**
 * ฟังก์ชันช่วย: แปลงค่า Excel Serial Number (เช่น 46266) ให้เป็น Date
 * @param {number|string} serial
 * @return {Date|null}
 */
function parseExcelSerial(serial) {
  const n = Number(serial);
  if (isNaN(n) || n <= 0 || n > 100000) return null;
  return new Date(Math.round((n - 25569) * 86400 * 1000)); // 25569 = 1970-01-01 - 1900-01-01
}

/**
 * ฟังก์ชันช่วย: แปลงและตรวจจับวันที่ใน Cell แบบยืดหยุ่น
 * รองรับ: Date Object, Excel Serial, ISO (yyyy-MM-dd), d/M/yyyy, dd/MM/yyyy
 */
function parseDateFlexible(val, defaultYear) {
  if (!val) return null;

  if (val instanceof Date) {
    return {
      day: val.getDate(),
      month: val.getMonth() + 1,
      year: val.getFullYear()
    };
  }

  const str = String(val).trim();
  if (!str) return null;

  // Excel Serial Number (เช่น "46266") -> แปลงเป็น Date
  if (/^\d{4,5}(\.\d+)?$/.test(str)) {
    const d = parseExcelSerial(str);
    if (d) {
      return {
        day: d.getDate(),
        month: d.getMonth() + 1,
        year: d.getFullYear()
      };
    }
  }

  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return {
      day: parseInt(isoMatch[3], 10),
      month: parseInt(isoMatch[2], 10),
      year: parseInt(isoMatch[1], 10)
    };
  }

  const slashMatch = str.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (slashMatch) {
    return {
      day: parseInt(slashMatch[1], 10),
      month: parseInt(slashMatch[2], 10),
      year: slashMatch[3] ? parseInt(slashMatch[3], 10) : defaultYear
    };
  }

  return null;
}

/**
 * ฟังก์ชันช่วย: จัดรูปแบบวันที่รับสินค้าให้อ่านง่ายและกระชับ (d/M)
 */
function formatCellDate(cellVal, fallbackStr) {
  if (!cellVal) return fallbackStr;
  if (cellVal instanceof Date) {
    return `${cellVal.getDate()}/${cellVal.getMonth() + 1}`;
  }
  const str = String(cellVal).trim();
  if (/^\d{4,5}(\.\d+)?$/.test(str)) {
    const d = parseExcelSerial(str);
    if (d) return `${d.getDate()}/${d.getMonth() + 1}`;
  }
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return `${parseInt(isoMatch[3], 10)}/${parseInt(isoMatch[2], 10)}`;
  }
  return str !== '' ? str : fallbackStr;
}

/**
 * ดึงยอดค้างจ่ายจาก Cell I1 -> { amount: number|null, text: string }
 * รองรับทั้งข้อความ "ค้างจ่าย   511,105" และตัวเลขล้วน (เช่น 732675)
 */
function parseOutstandingCell(cellValue) {
  const out = { amount: null, text: '-' };
  if (cellValue === null || cellValue === undefined || String(cellValue).trim() === '') {
    return out;
  }
  out.text = String(cellValue).replace(/\s+/g, ' ').trim();
  const m = out.text.match(/[\d,]+(?:\.\d+)?/);
  if (m) {
    out.amount = Number(m[0].replace(/,/g, ''));
  } else if (typeof cellValue === 'number' && !isNaN(cellValue)) {
    out.amount = cellValue;
  }
  return out;
}

/**
 * หาชีตตามคำย่อเดือน (เช่น "ส.ค.") แล้วคืนชีตแรกที่ชื่อตรง -> Sheet|null
 */
function findSheetByAbbr(ss, abbr) {
  if (!abbr) return null;
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().includes(abbr)) return sheets[i];
  }
  return null;
}

/**
 * อ่าน Cell I1 ของชีต แล้วคืน data จาก parseOutstandingCell เฉพาะกรณีมียอดค้างจริง -> Object|null
 */
function readOutstandingFromSheet(sheetToRead) {
  try {
    if (!sheetToRead) return null;
    const v = sheetToRead.getRange('I1').getValue();
    const d = parseOutstandingCell(v);
    if (d && d.amount !== null && !isNaN(d.amount)) return d;
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * ดึงเดือนจากชื่อชีต เช่น "ก.ย.69" -> "ก.ย.69" / "ตาราง Pivot 1" -> ""
 */
function getSheetMonthLabel(sheetName) {
  const names = sheetName ? String(sheetName) : '';
  const MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  for (let i = 0; i < MON.length; i++) {
    if (names.includes(MON[i])) {
      const yMatch = names.match(/(\d{2,4})/);
      return yMatch ? MON[i] + yMatch[1] : MON[i];
    }
  }
  return '';
}

/**
 * หายอดค้างจ่ายจาก Cell I1: อ่านชีตที่ใช้รายงานก่อน หากว่างให้เช็คชีต "เดือนก่อนหน้า" อีก 1 ชีต
 * (รองรับช่วงคาบเกี่ยวต้นเดือนที่ยอดค้างอาจอยู่ที่ชีตเดือนก่อนหน้า)
 * @return {Object|null} { amount, text, source } - source คือชื่อเดือนของชีตที่มียอดค้าง
 */
function findOutstandingWithSource(ss, reportSheet, prevMonthAbbr) {
  const trySheet = (sh, fallbackAbbr) => {
    if (!sh) return null;
    const data = readOutstandingFromSheet(sh);
    if (!data) return null;
    return { amount: data.amount, text: data.text, source: getSheetMonthLabel(sh.getName()) || fallbackAbbr };
  };

  const fromReport = trySheet(reportSheet, '');
  if (fromReport) return fromReport;

  const prevSheet = findSheetByAbbr(ss, prevMonthAbbr);
  if (prevSheet && prevSheet !== reportSheet) {
    return trySheet(prevSheet, prevMonthAbbr);
  }
  return null;
}

/**
 * หาชีตประจำเดือนเป้าหมาย (ใช้ได้ทั้ง Trigger รันเบื้องหลัง และ รันด้วยมือ)
 * 1. ชีตที่ชื่อตรงเดือนเมื่อวาน และมีข้อมูลเดือนนั้นในคอลัมน์ A
 * 2. ชีตที่ "มีข้อมูลเดือนเป้าหมาย" จริง (เช่น 1 ต.ค. ยังไม่มี ต.ค.69 -> อ่าน ก.ย.69)
 * 3. ชีตที่ชื่อตรงเดือนปัจจุบัน และมีข้อมูลเดือนนั้น
 * 4. สำรอง -> active sheet
 * @param {SpreadsheetApp.Spreadsheet} ss
 * @param {string} monthAbbr เช่น "ก.ย."
 * @param {number} day
 * @param {number} month
 * @param {Date} now
 * @return {Sheet|null}
 */
function findTargetSheet(ss, monthAbbr, day, month, now) {
  const THAI_MONTHS = [
    'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
  ];
  const nowDate = now || new Date();
  const curMonthAbbr = THAI_MONTHS[nowDate.getMonth()] || '';
  const curMonthNum = nowDate.getMonth() + 1;

  const sheets = ss.getSheets();
  let fallbackTarget = null;
  let fallbackCur = null;
  let sheetWithTargetDates = null;

  for (let i = 0; i < sheets.length; i++) {
    const name = sheets[i].getName();
    const hasTargetMonthName = name.includes(monthAbbr);
    const hasCurMonthName = name.includes(curMonthAbbr);

    // ชีตที่ชื่อตรงเดือนเป้าหมาย และมีข้อมูลเดือนนั้น -> เลือกทันที
    if (hasTargetMonthName && sheetHasDateColumn(sheets[i], month)) {
      return sheets[i];
    }

    // จำชีตที่ "มีข้อมูลเดือนเป้าหมาย" ไว้แม้ชื่อจะไม่ตรง
    if (month !== curMonthNum) {
      if (!sheetWithTargetDates && sheetHasDateColumn(sheets[i], month)) {
        sheetWithTargetDates = sheets[i];
      }
    }

    if (hasCurMonthName && sheetHasDateColumn(sheets[i], curMonthNum)) {
      if (!fallbackCur) fallbackCur = sheets[i];
      continue;
    }

    if (hasTargetMonthName && !fallbackTarget) fallbackTarget = sheets[i];
    if (hasCurMonthName && !fallbackCur) fallbackCur = sheets[i];
  }

  if (sheetWithTargetDates) return sheetWithTargetDates;
  if (fallbackCur) return fallbackCur;
  if (fallbackTarget) return fallbackTarget;

  try {
    return ss.getActiveSheet();
  } catch (e) {
    return null;
  }
}

/**
 * ตรวจสอบว่าชีตมีข้อมูลของเดือนเป้าหมายอยู่จริงหรือไม่ (อ่านคอลัมน์ A)
 * @param {Sheet} sheet
 * @param {number} targetMonth 1-12
 * @return {boolean}
 */
function sheetHasDateColumn(sheet, targetMonth) {
  try {
    const last = sheet.getLastRow();
    if (last < 2) return false;

    const aCol = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < aCol.length; i++) {
      const cv = aCol[i][0];
      if (cv instanceof Date) {
        if (cv.getMonth() + 1 === targetMonth) return true;
      } else if (cv !== null && cv !== undefined) {
        const s = String(cv).trim();
        const m = s.match(/^\d{1,2}\/(\d{1,2})(?:\/\d{2,4})?/);
        if (m && parseInt(m[1], 10) === targetMonth) return true;
        if (/^\d{4,5}(\.\d+)?$/.test(s)) {
          const d = parseExcelSerial(s);
          if (d && d.getMonth() + 1 === targetMonth) return true;
        }
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * ฟังก์ชันส่งข้อความ LINE แบบ Flex Message
 */
function pushLineFlex(token, recipientId, altText, flexBubble) {
  const url = 'https://api.line.me/v2/bot/message/push';
  const payload = {
    to: recipientId,
    messages: [
      {
        type: 'flex',
        altText: altText,
        contents: flexBubble
      }
    ]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    if (code === 200) {
      Logger.log(`ส่ง Flex Message ไปยัง ${recipientId} สำเร็จเรียบร้อยค่ะ ✨`);
    } else {
      Logger.log(`เกิดข้อผิดพลาดในการส่ง Flex (${code}): ${response.getContentText()}`);
    }
  } catch (err) {
    Logger.log(`เกิดข้อผิดพลาดในการเชื่อมต่อ LINE API: ${err.message}`);
  }
}

/**
 * ฟังก์ชันส่งข้อความแบบ Text ธรรมดา (ใช้สำหรับแจ้งเตือนกรณีไม่พบข้อมูล)
 */
function pushLineText(token, recipientId, textMessage) {
  const url = 'https://api.line.me/v2/bot/message/push';
  const payload = {
    to: recipientId,
    messages: [{ type: 'text', text: textMessage }]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    if (code === 200) {
      Logger.log(`ส่ง Text Message ไปยัง ${recipientId} สำเร็จเรียบร้อยค่ะ ✨`);
    } else {
      Logger.log(`เกิดข้อผิดพลาดในการส่ง Text (${code}): ${response.getContentText()}`);
    }
  } catch (err) {
    Logger.log(`เกิดข้อผิดพลาดในการเชื่อมต่อ LINE API: ${err.message}`);
  }
}