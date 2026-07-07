function repairDriveLinksFromAppsScript() {
  const parent = getUploadFolder();
  const folders = parent.getFolders();
  const rows = getRows(CONFIG.APPLICATIONS_TAB);
  if (!rows || rows.length <= 1) return { ok: true, repaired: 0, message: 'No application rows found.' };

  const headers = rows[0];
  const idColumn = headers.indexOf('Application ID');
  const documentLinksColumn = headers.indexOf('Document Links');
  if (idColumn === -1 || documentLinksColumn === -1) throw new Error('Application ID or Document Links column missing.');

  const folderMap = {};
  while (folders.hasNext()) {
    const folder = folders.next();
    const folderName = folder.getName();
    const applicationId = extractApplicationIdFromFolderName(folderName);
    if (applicationId) folderMap[applicationId] = folder.getUrl();
  }

  const sheet = getOrCreateSheet(CONFIG.APPLICATIONS_TAB);
  let repaired = 0;
  const missing = [];

  for (let i = 1; i < rows.length; i++) {
    const applicationId = String(rows[i][idColumn] || '').trim();
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

  return { ok: true, repaired: repaired, missing: missing };
}

function extractApplicationIdFromFolderName(folderName) {
  const match = String(folderName || '').match(/APP-[A-Z0-9-]+/i);
  return match ? match[0].toUpperCase() : '';
}
