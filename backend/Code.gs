// =================================================================
// Code.gs — PMS Prototype Backend
// Version: 0.2.0
// Frontend: Vercel Static + /api/gas-proxy
// Backend: Google Apps Script Web App + Google Sheets + Google Drive
// =================================================================

const SESSION_TTL_SECONDS = 21600; // 6 hours
const SESSION_PREFIX = 'PMS_SESSION_';

const EVAL_REQUIRED_COLUMNS = [
  'รหัสพนักงาน', 'TotalScore', 'InitGrade', 'AdjGrade', 'Reason', 'Status', 'Payload',
  'SubmittedBy', 'SubmittedAt', 'ConfirmedBy', 'ConfirmedAt'
];

const AUDIT_HEADERS = ['Timestamp', 'Level', 'Action', 'UserEmail', 'Role', 'TargetID', 'Before', 'After', 'Note'];
const SYSTEM_LOG_HEADERS = ['Timestamp', 'Level', 'Function', 'Message', 'Payload'];


// =================================================================
// ONE-TIME SETUP FOR THIS PROTOTYPE
// Run this function once in Apps Script editor after pasting Code.gs.
// It stores the two Spreadsheet IDs in Script Properties and creates
// an Evidence folder automatically if EVIDENCE_FOLDER_ID is not set.
// =================================================================
function setupPrototypeConfig() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('DB_EVAL_ID', '1eqGARF_24jDi4Z326njcLQ03DN0xCmpBlvvBsAvxJ-k');
  props.setProperty('DB_KPI_ID', '1X_LvGf830BdElP-CW6hS_EkqriqBvEtN5Qn42lJYgKg');

  let evidenceFolderId = props.getProperty('EVIDENCE_FOLDER_ID');
  if (!evidenceFolderId) {
    const folder = DriveApp.createFolder('PMS_Evidence_2026_Prototype');
    evidenceFolderId = folder.getId();
    props.setProperty('EVIDENCE_FOLDER_ID', evidenceFolderId);
    Logger.log('Created evidence folder: ' + folder.getUrl());
  }

  Logger.log('Setup completed.');
  Logger.log('DB_EVAL_ID: ' + props.getProperty('DB_EVAL_ID'));
  Logger.log('DB_KPI_ID: ' + props.getProperty('DB_KPI_ID'));
  Logger.log('EVIDENCE_FOLDER_ID: ' + props.getProperty('EVIDENCE_FOLDER_ID'));
}

// ปรับเกณฑ์นี้ได้ตาม Policy จริงขององค์กร
const GRADE_RULES = [
  { min: 95, grade: 'A+' },
  { min: 90, grade: 'A' },
  { min: 85, grade: 'B+' },
  { min: 75, grade: 'B' },
  { min: 60, grade: 'C' },
  { min: 0,  grade: 'D' }
];

function doGet() {
  return HtmlService.createHtmlOutput('HR Evaluation API Server is running.');
}

function doPost(e) {
  let requestData = {};
  try {
    requestData = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = requestData.action;
    const payload = requestData.payload || {};

    return withLogger(`doPost -> ${action}`, payload, () => {
      if (action === 'login') return processLogin(payload);

      const session = authenticate(payload);

      if (action === 'get_manager_data') return getManagerData(session);
      if (action === 'save_manager_draft') return saveManagerEval(payload, session, 'Draft');
      if (action === 'save_manager_eval') return saveManagerEval(payload, session, 'Evaluated');
      if (action === 'upload_evidence_to_drive') return uploadEvidenceToDrive(payload, session);
      if (action === 'get_director_data') return getDirectorData(session);
      if (action === 'save_director_confirm') return saveDirectorConfirm(payload, session);
      if (action === 'logout') return logoutSession(payload);

      throw new Error('Invalid Action');
    });
  } catch (error) {
    logSystemError('doPost', error, requestData);
    return jsonResponse({ status: 'error', message: error.message || String(error) });
  }
}

function withLogger(functionName, payload, callback) {
  try {
    return callback();
  } catch (error) {
    logSystemError(functionName, error, payload);
    return jsonResponse({ status: 'error', message: error.message || String(error) });
  }
}

// =================================================================
// AUTH
// =================================================================

