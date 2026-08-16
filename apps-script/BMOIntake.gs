const VFC_BMO = {
  VERSION:'VFC-BMO-INTAKE-2.1-DETERMINISTIC',
  FUNDING_MIN:5000,
  LOOKBACK_DAYS:75,
  AMOUNT_PCT:.05,
  AMOUNT_DOLLARS:3
};

// BMO only. RBC/Other continue to use uploadStatementBatch() in Code.gs unchanged.
function uploadStatementBatchBMO(companyName,files){
  if(!companyName)throw new Error('Company name is required.');
  if(!files||!files.length)throw new Error('Upload at least one PDF.');
  const company=getOrCreateCompany_(companyName),folder=DriveApp.getFolderById(company.folderId),temp=getOrCreateSubFolder_(folder,'_TEMP_PROCESSING'),staged=[];
  files.forEach(function(file){
    const name=file.name||'statement.pdf',blob=Utilities.newBlob(Utilities.base64Decode(file.base64),'application/pdf',name.toLowerCase().endsWith('.pdf')?name:name+'.pdf'),f=temp.createFile(blob);
    staged.push({uploadId:Utilities.getUuid(),fileName:name,fileId:f.getId(),fileUrl:f.getUrl(),text:extractTextFromPdf_(f.getId())});
  });
  const summaries=callOpenAIJsonBatch_(staged.map(function(x){return bmoPrompt_(x.text,companyName,x.fileName);}));
  if(summaries.length!==staged.length)throw new Error('BMO statement reader returned an incomplete batch.');
  const starts=[],ends=[];
  const processed=staged.map(function(x,i){
    let s=bmoLockFacts_(summaries[i]||{},x.text,x.fileName);s.bank_name='BMO';s.nsf_count=bmoNsfCount_(x.text);
    s.document_type=String(s.document_type||'BANK_STATEMENT').trim().toUpperCase().replace(/\s+/g,'_');
    if(s.document_type==='BANK_STATEMENT'&&!Array.isArray(s.banking_transactions))s.banking_transactions=[];
    const sd=parseDateSafe_(s.statement_start_date),ed=parseDateSafe_(s.statement_end_date);if(sd)starts.push(sd);if(ed)ends.push(ed);
    return{uploadId:x.uploadId,fileName:x.fileName,fileId:x.fileId,fileUrl:x.fileUrl,text:x.text,summary:s,records:s.document_type==='BANK_STATEMENT'?bmoRecords_(x.text,s.statement_end_date,i):[]};
  });
  if(!starts.length||!ends.length)throw new Error('BMO statement dates could not be verified from the uploaded statements.');
  bmoApplyLedger_(processed);
  processed.forEach(function(x){if(x.summary.document_type==='BANK_STATEMENT')x.summary.possible_mca_or_loan_payments=bmoPayload_(x.summary,x.fileName);});
  const period=buildDetectedPeriod_(starts,ends),periodFolder=getOrCreateSubFolder_(folder,period.label),uploadRows=[],pdfRows=[],batchInput=[],now=new Date();
  processed.forEach(function(x){
    const f=DriveApp.getFileById(x.fileId);periodFolder.addFile(f);temp.removeFile(f);
    uploadRows.push([x.uploadId,company.companyId,companyName,period.label,x.fileName,x.fileId,x.fileUrl,x.summary.document_type==='BANK_STATEMENT'?'READ':'REVIEW_REQUIRED',now]);
    pdfRows.push([x.uploadId,companyName,period.label,x.fileName,x.summary.document_type||'','BMO',x.summary.account_holder||'',x.summary.statement_start_date||'',x.summary.statement_end_date||'',x.summary.opening_balance||'',x.summary.closing_balance||'',x.summary.total_deposits||'',x.summary.total_withdrawals||'',x.summary.nsf_count||'',x.summary.negative_balance_detected||'',x.summary.possible_mca_or_loan_payments||'',x.summary.summary||'',x.summary.risks||'',x.summary.missing_info||'',now]);
    batchInput.push({fileName:x.fileName,summary:x.summary});
  });
  appendRows_('Uploads',uploadRows);appendRows_('PDF Summaries',pdfRows);
  const batch=summarizeBatch_(batchInput,companyName,period.label);
  appendRow_('Batch Summaries',[Utilities.getUuid(),companyName,period.label,files.length,period.earliest||'',period.latest||'',batch.combined_summary||'',batch.key_findings||'',batch.risks||'',batch.missing_info||'',new Date()]);
  upsertStructuredFeature_(companyName,period.label);
  return{ok:true,intakeModelVersion:VFC_BMO.VERSION,bankProfile:'BMO',companyName:companyName,detectedPeriod:period.label,filesUploaded:files.length,companyFolderLink:company.folderLink,periodFolderLink:periodFolder.getUrl(),batchSummary:batch};
}

