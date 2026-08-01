const VFC_OPENAI_RECOMMENDATION_CONFIG = {
  MODEL_VERSION: 'VFC-OPENAI-SHEETS-1.0',
  DEFAULT_MODEL: 'gpt-5-mini',
  MAX_COMPARABLE_CASES: 24,
  MIN_SIMILARITY: 0.30,
  ROUNDING: 500,
  MAX_AVERAGE_MONTHLY_DEPOSITS: 5000000,
  MAX_APPROVED_AMOUNT: 5000000
};

/**
 * Separate OpenAI recommendation.
 *
 * Reads current banking features and verified historical outcomes from the
 * existing Sheets on every request. It never writes to a Sheet and never
 * changes the production "Our Max" result.
 */
function generateOpenAIRecommendationSafe(companyOrRequest, requestedPeriod) {
  const request = vfcOaiNormalizeRequest_(companyOrRequest, requestedPeriod);
  const period = vfcOaiResolvePeriod_(request.companyName, request.period);
  const current = vfcOaiBuildFeatures_(request.companyName, period);

  vfcOaiValidateCurrent_(current);

  const outcomes = vfcOaiHistoricalOutcomes_().filter(function(row) {
    return !(
      vfcOaiSame_(row.companyName, request.companyName) &&
      vfcOaiPeriodSame_(row.period, period)
    );
  });

  if (!outcomes.length) {
    throw new Error('No verified historical outcomes are available in the training Sheets.');
  }

  const built = vfcOaiBuildComparableCases_(current, outcomes);
  const cases = built.validCases.slice(0, VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_COMPARABLE_CASES);
  const positiveCases = cases.filter(function(row) {
    return row.isPositive && row.approvedAmount > 0;
  });

  if (!cases.length || !positiveCases.length) {
    throw new Error('No usable comparable approvals were found after data-quality checks.');
  }

  const promptData = {
    current_profile: vfcOaiCompactFeatures_(current),
    comparable_cases: cases.map(function(row, index) {
      return {
        case_id: 'CASE_' + (index + 1),
        lender: row.lenderName,
        decision: row.decision,
        actual_approved_amount: row.approvedAmount,
        deposit_adjusted_amount: row.adjustedAmount,
        similarity_percent: Math.round(row.similarity * 100),
        average_monthly_deposits: row.features.averageMonthlyDeposits,
        deposit_withdrawal_ratio: row.features.depositWithdrawalRatio,
        nsf_per_month: row.features.nsfPerMonth,
        negative_balance: row.features.negativeBalanceFlag,
        existing_mca_or_loan: row.features.mcaPaymentFlag,
        months_covered: row.features.monthsCovered,
        decline_reason: row.decision === 'Declined' ? row.declineReason : ''
      };
    })
  };

  const instruction = [
    'You are the VFC experimental underwriting analyst.',
    'Use only the supplied current banking profile and verified historical cases.',
    'Do not invent lender policies, lender criteria, or facts not in the data.',
    'This recommendation must remain separate from the production Our Max calculation.',
    'Use approved and conditional cases to estimate the amount.',
    'Do not treat a decline as a zero-dollar approval; use declines only for approval probability and risk analysis.',
    'Prefer the most similar cases and explain the recommendation in plain language.',
    'Keep the recommended amount reasonably supported by deposit-adjusted historical approvals.',
    'Return the best-supported lender from the lender names present in the comparable cases.'
  ].join(' ');

  const raw = vfcOaiCallOpenAI_(instruction, promptData);
  const protectedResult = vfcOaiApplySanityChecks_(raw, current, cases, positiveCases);

  return JSON.parse(JSON.stringify({
    ok: true,
    modelVersion: VFC_OPENAI_RECOMMENDATION_CONFIG.MODEL_VERSION,
    openAIModel: protectedResult.openAIModel,
    productionModelAffected: false,
    companyName: request.companyName,
    period: period,
    recommendation: {
      recommendedAmount: protectedResult.recommendedAmount,
      rawOpenAIAmount: protectedResult.rawOpenAIAmount,
      recommendedLender: protectedResult.recommendedLender,
      approvalProbability: protectedResult.approvalProbability,
      confidence: protectedResult.confidence,
      closestCasesUsed: protectedResult.closestCasesUsed,
      reasoning: protectedResult.reasoning,
      keyStrengths: protectedResult.keyStrengths,
      keyRisks: protectedResult.keyRisks,
      sanityCapApplied: protectedResult.sanityCapApplied
    },
    trainingDataRead: {
      totalHistoricalOutcomes: outcomes.length,
      validComparableCases: cases.length,
      comparableApprovals: positiveCases.length,
      ignoredCases: built.ignoredCases.length
    },
    dataSentToOpenAI: {
      structuredMetricsOnly: true,
      historicalCompanyNamesSent: false,
      bankStatementTextSent: false,
      accountNumbersSent: false
    },
    note: 'OpenAI recommendation only. It does not change Our Max and is not a lender approval or guarantee.'
  }));
}

