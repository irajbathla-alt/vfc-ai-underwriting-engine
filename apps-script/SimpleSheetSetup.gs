const VFC_SIMPLE_SHEET_SCHEMAS = {
  'Companies': ['Company ID','Company Name','Folder ID','Folder Link','Created At'],
  'Uploads': ['Upload ID','Company ID','Company Name','Detected Period','File Name','File ID','File Link','Status','Created At'],
  'PDF Summaries': ['Upload ID','Company Name','Detected Period','File Name','Document Type','Bank Name','Account Holder','Statement Start Date','Statement End Date','Opening Balance','Closing Balance','Total Deposits','Total Withdrawals','NSF Count','Negative Balance Detected','Possible MCA Or Loan Payments','Summary','Risks','Missing Info','Created At'],
  'Batch Summaries': ['Batch ID','Company Name','Detected Period','Files Read','Earliest Statement Date','Latest Statement Date','Combined Summary','Key Findings','Risks','Missing Info','Created At'],
  'Settings': ['Key','Value'],
  'Lenders': ['Lender ID','Lender Name','Product Type','Notes','Status','Created At'],
  'Observed Lender Behaviour': ['Behaviour ID','Lender Name','Company Name','Period','Decision','Approved Amount','Decline Reason','Observed Pattern Note','Created At'],
  'Training Records': ['Training ID','Company Name','Period','Lender Name','Decision','Approved Amount','Decline Reason','Bank Summary','Key Findings','Risks','Missing Info','Created At'],
  'Structured Features': ['Feature ID','Company Name','Period','Statement Count','Months Covered','Total Deposits','Average Monthly Deposits','Total Withdrawals','Deposit Withdrawal Ratio','NSF Count','Negative Balance Flag','MCA Payment Flag','Summary Text','Updated At']
};

const VFC_UNUSED_SHEETS = [
  'Underwriting Assessments',
  'AI Recommendations',
  'Deal Outcomes',
  'Hybrid Assessments',
  'Risk Scorecards',
  'Institutional Assessments',
  'AI Pattern Models',
  'Prediction Outcomes'
];

const VFC_SHEET_CLEANUP_PROPERTY = 'VFC_SIMPLE_UNUSED_SHEETS_REMOVED_V1';

/** Creates only the sheets required by the simple historical engine. */
function setupSimpleVFC() {
  Object.keys(VFC_SIMPLE_SHEET_SCHEMAS).forEach(function(name) {
    ensureSheetSchema_(name, VFC_SIMPLE_SHEET_SCHEMAS[name]);
  });
  getOrCreateRootFolder_();
  seedDefaultLenders_();

  const bankTabs = typeof setupBankTrainingTabs === 'function'
    ? setupBankTrainingTabs()
    : {ok:false, created:[], tabs:[]};

  return {
    ok: true,
    message: 'Simple VFC sheet setup complete, including isolated bank training tabs.',
    activeSheets: Object.keys(VFC_SIMPLE_SHEET_SCHEMAS),
    bankTrainingTabs: bankTabs
  };
}

/**
 * Deletes only exact legacy sheet names from superseded underwriting versions.
 * Core uploads, statement summaries, training outcomes and structured features
 * are never deleted by this function.
 */
function cleanupUnusedSheets() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const removed = [];
  const notFound = [];

  VFC_UNUSED_SHEETS.forEach(function(name) {
    const sheet = spreadsheet.getSheetByName(name);
    if (!sheet) {
      notFound.push(name);
      return;
    }
    spreadsheet.deleteSheet(sheet);
    removed.push(name);
  });

  PropertiesService.getScriptProperties().setProperty(
    VFC_SHEET_CLEANUP_PROPERTY,
    new Date().toISOString()
  );

  return {
    ok: true,
    message: removed.length
      ? 'Removed ' + removed.length + ' unused sheets.'
      : 'No unused legacy sheets were found.',
    removedSheets: removed,
    retainedSheets: Object.keys(VFC_SIMPLE_SHEET_SCHEMAS),
    notFound: notFound
  };
}

/**
 * Skips work only when cleanup has run and no obsolete sheet has reappeared.
 * This protects the simple engine if an old manual function is run later.
 */
function cleanupUnusedSheetsOnce_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const legacyStillPresent = VFC_UNUSED_SHEETS.some(function(name) {
    return !!spreadsheet.getSheetByName(name);
  });
  const alreadyCleaned = !!PropertiesService.getScriptProperties()
    .getProperty(VFC_SHEET_CLEANUP_PROPERTY);

  if (alreadyCleaned && !legacyStillPresent) {
    return { ok: true, skipped: true, message: 'No unused legacy sheets are present.' };
  }
  return cleanupUnusedSheets();
}

function getSimpleSheetStatus() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const existing = spreadsheet.getSheets().map(function(sheet) {
    return sheet.getName();
  });
  return {
    requiredSheets: Object.keys(VFC_SIMPLE_SHEET_SCHEMAS),
    bankTrainingSheets: typeof getBankParserTabs === 'function' ? getBankParserTabs().map(function(x){return 'BANK_'+x.id;}) : [],
    unusedSheetsStillPresent: VFC_UNUSED_SHEETS.filter(function(name) {
      return existing.indexOf(name) >= 0;
    }),
    allExistingSheets: existing
  };
}
