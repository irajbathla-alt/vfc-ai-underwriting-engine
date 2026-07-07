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
    'Average Monthly Withdrawals', 'Total Deposits', 'Total Withdrawals',
    'Statement Months Reviewed', 'NSF Count', 'Negative Days',
    'Existing MCA Payments', 'Average Daily Balance', 'Lowest Balance',
    'Revenue Trend', 'Cash Flow Strength', 'Risk Grade', 'Underwriter Notes'
  ];

  const resultHeaders = [
    'Application ID', 'Decision Date', 'Risk Grade Or Status',
    'Low Offer Or Final Amount', 'High Offer Or Conditions',
    'Recommended Action Or Notes', 'Conditions Or Audit Note'
  ];

  const adminDecisionHeaders = [
    'Decision ID', 'Application ID', 'Decision Date', 'Status',
    'Final Amount', 'Final Lender', 'Scenario', 'Conditions', 'Notes', 'Reviewer'
  ];

  const applicationStatusHeaders = [
    'Application ID', 'Status Date', 'Status', 'Note'
  ];

  initializeSheet(CONFIG.APPLICATIONS_TAB, applicationHeaders);
  initializeSheet(CONFIG.ANALYSIS_TAB, analysisHeaders);
  initializeSheet(CONFIG.RESULTS_TAB, resultHeaders);
  initializeSheet(CONFIG.ADMIN_DECISIONS_TAB, adminDecisionHeaders);
  initializeSheet(CONFIG.APPLICATION_STATUS_TAB, applicationStatusHeaders);
}

function cleanupV1Sheets() {
  const spreadsheet = getSpreadsheet();
  const keep = [
    CONFIG.APPLICATIONS_TAB,
    CONFIG.ANALYSIS_TAB,
    CONFIG.RESULTS_TAB,
    CONFIG.ADMIN_DECISIONS_TAB,
    CONFIG.APPLICATION_STATUS_TAB
  ];

  const remove = [
    'Historical Cases',
    'AI Training Files',
    'Client Users',
    'Lender Criteria'
  ];

  remove.forEach(function(tabName) {
    const sheet = spreadsheet.getSheetByName(tabName);
    if (sheet && keep.indexOf(tabName) === -1 && spreadsheet.getSheets().length > 1) {
      spreadsheet.deleteSheet(sheet);
    }
  });

  setupDatabaseSheets();
  return { ok: true, keptTabs: keep, removedTabs: remove };
}

function initializeSheet(tabName, headers) {
  const sheet = getOrCreateSheet(tabName);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
  sheet.setFrozenRows(1);
}

function toCamelCase(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_, chr) => chr.toUpperCase());
}
