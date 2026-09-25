/**
 * ============================================================================
 *  ระบบบันทึกการใช้รถ โพนพิสัย ผ่าน LINE Messaging API + Google Sheets
 *  (ออกแบบให้รองรับ Web Dashboard ผ่าน AppSheet)
 *
 *  โครงสร้างข้อมูล (หัวตารางตามไฟล์ บันทึกน้ำมัน.xlsx):
 *   - ชีท "ผู้รับผิดชอบรถ" : line_id | name | plate
 *   - ชีท "เหตุการณ์"      : event_id | timestamp | event_time | event_type |
 *                            sender_line_id | plate | mileage_km | error_note
 *   - ชีท "เติมน้ำมัน"      : event_id | fuel_before_pct | fuel_after_pct |
 *                            amount_baht | price_per_liter | liters | district |
 *                            receipt_url | error_note
 *   - ชีท "Log"            : message_id | sender_line_id | event_id | status |
 *                            error_log | received_at   (ไม่สร้างตารางใน AppSheet)
 *
 *  สถาปัตยกรรม (Async Queue):
 *   LINE Webhook -> doPost(e) ตอบ 200 ทันที + เขียน Log (status=queued)
 *   Time-Driven Trigger (ทุก 1 นาที) -> processQueuedMessages()
 *        จับกลุ่มรูปจากคนเดียวกันในช่วงเวลากล้อกัน -> Gemini อ่านรูป ->
 *        ระบุรถ/เข้า-ออก -> เขียนชีท เหตุการณ์ (+ เติมน้ำมัน) -> อัปเดต Log
 *
 *  ScriptProperties ที่ต้องตั้งค่า:
 *   LINE_ACCESS_TOKEN, GOOGLE_SHEET_ID, FOLDER_ID, GEMINI_API_KEY
 *
 *  ค่าปรับเพิ่มเติม (ถ้าไม่ตั้งจะใช้ค่า default ใน DEFAULT_CONFIG):
 *   GEMINI_MODEL, WAIT_MINUTES, GAP_MINUTES, TZ,
 *   SHEET_VEHICLES, SHEET_EVENTS, SHEET_FUEL, SHEET_LOG
 * ============================================================================
 */

// ==================== ค่า config (ค่าเริ่มต้นในโค้ด) ========================
// ค่าทั้งหมดด้านล่าง override ได้ผ่าน ScriptProperties (Project Settings)
// โดยใช้ชื่อคีย์เดียวกัน เช่น GEMINI_MODEL, WAIT_MINUTES, TZ
// loadConfig_() จะอ่าน properties แล้ว merge ทับค่าเริ่มต้นเหล่านี้
// ถ้าไม่ได้ตั้งค่าใด ๆ ระบบจะทำงานด้วยค่า default ทันที
var DEFAULT_CONFIG = {
  SHEET_VEHICLES: 'ผู้รับผิดชอบรถ',
  SHEET_EVENTS:   'เหตุการณ์',
  SHEET_FUEL:     'เติมน้ำมัน',
  SHEET_LOG:      'Log',
  GEMINI_MODEL:   'gemini-3.5-flash-lite', // *** ตรวจสอบชื่อรุ่นจริงก่อน Deploy ***
  WAIT_MINUTES:   '3',  // รอประมวลผลจนสุดท้ายของกลุ่มอายุ (ให้ภาพมาครบชุด)
  GAP_MINUTES:    '10', // ภาพของ sender เดียวกันภายในช่วงนี้ = เหตุการณ์เดียวกัน
  TZ:             'Asia/Bangkok'
};

// ============================ Webhook ======================================
/**
 * จุดรับ Webhook จาก LINE
 * - ตอบ HTTP 200 ทันที
 * - ไม่ Verify Signature ตามข้อกำหนด
 * - เฉพาะ event ประเภท image -> เขียน Log (status=queued) เพื่อรอ worker
 *   ประมวลผล (กัน duplicate ด้วย message_id)
 */
function doPost(e) {
  try {
    setupSheet_();

    var body = JSON.parse(e.postData.contents);
    var events = body.events || [];

    events.forEach(function (evt) {
      if (!evt.message || evt.message.type !== 'image') return; // สนใจเฉพาะรูปภาพ
      var messageId = String(evt.message.id);
      var senderId = evt.source && evt.source.userId ? String(evt.source.userId) : 'ไม่ระบุ';
      var receivedAt = evt.timestamp ? new Date(evt.timestamp) : new Date();

      if (isDuplicateMessageId_(messageId)) return; // กันทำซ้ำ

      addLogRow_(messageId, senderId, null, 'queued', '', receivedAt);
    });

  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
  }

  return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
}

// ==================== Worker: ประมวลผลคิว (Time Trigger) ==================
/**
 * ฟังก์ชันที่ Time-Driven Trigger เรียกทุก 1 นาที
 * อ่าน Log ที่ status=queued -> จับกลุ่มโดย sender + ช่วงเวลา -> ประมวลผลเป็นเหตุการณ์
 */