function bmoPayload_(summary,fileName){
  const raw=vfcBankCreateIntakePayload_(summary,fileName);
  if(typeof VFC_BANKING==='undefined'||!VFC_BANKING.PREFIX||String(raw).indexOf(VFC_BANKING.PREFIX)!==0)return raw;
  try{const p=JSON.parse(String(raw).slice(VFC_BANKING.PREFIX.length));p.transactionsVerified=true;p.explicitScanVerified=true;p.source='BMO_DETERMINISTIC_INTAKE';p.modelVersion=VFC_BMO.VERSION+' + '+String(VFC_BANKING.VERSION||'');return VFC_BANKING.PREFIX+JSON.stringify(p);}catch(e){return raw;}
}

function bmoPrompt_(text,companyName,fileName){return[
  'You are the VFC BMO Bank Statement Fact Reader. Return JSON only.','Company: '+companyName,'File: '+fileName,
  'This is BMO / Bank of Montreal. FACT EXTRACTION ONLY. Do not underwrite.',
  'Return fields: document_type, bank_name, account_holder, statement_start_date, statement_end_date, opening_balance, closing_balance, total_deposits, total_withdrawals, nsf_count, negative_balance_detected, banking_transactions, summary, risks, missing_info.',
  'banking_transactions: {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
  'BMO HEADER: Total amounts credited = deposits; Total amounts debited = withdrawals.',
  'BMO TABLE: Amounts debited from your account = DEBIT; Amounts credited to your account = CREDIT.',
  'Extract financing/PAD/MCA/loan, equipment finance/lease, tax/government, insurance/premium finance and credit-card payments. Preserve BMO Pre-Authorized Payment descriptions exactly.',
  'Returned/NSF reversals are not financing proceeds. Do not duplicate rows. Use YYYY-MM-DD.','Document text:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
].join('\n');}

function bmoLockFacts_(summary,text,fileName){
  const f=bmoFacts_(text);if(!f.ok)throw new Error('BMO printed summary totals could not be reconciled for '+(fileName||'statement')+'. The file was not accepted rather than guessing the totals.');
  summary=summary||{};if(f.start)summary.statement_start_date=f.start;if(f.end)summary.statement_end_date=f.end;summary.opening_balance=f.opening;summary.closing_balance=f.closing;summary.total_deposits=f.credits;summary.total_withdrawals=f.debits;return summary;
}
function bmoFacts_(text){
  const src=String(text||'').replace(/\u00a0/g,' '),out={ok:false,start:'',end:'',opening:null,closing:null,debits:null,credits:null};
  const em=src.match(/For\s+the\s+period\s+ending\s+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i);if(em)out.end=vfcPrintedIsoDate_(em[1]);
  const om=src.match(/\b([A-Za-z]{3})\s+(\d{1,2})\s+Opening\s+balance\b/i);if(om&&out.end)out.start=bmoDate_(om[1],om[2],out.end);
  const sm=src.match(/Summary\s+of\s+account([\s\S]{0,3000}?)Transaction\s+details/i);if(!sm)return out;
  const nums=(sm[1].match(/-?\s*\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}/g)||[]).map(vfcPrintedMoney_).filter(function(x){return x!==null;});
  for(let i=0;i<=nums.length-4;i++){const o=nums[i],d=Math.abs(nums[i+1]),c=Math.abs(nums[i+2]),cl=nums[i+3];if(Math.abs((o+c-d)-cl)<=5){out.opening=o;out.debits=d;out.credits=c;out.closing=cl;out.ok=true;}}
  return out;
}

