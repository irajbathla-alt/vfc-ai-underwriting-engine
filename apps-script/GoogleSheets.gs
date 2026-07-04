function getSpreadsheet() {
  return SpreadsheetApp.openById(CONFIG.SHEET_ID);
}

function getOrCreateSheet(tabName) {
  const spreadsheet = getSpreadsheet();
  return spreadsheet.getSheetByName(tabName) || spreadsheet.insertSheet(tabName);
}

function appendRow(tabName, row) {
  getOrCreateSheet(tabName).appendRow(row);
}

function getRows(tabName) {
  const sheet = getOrCreateSheet(tabName);
  return sheet.getDataRange().getValues();
}

function setupDatabaseSheets() {
  const applicationHeaders = [
    'Application ID', 'Date Submitted', 'Business Name', 'Owner Name',
    'Email', 'Phone', 'Industry', 'Time In Business', 'Credit Score',
    'Monthly Sales Estimate', 'Status', 'Document Links', 'Assigned Lender'
  ];

  const analysisHeaders = [
    'Application ID', 'Analysis Date', 'Average Monthly Deposits',
    'NSF Count', 'Negative Days', 'Existing MCA Payments',
    'Revenue Trend', 'Risk Grade', 'Underwriter Notes'
  ];

  const resultHeaders = [
    'Application ID', 'Decision Date', 'Risk Grade Or Status',
    'Low Offer Or Final Amount', 'High Offer Or Conditions',
    'Recommended Action Or Notes', 'Conditions Or Audit Note'
  ];

  initializeSheet(CONFIG.APPLICATIONS_TAB, applicationHeaders);
  initializeSheet(CONFIG.ANALYSIS_TAB, analysisHeaders);
  initializeSheet(CONFIG.RESULTS_TAB, resultHeaders);
}

function initializeSheet(tabName, headers) {
  const sheet = getOrCreateSheet(tabName);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  sheet.setFrozenRows(1);
}

function toCamelCase(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_, chr) => chr.toUpperCase());
}