function processQueuedMessages() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('Lock ไม่ว่าง ข้ามรอบนี้');
    return;
  }

  try {
    setupSheet_();

    var queued = getLogRowsQueued_();
    if (queued.length === 0) return;

    var groups = groupQueuedRows_(queued);
    Logger.log('พบคิวฟรี ' + queued.length + ' รายการ -> ' + groups.length + ' กลุ่ม');

    groups.forEach(function (rows) {
      var oldest = minReceivedAt_(rows);
      var ageMin = (Date.now() - oldest.getTime()) / 60000;
      if (ageMin < getConfig_().WAIT_MINUTES) {
        Logger.log('ข้ามกลุ่ม: รอภาพมาครบ (' + Math.round(ageMin) + ' นาที)');
        return;
      }
      try {
        processEventGroup_(rows);
      } catch (grpErr) {
        Logger.log('ประมวลผลกลุ่มผิดพลาด: ' + grpErr.toString());
        rows.forEach(function (r) {
          updateLogStatus_(r.rowIdx, 'error', grpErr.toString());
        });
      }
    });

  } finally {
    lock.releaseLock();
  }
}

/** จับกลุ่มแถว Log โดย group ตาม sender_line_id + เวลาห่างกันไม่เกิน GAP_MINUTES */
function groupQueuedRows_(queued) {
  var groups = [];
  var current = null;

  queued.sort(function (a, b) {
    return a.receivedAt.getTime() - b.receivedAt.getTime();
  });

  queued.forEach(function (r) {
    if (current &&
        current[0].sender === r.sender &&
        (r.receivedAt.getTime() - maxReceivedAt_(current).getTime()) / 60000 <= getConfig_().GAP_MINUTES) {
      current.push(r);
    } else {
      current = [r];
      groups.push(current);
    }
  });

  return groups;
}

/**
 * ประมวลผล 1 เหตุการณ์จากกลุ่มรูป
 * 1) ดาวน์โหลดภาพแต่ละรูป
 * 2) ให้ Gemini อ่านแต่ละภาพ (ประเภทภาพ/เลขไมล์/%น้ำมัน/ข้อมูลบิล)
 * 3) รวมผล -> ระบุรถ -> แยกเข้า/ออก -> เขียนชีท -> อัปเดต Log
 */