/** Easy Apps Script test: runs the OpenAI recommendation for the latest Structured Features row. */
function testLatestOpenAIRecommendation() {
  const rows = getSheetObjects_('Structured Features');
  if (!rows.length) throw new Error('Structured Features has no records to test.');
  const latest = rows[rows.length - 1];
  const result = generateOpenAIRecommendationSafe({
    companyName: latest.companyName,
    period: latest.period
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function getOpenAIRecommendationStatus() {
  return {
    modelVersion: VFC_OPENAI_RECOMMENDATION_CONFIG.MODEL_VERSION,
    readsLiveSheetsEveryRun: true,
    writesToSheets: false,
    changesOurMax: false,
    defaultOpenAIModel: VFC_OPENAI_RECOMMENDATION_CONFIG.DEFAULT_MODEL,
    sourceSheets: ['Training Records', 'Observed Lender Behaviour', 'Structured Features', 'PDF Summaries']
  };
}

function vfcOaiCallOpenAI_(instruction, promptData) {
  const properties = PropertiesService.getScriptProperties();
  const apiKey = properties.getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Apps Script Properties.');

  const model = properties.getProperty('OPENAI_RECOMMENDATION_MODEL') ||
    VFC_OPENAI_RECOMMENDATION_CONFIG.DEFAULT_MODEL;

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      recommended_amount: { type: 'number', minimum: 0 },
      recommended_lender: { type: 'string' },
      approval_probability: { type: 'integer', minimum: 0, maximum: 100 },
      confidence: { type: 'string', enum: ['Low', 'Moderate', 'High'] },
      closest_cases_used: { type: 'integer', minimum: 1 },
      reasoning: { type: 'string' },
      key_strengths: { type: 'array', items: { type: 'string' } },
      key_risks: { type: 'array', items: { type: 'string' } }
    },
    required: [
      'recommended_amount',
      'recommended_lender',
      'approval_probability',
      'confidence',
      'closest_cases_used',
      'reasoning',
      'key_strengths',
      'key_risks'
    ]
  };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({
      model: model,
      instructions: instruction,
      input: JSON.stringify(promptData),
      text: {
        format: {
          type: 'json_schema',
          name: 'vfc_openai_recommendation',
          description: 'A separate experimental underwriting recommendation based only on supplied VFC historical outcomes.',
          strict: true,
          schema: schema
        }
      }
    }),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error('OpenAI returned an unreadable response. HTTP ' + status + '.');
  }

  if (status < 200 || status >= 300 || body.error) {
    const message = body && body.error && body.error.message
      ? body.error.message
      : 'OpenAI request failed with HTTP ' + status + '.';
    throw new Error(message);
  }

  const outputText = vfcOaiOutputText_(body);
  if (!outputText) throw new Error('OpenAI returned no structured recommendation.');

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    throw new Error('OpenAI recommendation was not valid JSON.');
  }

  parsed.__openAIModel = body.model || model;
  return parsed;
}

function vfcOaiOutputText_(body) {
  if (body && typeof body.output_text === 'string' && body.output_text) {
    return body.output_text;
  }
  const output = body && Array.isArray(body.output) ? body.output : [];
  for (let i = 0; i < output.length; i++) {
    const content = Array.isArray(output[i].content) ? output[i].content : [];
    for (let j = 0; j < content.length; j++) {
      if (content[j] && typeof content[j].text === 'string' && content[j].text) {
        return content[j].text;
      }
    }
  }
  return '';
}

