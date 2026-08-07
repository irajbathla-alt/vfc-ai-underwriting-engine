/**
 * Compatibility shim for the simplified VFC production model.
 *
 * The current production assessment no longer needs the old SimpleSheetSetup
 * / cleanup layer. These no-op functions prevent legacy calls in
 * InstitutionalUnderwritingLayer.gs from breaking an otherwise working Apps
 * Script deployment.
 *
 * IMPORTANT: These functions intentionally do not create, rename, clear, hide,
 * delete, or otherwise modify any spreadsheet sheets or data.
 */
function setupSimpleVFC() {
  return {
    ok: true,
    skipped: true,
    message: 'Legacy sheet setup is disabled. Existing VFC sheets are used as-is.'
  };
}

function cleanupUnusedSheetsOnce_() {
  return {
    ok: true,
    skipped: true,
    message: 'Legacy sheet cleanup is disabled. No sheets were changed.'
  };
}

function getRuntimeCompatibilityStatus() {
  return {
    legacySetupDisabled: true,
    legacyCleanupDisabled: true,
    createsSheets: false,
    deletesSheets: false,
    modifiesSheetStructure: false
  };
}