function processEventGroup_(rows) {
  var results = [];   // ผลจาก Gemini ต่อภาพ

  rows.forEach(function (r) {
    try {
      var img = downloadLineImage_(r.messageId);
      var analysis = analyzeImageWithGemini_(img.blob, img.mime);
      results.push({ messageId: r.messageId, analysis: analysis, blob: img.blob });
    } catch (e) {
      results.push({ messageId: r.messageId, analysis: { image_type: 'unknown', error: e.toString() } });
    }
  });

  var sender = rows[0].sender;
  var eventTime = rows[0].receivedAt; // default: เวลา LINE

  // ---- รวม/เลือกผลวิเคราะห์ ----
  var mileage = null;
  var fuelVals = [];        // ค่า % จากภาพเกจ
  var fuelReadings = [];    // จับคู่ค่า % กับ index ของภาพต้นทาง (ใช้ upload ภาพเกจ)
  var receipt = null;       // ข้อมูลจากใบเสร็จ
  var hasReceipt = false;
  var errorNote = [];

  results.forEach(function (res, idx) {
    var a = res.analysis || {};
    var type = String(a.image_type || '').toLowerCase();

    // เก็บระดับน้ำมันจากทุกภาพที่อ่านค่าได้ (รวมรูปแผงไมล์+เข็ม, ไม่จำกัดเฉพาะภาพเกจ)
    if (type.indexOf('unknown') < 0 &&
        a.fuel_percent !== null && a.fuel_percent !== undefined && !isNaN(a.fuel_percent)) {
      var pctV = Math.round(Number(a.fuel_percent));
      fuelVals.push(pctV);
      fuelReadings.push({ pct: pctV, resIndex: idx });
    }

    if (type.indexOf('receipt') >= 0 || type.indexOf('บิล') >= 0) {
      hasReceipt = true;
      if (a.receipt && (!receipt || isMoreCompleteReceipt_(a.receipt, receipt))) {
        receipt = a.receipt;
      }
      if (a.mileage_km !== null && a.mileage_km !== undefined && !isNaN(a.mileage_km)) {
        mileage = Number(a.mileage_km);
      }
    } else if (type.indexOf('odometer') >= 0 || type.indexOf('ไมล์') >= 0) {
      if (a.mileage_km !== null && a.mileage_km !== undefined && !isNaN(a.mileage_km)) {
        if (mileage === null) mileage = Number(a.mileage_km);
        else mileage = Math.max(mileage, Number(a.mileage_km));
      } else if (!hasReceipt) {
        errorNote.push('อ่านเลขไมล์ไม่ได้');
      }
    } else {
      errorNote.push(res.analysis && res.analysis.error ? String(res.analysis.error) : 'ไม่รู้จักประเภทภาพ');
    }
  });

  // ---- สรุปผลวิเคราะห์รายภาพ (บันทึกลง Log.error_log เพื่อตรวจว่าภาพไหนอ่านอะไรได้) ----
  var imageDetail = results.map(function (res, i) {
    var a = res.analysis || {};
    var bits = ['img' + (i + 1) + ':' + String(a.image_type || 'unknown')];
    if (a.mileage_km !== null && a.mileage_km !== undefined && !isNaN(a.mileage_km)) bits.push('มิล' + Number(a.mileage_km));
    if (a.fuel_percent !== null && a.fuel_percent !== undefined && !isNaN(a.fuel_percent)) bits.push('%' + Math.round(Number(a.fuel_percent)));
    if (a.receipt && a.receipt.amount_baht) bits.push('บิล' + String(a.receipt.amount_baht));
    if (a.error) bits.push('ERR:' + String(a.error).slice(0, 60));
    return bits.join(',');
  }).join(' | ');

  // เวลาจากบิล (แปลงเป็น ค.ศ.) -> ใช้เป็น event_time
  if (hasReceipt && receipt) {
    var parsedReceiptTime = parseReceiptDateTime_(
      String(receipt.date_text || ''), String(receipt.time_text || ''));
    if (parsedReceiptTime) eventTime = parsedReceiptTime;
    else errorNote.push('อ่านเวลาบิลไม่ได้ ใช้เวลาตาม LINE');
  }

  // ---- ระบุรถ ----
  var vehicle = identifyVehicle_(sender, mileage);

  // ---- กำหนด event_type ----
  var eventType;

  if (hasReceipt) {
    eventType = 'เติมน้ำมัน';
  } else if (fuelVals.length > 0 && mileage === null && !hasReceipt) {
    // กรณีส่งเกจ มารูปเดียว -> ถือว่าเป็น "หลังเติม" (ตามข้อกำหนดข้อ 5)
    eventType = 'เติมน้ำมัน';
    if (fuelVals.length === 1) errorNote.push('ส่งรูปเกจมารูปเดียว ถือเป็นภาพหลังเติม');
  } else {
    // รูปเลขไมล์ 1 รูป -> แยก เข้า/ออก (ทางเลือก ก.)
    var inOut = decideInOut_(vehicle.plate, eventTime, mileage);
    eventType = inOut.type;
    if (inOut.error) errorNote.push(inOut.error);
  }

  // ---- ค่า fuel_pct ของเหตุการณ์นี้ (เก็บทุกรายการ เข้า/ออก/เติม) ----
  var fuelPct = null;
  if (fuelVals.length > 0) {
    if (eventType === 'เติมน้ำมัน') {
      fuelPct = Math.max.apply(null, fuelVals);
    } else {
      fuelPct = fuelVals[fuelVals.length - 1];
    }
  }

  // ---- เขียนชีท เหตุการณ์ ----
  var eventId = Utilities.getUuid();
  var eventTypeFinal = eventType;
  if (eventType === 'เติมน้ำมัน' && fuelVals.length === 1) {
    errorNote.push('ภาพเกจก่อนเติมอ่านระดับน้ำมันไม่ได้ (ได้แค่หลังเติม)');
  }
  var errorFinal = errorNote.join(' | ');

  writeEventRow_({
    eventId: eventId,
    timestamp: rows[0].receivedAt,
    eventTime: eventTime,
    eventType: eventTypeFinal,
    senderLineId: sender,
    plate: vehicle.plate,
    mileage: mileage,
    fuelPct: fuelPct,
    errorNote: errorFinal + (vehicle.error ? ' | ' + vehicle.error : '')
  });

  // ---- เติมน้ำมัน: เขียนชีท เติมน้ำมัน + copy รูปเกจ/บิลไป Drive ----
  if (eventTypeFinal === 'เติมน้ำมัน') {
    var beforePct = null, afterPct = null;
    var gaugeBeforeUrl = '', gaugeAfterUrl = '';

    if (fuelVals.length >= 2) {
      beforePct = Math.min.apply(null, fuelVals);
      afterPct = Math.max.apply(null, fuelVals);
      var minIdx = fuelVals.indexOf(beforePct);
      var maxIdx = fuelVals.indexOf(afterPct);
      var beforeO = fuelReadings[minIdx];
      var afterO = fuelReadings[maxIdx];
      if (beforeO && results[beforeO.resIndex] && results[beforeO.resIndex].blob) {
        gaugeBeforeUrl = uploadImageToDrive_(results[beforeO.resIndex].blob, vehicle.plate, eventTime, '_before');
      }
      if (afterO && results[afterO.resIndex] && results[afterO.resIndex].blob) {
        gaugeAfterUrl = uploadImageToDrive_(results[afterO.resIndex].blob, vehicle.plate, eventTime, '_after');
      }
    } else if (fuelVals.length === 1) {
      afterPct = fuelVals[0];
      var onlyO = fuelReadings[0];
      if (onlyO && results[onlyO.resIndex] && results[onlyO.resIndex].blob) {
        gaugeAfterUrl = uploadImageToDrive_(results[onlyO.resIndex].blob, vehicle.plate, eventTime, '_after');
      }
    }

    var fuelVars = {};
    if (receipt) {
      fuelVars.amountBaht = toNumOrNull_(receipt.amount_baht);
      fuelVars.pricePerLiter = toNumOrNull_(receipt.price_per_liter);
      fuelVars.liters = toNumOrNull_(receipt.liters);
      fuelVars.district = String(receipt.district || '').trim();
      fuelVars.receiptUrl = uploadReceiptToDrive_(results, vehicle.plate, eventTime);
    }

    writeFuelRow_({
      eventId: eventId,
      fuelBefore: beforePct,
      fuelAfter: afterPct,
      amountBaht: fuelVars.amountBaht,
      pricePerLiter: fuelVars.pricePerLiter,
      liters: fuelVars.liters,
      district: fuelVars.district || '',
      receiptUrl: fuelVars.receiptUrl || '',
      gaugeBeforeUrl: gaugeBeforeUrl,
      gaugeAfterUrl: gaugeAfterUrl,
      errorNote: ''
    });
  }

  // ---- อัปเดต Log -> done ----
  rows.forEach(function (r) {
    updateLogStatusAndEventId_(r.rowIdx, 'done', eventId, imageDetail);
  });
}
// ============================================================================

