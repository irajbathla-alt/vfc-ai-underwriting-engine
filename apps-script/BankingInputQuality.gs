const VFC_BANKING = {
  VERSION: 'VFC-BANKING-PURE-4.6-CADENCE-CANONICAL',
  PREFIX: 'VFC_BANK_PURE_V46:',
  LEGACY: ['VFC_BANK_PURE_V45:','VFC_BANK_PURE_V44:','VFC_BANK_PURE_V43:','VFC_BANK_PURE_V42:','VFC_BANK_PURE_V41:','VFC_BANK_PURE_V40:','VFC_BANK_PURE_V35:','VFC_BANK_PURE_V34:'],
  PAYLOAD_VERSION: 46,
  MAX_STATEMENTS: 12,
  DEBT_LOOKBACK: 6,
  RECONCILE_TOLERANCE: 5,
  ACTIVE_LOOKBACK_DAYS: 60,
  AMOUNT_MATCH_PERCENT: 0.05,
  AMOUNT_MATCH_DOLLARS: 3
};

function getBankingInputQualityStatus() {
  return {
    modelVersion: VFC_BANKING.VERSION,
    automatic: true,
    bankAgnostic: true,
    statementHeaderTotalsAuthoritative: true,
    financingCreditFamiliesCanonicalized: true,
    operatingDepositsExcludeUniqueConfirmedFinancingCredits: true,
    recurringMonthlyEquivalentUsesObservedCadence: true,
    splitOcrLinesJoined: true,
    continuationLineDatesCarriedForward: true,
    debitVerificationNeverDeletesCredits: true,
    recurringGroupingUsesNameAndAmount: true,
    visibleLabelsUsePrintedDescriptions: true,
    creditsNeverCountAsDebt: true,
    historicalTrainingPdfReprocessingRequired: false
  };
}