function processLogin(payload) {
  const email = normalizeEmail(payload.email);
  const pin = String(payload.pin || '').trim();
  if (!email || !pin) throw new Error('กรุณาระบุ Email และ PIN');

  const usersSheet = getSheetByName_(getEvalSpreadsheet_(), 'Users');
  const users = getArrayOfObjects(usersSheet);
  const user = users.find(u =>
    normalizeEmail(u['Email']) === email &&
    String(u['PIN (6 หลัก)'] || '').trim() === pin &&
    String(u['Active'] || 'TRUE').toUpperCase() !== 'FALSE'
  );

  if (!user) throw new Error('อีเมล หรือ PIN ไม่ถูกต้อง');

  const role = String(user['Role (Manager/Director)'] || '').trim();
  if (!['Manager', 'Director'].includes(role)) throw new Error('Role ในชีต Users ต้องเป็น Manager หรือ Director');

  const sessionUser = {
    email: normalizeEmail(user['Email']),
    role,
    userId: String(user['UserID'] || '').trim(),
    deptScope: String(user['Dept'] || '').trim() || '-'
  };

  const token = Utilities.getUuid();
  CacheService.getScriptCache().put(SESSION_PREFIX + token, JSON.stringify(sessionUser), SESSION_TTL_SECONDS);

  appendAudit('LOGIN', sessionUser, sessionUser.userId || sessionUser.email, '', '', 'Login success');

  return jsonResponse({
    status: 'success',
    user: Object.assign({}, sessionUser, { token })
  });
}

function authenticate(payload, requiredRole) {
  const token = payload && payload._session && payload._session.token;
  if (!token) throw new Error('Session หมดอายุ หรือยังไม่ได้ Login');

  const cached = CacheService.getScriptCache().get(SESSION_PREFIX + token);
  if (!cached) throw new Error('Session หมดอายุ กรุณา Login ใหม่');

  const session = JSON.parse(cached);
  if (requiredRole && session.role !== requiredRole) {
    throw new Error(`บัญชีนี้เป็นสิทธิ์ ${session.role} ไม่สามารถทำรายการของ ${requiredRole} ได้`);
  }
  return session;
}

function logoutSession(payload) {
  const token = payload && payload._session && payload._session.token;
  if (token) CacheService.getScriptCache().remove(SESSION_PREFIX + token);
  return jsonResponse({ status: 'success' });
}

// =================================================================
// MANAGER
// =================================================================

function getManagerData(session) {
  if (session.role !== 'Manager') throw new Error('Only Manager can access Manager Workspace');

  const evalSS = getEvalSpreadsheet_();
  const empSheet = getSheetByName_(evalSS, 'Employees');
  const allEmps = getArrayOfObjects(empSheet);
  const myTeam = allEmps.filter(emp => String(emp['ManagerID'] || '').trim() === String(session.userId || '').trim());

  const kpiSheet = getSheetByName_(getKpiSpreadsheet_(), 'KPI_2026');
  const allKPIs = getArrayOfObjects(kpiSheet);

  const evalSheet = getSheetByName_(evalSS, 'Eval_Data');
  ensureColumns(evalSheet, EVAL_REQUIRED_COLUMNS);
  const allEvals = getArrayOfObjects(evalSheet);

  const teamData = myTeam.map(emp => {
    const empId = String(emp['รหัสพนักงาน'] || '').trim();
    const fullName = `${emp['คำนำหน้า'] || ''}${emp['ชื่อ'] || ''} ${emp['สกุล'] || ''}`.trim();
    const empKPIs = allKPIs.filter(kpi => String(kpi['รหัสพนักงาน'] || '').trim() === empId);
    const mappedKPIs = mapKpisForFrontend(empId, empKPIs);

    const savedEval = allEvals.find(e => String(e['รหัสพนักงาน'] || '').trim() === empId);
    let status = 'Pending';
    let savedKPIs = null;
    let savedScore = '';
    let savedInitGrade = '-';

    if (savedEval && ['Draft', 'Evaluated', 'Confirmed'].includes(String(savedEval['Status'] || ''))) {
      status = String(savedEval['Status']);
      savedScore = savedEval['TotalScore'] || '';
      savedInitGrade = savedEval['InitGrade'] || '-';
      if (savedEval['Payload']) {
        try { savedKPIs = JSON.parse(savedEval['Payload']); } catch (err) { savedKPIs = null; }
      }
    }

    return {
      id: empId,
      name: fullName,
      nickname: emp['ชื่อเล่น'] || '-',
      department: emp['แผนก'] || '-',
      position: emp['ตำแหน่ง'] || '-',
      status,
      kpis: mappedKPIs,
      savedKPIs,
      savedScore,
      savedInitGrade
    };
  });

  return jsonResponse({ status: 'success', data: teamData });
}

