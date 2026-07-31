const VFC_PATTERN_CONFIG = {
  MODEL_VERSION: 'VFC-PATTERN-LEARNER-1.0',
  MIN_TRAINING_CASES: 12,
  MIN_APPROVALS: 6,
  MAX_NEIGHBOURS: 15,
  ROUNDING: 500,
  PROPERTY_KEY: 'VFC_PATTERN_MODEL_JSON'
};

const VFC_PATTERN_FEATURES = [
  {key:'averageMonthlyDeposits', type:'numeric', defaultWeight:0.28},
  {key:'depositWithdrawalRatio', type:'numeric', scale:2, defaultWeight:0.12},
  {key:'nsfPerMonth', type:'numeric', scale:2, defaultWeight:0.13},
  {key:'depositVolatility', type:'numeric', scale:1, defaultWeight:0.10},
  {key:'depositTrend', type:'numeric', scale:0.5, defaultWeight:0.08},
  {key:'averageClosingBalance', type:'numeric', defaultWeight:0.08},
  {key:'negativeBalanceFlag', type:'binary', defaultWeight:0.07},
  {key:'mcaPaymentFlag', type:'binary', defaultWeight:0.06},
  {key:'suspectedStacking', type:'binary', defaultWeight:0.04},
  {key:'monthsCovered', type:'numeric', scale:6, defaultWeight:0.04}
];

function ensurePatternModelFresh_() {
  const outcomes = collectHistoricalOutcomes_();
  const usableCount = outcomes.filter(function(r) {
    return r.companyName && r.period && r.lenderName && normalizeDecision_(r.decision);
  }).length;
  const current = getPatternModel_();
  if (!current || current.trainingCases !== usableCount) {
    return trainPatternModel();
  }
  return current;
}

function trainPatternModel() {
  setupVFC();
  const outcomes = collectHistoricalOutcomes_();
  const rows = [];

  outcomes.forEach(function(outcome) {
    const decision = normalizeDecision_(outcome.decision);
    if (!outcome.companyName || !outcome.period || !decision) return;
    const features = buildPowerFeatures_(outcome.companyName, outcome.period);
    if (!features || !features.statementCount || !features.averageMonthlyDeposits) return;
    rows.push({
      companyName: outcome.companyName,
      period: outcome.period,
      lenderName: outcome.lenderName || '',
      decision: decision,
      approved: decision === 'Approved' || decision === 'Conditional',
      approvedAmount: Math.max(0, toNumber_(outcome.approvedAmount)),
      features: features
    });
  });

  const approvals = rows.filter(function(r) { return r.approved && r.approvedAmount > 0; });
  const declines = rows.filter(function(r) { return !r.approved; });
  const learnedWeights = learnFeatureWeights_(approvals, declines);
  const lenderProfiles = buildLenderPatternProfiles_(rows, learnedWeights);
  const backtest = backtestPatternModel_(approvals, learnedWeights);

  const model = {
    modelVersion: VFC_PATTERN_CONFIG.MODEL_VERSION,
    trainedAt: new Date().toISOString(),
    trainingCases: rows.length,
    approvalCases: approvals.length,
    declineCases: declines.length,
    featureWeights: learnedWeights,
    lenderProfiles: lenderProfiles,
    backtest: backtest,
    active: rows.length >= VFC_PATTERN_CONFIG.MIN_TRAINING_CASES && approvals.length >= VFC_PATTERN_CONFIG.MIN_APPROVALS
  };

  PropertiesService.getScriptProperties().setProperty(VFC_PATTERN_CONFIG.PROPERTY_KEY, JSON.stringify(model));
  savePatternModel_(model);
  return model;
}