// ==================== ฟังก์ชันช่วย: ข้อมูลอ้างอิง / ประวัติ ==================
/**
 * อ่าน config ทั้งหมดจาก ScriptProperties แล้วทับค่า default ในโค้ด
 * (คีย์เดียวกันกับ DEFAULT_CONFIG; กันกรณีค่าเป็นค่าว่าง)
 */
function loadConfig_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var cfg = {};
  Object.keys(DEFAULT_CONFIG).forEach(function (k) {
    var v = props[k];
    cfg[k] = (v !== undefined && v !== null && String(v).trim() !== '') ? String(v).trim() : DEFAULT_CONFIG[k];
  });
  cfg.WAIT_MINUTES = Number(cfg.WAIT_MINUTES);
  cfg.GAP_MINUTES = Number(cfg.GAP_MINUTES);
  return cfg;
}

var _configCache = null;
function getConfig_() {
  if (!_configCache) _configCache = loadConfig_();
  return _configCache;
}

function getProps_() {
  return PropertiesService.getScriptProperties().getProperties();
}

function getSheetId_() {
  var props = getProps_();
  return props.GOOGLE_SHEET_ID || props.GOOGLESHEET_ID || '';
}

function getSheet_(name) {
  var id = getSheetId_();
  if (!id) {
    Logger.log('⚠️ ไม่พบ GOOGLE_SHEET_ID ใน ScriptProperties');
    return null;
  }
  var ss = SpreadsheetApp.openById(id);
  return ss.getSheetByName(name);
}

function getVehiclesSheet_() { return getSheet_(getConfig_().SHEET_VEHICLES); }
function getEventsSheet_()   { return getSheet_(getConfig_().SHEET_EVENTS); }
function getFuelSheet_()     { return getSheet_(getConfig_().SHEET_FUEL); }
function getLogSheet_()      { return getSheet_(getConfig_().SHEET_LOG); }

var _sheetSetupChecked = false;
function setupSheet_() {
  if (_sheetSetupChecked) return;
  _sheetSetupChecked = true;

  ensureEventHeader_();
  ensureFuelHeader_();

  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SHEET_SETUP_DONE') === '1') return;

  var id = getSheetId_();
  if (id) {
    try {
      var ss = SpreadsheetApp.openById(id);
      ss.setSpreadsheetTimeZone(getConfig_().TZ);

      var fmt = 'dd/MM/yyyy HH:mm:ss';
      var logSheet = getLogSheet_();
      if (logSheet) logSheet.getRange('F:F').setNumberFormat(fmt);
      var evSheet = getEventsSheet_();
      if (evSheet) {
        evSheet.getRange('B:B').setNumberFormat(fmt);
        evSheet.getRange('C:C').setNumberFormat(fmt);
      }
    } catch (e) {
      Logger.log('setupSheet_ error: ' + e.toString());
    }
  }
  props.setProperty('SHEET_SETUP_DONE', '1');
}

/** เพิ่มคอลัมน์ fuel_pct ในชีท เหตุการณ์ (แทรกหน้า error_note) ถ้ายังไม่มี */
function ensureEventHeader_() {
  var evSheet = getEventsSheet_();
  if (!evSheet) return;
  var lc = evSheet.getLastColumn();
  if (lc < 1) return;
  var headers = evSheet.getRange(1, 1, 1, lc).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i] || '').trim().toLowerCase() === 'fuel_pct') return;
  }
  var errIdx = -1;
  for (var j = 0; j < headers.length; j++) {
    if (String(headers[j] || '').trim().toLowerCase() === 'error_note') { errIdx = j; break; }
  }
  if (errIdx >= 0) {
    evSheet.insertColumnBefore(errIdx + 1);
    evSheet.getRange(1, errIdx + 1).setValue('fuel_pct');
  } else {
    evSheet.getRange(1, lc + 1).setValue('fuel_pct');
  }
}

/** เพิ่มคอลัมน์ gauge_before_url / gauge_after_url ในชีท เติมน้ำมัน อัตโนมัติ ถ้ายังไม่มี */
function ensureFuelHeader_() {
  var fuelSheet = getFuelSheet_();
  if (!fuelSheet) return;
  var lc = fuelSheet.getLastColumn();
  if (lc < 1) return;
  var headers = fuelSheet.getRange(1, 1, 1, lc).getValues()[0];
  var has = {};
  headers.forEach(function (h) { has[String(h || '').trim().toLowerCase()] = true; });
  if (has['gauge_before_url']) return;
  var col = lc + 1;
  fuelSheet.getRange(1, col).setValue('gauge_before_url');
  fuelSheet.getRange(1, col + 1).setValue('gauge_after_url');
}