function saveManagerEval(payload, session, statusLabel) {
  if (session.role !== 'Manager') throw new Error('Only Manager can save Manager Evaluation');
  if (!payload.empId) throw new Error('Missing empId');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const evalSS = getEvalSpreadsheet_();
    const emp = assertManagerOwnsEmployee(session, payload.empId);
    const evalSheet = getSheetByName_(evalSS, 'Eval_Data');
    ensureColumns(evalSheet, EVAL_REQUIRED_COLUMNS);

    const before = getEvalRecordByEmpId(evalSheet, payload.empId);
    const calculated = calculateEvaluation(payload.empId, payload.kpis || [], statusLabel === 'Evaluated');

    const row = upsertEvalRow(evalSheet, payload.empId, {
      'TotalScore': calculated.totalScore,
      'InitGrade': calculated.initGrade,
      'Status': statusLabel,
      'Payload': JSON.stringify(calculated.kpis),
      'SubmittedBy': session.email,
      'SubmittedAt': new Date()
    });

    appendAudit(statusLabel === 'Draft' ? 'SAVE_MANAGER_DRAFT' : 'SAVE_MANAGER_EVAL', session, payload.empId, before, getRowObject(evalSheet, row), `Employee: ${emp['ชื่อ'] || ''}`);

    return jsonResponse({
      status: 'success',
      statusLabel,
      totalScore: calculated.totalScore,
      initGrade: calculated.initGrade,
      kpis: calculated.kpis
    });
  } finally {
    lock.releaseLock();
  }
}

function uploadEvidenceToDrive(payload, session) {
  if (session.role !== 'Manager') throw new Error('Only Manager can upload evidence');
  if (!payload.empId) throw new Error('Missing empId');
  if (!payload.dataUrl) throw new Error('Missing file data');

  assertManagerOwnsEmployee(session, payload.empId);

  const folderId = getOptionalScriptProperty_('EVIDENCE_FOLDER_ID');
  if (!folderId) throw new Error('ยังไม่ได้ตั้งค่า Script Property: EVIDENCE_FOLDER_ID');

  const match = String(payload.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('รูปแบบไฟล์ไม่ถูกต้อง');

  const mimeType = payload.mimeType || match[1] || 'application/octet-stream';
  const rawName = payload.fileName || 'evidence-file';
  const safeName = sanitizeFileName(`${payload.empId}_${payload.kpiId || 'KPI'}_${formatDateForFile_(new Date())}_${rawName}`);
  const bytes = Utilities.base64Decode(match[2]);
  const blob = Utilities.newBlob(bytes, mimeType, safeName);

  const folder = DriveApp.getFolderById(folderId);
  const file = folder.createFile(blob);
  file.setDescription(`PMS Evidence | EmployeeID=${payload.empId} | KPI=${payload.kpiId || '-'} | UploadedBy=${session.email}`);

  appendAudit('UPLOAD_EVIDENCE', session, payload.empId, '', { fileId: file.getId(), fileName: file.getName(), kpiId: payload.kpiId }, 'Uploaded evidence to Drive');

  return jsonResponse({
    status: 'success',
    fileId: file.getId(),
    fileUrl: file.getUrl(),
    fileName: file.getName()
  });
}

// =================================================================
// DIRECTOR
// =================================================================

function getDirectorData(session) {
  if (session.role !== 'Director') throw new Error('Only Director can access Director Dashboard');

  const evalSS = getEvalSpreadsheet_();
  const empSheet = getSheetByName_(evalSS, 'Employees');
  let allEmps = getArrayOfObjects(empSheet);
  allEmps = filterEmployeesByDirectorScope(allEmps, session.deptScope);

  const evalSheet = getSheetByName_(evalSS, 'Eval_Data');
  ensureColumns(evalSheet, EVAL_REQUIRED_COLUMNS);
  const allEvals = getArrayOfObjects(evalSheet);

  const directorData = [];
  allEmps.forEach(emp => {
    const empId = String(emp['รหัสพนักงาน'] || '').trim();
    const evalData = allEvals.find(e => String(e['รหัสพนักงาน'] || '').trim() === empId);

    if (evalData && ['Evaluated', 'Confirmed'].includes(String(evalData['Status'] || ''))) {
      const fullName = `${emp['คำนำหน้า'] || ''}${emp['ชื่อ'] || ''} ${emp['สกุล'] || ''}`.trim();
      directorData.push({
        id: empId,
        name: fullName,
        nickname: emp['ชื่อเล่น'] || '-',
        dept: emp['แผนก'] || '-',
        score: Number(evalData['TotalScore'] || 0),
        initGrade: evalData['InitGrade'] || '-',
        adjGrade: evalData['AdjGrade'] || evalData['InitGrade'] || '-',
        reason: evalData['Reason'] || '',
        status: evalData['Status'] || ''
      });
    }
  });

  return jsonResponse({ status: 'success', data: directorData, totalScopeCount: directorData.length });
}

function saveDirectorConfirm(payload, session) {
  if (session.role !== 'Director') throw new Error('Only Director can confirm grades');

  const items = Array.isArray(payload) ? payload : (payload.items || []);
  if (!items.length) throw new Error('ไม่มีรายการสำหรับบันทึก');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const evalSS = getEvalSpreadsheet_();
    const empSheet = getSheetByName_(evalSS, 'Employees');
    const allowedEmployees = filterEmployeesByDirectorScope(getArrayOfObjects(empSheet), session.deptScope);
    const allowedIds = new Set(allowedEmployees.map(e => String(e['รหัสพนักงาน'] || '').trim()));

    const evalSheet = getSheetByName_(evalSS, 'Eval_Data');
    ensureColumns(evalSheet, EVAL_REQUIRED_COLUMNS);
    const headers = getHeaders(evalSheet);
    const data = evalSheet.getDataRange().getValues();

    items.forEach(item => {
      const empId = String(item.id || '').trim();
      if (!allowedIds.has(empId)) throw new Error(`ไม่มีสิทธิ์บันทึกข้อมูลพนักงานรหัส ${empId}`);

      const rowIdx = findRowByValue(data, headers, 'รหัสพนักงาน', empId);
      if (rowIdx === -1) throw new Error(`ไม่พบข้อมูลประเมินของรหัส ${empId}`);

      const before = getRowObject(evalSheet, rowIdx);
      const initGrade = String(before['InitGrade'] || '-');
      const finalGrade = String(item.finalGrade || initGrade);
      const reason = String(item.reason || '').trim();

      if (initGrade !== finalGrade && !reason) {
        throw new Error(`กรุณาระบุเหตุผลการปรับเกรดของรหัส ${empId}`);
      }

      setRowValuesByHeader(evalSheet, rowIdx, {
        'AdjGrade': finalGrade,
        'Reason': reason,
        'Status': 'Confirmed',
        'ConfirmedBy': session.email,
        'ConfirmedAt': new Date()
      });

      appendAudit('SAVE_DIRECTOR_CONFIRM', session, empId, before, getRowObject(evalSheet, rowIdx), initGrade !== finalGrade ? 'Grade adjusted' : 'Grade confirmed');
    });

    return jsonResponse({ status: 'success' });
  } finally {
    lock.releaseLock();
  }
}

