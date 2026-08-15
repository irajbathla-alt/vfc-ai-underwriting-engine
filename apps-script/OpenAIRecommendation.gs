const VFC_OPENAI_RECOMMENDATION_CONFIG = {
  MODEL_VERSION: 'VFC-OPENAI-STABLE-2.1-FAST-HISTORY',
  DEFAULT_MODEL: 'gpt-4.1-mini',
  MAX_COMPARABLE_CASES: 12,
  MIN_SIMILARITY: 0.30,
  ROUNDING: 500,
  MAX_AVERAGE_MONTHLY_DEPOSITS: 5000000,
  MAX_APPROVED_AMOUNT: 5000000,
  CACHE_PREFIX: 'VFC_OAI_STABLE_21:'
};

function generateOpenAIRecommendationSafe(companyOrRequest, requestedPeriod) {
  const request = vfcOaiNormalizeRequest_(companyOrRequest, requestedPeriod);
  const period = vfcOaiResolvePeriod_(request.companyName, request.period);
  const current = vfcOaiBuildCurrentFeatures_(request.companyName, period);
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
        months_covered: row.features.monthsCovered
      };
    })
  };

  const instruction = [
    'You are the VFC experimental underwriting analyst.',
    'Use only the supplied current banking profile and verified historical cases.',
    'Do not invent lender policies, lender criteria, outstanding balances, payoff amounts, or facts not in the data.',
    'This recommendation is separate from the production Our Max calculation.',
    'Use approved and conditional cases to estimate the amount and declines only for risk/probability.',
    'Prefer the most similar cases.',
    'Treat confirmed recurring financing debt service as a direct capacity constraint.',
    'Financing advances are not operating revenue.',
    'Do not treat tax/government, insurance, credit-card payments, or unclear recurring obligations as confirmed MCA/loan debt unless the supplied category proves it.',
    'Return concise reasoning.'
  ].join(' ');

  const model = vfcOaiModel_();
  const fingerprint = vfcOaiFingerprint_({
    version: VFC_OPENAI_RECOMMENDATION_CONFIG.MODEL_VERSION,
    model: model,
    data: promptData
  });
  const cached = vfcOaiReadCache_(fingerprint);
  let protectedResult;

  if (cached) {
    protectedResult = cached;
  } else {
    const raw = vfcOaiCallOpenAI_(instruction, promptData, model);
    protectedResult = vfcOaiApplySanityChecks_(raw, current, cases, positiveCases);
    vfcOaiWriteCache_(fingerprint, protectedResult);
  }

  const debtProfile = current && current.debtProfile ? current.debtProfile : {};
  const inputAudit = current && current.inputQualityAudit ? current.inputQualityAudit : {};

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
    bankingInputsUsed: {
      grossAverageMonthlyDeposits: vfcOaiNumber_(current.averageMonthlyDeposits),
      estimatedOperatingMonthlyDeposits: vfcOaiNumber_(current.estimatedOperatingMonthlyDeposits),
      detectedFinancingCredits: vfcOaiNumber_(current.detectedFinancingCredits),
      existingMonthlyDebtService: vfcOaiNumber_(current.existingMonthlyDebtService),
      otherRecurringMonthlyObligations: vfcOaiNumber_(current.otherRecurringMonthlyObligations),
      debtServiceToDepositsRatio: vfcOaiNumber_(current.debtServiceToDepositsRatio),
      activeDebtObligations: Array.isArray(debtProfile.activeDebtObligations)
        ? debtProfile.activeDebtObligations
        : [],
      otherRecurringObligations: Array.isArray(debtProfile.otherRecurringObligations)
        ? debtProfile.otherRecurringObligations
        : [],
      inputQualityWarnings: Array.isArray(inputAudit.warnings)
        ? inputAudit.warnings
        : []
    },
    trainingDataRead: {
      totalHistoricalOutcomes: outcomes.length,
      validComparableCases: cases.length,
      comparableApprovals: positiveCases.length,
      ignoredCases: built.ignoredCases.length,
      historicalPdfReprocessing: false
    },
    stableCache: {
      fingerprint: fingerprint,
      reused: !!cached
    },
    note: 'OpenAI recommendation only. It does not change Our Max and is not a lender approval or guarantee.'
  }));
}

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
    currentBorrowerUsesValidatedBanking: true,
    historicalCasesUseStoredFeatures: true,
    historicalPdfReprocessing: false,
    stableRecommendationCache: true,
    usesRecurringDebtService: true,
    writesToSheets: false,
    changesOurMax: false,
    defaultOpenAIModel: VFC_OPENAI_RECOMMENDATION_CONFIG.DEFAULT_MODEL
  };
}