/** แผนที่ line_id -> { name, plate } */
function getVehiclesMap_() {
  var map = {};
  var sheet = getVehiclesSheet_();
  if (!sheet) return map;
  var lr = sheet.getLastRow();
  if (lr < 2) return map;
  var data = sheet.getRange(2, 1, lr - 1, 3).getValues();
  data.forEach(function (r) {
    var lid = String(r[0] || '').trim();
    if (lid) map[lid] = { name: String(r[1] || '').trim(), plate: String(r[2] || '').trim() };
  });
  return map;
}

/** ประวัติเหตุการณ์ทั้งหมดของรถคันหนึ่ง (เรียงตามเวลา) */
function getEventsByPlate_(plate) {
  var rows = [];
  var sheet = getEventsSheet_();
  if (!sheet || sheet.getLastRow() < 2) return rows;

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).getValues();
  data.forEach(function (r) {
    if (!r[0]) return;
    if (String(r[5] || '').trim() !== String(plate).trim()) return;
    rows.push({
      eventId: String(r[0]),
      timestamp: r[1],
      eventTime: r[2],
      eventType: String(r[3] || '').trim(),
      sender: String(r[4] || '').trim(),
      plate: String(r[5]).trim(),
      mileage: toNumOrNull_(r[6]),
      fuelPct: toNumOrNull_(r[7]),
      error: String(r[8] || '').trim()
    });
  });

  rows.sort(function (a, b) {
    return timeToMs_(a.eventTime) - timeToMs_(b.eventTime);
  });
  return rows;
}

/** ระบุรถ: ใช้ทะเบียนประจำตัวผู้ส่งก่อน; ถ้าไมล์ไม่สอดคล้อง -> เทียบคันอื่นจากเลขไมล์ */
function identifyVehicle_(senderLineId, mileage) {
  var map = getVehiclesMap_();
  var base = map[String(senderLineId || '')];
  if (!base || !base.plate) {
    return { plate: 'ไม่ระบุ', error: 'ผู้ส่งไม่พบในชีท ผู้รับผิดชอบรถ' };
  }
  if (mileage === null || isNaN(mileage)) {
    return { plate: base.plate, error: '' };
  }

  var hist = getEventsByPlate_(base.plate);
  var last = hist.length ? hist[hist.length - 1] : null;
  if (!last || last.mileage === null || isNaN(last.mileage) || mileage >= last.mileage) {
    return { plate: base.plate, error: '' }; // สอดคล้องกับรถประจำ
  }

  // ไมล์ต่ำกว่าค่าล่าสุดของรถประจำ -> น่าจะไปขับคันอื่น
  var allPlates = getAllPlates_();
  var bestPlate = null, bestDiff = Infinity;
  allPlates.forEach(function (p) {
    if (p === base.plate) return;
    var h = getEventsByPlate_(p);
    var l = h.length ? h[h.length - 1] : null;
    if (l && l.mileage !== null && !isNaN(l.mileage) && mileage >= l.mileage) {
      var diff = mileage - l.mileage;
      if (diff < bestDiff) { bestDiff = diff; bestPlate = p; }
    }
  });

  if (bestPlate) {
    return { plate: bestPlate, error: 'สันนิษฐานจากเลขไมล์: ผู้ขับอาจใช้คันอื่น (' + base.plate + ')' };
  }
  return { plate: base.plate, error: 'เลขไมล์ไม่สอดคล้องตามประวัติ ใช้รถประจำแทน' };
}

function getAllPlates_() {
  var set = {};
  var sheetV = getVehiclesSheet_();
  if (sheetV && sheetV.getLastRow() >= 2) {
    var dv = sheetV.getRange(2, 1, sheetV.getLastRow() - 1, 3).getValues();
    dv.forEach(function (r) { var p = String(r[2] || '').trim(); if (p) set[p] = true; });
  }
  var sheetE = getEventsSheet_();
  if (sheetE && sheetE.getLastRow() >= 2) {
    var de = sheetE.getRange(2, 1, sheetE.getLastRow() - 1, 8).getValues();
    de.forEach(function (r) { var p = String(r[5] || '').trim(); if (p) set[p] = true; });
  }
  return Object.keys(set);
}

/** แยก เข้า/ออก (ทางเลือก ก.): สลับกับเหตุการณ์ล่าสุดของคันนั้น; fallback = เวลา */
function decideInOut_(plate, eventTime, mileage) {
  var hist = getEventsByPlate_(plate);
  var last = hist.length ? hist[hist.length - 1] : null;

  if (last) {
    var newType = last.eventType === 'ออก' ? 'เข้า' : 'ออก';
    if (mileage !== null && !isNaN(mileage) && last.mileage !== null &&
        !isNaN(last.mileage) && mileage < last.mileage) {
      return { type: newType, error: 'เลขไมล์น้อยกว่าเรคคอร์ดล่าสุด ตรวจสอบอีกครั้ง' };
    }
    return { type: newType, error: '' };
  }

  var hour = eventTime ? eventTime.getHours() : 12;
  var type = hour < 12 ? 'ออก' : 'เข้า';
  return { type: type, error: 'ไม่มีประวัติ ใช้ fallback ตามเวลา (ก่อนเที่ยง=ออก, หลังเที่ยง=เข้า)' };
}
// ============================================================================