// =================================================================
// SCORING
// =================================================================

function calculateEvaluation(empId, submittedKpis, requireComplete) {
  const kpiSheet = getSheetByName_(getKpiSpreadsheet_(), 'KPI_2026');
  const allKpis = getArrayOfObjects(kpiSheet);
  const empKpis = allKpis.filter(kpi => String(kpi['รหัสพนักงาน'] || '').trim() === String(empId).trim());

  const submittedByKey = {};
  (submittedKpis || []).forEach(k => {
    if (k.id) submittedByKey[String(k.id)] = k;
    if (k.name) submittedByKey[String(k.name)] = k;
  });

  let totalWeightedScore = 0;
  let activeWeight = 0;

  const kpis = empKpis.map((master, idx) => {
    const base = mapSingleKpiForFrontend(empId, master, idx);
    const submitted = submittedByKey[base.id] || submittedByKey[base.name] || {};
    const actual = submitted.actual === undefined || submitted.actual === null ? '' : String(submitted.actual).trim();
    const isCorpBlank = base.type === 'Corp' && actual === '';

    if (requireComplete && base.type !== 'Corp' && actual === '') {
      throw new Error(`กรุณากรอก Actual ให้ครบ: ${base.name}`);
    }

    let score5 = 0;
    let weightedScore = 0;
    let outOfScale = false;

    if (actual !== '' && !isCorpBlank) {
      const scoreResult = calculateLinearScore(Number(actual), base.scale);
      score5 = scoreResult.score5;
      outOfScale = scoreResult.outOfScale;
      weightedScore = (score5 / 5) * Number(base.weight || 0);
      activeWeight += Number(base.weight || 0);
      totalWeightedScore += weightedScore;
    }

    return {
      id: base.id,
      type: base.type,
      name: base.name,
      remark: base.remark,
      weight: base.weight,
      target: base.target,
      scale: base.scale,
      actual,
      details: submitted.details || '',
      evidenceName: submitted.evidenceName || '',
      evidenceUrl: submitted.evidenceUrl || '',
      evidenceId: submitted.evidenceId || '',
      score5: Number(score5.toFixed(4)),
      weightedScore: Number(weightedScore.toFixed(4)),
      outOfScale
    };
  });

  const totalScore = activeWeight > 0 ? Number(((totalWeightedScore / activeWeight) * 100).toFixed(2)) : 0;
  return { totalScore, initGrade: gradeFromScore(totalScore), kpis };
}