function vfcOaiApplySanityChecks_(raw, current, cases, positiveCases) {
  const rawAmount = Math.max(0, vfcOaiNumber_(raw.recommended_amount));
  const deposits = Math.max(0, vfcOaiNumber_(current.averageMonthlyDeposits));
  const highestAdjusted = Math.max.apply(null, positiveCases.map(function(row) {
    return row.adjustedAmount;
  }));

  const evidenceCap = highestAdjusted > 0 ? highestAdjusted * 1.15 : 0;
  const depositCap = deposits > 0 ? deposits * 1.50 : 0;
  const availableCaps = [evidenceCap, depositCap].filter(function(value) {
    return value > 0;
  });
  const sanityCap = availableCaps.length
    ? Math.min.apply(null, availableCaps)
    : VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_APPROVED_AMOUNT;

  const capped = Math.min(
    rawAmount,
    sanityCap,
    VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_APPROVED_AMOUNT
  );
  const recommendedAmount = vfcOaiRound_(
    Math.max(0, capped),
    VFC_OPENAI_RECOMMENDATION_CONFIG.ROUNDING
  );

  const lenderNames = {};
  cases.forEach(function(row) {
    lenderNames[String(row.lenderName || '').trim().toLowerCase()] = row.lenderName;
  });
  const requestedLender = String(raw.recommended_lender || '').trim();
  const supportedLender = lenderNames[requestedLender.toLowerCase()] ||
    (cases[0] ? cases[0].lenderName : '');

  return {
    openAIModel: raw.__openAIModel || VFC_OPENAI_RECOMMENDATION_CONFIG.DEFAULT_MODEL,
    rawOpenAIAmount: vfcOaiRound_(rawAmount, VFC_OPENAI_RECOMMENDATION_CONFIG.ROUNDING),
    recommendedAmount: recommendedAmount,
    recommendedLender: supportedLender,
    approvalProbability: Math.round(vfcOaiClamp_(vfcOaiNumber_(raw.approval_probability), 0, 100)),
    confidence: ['Low', 'Moderate', 'High'].indexOf(raw.confidence) >= 0 ? raw.confidence : 'Low',
    closestCasesUsed: Math.max(1, Math.min(cases.length, Math.round(vfcOaiNumber_(raw.closest_cases_used) || cases.length))),
    reasoning: String(raw.reasoning || '').trim(),
    keyStrengths: Array.isArray(raw.key_strengths) ? raw.key_strengths.slice(0, 6) : [],
    keyRisks: Array.isArray(raw.key_risks) ? raw.key_risks.slice(0, 6) : [],
    sanityCapApplied: recommendedAmount < vfcOaiRound_(rawAmount, VFC_OPENAI_RECOMMENDATION_CONFIG.ROUNDING)
  };
}

function vfcOaiBuildComparableCases_(current, outcomes) {
  const validCases = [];
  const ignoredCases = [];
  const currentDeposits = vfcOaiNumber_(current.averageMonthlyDeposits);

  outcomes.forEach(function(outcome) {
    const decision = vfcOaiDecision_(outcome.decision);
    if (!decision || !outcome.companyName || !outcome.lenderName) return;

    let features;
    try {
      features = vfcOaiBuildFeatures_(outcome.companyName, outcome.period);
    } catch (error) {
      features = null;
    }

    const validation = vfcOaiValidateHistorical_(features);
    if (!validation.valid) {
      ignoredCases.push({ companyName: outcome.companyName, reason: validation.reason });
      return;
    }

    const approvedAmount = Math.max(0, vfcOaiNumber_(outcome.approvedAmount));
    const isPositive = decision === 'Approved' || decision === 'Conditional';
    if (isPositive && (!approvedAmount || approvedAmount > VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_APPROVED_AMOUNT)) {
      ignoredCases.push({ companyName: outcome.companyName, reason: 'Missing or unreasonable approved amount' });
      return;
    }

    const similarity = vfcOaiSimilarity_(current, features);
    if (similarity < VFC_OPENAI_RECOMMENDATION_CONFIG.MIN_SIMILARITY) return;

    const historicalDeposits = vfcOaiNumber_(features.averageMonthlyDeposits);
    const ratio = historicalDeposits > 0
      ? vfcOaiClamp_(currentDeposits / historicalDeposits, 0.60, 1.50)
      : 1;

    validCases.push({
      companyName: outcome.companyName,
      period: outcome.period,
      lenderName: outcome.lenderName,
      decision: decision,
      approvedAmount: approvedAmount,
      declineReason: outcome.declineReason || '',
      isPositive: isPositive,
      similarity: similarity,
      adjustedAmount: isPositive ? vfcOaiRound_(approvedAmount * ratio, 1) : 0,
      features: vfcOaiCompactFeatures_(features)
    });
  });

  validCases.sort(function(a, b) {
    return b.similarity - a.similarity;
  });
  return { validCases: validCases, ignoredCases: ignoredCases };
}