// ==================== ฟังก์ชันช่วย: Log =====================================
function getLogRowsQueued_() {
  var rows = [];
  var sheet = getLogSheet_();
  if (!sheet) return rows;
  var lr = sheet.getLastRow();
  if (lr < 2) return rows;

  var data = sheet.getRange(2, 1, lr - 1, 6).getValues();
  data.forEach(function (r, i) {
    if (String(r[3] || '').trim() === 'queued') {
      rows.push({
        rowIdx: i + 2,
        messageId: String(r[0] || ''),
        sender: String(r[1] || '').trim(),
        eventId: String(r[2] || ''),
        status: String(r[3] || ''),
        error: String(r[4] || ''),
        receivedAt: r[5] instanceof Date ? r[5] : new Date(r[5])
      });
    }
  });
  return rows;
}

function isDuplicateMessageId_(messageId) {
  var sheet = getLogSheet_();
  if (!sheet || sheet.getLastRow() < 2) return false;
  var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(messageId)) return true;
  }
  return false;
}

function addLogRow_(messageId, sender, eventId, status, errorLog, receivedAt) {
  var sheet = getLogSheet_();
  if (!sheet) return;
  sheet.appendRow([String(messageId), String(sender), eventId || '', String(status),
                   String(errorLog || ''), receivedAt instanceof Date ? receivedAt : new Date(receivedAt)]);
}

function updateLogStatus_(rowIdx, status, errorLog) {
  var sheet = getLogSheet_();
  if (!sheet) return;
  sheet.getRange(rowIdx, 4, 1, 2).setValues([[status, String(errorLog || '')]]);
}

function updateLogStatusAndEventId_(rowIdx, status, eventId, errorLog) {
  var sheet = getLogSheet_();
  if (!sheet) return;
  sheet.getRange(rowIdx, 3, 1, 3).setValues([[eventId, status, String(errorLog || '')]]);
}
// ============================================================================

// ==================== ฟังก์ชันช่วย: เขียนข้อมูล ==============================
function writeEventRow_(o) {
  var sheet = getEventsSheet_();
  if (!sheet) return;
  sheet.appendRow([
    o.eventId,
    o.timestamp instanceof Date ? o.timestamp : new Date(),
    o.eventTime instanceof Date ? o.eventTime : o.timestamp,
    o.eventType,
    o.senderLineId,
    o.plate,
    o.mileage === null || o.mileage === undefined ? '' : Number(o.mileage),
    o.fuelPct === null || o.fuelPct === undefined ? '' : Number(o.fuelPct),
    o.errorNote || ''
  ]);
}

function writeFuelRow_(o) {
  var sheet = getFuelSheet_();
  if (!sheet) return;
  sheet.appendRow([
    o.eventId,
    o.fuelBefore === null || o.fuelBefore === undefined ? '' : Number(o.fuelBefore),
    o.fuelAfter === null || o.fuelAfter === undefined ? '' : Number(o.fuelAfter),
    o.amountBaht === null || o.amountBaht === undefined ? '' : Number(o.amountBaht),
    o.pricePerLiter === null || o.pricePerLiter === undefined ? '' : Number(o.pricePerLiter),
    o.liters === null || o.liters === undefined ? '' : Number(o.liters),
    String(o.district || ''),
    String(o.receiptUrl || ''),
    String(o.errorNote || ''),
    String(o.gaugeBeforeUrl || ''),
    String(o.gaugeAfterUrl || '')
  ]);
}
// ============================================================================

// ==================== ฟังก์ชันช่วย: รูป + Gemini + Drive =====================
/** ดาวน์โหลดรูปจาก LINE CDN (ต้องใช้ token ของ bot) */
function downloadLineImage_(messageId) {
  var token = (getProps_().LINE_ACCESS_TOKEN || '').trim();
  var url = 'https://api-data.line.me/v2/bot/message/' + encodeURIComponent(messageId) + '/content';
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('ดาวน์โหลดรูปไม่สำเร็จ (' + res.getResponseCode() + '): ' + res.getContentText());
  }
  var blob = res.getBlob();
  return { messageId: messageId, blob: blob, mime: blob.getContentType() || 'image/jpeg' };
}

/**
 * ส่งภาพให้ Gemini วิเคราะห์ กำหนดให้ตอบเป็น JSON
 * โมเดล: GEMINI_MODEL (ตรวจสอบชื่อรุ่นจริงก่อน Deploy)
 */