function calculateLinearScore(actual, scale) {
  const s = [1, 2, 3, 4, 5].map(i => extractNum(scale[i]));
  if (isNaN(actual) || s.some(isNaN)) return { score5: 0, outOfScale: false };

  const isAsc = s[4] > s[0];
  let score5 = 0;
  let outOfScale = false;

  if (isAsc) {
    outOfScale = actual < s[0] || actual > s[4];
    if (actual < s[0]) score5 = 0;
    else if (actual >= s[4]) score5 = 5;
    else {
      for (let i = 0; i < 4; i++) {
        if (actual >= s[i] && actual <= s[i + 1]) {
          score5 = (i + 1) + ((actual - s[i]) / (s[i + 1] - s[i]));
          break;
        }
      }
    }
  } else {
    outOfScale = actual > s[0] || actual < s[4];
    if (actual > s[0]) score5 = 0;
    else if (actual <= s[4]) score5 = 5;
    else {
      for (let i = 0; i < 4; i++) {
        if (actual <= s[i] && actual >= s[i + 1]) {
          score5 = (i + 1) + ((s[i] - actual) / (s[i] - s[i + 1]));
          break;
        }
      }
    }
  }

  return { score5: Math.max(0, Math.min(5, score5)), outOfScale };
}

function gradeFromScore(score) {
  const rule = GRADE_RULES.find(r => Number(score) >= r.min);
  return rule ? rule.grade : 'D';
}

// =================================================================
// DATA HELPERS
// =================================================================

function getEvalSpreadsheet_() {
  return SpreadsheetApp.openById(getRequiredScriptProperty_('DB_EVAL_ID'));
}

function getKpiSpreadsheet_() {
  return SpreadsheetApp.openById(getRequiredScriptProperty_('DB_KPI_ID'));
}

function getSheetByName_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw new Error(`ไม่พบชีต: ${sheetName}`);
  return sheet;
}

function getRequiredScriptProperty_(key) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error(`Missing Script Property: ${key}`);
  return val;
}

function getOptionalScriptProperty_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function getArrayOfObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0].map(h => String(h || '').trim());
  return data.slice(1)
    .filter(row => row.join('').trim() !== '')
    .map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        if (header) obj[header] = row[index];
      });
      return obj;
    });
}

function getHeaders(sheet) {
  return sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(h => String(h || '').trim());
}

function ensureColumns(sheet, requiredHeaders) {
  let headers = getHeaders(sheet);
  if (headers.length === 1 && headers[0] === '') {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return requiredHeaders;
  }

  requiredHeaders.forEach(header => {
    if (!headers.includes(header)) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
      headers.push(header);
    }
  });
  return headers;
}

function upsertEvalRow(sheet, empId, values) {
  const headers = getHeaders(sheet);
  const data = sheet.getDataRange().getValues();
  let rowIdx = findRowByValue(data, headers, 'รหัสพนักงาน', empId);

  if (rowIdx === -1) {
    const newRow = new Array(headers.length).fill('');
    headers.forEach((h, i) => {
      if (h === 'รหัสพนักงาน') newRow[i] = empId;
      if (values[h] !== undefined) newRow[i] = values[h];
    });
    sheet.appendRow(newRow);
    rowIdx = sheet.getLastRow();
  } else {
    setRowValuesByHeader(sheet, rowIdx, values);
  }

  return rowIdx;
}

function setRowValuesByHeader(sheet, rowIdx, values) {
  const headers = getHeaders(sheet);
  Object.keys(values).forEach(key => {
    const colIdx = headers.indexOf(key);
    if (colIdx > -1) sheet.getRange(rowIdx, colIdx + 1).setValue(values[key]);
  });
}