function bmoRecords_(text,endIso,fileIndex){
  const lines=String(text||'').replace(/\u00a0/g,' ').split(/\r?\n/),out=[];let cur=null;
  function flush(){if(!cur)return;const r=bmoRecord_(cur,endIso,fileIndex);if(r)out.push(r);cur=null;}
  lines.forEach(function(raw){const line=String(raw||'').replace(/\s+/g,' ').trim();if(!line)return;let m=line.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(.*)$/),reverse=false;if(!m){m=line.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(.*)$/);reverse=!!m;}if(m){flush();cur=reverse?{month:m[2],day:m[1],body:m[3]||''}:{month:m[1],day:m[2],body:m[3]||''};return;}if(cur&&!bmoNoise_(line))cur.body+=' '+line;});flush();return out;
}
function bmoRecord_(row,endIso,fileIndex){
  const body=String(row.body||'').replace(/\s+/g,' ').trim();if(!body||/^Opening balance\b/i.test(body))return null;let type='';
  if(/^Pre-Authorized Payment(?: No Fee)?,/i.test(body))type='PAD';else if(/^Direct Deposit,/i.test(body))type='CREDIT';else if(/^Cheque Returned NSF\b/i.test(body)||/^Returned Item Payment Stopped\b/i.test(body))type='RETURN';else return null;
  const ms=body.match(/-?\s*\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}/g)||[];if(!ms.length)return null;const amount=Math.abs(vfcPrintedMoney_(ms[0])||0);if(!(amount>0))return null;
  const printed=body.slice(0,body.indexOf(ms[0])).replace(/\s+/g,' ').trim().replace(/[\s,]+$/,''),payee=bmoPayee_(printed),date=bmoDate_(row.month,row.day,endIso);if(!date)return null;
  return{fileIndex:Number(fileIndex)||0,date:date,type:type,amount:Math.round(amount*100)/100,payee:payee,raw:body,key:bmoKey_(payee||printed)};
}
function bmoNoise_(s){return/^(Transaction details|Amounts debited|Amounts credited|Date Description|Business Account|Business Banking|continued|Page \d+|Your branch|Your Branch|For questions|Direct Banking|www\.|Your Plan|Summary of account|Opening amounts|Closing balance|Account balance)/i.test(String(s||''));}
function bmoPayee_(s){return String(s||'').replace(/^Pre-Authorized Payment(?: No Fee)?,\s*/i,'').replace(/^Direct Deposit,\s*/i,'').replace(/^Cheque Returned NSF\b\s*/i,'').replace(/^Returned Item Payment Stopped,?\s*/i,'').replace(/\s+/g,' ').trim();}

