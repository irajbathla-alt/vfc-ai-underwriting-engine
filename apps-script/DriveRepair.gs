function repairDriveLinksFromAppsScript() {
  return repairDriveLinksSimple();
}

function repairDriveLinksSimple() {
  const sheet = getOrCreateSheet(CONFIG.APPLICATIONS_TAB || 'Applications');
  const parent = getUploadFolder();
  const folderMap = buildApplicationFolderMapSimple(parent);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Application ID', 'Date Submitted', 'Business Name', 'Owner Name', 'Email', 'Phone', 'Industry', 'Time In Business', 'Credit Score', 'Monthly Sales Estimate', 'Status', 'Document Links', 'Assigned Lender']);
  }

  let rows = sheet.getDataRange().getValues();
  if (!rows || rows.length <= 1) {
    return { ok: true, repaired: 0, message: 'Applications sheet has no application rows yet.' };
  }

  const headers = rows[0] || [];
  let appIdCol = getColumnByHeaderSimple(headers, ['Application ID', 'Application Id', 'App ID', 'App Id', 'ApplicationID']);
  if (appIdCol === -1) appIdCol = scanForAppIdColumnSimple(rows);

  if (appIdCol === -1) {
    return { ok: false, error: 'Could not find any APP ID in the Applications sheet. Please confirm the sheet has submitted applications.', headersFound: headers };
  }

  let linksCol = getColumnByHeaderSimple(headers, ['Document Links', 'Document Link', 'Drive Link', 'Drive Folder', 'Folder Link']);
  if (linksCol === -1) {
    linksCol = headers.length;
    sheet.getRange(1, linksCol + 1).setValue('Document Links');
    rows = sheet.getDataRange().getValues();
  }

  let repaired = 0;
  const missing = [];

  for (let r = 1; r < rows.length; r++) {
    const appId = getAppIdFromTextSimple(rows[r][appIdCol]);
    if (!appId) continue;

    const existing = String(rows[r][linksCol] || '').trim();
    if (existing.indexOf('Application Folder:') !== -1) continue;

    const url = folderMap[appId];
    if (!url) {
      missing.push(appId);
      continue;
    }

    const updated = existing ? 'Application Folder: ' + url + '\n' + existing : 'Application Folder: ' + url;
    sheet.getRange(r + 1, linksCol + 1).setValue(updated);
    repaired++;
  }

  return { ok: true, repaired: repaired, missing: missing, message: 'Drive links repaired.' };
}

function buildApplicationFolderMapSimple(parent) {
  const folders = parent.getFolders();
  const map = {};
  while (folders.hasNext()) {
    const folder = folders.next();
    const appId = getAppIdFromTextSimple(folder.getName());
    if (appId) map[appId] = folder.getUrl();
  }
  return map;
}

function getColumnByHeaderSimple(headers, names) {
  const normalized = headers.map(function(h) { return normalizeSimple(h); });
  for (let i = 0; i < names.length; i++) {
    const idx = normalized.indexOf(normalizeSimple(names[i]));
    if (idx !== -1) return idx;
  }
  return -1;
}

function scanForAppIdColumnSimple(rows) {
  const width = rows[0] ? rows[0].length : 0;
  const height = Math.min(rows.length, 25);
  for (let c = 0; c < width; c++) {
    for (let r = 1; r < height; r++) {
      if (getAppIdFromTextSimple(rows[r][c])) return c;
    }
  }
  return -1;
}

function getAppIdFromTextSimple(value) {
  const text = String(value || '').toUpperCase();
  const start = text.indexOf('APP-');
  if (start === -1) return '';
  let end = start + 4;
  while (end < text.length) {
    const ch = text.charAt(end);
    if (!((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-')) break;
    end++;
  }
  return text.substring(start, end);
}

function normalizeSimple(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