function analyzeImageWithGemini_(blob, mime) {
  var apiKey = (getProps_().GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('ไม่พบ GEMINI_API_KEY ใน ScriptProperties');

  var base64 = Utilities.base64Encode(blob.getBytes());

  var prompt = [
    'คุณคือผู้ช่วยอ่านรูปหน้ารถและบิลเติมน้ำมัน วิเคราะห์ภาพนี้ให้ละเอียด แล้วตอบเป็น JSON ตาม schema ต่อไปนี้เท่านั้น:',
    '{',
    '  "image_type": "odometer" | "fuel_gauge" | "receipt" | "unknown",',
    '  "mileage_km": จำนวนเต็ม (เฉพาะรูปเลขไมล์) หรือ null',
    '  "fuel_percent": จำนวนเต็ม 0-100 โดยประมาณตำแหน่งเข็มระหว่าง E กับ F (อ่านเมื่อเห็นเข็มน้ำมัน/เกจชัดในภาพ รวมถึงรูปแผงที่มีทั้งไมล์+เกจด้วย) หรือ null',
    '  "receipt": { "date_text": "วันที่บนบิล เช่น 23/09/2026", "time_text": "เวลาวางมือจ่าย เช่น 15:39",',
    '               "amount_baht": ตัวเลขจำนวนเงิน, "price_per_liter": ตัวเลข, "liters": ตัวเลข,',
    '               "district": "อำเภอหรือที่ตั้งของปั้ม", "plate_text": "ทะเบียนรถถ้ามี" }',
    '    (รายละเอียดเฉพาะรูปบิล ใส่ค่าเป็น null ถ้าอ่านไม่ได้ และ date/time เป็น ค.ศ.หรือ พ.ศ. ตามที่พิมพ์)',
    '  "notes": "ข้อความช่วยสังเกต ถ้าเคย"',
    '}'
  ].join('\n');

  var payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mime || 'image/jpeg', data: base64 } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  // ลำดับโมเดลที่ลอง: ตัวที่ตั้งใน GEMINI_MODEL ก่อน แล้วเผื่อโมเดลสำรองถ้าตัวนั้นแน่น/ไม่มีแล้ว
  var fallbackModels = [
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite'
  ];
  var modelList = [];
  var pushModel = function (m) {
    m = String(m || '').trim();
    if (m && modelList.indexOf(m) < 0) modelList.push(m);
  };
  pushModel(getConfig_().GEMINI_MODEL);
  fallbackModels.forEach(pushModel);

  var apiBase = 'https://generativelanguage.googleapis.com/v1beta/models/';
  var keyParam = '?key=' + encodeURIComponent(apiKey);
  var res = null;
  var lastErr = null;
  var lastErrorText = '';
  var ok = false;

outer:
  for (var mi = 0; mi < modelList.length && !ok; mi++) {
    var model = modelList[mi];
    var url = apiBase + encodeURIComponent(model) + ':generateContent' + keyParam;

    // ลองซ้ำ 2 รอบต่อโมเดล (ห่าง 5 วิ) แล้วค่อยสลับโมเดลถัดไป
    for (var attempt = 1; attempt <= 2; attempt++) {
      try {
        res = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        lastErr = null;
      } catch (e) {
        res = null;
        lastErr = e;
      }

      var code = res ? res.getResponseCode() : 0;
      if (code === 200) { ok = true; break outer; }

      lastErrorText = 'Gemini error (' + code + '): ' + (res ? res.getContentText() : String(lastErr || 'NA'));

      if (code === 404 || code === 410) break;           // โมเดลนี้ไม่มี/ปิดแล้ว -> ข้าม
      if (code !== 503 && code !== 429) throw new Error(lastErrorText); // error อื่น -> หยุด
      Utilities.sleep(5000);                              // 503/429 -> รอ 5 วิ ลองใหม่
    }
  }

  if (!ok) throw new Error(lastErrorText + ' [ลอง ' + modelList.length + ' โมเดลแล้ว]');

  var json = JSON.parse(res.getContentText());
  var text = json.candidates && json.candidates[0] && json.candidates[0].content &&
             json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
             json.candidates[0].content.parts[0].text;

  if (!text) throw new Error('Gemini ตอบกลับไม่มีเนื้อหา');

  try {
    var cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e2) {
    throw new Error('Gemini ตอบกลับไม่ใช่ JSON ที่อ่านได้');
  }
}

/** อัปโหลด blob ภาพใดๆ ขึ้น Drive: ชื่อ ทะเบียน_เวลา[suffix].ext */
function uploadImageToDrive_(blob, plate, eventTime, suffix) {
  var folderId = ((getProps_().FOLDER_ID) || '').trim();
  if (!folderId) throw new Error('ไม่พบ FOLDER_ID ใน ScriptProperties');
  if (!blob) return '';

  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (fErr) { throw new Error('ไม่พบโฟลเดอร์ FOLDER_ID'); }

  var plateName = normalizePlate_(plate);
  var dt = eventTime instanceof Date ? eventTime : new Date();
  var fileName = plateName + '_' + Utilities.formatDate(dt, getConfig_().TZ, 'yyyyMMdd_HHmm') + (suffix || '');

  var ext = 'jpg';
  var mime = blob.getContentType() || '';
  if (mime.indexOf('png') >= 0) ext = 'png';
  else if (mime.indexOf('gif') >= 0) ext = 'gif';
  else if (mime.indexOf('webp') >= 0) ext = 'webp';

  var file = folder.createFile(blob).setName(fileName + '.' + ext);
  return file.getUrl();
}