function findRowByValue(data, headers, colName, value) {
  const idx = headers.indexOf(colName);
  if (idx === -1) return -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idx] || '').trim() === String(value || '').trim()) return i + 1;
  }
  return -1;
}

function getRowObject(sheet, rowIdx) {
  const headers = getHeaders(sheet);
  const row = sheet.getRange(rowIdx, 1, 1, headers.length).getValues()[0];
  const obj = {};
  headers.forEach((h, i) => obj[h] = row[i]);
  return obj;
}

function getEvalRecordByEmpId(sheet, empId) {
  const headers = getHeaders(sheet);
  const data = sheet.getDataRange().getValues();
  const rowIdx = findRowByValue(data, headers, 'รหัสพนักงาน', empId);
  return rowIdx === -1 ? '' : getRowObject(sheet, rowIdx);
}

function assertManagerOwnsEmployee(session, empId) {
  const empSheet = getSheetByName_(getEvalSpreadsheet_(), 'Employees');
  const employees = getArrayOfObjects(empSheet);
  const emp = employees.find(e => String(e['รหัสพนักงาน'] || '').trim() === String(empId || '').trim());
  if (!emp) throw new Error(`ไม่พบพนักงานรหัส ${empId}`);

  if (String(emp['ManagerID'] || '').trim() !== String(session.userId || '').trim()) {
    throw new Error(`บัญชีนี้ไม่มีสิทธิ์จัดการข้อมูลพนักงานรหัส ${empId}`);
  }
  return emp;
}

function filterEmployeesByDirectorScope(employees, deptScope) {
  const scope = String(deptScope || '').trim();
  if (!scope || scope === '-' || scope.toLowerCase() === 'all' || scope === 'All') return employees;
  const allowed = scope.split(',').map(s => s.trim()).filter(Boolean);
  return employees.filter(emp => allowed.includes(String(emp['แผนก'] || '').trim()));
}

function mapKpisForFrontend(empId, empKPIs) {
  return empKPIs.map((row, idx) => mapSingleKpiForFrontend(empId, row, idx));
}

function mapSingleKpiForFrontend(empId, row, idx) {
  return {
    id: row['KPI_ID'] || `KPI_${empId}_${idx}`,
    type: row['ประเภท'] || row['Type'] || 'Indv',
    name: row['รายละเอียด KPIs'] || row['KPI'] || row['KPI Name'] || '-',
    remark: row['หมายเหตุ'] || row['สูตรคำนวณ'] || row['Remark'] || 'ไม่มีหมายเหตุระบุไว้',
    weight: Number(row['น้ำหนัก (%)'] || row['น้ำหนัก'] || row['Weight'] || row['Weight (%)'] || 0),
    target: row['3'] || row['Target'] || 'เป้ามาตรฐาน',
    actual: '',
    details: '',
    evidenceName: '',
    evidenceUrl: '',
    evidenceId: '',
    scale: {
      1: row['1'] || '-',
      2: row['2'] || '-',
      3: row['3'] || '-',
      4: row['4'] || '-',
      5: row['5'] || '-'
    }
  };
}

// =================================================================
// LOGGING
// =================================================================

function appendAudit(action, session, targetId, before, after, note) {
  try {
    const ss = getEvalSpreadsheet_();
    const sheet = getOrCreateSheet_(ss, 'Audit_Log', AUDIT_HEADERS);
    sheet.appendRow([
      new Date(),
      'INFO',
      action,
      session && session.email ? session.email : '-',
      session && session.role ? session.role : '-',
      targetId || '-',
      stringifySafe(before),
      stringifySafe(after),
      note || ''
    ]);
  } catch (error) {
    // Avoid breaking user transaction because audit failed.
    console.error('appendAudit failed', error);
  }
}

function logSystemError(functionName, error, payload) {
  try {
    const ss = getEvalSpreadsheet_();
    const sheet = getOrCreateSheet_(ss, 'System_Logs', SYSTEM_LOG_HEADERS);
    sheet.appendRow([new Date(), 'ERROR', functionName, error.message || String(error), stringifySafe(payload)]);
  } catch (logError) {
    console.error('logSystemError failed', logError);
  }
}

function getOrCreateSheet_(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  ensureColumns(sheet, headers);
  return sheet;
}

// =================================================================
// GENERIC HELPERS
// =================================================================

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function extractNum(value) {
  const match = String(value || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function sanitizeFileName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|#%{}~&]/g, '_').slice(0, 180);
}

function formatDateForFile_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
}

function stringifySafe(value) {
  if (value === '' || value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}
