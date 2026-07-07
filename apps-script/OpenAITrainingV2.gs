function analyzeTrainingFileUploadWithOpenAI_v2(input) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Apps Script Properties. Go to Project Settings > Script Properties and add OPENAI_API_KEY.');
  if (!input || !input.base64Data) throw new Error('Missing uploaded file data for OpenAI training parse.');

  const mimeType = input.mimeType || 'application/pdf';
  const fileName = input.fileName || 'historical-case.pdf';
  const payload = {
    model: getVfcOpenAIModel(),
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: buildTrainingFilePrompt_v2({
          fileName: fileName,
          metadata: input.metadata || {}
        })
      }, {
        type: 'input_file',
        filename: fileName,
        file_data: 'data:' + mimeType + ';base64,' + input.base64Data,
        detail: 'high'
      }]
    }],
    temperature: 0
  };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const responseText = response.getContentText();
  let body;
  try {
    body = JSON.parse(responseText);
  } catch (error) {
    throw new Error('OpenAI returned a non-JSON response: ' + responseText);
  }

  if (status < 200 || status >= 300) {
    throw new Error('OpenAI file parse failed (' + status + '): ' + responseText);
  }

  const text = extractResponseText(body);
  try {
    return JSON.parse(stripCodeFences(text));
  } catch (error) {
    throw new Error('OpenAI did not return valid JSON. Raw response: ' + text);
  }
}

function getVfcOpenAIModel() {
  return PropertiesService.getScriptProperties().getProperty('OPENAI_MODEL') || 'gpt-4.1';
}

function buildTrainingFilePrompt_v2(input) {
  input = input || {};
  const metadata = input.metadata || {};
  return [
    'You are extracting a historical MCA underwriting case for Vancouver Finance Company Inc.',
    'Read the uploaded file carefully. It may be a bank statement, lender approval, lender decline, email, or underwriting notes.',
    'Your job is to extract the business/client names and underwriting data from the actual uploaded file.',
    'Use admin-entered metadata only as a fallback when the uploaded file does not show the value.',
    'Do not invent missing values. Use 0, unknown, or an empty string when not found.',
    'Return valid JSON only. No markdown. No commentary.',
    '',
    'Required JSON schema:',
    '{',
    '  "case_id": "string",',
    '  "business_name": "string",',
    '  "owner_name": "string",',
    '  "lender_name": "Journey Capital|Merchant Growth|iCapital|Canacap Funding|Sheaves Capital|VFC Internal|unknown",',
    '  "decision": "Approved|Declined|Unknown",',
    '  "funded": "Yes|No",',
    '  "approved_amount": number,',
    '  "requested_amount": number,',
    '  "industry": "string",',
    '  "time_in_business": "string",',
    '  "credit_score": number,',
    '  "average_monthly_deposits": number,',
    '  "average_monthly_withdrawals": number,',
    '  "total_deposits": number,',
    '  "total_withdrawals": number,',
    '  "statement_months_reviewed": number,',
    '  "nsf_count": number,',
    '  "negative_days": number,',
    '  "existing_mca_payments": number,',
    '  "average_daily_balance": number,',
    '  "lowest_balance": number,',
    '  "revenue_trend": "increasing|stable|declining|unknown",',
    '  "reason_approved": "string",',
    '  "reason_declined": "string",',
    '  "conditions": ["string"],',
    '  "decision_date": "YYYY-MM-DD or empty string",',
    '  "notes": "string"',
    '}',
    '',
    'Admin fallback metadata:',
    'File name: ' + (input.fileName || 'unknown'),
    'Lender: ' + (metadata.lenderName || 'unknown'),
    'Decision: ' + (metadata.decision || 'unknown'),
    'Approved amount: ' + (metadata.approvedAmount || 'unknown'),
    'Requested amount: ' + (metadata.requestedAmount || 'unknown'),
    'Industry: ' + (metadata.industry || 'unknown'),
    'Notes: ' + (metadata.reasonApproved || metadata.reasonDeclined || metadata.conditions || '')
  ].join('\n');
}

function testOpenAITrainingParserV2WithTextOnly() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Apps Script Properties.');
  const payload = {
    model: getVfcOpenAIModel(),
    input: buildTrainingFilePrompt_v2({
      fileName: 'sample-case.txt',
      metadata: {
        lenderName: 'Journey Capital',
        decision: 'Approved',
        approvedAmount: '50000',
        industry: 'Restaurant',
        reasonApproved: 'Business ABC Pizza Ltd owned by John Smith was approved with stable deposits.'
      }
    }),
    temperature: 0
  };
  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const result = {
    ok: response.getResponseCode() >= 200 && response.getResponseCode() < 300,
    status: response.getResponseCode(),
    body: response.getContentText()
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