function getPatternModel_() {
  const raw = PropertiesService.getScriptProperties().getProperty(VFC_PATTERN_CONFIG.PROPERTY_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function learnFeatureWeights_(approvals, declines) {
  const raw = {};
  let total = 0;

  VFC_PATTERN_FEATURES.forEach(function(def) {
    const approvedValues = approvals.map(function(r) { return featureNumber_(r.features, def.key); });
    const declinedValues = declines.map(function(r) { return featureNumber_(r.features, def.key); });
    let signal = def.defaultWeight;

    if (approvedValues.length >= 3 && declinedValues.length >= 3) {
      const meanA = average_(approvedValues);
      const meanD = average_(declinedValues);
      const spread = Math.max(standardDeviation_(approvedValues.concat(declinedValues)), Math.abs(meanA) * 0.05, 0.01);
      const separation = Math.min(3, Math.abs(meanA - meanD) / spread);
      signal = def.defaultWeight * (0.55 + separation);
    }

    raw[def.key] = Math.max(0.01, signal);
    total += raw[def.key];
  });

  const normalized = {};
  Object.keys(raw).forEach(function(key) { normalized[key] = round4_(raw[key] / total); });
  return normalized;
}

function getLearnedPatternRecommendation_(currentFeatures) {
  const model = ensurePatternModelFresh_();
  if (!model || !model.active) {
    return {
      active:false,
      predictedAmount:0,
      confidence:'Insufficient history',
      confidenceScore:0,
      comparableCases:0,
      model:model
    };
  }

  const outcomes = collectHistoricalOutcomes_();
  const approvals = [];
  outcomes.forEach(function(outcome) {
    const decision = normalizeDecision_(outcome.decision);
    const amount = Math.max(0, toNumber_(outcome.approvedAmount));
    if ((decision !== 'Approved' && decision !== 'Conditional') || !amount) return;
    const features = buildPowerFeatures_(outcome.companyName, outcome.period);
    if (!features || !features.statementCount) return;
    approvals.push({
      companyName:outcome.companyName,
      lenderName:outcome.lenderName || '',
      amount:amount,
      similarity:learnedPatternSimilarity_(currentFeatures, features, model.featureWeights),
      deposits:toNumber_(features.averageMonthlyDeposits)
    });
  });

  approvals.sort(function(a,b) { return b.similarity - a.similarity; });
  const neighbours = approvals.slice(0, VFC_PATTERN_CONFIG.MAX_NEIGHBOURS);
  let weightedAmount = 0;
  let weight = 0;

  neighbours.forEach(function(n) {
    const depositRatio = n.deposits > 0 ? toNumber_(currentFeatures.averageMonthlyDeposits) / n.deposits : 1;
    const adjustedAmount = n.amount * clamp_(depositRatio, 0.60, 1.45);
    const w = Math.pow(Math.max(0.05, n.similarity), 2);
    weightedAmount += adjustedAmount * w;
    weight += w;
  });

  const predicted = weight ? roundToNearest_(weightedAmount / weight, VFC_PATTERN_CONFIG.ROUNDING) : 0;
  const avgSimilarity = neighbours.length ? average_(neighbours.map(function(n){return n.similarity;})) : 0;
  const sampleScore = Math.min(100, neighbours.length / 10 * 100);
  const similarityScore = Math.min(100, avgSimilarity * 100);
  const backtestScore = model.backtest && model.backtest.accuracyScore ? model.backtest.accuracyScore : 50;
  const confidenceScore = Math.round(sampleScore * 0.30 + similarityScore * 0.45 + backtestScore * 0.25);

  return {
    active:true,
    predictedAmount:predicted,
    confidenceScore:confidenceScore,
    confidence:confidenceScore >= 80 ? 'High' : confidenceScore >= 60 ? 'Moderate' : 'Low',
    comparableCases:neighbours.length,
    averageSimilarity:round2_(avgSimilarity * 100),
    closestCases:neighbours.slice(0,5),
    model:model
  };
}

function learnedPatternSimilarity_(a, b, weights) {
  let score = 0;
  VFC_PATTERN_FEATURES.forEach(function(def) {
    const w = toNumber_(weights && weights[def.key]) || def.defaultWeight;
    let similarity;
    if (def.type === 'binary') {
      similarity = featureNumber_(a, def.key) === featureNumber_(b, def.key) ? 1 : 0;
    } else {
      similarity = numericSimilarity_(featureNumber_(a, def.key), featureNumber_(b, def.key), def.scale);
    }
    score += similarity * w;
  });
  return clamp_(score, 0, 1);
}

function buildLenderPatternProfiles_(rows, weights) {
  const lenders = unique_(rows.map(function(r){return r.lenderName;}).filter(Boolean));
  const profiles = {};
  lenders.forEach(function(lender) {
    const lenderRows = rows.filter(function(r){return sameText_(r.lenderName,lender);});
    const approved = lenderRows.filter(function(r){return r.approved && r.approvedAmount > 0;});
    profiles[lender] = {
      cases:lenderRows.length,
      approvals:approved.length,
      declines:lenderRows.length-approved.length,
      approvalRate:lenderRows.length ? round2_(approved.length/lenderRows.length*100) : 0,
      medianApprovedAmount:approved.length ? median_(approved.map(function(r){return r.approvedAmount;}).sort(function(a,b){return a-b;})) : 0,
      averageMonthlyDeposits:approved.length ? round2_(average_(approved.map(function(r){return toNumber_(r.features.averageMonthlyDeposits); }))) : 0
    };
  });
  return profiles;
}

function backtestPatternModel_(approvals, weights) {
  if (approvals.length < 6) return {testedCases:0, medianAbsoluteError:0, medianPercentError:0, accuracyScore:40};
  const errors = [];
  const percentErrors = [];

  approvals.forEach(function(target, index) {
    const peers = approvals.filter(function(_, i){return i !== index;}).map(function(peer) {
      return {
        amount:peer.approvedAmount,
        deposits:toNumber_(peer.features.averageMonthlyDeposits),
        similarity:learnedPatternSimilarity_(target.features, peer.features, weights)
      };
    }).sort(function(a,b){return b.similarity-a.similarity;}).slice(0, Math.min(10, approvals.length-1));

    let sum = 0, totalWeight = 0;
    peers.forEach(function(peer) {
      const depositRatio = peer.deposits > 0 ? toNumber_(target.features.averageMonthlyDeposits)/peer.deposits : 1;
      const adjusted = peer.amount * clamp_(depositRatio,0.60,1.45);
      const w = Math.pow(Math.max(0.05,peer.similarity),2);
      sum += adjusted*w; totalWeight += w;
    });
    if (!totalWeight) return;
    const predicted = sum/totalWeight;
    const error = Math.abs(predicted-target.approvedAmount);
    errors.push(error);
    percentErrors.push(target.approvedAmount ? error/target.approvedAmount*100 : 100);
  });

  const medianError = errors.length ? median_(errors.sort(function(a,b){return a-b;})) : 0;
  const medianPercent = percentErrors.length ? median_(percentErrors.sort(function(a,b){return a-b;})) : 100;
  return {
    testedCases:errors.length,
    medianAbsoluteError:roundToNearest_(medianError,VFC_PATTERN_CONFIG.ROUNDING),
    medianPercentError:round2_(medianPercent),
    accuracyScore:clamp_(Math.round(100-medianPercent),25,95)
  };
}

function savePatternModel_(model) {
  ensureSheetSchema_('AI Pattern Models', [
    'Model Version','Trained At','Training Cases','Approval Cases','Decline Cases','Active',
    'Feature Weights','Lender Profiles','Backtest Cases','Median Absolute Error','Median Percent Error','Accuracy Score'
  ]);
  appendRow_('AI Pattern Models', [
    model.modelVersion,new Date(model.trainedAt),model.trainingCases,model.approvalCases,model.declineCases,model.active,
    JSON.stringify(model.featureWeights),JSON.stringify(model.lenderProfiles),
    model.backtest.testedCases,model.backtest.medianAbsoluteError,model.backtest.medianPercentError,model.backtest.accuracyScore
  ]);
}

function featureNumber_(features, key) { return toNumber_((features || {})[key]); }
function round4_(n) { return Math.round(toNumber_(n) * 10000) / 10000; }
