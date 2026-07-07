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

  const historicalCaseHeaders = [
    'Case ID', 'Lender Name', 'Decision', 'Funded', 'Approved Amount',
    'Requested Amount', 'Industry', 'Time in Business', 'Credit Score',
    'Average Monthly Deposits', 'NSF Count', 'Negative Days',
    'Existing MCA Payments', 'Revenue Trend', 'Reason Approved',
    'Reason Declined', 'Conditions', 'Statement Months Reviewed',
    'Decision Date', 'Notes'
  ];

  const clientUserHeaders = [
    'Client ID', 'Created Date', 'Owner Name', 'Business Name',
    'Email', 'Phone', 'Latest Application ID', 'Account Status'
  ];

  const applicationStatusHeaders = [
    'Application ID', 'Status Date', 'Status', 'Note'
  ];

  const lenderCriteriaHeaders = [
    'Lender Name', 'Minimum Deposits', 'Minimum Time in Business',
    'Minimum Credit Score', 'Preferred Industries', 'Risk Notes', 'Last Updated'
  ];

  initializeSheet(CONFIG.APPLICATIONS_TAB, applicationHeaders);
  initializeSheet(CONFIG.ANALYSIS_TAB, analysisHeaders);
  initializeSheet(CONFIG.RESULTS_TAB, resultHeaders);
  initializeSheet(CONFIG.ADMIN_DECISIONS_TAB, adminDecisionHeaders);
  initializeSheet(CONFIG.HISTORICAL_CASES_TAB, historicalCaseHeaders);
  initializeSheet(CONFIG.CLIENT_USERS_TAB, clientUserHeaders);
  initializeSheet(CONFIG.APPLICATION_STATUS_TAB, applicationStatusHeaders);
  initializeSheet(CONFIG.LENDER_CRITERIA_TAB, lenderCriteriaHeaders);
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