function bmoApplyLedger_(processed){
  const all=[];(processed||[]).forEach(function(x,i){(x.records||[]).forEach(function(r){r.fileIndex=i;all.push(r);});});
  const pads=all.filter(function(r){return r.type==='PAD';}),credits=all.filter(function(r){return r.type==='CREDIT';}),map={};
  pads.forEach(function(r){if(!r.key)return;if(!map[r.key])map[r.key]={key:r.key,items:[],names:[]};map[r.key].items.push(r);if(r.payee&&map[r.key].names.indexOf(r.payee)<0)map[r.key].names.push(r.payee);});
  const debts=[];Object.keys(map).forEach(function(k){const g=map[k];if(!bmoLender_(g,credits))return;g.current=bmoCurrentAmount_(g.items);if(!(g.current>0))return;g.clusters=bmoAcceptedClusters_(g.items,g.current);debts.push(g);});
  const byFile={};(processed||[]).forEach(function(_,i){byFile[i]=[];});
  debts.forEach(function(g){const names=g.names.slice(),visible=names.join(' / ')||g.key,seen={};g.items.slice().sort(function(a,b){return String(a.date).localeCompare(String(b.date));}).forEach(function(r){if(!bmoInClusters_(r.amount,g.clusters))return;const k=r.fileIndex+'|'+r.date;if(seen[k])return;seen[k]=1;byFile[r.fileIndex].push({date:r.date,description:'BMO PAD | '+visible,counterparty:visible,direction:'DEBIT',amount:Math.round(g.current*100)/100,_aliases:names.slice()});});});
  const funding={};credits.forEach(function(r){if(r.amount<VFC_BMO.FUNDING_MIN)return;const g=bmoDebtMatch_(r,debts);if(!g)return;const k=r.fileIndex+'|'+r.date+'|'+g.key;if(!funding[k])funding[k]={fileIndex:r.fileIndex,date:r.date,amount:0,group:g,names:[]};funding[k].amount+=r.amount;if(r.payee&&funding[k].names.indexOf(r.payee)<0)funding[k].names.push(r.payee);});
  Object.keys(funding).forEach(function(k){const f=funding[k],names=f.names.length?f.names:f.group.names,visible=names.join(' / ')||f.group.key;byFile[f.fileIndex].push({date:f.date,description:'FINANCING ADVANCE BMO | '+visible,counterparty:visible,direction:'CREDIT',amount:Math.round(f.amount*100)/100,_aliases:names.slice()});});
  (processed||[]).forEach(function(x,i){x.summary.banking_transactions=bmoMergeAi_(x.summary.banking_transactions||[],byFile[i]||[],debts);});
}
function bmoLender_(g,credits){
  const names=(g.names||[]).join(' ').toUpperCase(),raw=(g.items||[]).map(function(x){return x.raw||'';}).join(' ').toUpperCase(),n=(g.items||[]).length;if(!n)return false;
  if(/\bICBC\b|CLOVER\s+(?:FEES|APP)|\bFISERV\b|FIRST\s+DATA|\bFD\d{6,}\b|\bHYDRO\b|\bFORTIS\b|\bSHAW\b|\bTELUS\b|\bROGERS\b|\bINTUIT\b/.test(names))return false;
  if(/LNS\/PRE/.test(raw)||/\bLOAN\b|\bMCA\b|FINANC|CAPITA|\bCREDIT\b|LENDING|FUNDING|\bFUND\b|ADVANCE|CANACAP|\b2M7\b/.test(names))return true;
  if(/BUS\/ENT/.test(names)&&n>=5&&bmoStableRatio_(g.items)>=.70)return true;
  return(credits||[]).some(function(c){return c.amount>=VFC_BMO.FUNDING_MIN&&bmoRelated_(g.key,c.key);});
}
function bmoCurrentAmount_(items){
  items=(items||[]).filter(function(x){return x&&x.amount>0&&x.date;});if(!items.length)return 0;let latest=null;items.forEach(function(x){const d=new Date(x.date+'T00:00:00');if(!isNaN(d)&&(!latest||d>latest))latest=d;});
  const recent=latest?items.filter(function(x){const d=new Date(x.date+'T00:00:00');return!isNaN(d)&&(latest-d)/86400000<=VFC_BMO.LOOKBACK_DAYS;}):items.slice(),cs=bmoClusters_(recent.length?recent:items);if(!cs.length)return 0;
  cs.sort(function(a,b){return b.items.length-a.items.length||String(b.last).localeCompare(String(a.last));});return bmoMedian_(cs[0].items.map(function(x){return x.amount;}));
}
function bmoAcceptedClusters_(items,current){const cs=bmoClusters_(items||[]),total=Math.max(1,(items||[]).length);return cs.filter(function(c){const m=bmoMedian_(c.items.map(function(x){return x.amount;})),r=current?m/current:0;return(c.items.length>=3||c.items.length/total>=.10)&&r>=.50&&r<=1.50;}).map(function(c){return bmoMedian_(c.items.map(function(x){return x.amount;}));});}
function bmoClusters_(items){const out=[];(items||[]).slice().sort(function(a,b){return a.amount-b.amount;}).forEach(function(x){let c=null;for(let i=0;i<out.length;i++){if(bmoClose_(bmoMedian_(out[i].items.map(function(y){return y.amount;})),x.amount)){c=out[i];break;}}if(!c){c={items:[],last:''};out.push(c);}c.items.push(x);if(String(x.date)>String(c.last))c.last=x.date;});return out;}
function bmoInClusters_(amount,cs){return(cs||[]).some(function(x){return bmoClose_(amount,x);});}
function bmoStableRatio_(items){const cs=bmoClusters_(items||[]);if(!cs.length||!items.length)return 0;let m=0;cs.forEach(function(c){m=Math.max(m,c.items.length);});return m/items.length;}
function bmoClose_(a,b){a=Number(a)||0;b=Number(b)||0;return Math.abs(a-b)<=Math.max(VFC_BMO.AMOUNT_DOLLARS,Math.max(Math.abs(a),Math.abs(b))*VFC_BMO.AMOUNT_PCT);}
function bmoDebtMatch_(r,groups){for(let i=0;i<(groups||[]).length;i++)if(bmoRelated_(r.key,groups[i].key))return groups[i];return null;}
function bmoMergeAi_(ai,det,groups){const keys=(groups||[]).map(function(g){return g.key;});return(Array.isArray(ai)?ai:[]).filter(function(t){const k=bmoKey_(String(t&&t.counterparty||'')+' '+String(t&&t.description||''));return!keys.some(function(g){return bmoRelated_(k,g);});}).concat(det||[]);}
function bmoKey_(v){let s=String(v||'').toUpperCase();s=s.replace(/^PRE[- ]AUTHORIZED PAYMENT(?: NO FEE)?,?\s*/i,'').replace(/^DIRECT DEPOSIT,?\s*/i,'').replace(/\b(?:MSP\/DIV|BUS\/ENT|LNS\/PRE|APY\/PAA|CLN\/PEE|RLS\/LOY|BPY\/FAC|INS\/ASS)\b/g,' ').replace(/FINANCIALSOL/g,' FINANCIAL ').replace(/\b(?:FINANCIAL|FINANCE|CAPITAL|CAPITA|CREDIT|CANADA|CA|SOLUTIONS|SOLUTION|SOL)\b/g,' ').replace(/\b(?:BMO|BANK|PAYMENT|PREAUTHORIZED|PRE|AUTHORIZED|DIRECT|DEPOSIT|BUSINESS|ENT)\b/g,' ');return s.replace(/[^A-Z0-9]+/g,'').substring(0,80);}
function bmoRelated_(a,b){a=String(a||'');b=String(b||'');return!!a&&!!b&&(a===b||(a.length>=4&&b.length>=4&&(a.indexOf(b)>=0||b.indexOf(a)>=0)));}
function bmoMedian_(a){a=(a||[]).map(Number).filter(function(x){return isFinite(x);}).sort(function(x,y){return x-y;});if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function bmoNsfCount_(text){return(String(text||'').match(/Cheque\s+Returned\s+NSF/gi)||[]).length;}
function bmoDate_(mon,day,endIso){const M={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11},m=M[String(mon||'').substring(0,3).toUpperCase()],end=parseDateSafe_(endIso);if(m===undefined||!end)return'';let y=end.getFullYear();if(m>end.getMonth())y--;return formatDate_(new Date(y,m,Number(day)));}
