function getNextDocumentNumber(folder) {
  const files = folder.getFiles();
  let maxNumber = 0;
  while (files.hasNext()) {
    const name = files.next().getName();
    const match = String(name).match(/^(\d{2,4})\s*-/);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }
  return maxNumber + 1;
}

function makeNumberedFileName(number, originalName) {
  return String(number).padStart(2, '0') + ' - ' + sanitizeFileName(originalName || 'document');
}

function listNumberedApplicationFiles(applicationId) {
  const application = getApplication(applicationId);
  if (!application.ok) return [];

  const app = application.data;
  const folder = getOrCreateApplicationFolder({
    applicationId: applicationId,
    businessName: app.businessName || 'Unknown Business',
    ownerName: app.ownerName || 'Unknown Applicant'
  });

  const files = folder.getFiles();
  const result = [];
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    const match = String(name).match(/^(\d{2,4})\s*-/);
    result.push({
      number: match ? Number(match[1]) : 9999,
      name: name,
      url: file.getUrl(),
      id: file.getId()
    });
  }

  return result.sort(function(a, b) {
    return a.number - b.number || String(a.name).localeCompare(String(b.name));
  });
}