/** คัดลอกรูปบิล (ไฟล์แรกที่เป็นบิล) ไป Google Drive พร้อมเปลี่ยนชื่อ */
function uploadReceiptToDrive_(results, plate, eventTime) {
  if (!results || results.length === 0) return '';

  var receiptIndex = -1;
  for (var i = 0; i < results.length; i++) {
    var a = results[i].analysis || {};
    var t = String(a.image_type || '').toLowerCase();
    if (t.indexOf('receipt') >= 0 || t.indexOf('บิล') >= 0) { receiptIndex = i; break; }
  }
  if (receiptIndex < 0 || !results[receiptIndex].blob) return '';

  return uploadImageToDrive_(results[receiptIndex].blob, plate, eventTime, '');
}

function normalizePlate_(plate) {
  return String(plate || 'unk')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '') || 'unk';
}

// ==================== ฟังก์ชันช่วย: ตัวเลข / วันที่ ==========================
function toNumOrNull_(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
}

function timeToMs_(d) {
  return d instanceof Date ? d.getTime() : (d ? new Date(d).getTime() : 0);
}

function minReceivedAt_(rows) {
  var min = rows[0].receivedAt;
  rows.forEach(function (r) {
    if (r.receivedAt.getTime() < min.getTime()) min = r.receivedAt;
  });
  return min;
}

function maxReceivedAt_(rows) {
  var max = rows[0].receivedAt;
  rows.forEach(function (r) {
    if (r.receivedAt.getTime() > max.getTime()) max = r.receivedAt;
  });
  return max;
}

/** ดูว่าใบเสร็จชุดใดมีข้อมูลครบกว่า (ใช้ชุดที่สมบูรณ์กว่า) */
function isMoreCompleteReceipt_(a, b) {
  var fields = ['amount_baht', 'price_per_liter', 'liters', 'date_text', 'time_text', 'district'];
  var score = function (o) {
    return fields.reduce(function (acc, f) {
      var v = o && o[f];
      return acc + (v !== null && v !== undefined && String(v).trim() !== '' ? 1 : 0);
    }, 0);
  };
  return score(a) > score(b);
}

/**
 * แปลงเวลาบิลเป็น Date object (Asia/Bangkok, ค.ศ.)
 * รองรับปี พ.ศ. (>=2500 -> ลบ 543) และรูปแบบ d/m/y h:m
 */
function parseReceiptDateTime_(dateText, timeText) {
  var str = (dateText + ' ' + timeText).trim();
  if (!str) return null;

  var m = str.match(/(\d{1,2})[\/\-\. ](\d{1,2})[\/\-\. ](\d{2,4})[ /]*(\d{1,2}):(\d{2})/);
  if (!m) return null;

  var day = parseInt(m[1], 10), month = parseInt(m[2], 10), year = parseInt(m[3], 10);
  var hour = parseInt(m[4], 10), minute = parseInt(m[5], 10);

  // แปลงปีเป็น ค.ศ.
  if (year >= 2500) year -= 543;        // พ.ศ.
  else if (year < 100) year = year >= 60 ? 1900 + year : 2000 + year;

  // สร้าง Date ให้ตรงกับ "เวลาท้องถิ่นไทย" (Asia/Bangkok = UTC+7)
  // โดยหัก offset 7 ชม. ออกจาก Date.UTC แล้วเก็บเป็น instant ที่ถูกต้อง
  var instant = Date.UTC(year, month - 1, day, hour, minute) - 7 * 60 * 60 * 1000;
  var d = new Date(instant);
  if (isNaN(d.getTime())) return null;
  return d;
}

/**
 * ลงทะเบียน Time-Driven Trigger (ทุก 1 นาที) ให้เรียก processQueuedMessages
 * ใช้ครั้งเดียวตอนติดตั้ง (หรือรันด้วยมือ)
 */
function installTimeTrigger() {
  var existing = ScriptApp.getProjectTriggers().filter(function (tr) {
    return tr.getHandlerFunction() === 'processQueuedMessages';
  });
  existing.forEach(function (tr) { ScriptApp.deleteTrigger(tr); });

  ScriptApp.newTrigger('processQueuedMessages')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('ติดตั้ง Time Trigger ทุก 1 นาที เรียบร้อย');
}

/** ฟังก์ชันทดสอบ: สร้างแถว Log ตัวอย่างไว้ทดลองประมวลผล */
function testEnqueueDummy() {
  addLogRow_('TEST_MSG_001', 'U_TEST_SENDER', null, 'queued', '', new Date(Date.now() - 10 * 60000));
  Logger.log('เพิ่มแถวทดสอบเรียบร้อย');
}

/**
 * ปุ่มสำหรับกดด้วยมือ: ตั้งค่า/สร้างคอลัมน์อัตโนมัติในสเปรดชีต
 * (โค้ดจริงจะเรียก setupSheet_() เองตอนมีเหตุการณ์ — ตัวนี้ไว้กดให้พร้อมก่อน deploy)
 */
function setupSheet() {
  setupSheet_();
  Logger.log('สร้าง/ตรวจคอลัมน์เรียบร้อย (fuel_pct, gauge_before_url, gauge_after_url)');
}