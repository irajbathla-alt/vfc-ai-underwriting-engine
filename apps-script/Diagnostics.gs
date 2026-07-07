function runVfcSystemCheck() {
  const checks = [];

  addCheck(checks, 'CONFIG exists', typeof CONFIG !== 'undefined', 'Code.gs must be copied into Apps Script.');
  addCheck(checks, 'Spreadsheet ID set', !!(CONFIG && CONFIG.SHEET_ID), 'Set CONFIG.SHEET_ID in Code.gs.');
  addCheck(checks, 'Drive upload folder set', !!(CONFIG && CONFIG.DRIVE_UPLOAD_FOLDER_ID), 'Set CONFIG.DRIVE_UPLOAD_FOLDER_ID in Code.gs.');
  addCheck(checks, 'Admin password property', !!PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD'), 'Add ADMIN_PASSWORD in Project Settings > Script Properties.');
  addCheck(checks, 'OpenAI key property', !!PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY'), 'Add OPENAI_API_KEY in Project Settings > Script Properties for AI analysis.');

  addFunctionCheck(checks, 'adminLogin');
  addFunctionCheck(checks, 'listApplicationsAdmin');
  addFunctionCheck(checks, 'runAnalysisAdmin');
  addFunctionCheck(checks, 'uploadAdminDocument');
  addFunctionCheck(checks, 'uploadCaseStudyForAi');
  addFunctionCheck(checks, 'saveNumberedApplicationFile');
  addFunctionCheck(checks, 'listNumberedApplicationFiles');
  addFunctionCheck(checks, 'analyzeApplicationStatementFilesWithOpenAI');
  addFunctionCheck(checks, 'buildUnderwritingRecommendation');
  addFunctionCheck(checks, 'repairApplicationsFromDriveFolders');
  addFunctionCheck(checks, 'setupDatabaseSheets');

  try {
    const spreadsheet = getSpreadsheet();
    addCheck(checks, 'Spreadsheet opens', !!spreadsheet, 'Check Sheet ID and Apps Script permissions.');
    const requiredTabs = [
      CONFIG.APPLICATIONS_TAB,
      CONFIG.ANALYSIS_TAB,
      CONFIG.RESULTS_TAB,
      CONFIG.ADMIN_DECISIONS_TAB,
      CONFIG.HISTORICAL_CASES_TAB,
      CONFIG.CLIENT_USERS_TAB,
      CONFIG.APPLICATION_STATUS_TAB,
      CONFIG.LENDER_CRITERIA_TAB
    ];
    if (CONFIG.AI_TRAINING_FILES_TAB) requiredTabs.push(CONFIG.AI_TRAINING_FILES_TAB);
    requiredTabs.forEach(function(tabName) {
      addCheck(checks, 'Sheet tab: ' + tabName, !!spreadsheet.getSheetByName(tabName), 'Run setupDatabaseSheets().');
    });
  } catch (error) {
    addCheck(checks, 'Spreadsheet opens', false, error.message);
  }

  try {
    const folder = getUploadFolder();
    addCheck(checks, 'Drive folder opens', !!folder, 'Check Drive folder ID and permissions.');
  } catch (error) {
    addCheck(checks, 'Drive folder opens', false, error.message);
  }

  const failed = checks.filter(function(check) { return !check.ok; });
  const result = {
    ok: failed.length === 0,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks: checks
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function addFunctionCheck(checks, functionName) {
  addCheck(checks, 'Function exists: ' + functionName, typeof this[functionName] === 'function', 'Missing file or function: ' + functionName);
}

function addCheck(checks, name, ok, fix) {
  checks.push({ name: name, ok: !!ok, fix: ok ? '' : fix });
}
