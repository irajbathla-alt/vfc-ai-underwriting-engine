/**
 * Compatibility bridge for VFC Banking Input Quality v2.
 *
 * The implementation now lives in:
 *   BankingInputQuality_00_Core.gs
 *   BankingInputQuality_10_Extraction.gs
 *   BankingInputQuality_20_Debt.gs
 *   BankingInputQuality_30_Regression.gs
 *
 * Keep this file because BMOIntake.gs and older project code reference
 * VFC_BANKING and vfcBankCreateIntakePayload_().
 */

// Literal values are intentional here: this file can be loaded before the v2 core.
const VFC_BANKING = {
  VERSION: 'VFC-BANKING-BANKED-2.0',
  PREFIX: 'VFC_BANK_FACTS_V1:',
  PAYLOAD_VERSION: 2,
  MAX_STATEMENTS: 12,
  DEBT_LOOKBACK: 6,
  RECONCILE_TOLERANCE: 5,
  ACTIVE_LOOKBACK_DAYS: 75
};

/**
 * Backward-compatible intake payload creator used by BMOIntake.gs and the
 * existing upload flow. It writes the same frozen-facts cache format that the
 * v2 engine consumes, so rerunning an assessment does not re-interpret the PDF.
 */
function vfcBankCreateIntakePayload_(summary, fileName) {
  summary = summary || {};
  const opening = vfcPureNullableNumber_(summary.opening_balance);
  const closing = vfcPureNullableNumber_(summary.closing_balance);
  const deposits = vfcPureNullableNumber_(summary.total_deposits);
  const withdrawals = vfcPureNullableNumber_(summary.total_withdrawals);
  const diff = (opening!==null && closing!==null && deposits!==null && withdrawals!==null)
    ? vfcPureRound_((opening + deposits - withdrawals) - closing, .01)
    : 0;

  const bankId = vfcDetectBankId_(summary.bank_name || '');
  const payload = {
    version: 2,
    extractionVersion: 'VFC-BANK-FACTS-1.0',
    fileName: String(fileName || ''),
    bankId: bankId,
    bankName: String(summary.bank_name || bankId || 'Unknown'),
    statementStartDate: vfcPureIso_(summary.statement_start_date),
    statementEndDate: vfcPureIso_(summary.statement_end_date),
    openingBalance: opening===null ? 0 : opening,
    closingBalance: closing===null ? 0 : closing,
    totalDeposits: deposits===null ? 0 : deposits,
    totalWithdrawals: withdrawals===null ? 0 : withdrawals,
    reconciliationDifference: diff,
    totalsSource: 'INTAKE_SINGLE_PASS',
    nsfCount: Math.max(0, vfcPureNumber_(summary.nsf_count)),
    negativeBalanceDetected: vfcPureBool_(summary.negative_balance_detected),
    transactionsVerified: true,
    transactions: vfcPureNormalizeTransactions_(summary.banking_transactions || [])
  };

  return VFC_BANKING.PREFIX + JSON.stringify(payload);
}