function vfcOaiBuildComparableCases_(current, outcomes) {
  const validCases = [];
  const ignoredCases = [];
  const currentDeposits = vfcOaiNumber_(current.averageMonthlyDeposits);
  const historicalIndex = vfcOaiHistoricalFeatureIndex_();

  (outcomes || []).forEach(function(outcome) {
    const decision = vfcOaiDecision_(outcome.decision);
    if (!decision || !outcome.companyName || !outcome.lenderName) return;

    let features;
    try {
      features = vfcOaiBuildHistoricalFeatures_(outcome.companyName, outcome.period, historicalIndex);
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
    if (
      isPositive &&
      (!approvedAmount || approvedAmount > VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_APPROVED_AMOUNT)
    ) {
      ignoredCases.push({
        companyName: outcome.companyName,
        reason: 'Missing or unreasonable approved amount'
      });
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

  validCases.sort(function(a,b){ return b.similarity-a.similarity; });
  return { validCases: validCases, ignoredCases: ignoredCases };
}

function vfcOaiBuildCurrentFeatures_(companyName, period) {
  if (typeof getValidatedBankingFeatures_ === 'function') {
    return getValidatedBankingFeatures_(companyName, period);
  }
  if (typeof buildPowerFeatures_ === 'function') {
    return buildPowerFeatures_(companyName, period);
  }
  if (typeof buildFeaturesForCase_ === 'function') {
    return buildFeaturesForCase_(companyName, period);
  }
  throw new Error('Current banking-feature function was not found.');
}

function vfcOaiHistoricalFeatureIndex_() {
  const rows = typeof getSheetObjects_ === 'function'
    ? getSheetObjects_('Structured Features')
    : [];
  const map = {};

  rows.forEach(function(row) {
    const companyName = String(row.companyName || '').trim();
    const period = String(row.period || '').trim();
    if (!companyName || !period) return;

    const months = Math.max(1, vfcOaiNumber_(row.monthsCovered));
    const nsf = vfcOaiNumber_(row.nsfCount);
    map[vfcOaiHistoryKey_(companyName, period)] = {
      companyName: companyName,
      period: period,
      statementCount: vfcOaiNumber_(row.statementCount),
      monthsCovered: months,
      totalDeposits: vfcOaiNumber_(row.totalDeposits),
      averageMonthlyDeposits: vfcOaiNumber_(row.averageMonthlyDeposits),
      totalWithdrawals: vfcOaiNumber_(row.totalWithdrawals),
      depositWithdrawalRatio: vfcOaiNumber_(row.depositWithdrawalRatio),
      nsfCount: nsf,
      nsfPerMonth: nsf / months,
      negativeBalanceFlag: vfcOaiFlag_(row.negativeBalanceFlag),
      mcaPaymentFlag: vfcOaiFlag_(row.mcaPaymentFlag),
      summaryText: String(row.summaryText || '')
    };
  });

  return map;
}

function vfcOaiBuildHistoricalFeatures_(companyName, period, historicalIndex) {
  const key = vfcOaiHistoryKey_(companyName, period);
  if (historicalIndex && historicalIndex[key]) {
    return historicalIndex[key];
  }

  // Safe sheet-only fallback for older records that predate Structured Features.
  // Never invoke the live banking verifier or reopen historical PDFs here.
  if (typeof buildFeaturesForCase_ === 'function') {
    return buildFeaturesForCase_(companyName, period);
  }
  return null;
}

function vfcOaiHistoryKey_(companyName, period) {
  return String(companyName || '').trim().toLowerCase() + '|' +
    String(period || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
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
    const key = [
      row.companyName,row.period,row.lenderName,row.decision,row.approvedAmount
    ].join('|').toLowerCase();
    if (!row.companyName || !row.lenderName || !row.decision || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function vfcOaiValidateCurrent_(features) {
  const validation = vfcOaiValidateHistorical_(features);
  if (!validation.valid) {
    throw new Error('Current banking features failed validation: ' + validation.reason + '.');
  }
}

function vfcOaiValidateHistorical_(features) {
  if (!features || !vfcOaiNumber_(features.statementCount)) {
    return { valid:false, reason:'No statement features' };
  }
  const deposits = vfcOaiNumber_(features.averageMonthlyDeposits);
  if (!deposits) return { valid:false, reason:'Average monthly deposits are missing' };
  if (deposits > VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_AVERAGE_MONTHLY_DEPOSITS) {
    return { valid:false, reason:'Average monthly deposits are unreasonable' };
  }
  const ratio = vfcOaiNumber_(features.depositWithdrawalRatio);
  if (ratio < 0 || ratio > 20) {
    return { valid:false, reason:'Deposit-withdrawal ratio is unreasonable' };
  }
  return { valid:true, reason:'' };
}

function vfcOaiCompactFeatures_(features) {
  const debtProfile = features && features.debtProfile ? features.debtProfile : {};
  return {
    averageMonthlyDeposits:vfcOaiRound_(vfcOaiNumber_(features.averageMonthlyDeposits),1),
    estimatedOperatingMonthlyDeposits:vfcOaiRound_(
      vfcOaiNumber_(features.estimatedOperatingMonthlyDeposits),1
    ),
    detectedFinancingCredits:vfcOaiRound_(vfcOaiNumber_(features.detectedFinancingCredits),1),
    existingMonthlyDebtService:vfcOaiRound_(vfcOaiNumber_(features.existingMonthlyDebtService),1),
    otherRecurringMonthlyObligations:vfcOaiRound_(
      vfcOaiNumber_(features.otherRecurringMonthlyObligations),1
    ),
    debtServiceToDepositsRatio:vfcOaiRound_(
      vfcOaiNumber_(features.debtServiceToDepositsRatio),0.0001
    ),
    activeDebtObligations:Array.isArray(debtProfile.activeDebtObligations)
      ? debtProfile.activeDebtObligations.slice(0,10)
      : [],
    otherRecurringObligations:Array.isArray(debtProfile.otherRecurringObligations)
      ? debtProfile.otherRecurringObligations.slice(0,8)
      : [],
    totalDeposits:vfcOaiRound_(vfcOaiNumber_(features.totalDeposits),1),
    totalWithdrawals:vfcOaiRound_(vfcOaiNumber_(features.totalWithdrawals),1),
    depositWithdrawalRatio:vfcOaiRound_(vfcOaiNumber_(features.depositWithdrawalRatio),0.01),
    nsfPerMonth:vfcOaiRound_(
      features.nsfPerMonth !== undefined
        ? vfcOaiNumber_(features.nsfPerMonth)
        : vfcOaiNumber_(features.nsfCount)/Math.max(1,vfcOaiNumber_(features.monthsCovered)),
      0.01
    ),
    negativeBalanceFlag:vfcOaiFlag_(features.negativeBalanceFlag),
    mcaPaymentFlag:vfcOaiFlag_(features.mcaPaymentFlag),
    overdraftFlag:vfcOaiFlag_(features.overdraftFlag),
    suspectedStacking:vfcOaiFlag_(features.suspectedStacking),
    depositTrend:vfcOaiRound_(vfcOaiNumber_(features.depositTrend),0.01),
    depositVolatility:vfcOaiRound_(vfcOaiNumber_(features.depositVolatility),0.01),
    monthsCovered:vfcOaiNumber_(features.monthsCovered),
    statementCount:vfcOaiNumber_(features.statementCount)
  };
}

function vfcOaiSimilarity_(current, historical) {
  function sim(a,b,floorScale) {
    a=vfcOaiNumber_(a);
    b=vfcOaiNumber_(b);
    const scale=Math.max(Math.abs(a),Math.abs(b),floorScale||1);
    return vfcOaiClamp_(1-Math.abs(a-b)/scale,0,1);
  }

  return vfcOaiClamp_(
    sim(current.averageMonthlyDeposits,historical.averageMonthlyDeposits)*0.45 +
    sim(current.nsfPerMonth||current.nsfCount,historical.nsfPerMonth||historical.nsfCount,5)*0.20 +
    sim(current.depositWithdrawalRatio,historical.depositWithdrawalRatio,2)*0.10 +
    (vfcOaiFlag_(current.negativeBalanceFlag)===vfcOaiFlag_(historical.negativeBalanceFlag)?1:0)*0.15 +
    (vfcOaiFlag_(current.mcaPaymentFlag)===vfcOaiFlag_(historical.mcaPaymentFlag)?1:0)*0.10,
    0,1
  );
}

function vfcOaiCallOpenAI_(instruction, promptData, model) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Apps Script Properties.');

  const schema = {
    type:'object',
    additionalProperties:false,
    properties:{
      recommended_amount:{type:'number',minimum:0},
      recommended_lender:{type:'string'},
      approval_probability:{type:'integer',minimum:0,maximum:100},
      confidence:{type:'string',enum:['Low','Moderate','High']},
      closest_cases_used:{type:'integer',minimum:1},
      reasoning:{type:'string'},
      key_strengths:{type:'array',items:{type:'string'}},
      key_risks:{type:'array',items:{type:'string'}}
    },
    required:[
      'recommended_amount','recommended_lender','approval_probability','confidence',
      'closest_cases_used','reasoning','key_strengths','key_risks'
    ]
  };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses',{
    method:'post',
    contentType:'application/json',
    headers:{Authorization:'Bearer '+apiKey},
    payload:JSON.stringify({
      model:model,
      instructions:instruction,
      input:JSON.stringify(promptData),
      text:{
        format:{
          type:'json_schema',
          name:'vfc_openai_recommendation',
          strict:true,
          schema:schema
        }
      }
    }),
    muteHttpExceptions:true
  });

  const status=response.getResponseCode();
  let body;
  try{body=JSON.parse(response.getContentText());}
  catch(e){throw new Error('OpenAI returned an unreadable response. HTTP '+status+'.');}

  if(status<200||status>=300||body.error){
    throw new Error(body&&body.error&&body.error.message
      ? body.error.message
      : 'OpenAI request failed with HTTP '+status+'.');
  }

  const outputText=vfcOaiOutputText_(body);
  if(!outputText)throw new Error('OpenAI returned no structured recommendation.');

  let parsed;
  try{parsed=JSON.parse(outputText);}
  catch(e){throw new Error('OpenAI recommendation was not valid JSON.');}
  parsed.__openAIModel=body.model||model;
  return parsed;
}

function vfcOaiApplySanityChecks_(raw,current,cases,positiveCases) {
  const rawAmount=Math.max(0,vfcOaiNumber_(raw.recommended_amount));
  const deposits=Math.max(0,vfcOaiNumber_(current.averageMonthlyDeposits));
  const highestAdjusted=Math.max.apply(null,positiveCases.map(function(row){
    return row.adjustedAmount;
  }));
  const evidenceCap=highestAdjusted>0?highestAdjusted*1.15:0;
  const depositCap=deposits>0?deposits*1.50:0;
  const caps=[evidenceCap,depositCap].filter(function(v){return v>0;});
  const sanityCap=caps.length?Math.min.apply(null,caps):VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_APPROVED_AMOUNT;
  const capped=Math.min(rawAmount,sanityCap,VFC_OPENAI_RECOMMENDATION_CONFIG.MAX_APPROVED_AMOUNT);
  const recommendedAmount=vfcOaiRound_(Math.max(0,capped),VFC_OPENAI_RECOMMENDATION_CONFIG.ROUNDING);

  const lenderNames={};
  cases.forEach(function(row){
    lenderNames[String(row.lenderName||'').trim().toLowerCase()]=row.lenderName;
  });
  const requested=String(raw.recommended_lender||'').trim();
  const lender=lenderNames[requested.toLowerCase()]||(cases[0]?cases[0].lenderName:'');

  return {
    openAIModel:raw.__openAIModel||VFC_OPENAI_RECOMMENDATION_CONFIG.DEFAULT_MODEL,
    rawOpenAIAmount:vfcOaiRound_(rawAmount,VFC_OPENAI_RECOMMENDATION_CONFIG.ROUNDING),
    recommendedAmount:recommendedAmount,
    recommendedLender:lender,
    approvalProbability:Math.round(vfcOaiClamp_(vfcOaiNumber_(raw.approval_probability),0,100)),
    confidence:['Low','Moderate','High'].indexOf(raw.confidence)>=0?raw.confidence:'Low',
    closestCasesUsed:Math.max(1,Math.min(cases.length,Math.round(vfcOaiNumber_(raw.closest_cases_used)||cases.length))),
    reasoning:String(raw.reasoning||'').trim(),
    keyStrengths:Array.isArray(raw.key_strengths)?raw.key_strengths.slice(0,6):[],
    keyRisks:Array.isArray(raw.key_risks)?raw.key_risks.slice(0,6):[],
    sanityCapApplied:recommendedAmount<vfcOaiRound_(rawAmount,VFC_OPENAI_RECOMMENDATION_CONFIG.ROUNDING)
  };
}

function vfcOaiOutputText_(body) {
  if(body&&typeof body.output_text==='string'&&body.output_text)return body.output_text;
  const output=body&&Array.isArray(body.output)?body.output:[];
  for(let i=0;i<output.length;i++){
    const content=Array.isArray(output[i].content)?output[i].content:[];
    for(let j=0;j<content.length;j++){
      if(content[j]&&typeof content[j].text==='string'&&content[j].text)return content[j].text;
    }
  }
  return '';
}

function vfcOaiModel_() {
  const props=PropertiesService.getScriptProperties();
  const configured=props.getProperty('OPENAI_RECOMMENDATION_MODEL');
  const existing=typeof VFC_CONFIG!=='undefined'&&VFC_CONFIG.OPENAI_MODEL
    ? VFC_CONFIG.OPENAI_MODEL
    : '';
  return configured||existing||VFC_OPENAI_RECOMMENDATION_CONFIG.DEFAULT_MODEL;
}

function vfcOaiFingerprint_(value) {
  const text=JSON.stringify(value);
  const bytes=Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    text,
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(b){
    const n=(b+256)%256;
    return ('0'+n.toString(16)).slice(-2);
  }).join('').slice(0,40);
}

function vfcOaiReadCache_(fingerprint) {
  const raw=PropertiesService.getScriptProperties().getProperty(
    VFC_OPENAI_RECOMMENDATION_CONFIG.CACHE_PREFIX+fingerprint
  );
  if(!raw)return null;
  try{return JSON.parse(raw);}
  catch(e){return null;}
}

function vfcOaiWriteCache_(fingerprint,result) {
  const raw=JSON.stringify(result);
  if(raw.length>8500)return;
  PropertiesService.getScriptProperties().setProperty(
    VFC_OPENAI_RECOMMENDATION_CONFIG.CACHE_PREFIX+fingerprint,
    raw
  );
}

function vfcOaiResolvePeriod_(companyName,requestedPeriod) {
  if(requestedPeriod)return requestedPeriod;
  if(typeof resolveLatestAssessmentPeriod_==='function'){
    return resolveLatestAssessmentPeriod_(companyName,requestedPeriod);
  }
  const rows=getSheetObjects_('Structured Features').filter(function(row){
    return vfcOaiSame_(row.companyName,companyName);
  });
  if(!rows.length)throw new Error('No Structured Features record was found for this company.');
  return String(rows[rows.length-1].period||'').trim();
}

function vfcOaiNormalizeRequest_(companyOrRequest,requestedPeriod) {
  let companyName='';
  let period=requestedPeriod||'';
  if(companyOrRequest&&typeof companyOrRequest==='object'){
    companyName=companyOrRequest.companyName||companyOrRequest.company||'';
    period=companyOrRequest.period||companyOrRequest.detectedPeriod||period;
  }else{
    companyName=companyOrRequest||'';
  }
  companyName=String(companyName||'').trim();
  period=String(period||'').trim();
  if(!companyName)throw new Error('Company name is required.');
  return{companyName:companyName,period:period};
}

function vfcOaiDecision_(value) {
  const text=String(value||'').trim().toLowerCase();
  if(text.indexOf('condition')>=0)return'Conditional';
  if(text.indexOf('approv')>=0)return'Approved';
  if(text.indexOf('declin')>=0||text.indexOf('reject')>=0)return'Declined';
  return'';
}
function vfcOaiNumber_(value) {
  if(typeof value==='number')return isFinite(value)?value:0;
  const n=parseFloat(String(value||'').replace(/[^0-9.\-]/g,''));
  return isFinite(n)?n:0;
}
function vfcOaiFlag_(value) {
  return /^(1|true|yes|detected)$/i.test(String(value||'').trim())?1:0;
}
function vfcOaiSame_(left,right) {
  return String(left||'').trim().toLowerCase()===String(right||'').trim().toLowerCase();
}
function vfcOaiPeriodSame_(left,right) {
  function clean(v){return String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');}
  return clean(left)===clean(right);
}
function vfcOaiClamp_(value,minimum,maximum) {
  return Math.max(minimum,Math.min(maximum,value));
}
function vfcOaiRound_(value,step) {
  const number=vfcOaiNumber_(value);
  const increment=vfcOaiNumber_(step)||1;
  return Math.round(number/increment)*increment;
}