function vfcOaiHistoricalOutcomes_() {
  if (typeof collectHistoricalOutcomes_ === 'function') {
    return collectHistoricalOutcomes_();
  }

  const rows = [];
  ['Training Records', 'Observed Lender Behaviour'].forEach(function(sheetName) {
    getSheetObjects_(sheetName).forEach(function(row) {
      rows.push({
        companyName: row.companyName || '',
        period: row.period || row.detectedPeriod || '',
        lenderName: row.lenderName || '',
        decision: row.decision || '',
        approvedAmount: row.approvedAmount || '',
        declineReason: row.declineReason || ''
      });
    });
  });

  const seen = {};
  return rows.filter(function(row) {
    const key = [row.companyName, row.period, row.lenderName, row.decision, row.approvedAmount]
      .join('|').toLowerCase();
    if (!row.companyName || !row.lenderName || !row.decision || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function vfcOaiBuildFeatures_(companyName, period) {
  if (typeof buildPowerFeatures_ === 'function') {
    return buildPowerFeatures_(companyName, period);
  }
  if (typeof buildFeaturesForCase_ === 'function') {
    return buildFeaturesForCase_(companyName, period);
  }
  throw new Error('The existing banking-feature function was not found.');
}

function vfcOaiResolvePeriod_(companyName, requestedPeriod) {
  if (requestedPeriod) return requestedPeriod;
  if (typeof resolveLatestAssessmentPeriod_ === 'function') {
    return resolveLatestAssessmentPeriod_(companyName, requestedPeriod);
  }
  const rows = getSheetObjects_('Structured Features').filter(function(row) {
    return vfcOaiSame_(row.companyName, companyName);
  });
  if (!rows.length) throw new Error('No Structured Features record was found for this company.');
  return String(rows[rows.length - 1].period || '').trim();
}

function vfcOaiNormalizeRequest_(companyOrRequest, requestedPeriod) {
  let companyName = '';
  let period = requestedPeriod || '';
  if (companyOrRequest && typeof companyOrRequest === 'object') {
    companyName = companyOrRequest.companyName || companyOrRequest.company || '';
    period = companyOrRequest.period || companyOrRequest.detectedPeriod || period;
  } else {
    companyName = companyOrRequest || '';
  }
  companyName = String(companyName || '').trim();
  period = String(period || '').trim();
  if (!companyName) throw new Error('Company name is required.');
  return { companyName: companyName, period: period };
}

function vfcOaiValidateCurrent_(features) {
  const validation = vfcOaiValidateHistorical_(features);
  if (!validation.valid) {
    throw new Error('Current banking features failed validation: ' + validation.reason + '.');
  }
}

function vfcOaiValidateHistorical_(features) {
  if (!features || !vfcOaiNumber_(features.statementCount)) {
    return { valid: false, reason: 'No statement features' };
  }
  const deposits = vfcOaiNumber_(features.averageMonthlyDeposits);
  if (!deposits) return { valid: false, reason: 'Average monthly deposits are missing' };
  if (deposits > VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_AVERAGE_MONTHLY_DEPOSITS) {
    return { valid: false, reason: 'Average monthly deposits are unreasonable' };
  }
  const ratio = vfcOaiNumber_(features.depositWithdrawalRatio);
  if (ratio < 0 || ratio > 20) return { valid: false, reason: 'Deposit-withdrawal ratio is unreasonable' };
  return { valid: true, reason: '' };
}

function vfcOaiCompactFeatures_(features) {
  return {
    averageMonthlyDeposits: vfcOaiRound_(vfcOaiNumber_(features.averageMonthlyDeposits), 1),
    totalDeposits: vfcOaiRound_(vfcOaiNumber_(features.totalDeposits), 1),
    totalWithdrawals: vfcOaiRound_(vfcOaiNumber_(features.totalWithdrawals), 1),
    depositWithdrawalRatio: vfcOaiRound_(vfcOaiNumber_(features.depositWithdrawalRatio), 0.01),
    nsfPerMonth: vfcOaiRound_(
      features.nsfPerMonth !== undefined
        ? vfcOaiNumber_(features.nsfPerMonth)
        : vfcOaiNumber_(features.nsfCount) / Math.max(1, vfcOaiNumber_(features.monthsCovered)),
      0.01
    ),
    negativeBalanceFlag: vfcOaiFlag_(features.negativeBalanceFlag),
    mcaPaymentFlag: vfcOaiFlag_(features.mcaPaymentFlag),
    overdraftFlag: vfcOaiFlag_(features.overdraftFlag),
    suspectedStacking: vfcOaiFlag_(features.suspectedStacking),
    depositTrend: vfcOaiRound_(vfcOaiNumber_(features.depositTrend), 0.01),
    depositVolatility: vfcOaiRound_(vfcOaiNumber_(features.depositVolatility), 0.01),
    monthsCovered: vfcOaiNumber_(features.monthsCovered),
    statementCount: vfcOaiNumber_(features.statementCount)
  };
}

function vfcOaiSimilarity_(current, historical) {
  if (typeof powerSimilarity_ === 'function') {
    return vfcOaiClamp_(powerSimilarity_(current, historical), 0, 1);
  }

  const numericSimilarity = function(a, b, floorScale) {
    a = vfcOaiNumber_(a);
    b = vfcOaiNumber_(b);
    const scale = Math.max(Math.abs(a), Math.abs(b), floorScale || 1);
    return vfcOaiClamp_(1 - Math.abs(a - b) / scale, 0, 1);
  };

  return vfcOaiClamp_(
    numericSimilarity(current.averageMonthlyDeposits, historical.averageMonthlyDeposits) * 0.45 +
    numericSimilarity(current.depositWithdrawalRatio, historical.depositWithdrawalRatio, 2) * 0.15 +
    numericSimilarity(current.nsfPerMonth || current.nsfCount, historical.nsfPerMonth || historical.nsfCount, 3) * 0.15 +
    (vfcOaiFlag_(current.negativeBalanceFlag) === vfcOaiFlag_(historical.negativeBalanceFlag) ? 1 : 0) * 0.10 +
    (vfcOaiFlag_(current.mcaPaymentFlag) === vfcOaiFlag_(historical.mcaPaymentFlag) ? 1 : 0) * 0.10 +
    numericSimilarity(current.monthsCovered, historical.monthsCovered, 6) * 0.05,
    0,
    1
  );
}

function vfcOaiDecision_(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.indexOf('condition') >= 0) return 'Conditional';
  if (text.indexOf('approv') >= 0) return 'Approved';
  if (text.indexOf('declin') >= 0 || text.indexOf('reject') >= 0) return 'Declined';
  return '';
}

function vfcOaiNumber_(value) {
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  const number = parseFloat(String(value || '').replace(/[^0-9.\-]/g, ''));
  return isFinite(number) ? number : 0;
}

function vfcOaiFlag_(value) {
  return /^(1|true|yes|detected)$/i.test(String(value || '').trim()) ? 1 : 0;
}

function vfcOaiSame_(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function vfcOaiPeriodSame_(left, right) {
  const clean = function(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  };
  return clean(left) === clean(right);
}

function vfcOaiClamp_(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function vfcOaiRound_(value, step) {
  const number = vfcOaiNumber_(value);
  const increment = vfcOaiNumber_(step) || 1;
  return Math.round(number / increment) * increment;
}
