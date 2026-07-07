function repairDriveLinksFromAppsScript() {
  const parent = getUploadFolder();
  const folders = parent.getFolders();
  const sheet = getOrCreateSheet(CONFIG.APPLICATIONS_TAB);

  if (sheet.getLastRow() === 0) {
    setupDatabaseSheets();
  }

  let rows = sheet.getDataRange().getValues();
  if (!rows || rows.length <= 1) {
    setupDatabaseSheets();
    rows = sheet.getDataRange().getValues();
  }

  const headers = rows[0] || [];
  const idColumn = findHeaderColumn(headers, ['Application ID', 'Application Id', 'App ID', 'App Id', 'ApplicationID', 'applicationId']);
  let documentLinksColumn = findHeaderColumn(headers, ['Document Links', 'Document Link', 'Documents', 'Drive Link', 'Drive Folder', 'Folder Link']);

  if (idColumn === -1) {
    return {
      ok: false,
      error: 'Application ID column missing. Please make sure the Applications tab has an Application ID header.',
      headersFound: headers
    };
  }

  if (documentLinksColumn === -1) {
    documentLinksColumn = headers.length;
    sheet.getRange(1, documentLinksColumn + 1).setValue('Document Links');
    rows = sheet.getDataRange().getValues();
  }

  const folderMap = {};
  while (folders.hasNext()) {
    const folder = folders.next();
    const folderName = folder.getName();
    const applicationId = extractApplicationIdFromFolderName(folderName);
    if (applicationId) folderMap[applicationId] = folder.getUrl();
  }

  let repaired = 0;
  const missing = [];

  for (let i = 1; i < rows.length; i++) {
    const applicationId = String(rows[i][idColumn] || '').trim().toUpperCase();
    if (!applicationId) continue;

    const existingLinks = String(rows[i][documentLinksColumn] || '').trim();
    const existingFolder = parseDriveFolderUrl(existingLinks);
    if (existingFolder) continue;

    const folderUrl = folderMap[applicationId];
    if (!folderUrl) {
      missing.push(applicationId);
      continue;
    }

    const updatedLinks = existingLinks ? 'Application Folder: ' + folderUrl + '\n' + existingLinks : 'Application Folder: ' + folderUrl;
    sheet.getRange(i + 1, documentLinksColumn + 1).setValue(updatedLinks);
    repaired++;
  }

  return { ok: true, repaired: repaired, missing: missing, message: 'Drive folder links repaired where folder names contained matching APP IDs.' };
}

function findHeaderColumn(headers, possibleNames) {
  const normalizedHeaders = headers.map(function(header) { return normalizeHeaderName(header); });
  for (let i = 0; i < possibleNames.length; i++) {
    const target = normalizeHeaderName(possibleNames[i]);
    const index = normalizedHeaders.indexOf(target);
    if (index !== -1) return index;
  }
  return -1;
}

function normalizeHeaderName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractApplicationIdFromFolderName(folderName) {
  const match = String(folderName || '').match(/APP-[A-Z0-9-]+/i);
  return match ? match[0].toUpperCase() : '';
}
