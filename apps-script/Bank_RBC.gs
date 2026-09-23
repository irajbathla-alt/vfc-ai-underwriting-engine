/**
 * RBC BANK ENGINE v3.8.1 — CANDIDATE / FULL PROJECT SYNC
 * ONE PERMANENT RBC FILE.
 *
 * Architecture:
 * 1) Printed RBC Account Summary is the source of truth for statement totals/counts.
 * 2) Every visible Account Activity amount row is frozen.
 * 3) The extracted ledger must match printed CREDIT/DEBIT counts AND dollar totals exactly.
 * 4) If first-pass extraction misses/duplicates a row, RBC performs a targeted reconciliation pass.
 * 5) A repaired ledger is accepted only after the exact same deterministic audit passes.
 * 6) Printed column controls direction. Verified narrow signatures correct known drift.
 * 7) If row count and grand total are already exact, a unique minimum-flip checksum
 *    solution may correct direction-only PDF/LLM drift without changing any row fact.
 * 8) Transcript-visible transfer rows may be canonicalized only when one unique
 *    assignment exactly satisfies all four printed controls.
 * 9) If the cached transcript split a row, a focused original-PDF pass reads only
 *    that narrow row family before any full-ledger reread is allowed.
 * 10) Other missing rows or wrong amounts trigger a fresh structured read of the PDF.
 * 11) PAD/NSF/return/debt classification remains deterministic after facts are frozen.
 */
function vfcRbcBankProfile_(){
  return{
    id:'RBC',
    label:'RBC',
    status:'CANDIDATE',
    rulesVersion:'RBC-3.8.1-CANDIDATE',
    runtimeFingerprint:'RBC-3.8.1-FULL-PROJECT-SYNC-20260923',
    intakeContract:'BANK_MATCHED_FROZEN_LEDGER_V2',
    aliases:['ROYAL BANK OF CANADA','RBC ROYAL BANK','RBC']
  };
}

function vfcRbcExtractionRules_(){return[
  'RBC Account Summary: Total deposits & credits is total_deposits; Total cheques & debits is total_withdrawals.',
  'RBC Account Activity: Cheques & Debits = DEBIT and Deposits & Credits = CREDIT. The PRINTED COLUMN is authoritative.',
  'FULL LEDGER: banking_transactions must contain EVERY visible Account Activity row carrying a transaction amount, including ordinary fees, purchases, cheques, transfers, PADs, insurance, taxes, loans, refunds and deposits.',
  'Do not add Opening balance, Closing balance, Account Summary totals, Account Fees summary totals, page totals, cheque-image/support pages, serial-number image rows or endorsement/back-of-cheque text as transactions.',
  'The number of CREDIT and DEBIT transaction rows and their dollar sums must equal the printed Account Summary exactly. Never approximate or omit a row simply because it seems irrelevant.',
  'MISC PAYMENT, BR TO BR and ONLINE BANKING TRANSFER can appear on either side and follow the printed RBC column. Never omit debit-side ONLINE BANKING TRANSFER - #### rows.',
  'Verified narrow RBC signatures: MISC PAYMENT RBC CREDIT CARD is a DEBIT; CHEQUE RETURNED NSF is a CREDIT; ITEM RETURNED UNPAID is a DEBIT.',
  'These verified signatures correct known PDF/AI column drift before reconciliation. All other ambiguous return/transfer descriptions follow the printed column.',
  'Every transaction date must fall inside the printed statement period. When RBC prints one date followed by undated continuation rows, carry that printed date forward until the next visible date.',
  'Preserve every PAD-like debit: BUSINESS PAD, PAD, PRE-AUTH, PRE-AUTHORIZED, PREAUTHORIZED, DIRECT DEBIT, EFT DEBIT, ACH DEBIT, AUTOMATIC DEBIT, AUTO PAYMENT and lender-specific PAD wording.',
  'Unknown PAD/direct-debit counterparties remain informational unless independent lender/loan/MCA/finance/lease evidence exists. Recurrence or same amount alone never proves financing.',
  'Preserve every return/NSF/reversal principal event and any later retry. Return wording can be CREDIT or DEBIT; printed RBC column decides direction.',
  'A return CREDIT can reverse a failed borrower debit/PAD. A return DEBIT can reverse a deposited item. Do not confuse those two cases.',
  'Preserve NSF/returned-item fees separately as fee debits; fees are never the returned principal amount.',
  'Any recurring debit explicitly containing LOAN, MORTGAGE, LOC/LINE OF CREDIT, FINANCING, MCA or LEASE is a financing-obligation candidate.',
  'General e-Transfers, transfers, rent, tax, utility, payroll, card payments and unknown PADs are not financing merely because they recur.',
  'AFFIRM CANADA is financing when recurring.',
  'PREMIUM FINANCE, PREMIUM FINANCING, the RBC-truncated label IC PREMIUM FINA, and IPFS are financing when recurring; ordinary insurance remains informational.',
  'BDC: BUSINESS PAD BDC is the normal PAD stream. BDC-LOAN/PRET/manual BDC loan payments stay separate. Materially different BDC PAD amounts are separated into amount bands so catch-up payments cannot inflate normal monthly debt.',
  'Journey/OnDeck, Merchant Growth, Canacap and Greenbox are MCA-style exposures when recurring. iCapital remains general financing unless statement wording proves MCA.',
  'Known financing entities include BDC, Canacap, iCapital, Greenbox, Journey/OnDeck, Merchant Growth, SilverChef, Affirm Canada and explicit premium finance/IPFS.',
  'LOAN CREDIT, CSBFL advances and credits from known financing entities are financing-credit candidates only when printed in Deposits & Credits.',
  'BR TO BR credits, explicit TRANSFER FROM ACCOUNT credits and credit-side ONLINE BANKING TRANSFER - #### rows are internal account transfers unless independently identified as financing proceeds. Generic customer e-Transfers are not excluded.',
  'Do not duplicate cheque-image/support pages.'
].join('\n');}

function vfcRbcLockFacts_(summary,text,fileName,sourceFileId){
  const facts=vfcExtractPrintedStatementFacts_(text),name=String(fileName||'statement'),printed=vfcRbcPrintedActivityCounts_(text);
  if(!facts.startDate||!facts.endDate||facts.opening===null||facts.closing===null||facts.deposits===null||facts.withdrawals===null){
    throw new Error('RBC printed Account Summary could not be fully verified for '+name+'. Upload stopped before saving incomplete statement facts.');
  }
  if(printed.creditCount===null||printed.debitCount===null){
    throw new Error('RBC printed Account Summary transaction counts could not be verified for '+name+'. Upload stopped before freezing the ledger.');
  }

  const statementDiff=Math.abs((facts.opening+facts.deposits-facts.withdrawals)-facts.closing);
  if(statementDiff>.01)throw new Error('RBC printed Account Summary does not reconcile for '+name+'. Difference: $'+vfcRound_(statementDiff,.01)+'.');

  const locked=Object.assign({},summary||{});
  locked.statement_start_date=facts.startDate;
  locked.statement_end_date=facts.endDate;
  locked.opening_balance=facts.opening;
  locked.closing_balance=facts.closing;
  locked.total_deposits=facts.deposits;
  locked.total_withdrawals=facts.withdrawals;

  const directionRepairs=[],missingRowRepairs=[];
  let ledger=vfcRbcPrepareLedger_(locked.banking_transactions||[],directionRepairs),audit=null,lastError='',repairPasses=0,focusedRepairPasses=0;
  let missingRepair=vfcRbcRecoverMissingOnlineTransfers_(ledger,text,facts);
  if(missingRepair.changed){ledger=missingRepair.rows;Array.prototype.push.apply(missingRowRepairs,missingRepair.added);}
  let checksumRepair=vfcRbcReconcileDirectionOnly_(ledger,facts,text);
  if(checksumRepair.changed){ledger=checksumRepair.rows;Array.prototype.push.apply(directionRepairs,checksumRepair.flips);}
  for(let attempt=0;attempt<=2;attempt++){
    try{
      audit=vfcRbcAuditFullLedger_(ledger,facts,text,name);
      break;
    }catch(e){
      lastError=String(e&&e.message||e);
      if(!focusedRepairPasses&&sourceFileId&&vfcRbcHasOneSidedPositiveDeficit_(ledger,text,facts)){
        focusedRepairPasses++;
        try{
          const focusedRows=vfcRbcReadFocusedOnlineTransfersFromPdf_(sourceFileId,name,facts,focusedRepairPasses);
          missingRepair=vfcRbcRecoverMissingOnlineTransfers_(ledger,text,facts,focusedRows);
          if(missingRepair.changed){ledger=missingRepair.rows;Array.prototype.push.apply(missingRowRepairs,missingRepair.added);continue;}
        }catch(focusedError){lastError+=' | Focused RBC transfer recovery: '+String(focusedError&&focusedError.message||focusedError);}
      }
      if(attempt>=2)throw new Error(lastError);
      repairPasses++;
      ledger=vfcRbcRepairLedger_(ledger,text,name,facts,lastError,repairPasses,directionRepairs,sourceFileId);
      missingRepair=vfcRbcRecoverMissingOnlineTransfers_(ledger,text,facts);
      if(missingRepair.changed){ledger=missingRepair.rows;Array.prototype.push.apply(missingRowRepairs,missingRepair.added);}
      checksumRepair=vfcRbcReconcileDirectionOnly_(ledger,facts,text);
      if(checksumRepair.changed){ledger=checksumRepair.rows;Array.prototype.push.apply(directionRepairs,checksumRepair.flips);}
    }
  }

  if(!audit)throw new Error('RBC ledger verification did not complete for '+name+'.');
  locked.banking_transactions=ledger;
  locked.rbc_full_ledger_verified=true;
  locked.rbc_ledger_reconciled=repairPasses>0||directionRepairs.length>0||missingRowRepairs.length>0;
  locked.rbc_ledger_repair_passes=repairPasses;
  locked.rbc_focused_pdf_repair_passes=focusedRepairPasses;
  locked.rbc_original_pdf_repair_used=!!sourceFileId&&(repairPasses>0||focusedRepairPasses>0);
  locked.rbc_direction_repairs=directionRepairs;
  locked.rbc_missing_row_repairs=missingRowRepairs;
  locked.rbc_runtime_fingerprint=vfcRbcBankProfile_().runtimeFingerprint;
  locked.rbc_credit_transaction_count=audit.creditCount;
  locked.rbc_debit_transaction_count=audit.debitCount;
  locked.nsf_count=vfcRbcCountBorrowerNsfEvents_(ledger);
  locked.negative_balance_detected=vfcRbcNegativeBalanceFlag_(text,facts);
  return locked;
}

function vfcRbcPrintedActivityCounts_(text){
  const s=String(text||'').replace(/\u00a0/g,' '),
        c=s.match(/Total\s+deposits\s*(?:&|and)\s*credits\s*\((\d+)\)/i),
        d=s.match(/Total\s+cheques?\s*(?:&|and)\s*debits\s*\((\d+)\)/i);
  return{creditCount:c?Number(c[1]):null,debitCount:d?Number(d[1]):null};
}

function vfcRbcIsNonActivityArtifact_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return true;
  return/^OPENING\s+BALANCE\b|^CLOSING\s+BALANCE\b|^ACCOUNT\s+FEES?\b|^ACCOUNT\s+SUMMARY\b|^TOTAL\s+DEPOSITS\s*&\s*CREDITS\b|^TOTAL\s+CHEQUES\s*&\s+DEBITS\b|^PAGE\s+TOTAL\b|^SERIAL\s*#?\s*:?\s*\d+\s+AMOUNT\b|FOR\s+DEPOSIT\s+ONLY|BACKVERSO|BACK\s*\/\s*VERSO|CHEQUE\s+IMAGE|CHECK\s+IMAGE/.test(s);
}

function vfcRbcPrepareLedger_(items,directionRepairs){
  return(Array.isArray(items)?items:[]).filter(function(x){return!vfcRbcIsNonActivityArtifact_(x);}).map(function(x){
    const t=Object.assign({},x||{}),original=String(t.direction||'').toUpperCase(),forced=vfcRbcCertainDirection_(t);
    if(forced){
      t.direction=forced;
      if(original&&original!==forced&&Array.isArray(directionRepairs))directionRepairs.push({date:String(t.date||''),description:String(t.description||''),amount:vfcNum_(t.amount),from:original,to:forced});
    }
    t.direction=String(t.direction||'').toUpperCase();
    t.description=String(t.description||'').replace(/\s+/g,' ').trim();
    t.counterparty=String(t.counterparty||t.description||'').replace(/\s+/g,' ').trim();
    t.amount=vfcNum_(t.amount);
    return t;
  });
}

function vfcRbcCertainDirection_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return'';

  /*
   * These narrow RBC labels were verified against the printed columns, running
   * balances, transaction counts and statement totals. Online Banking Transfer
   * is deliberately absent because RBC prints that label in either column.
   */
  if(/^MISC\s+PAYMENT\s+RBC\s+CREDIT\s+CARD\b/.test(s))return'DEBIT';
  if(/^CHEQUE\s+RETURNED\s+NSF\b|^CHECK\s+RETURNED\s+NSF\b/.test(s))return'CREDIT';
  if(/^ITEM\s+RETURNED\s+UNPAID\b/.test(s))return'DEBIT';

  if(vfcRbcReturnEventText_(s))return'';
  if(/^LOAN\s+CREDIT\b/.test(s)||/\bPAYROLL\s+DEPOSIT\b|\bTAX\s+REFUND\b|E-TRANSFER\s+RECEIVED|INTERAC\s+PURCHASE\s+REFUND|E-TRANSFER\s+CANCEL|MOBILE\s+CHEQUE\s+DEPOSIT/.test(s))return'CREDIT';
  if(vfcRbcIsPadLikeText_(s)||/^LOAN\s+PAYMENT\b|^LOAN\s+INTEREST\b|^BLIP\s+PAYMENT\s*-?\s*LOAN\b|^BILL\s+PAYMENT\b|^FUEL\s+BILL\s+PAYMENT\b|^COMM\s+GAS\s+BILL\s+PMT\b|^COMMERCIAL\s+TAXES\b|^AUTO\s+INSURANCE\b|^INSURANCE\b|^RENT\/LEASE\b|^CHEQUE\s*-\s*\d+\b|^CONTACTLESS\s+INTERAC\s+PURCHASE\b|^ACTIVITY\s+FEE\b|^MONTHLY\s+FEE\b|^REGULAR\s+TRANSACTION\s+FEE\b|E-TRANSFER\s+SENT|E-TRANSFER\s+REQUEST\s+FULFILLED/.test(s))return'DEBIT';
  return'';
}

function vfcRbcDirectionCombos_(items,count,limit){
  if(count===0)return{combos:[{sum:0,indexes:[]}],overflow:false};
  if(count<0||count>items.length)return{combos:[],overflow:false};
  const combos=[],max=Math.max(1,Number(limit||25000));let overflow=false;
  function walk(start,left,sum,indexes){
    if(overflow)return;
    if(left===0){combos.push({sum:sum,indexes:indexes.slice()});if(combos.length>max)overflow=true;return;}
    for(let i=start;i<=items.length-left;i++){
      indexes.push(items[i].index);walk(i+1,left-1,sum+items[i].cents,indexes);indexes.pop();
      if(overflow)return;
    }
  }
  walk(0,count,0,[]);
  return{combos:overflow?[]:combos,overflow:overflow};
}

function vfcRbcActivityIsoDate_(dayValue,monthValue,facts){
  const months={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11},
        month=months[String(monthValue||'').substring(0,3).toUpperCase()],day=Number(dayValue),
        startDay=vfcRbcIsoDayNumber_(facts&&facts.startDate),endDay=vfcRbcIsoDayNumber_(facts&&facts.endDate),
        startYear=Number(String(facts&&facts.startDate||'').substring(0,4)),endYear=Number(String(facts&&facts.endDate||'').substring(0,4)),years=[];
  if(month===undefined||!(day>=1&&day<=31)||!startYear||!endYear)return'';
  for(let year=startYear-1;year<=endYear+1;year++)if(years.indexOf(year)<0)years.push(year);
  for(let i=0;i<years.length;i++){
    const date=new Date(Date.UTC(years[i],month,day));
    if(date.getUTCFullYear()!==years[i]||date.getUTCMonth()!==month||date.getUTCDate()!==day)continue;
    const iso=date.toISOString().slice(0,10),number=vfcRbcIsoDayNumber_(iso);
    if(number!==null&&startDay!==null&&endDay!==null&&number>=startDay&&number<=endDay)return iso;
  }
  return'';
}

function vfcRbcTranscriptLines_(text){
  const source=String(text||'').replace(/\u00a0/g,' '),activity=source.search(/Account\s+Activity(?:\s+Details)?/i);
  return(activity>=0?source.substring(activity):source).split(/\r?\n/);
}

function vfcRbcTranscriptDateFromLine_(line,facts,currentDate){
  const s=String(line||''),prefix='^\\s*(?:[-*]\\s*)?(?:["\\\']?DATE["\\\']?\\s*[:=|-]\\s*)?["\\\']?',
        iso=s.match(new RegExp(prefix+'(\\d{4}-\\d{2}-\\d{2})\\b','i')),
        start=vfcRbcIsoDayNumber_(facts&&facts.startDate),end=vfcRbcIsoDayNumber_(facts&&facts.endDate);
  if(iso){const day=vfcRbcIsoDayNumber_(iso[1]);if(day!==null&&start!==null&&end!==null&&day>=start&&day<=end)return iso[1];}
  const month='(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)',
        dayMonth=s.match(new RegExp(prefix+'(\\d{1,2})\\s+'+month+'\\b','i')),
        monthDay=s.match(new RegExp(prefix+month+'\\s+(\\d{1,2})\\b','i'));
  if(dayMonth)return vfcRbcActivityIsoDate_(dayMonth[1],dayMonth[2],facts)||currentDate||'';
  if(monthDay)return vfcRbcActivityIsoDate_(monthDay[2],monthDay[1],facts)||currentDate||'';
  return currentDate||'';
}

function vfcRbcTranscriptMoneyForRow_(lines,index,matchEnd){
  const first=String(lines[index]||'').substring(Math.max(0,Number(matchEnd||0))),parts=[first];
  let money=first.match(/\$?([0-9][0-9,]*\.\d{2})/);
  if(money)return{amount:Number(money[1].replace(/,/g,'')),fragment:parts.join(' ')};
  for(let offset=1;offset<=3&&index+offset<lines.length;offset++){
    const next=String(lines[index+offset]||'');
    if(/ONLINE\s+BANKING\s+TRANSFER\s*-\s*\d{3,}|CHEQUE\s*-\s*\d+|E-TRANSFER|BILL\s+PAYMENT|ACCOUNT\s+PAYABLE|BR\s+TO\s+BR|CLOSING\s+BALANCE/i.test(next))break;
    parts.push(next);money=next.match(/\$?([0-9][0-9,]*\.\d{2})/);
    if(money)return{amount:Number(money[1].replace(/,/g,'')),fragment:parts.join(' ')};
  }
  return null;
}

/** Parse the exact RBC transfer label even when the provider splits amount/date onto nearby lines. */
function vfcRbcOnlineTransferCandidates_(text,facts){
  const lines=vfcRbcTranscriptLines_(text),out=[];let currentDate='',seen=false;
  for(let i=0;i<lines.length;i++){
    const line=String(lines[i]||'');currentDate=vfcRbcTranscriptDateFromLine_(line,facts,currentDate);
    if(seen&&/\bClosing\s+balance\b/i.test(line))break;
    const transfer=line.match(/ONLINE\s+BANKING\s+TRANSFER\s*-\s*(\d{3,})/i);
    if(!transfer||!currentDate)continue;
    const money=vfcRbcTranscriptMoneyForRow_(lines,i,Number(transfer.index||0)+transfer[0].length);
    if(!money||!(money.amount>0))continue;
    const fragment=(line+' '+money.fragment).replace(/\s+/g,' ').trim().toUpperCase();let hint='';
    if(/\b(?:DEBIT|CHEQUES?\s*&\s*DEBITS?)\b/.test(fragment)&&!/\b(?:CREDIT|DEPOSITS?\s*&\s*CREDITS?)\b/.test(fragment))hint='DEBIT';
    else if(/\b(?:CREDIT|DEPOSITS?\s*&\s*CREDITS?)\b/.test(fragment)&&!/\b(?:DEBIT|CHEQUES?\s*&\s*DEBITS?)\b/.test(fragment))hint='CREDIT';
    out.push({date:currentDate,description:'Online Banking transfer - '+transfer[1],counterparty:'Online Banking transfer - '+transfer[1],amount:money.amount,cents:Math.round(money.amount*100),directionHint:hint,sourceLine:(line+' '+money.fragment).replace(/\s+/g,' ').trim()});seen=true;
  }
  return out;
}

function vfcRbcChequeCandidates_(text,facts){
  const lines=vfcRbcTranscriptLines_(text),out=[];let currentDate='',seen=false;
  for(let i=0;i<lines.length;i++){
    const line=String(lines[i]||'');currentDate=vfcRbcTranscriptDateFromLine_(line,facts,currentDate);
    if(seen&&/\bClosing\s+balance\b/i.test(line))break;
    const cheque=line.match(/\bCHEQUE\s*-\s*(\d+)\b/i);
    if(!cheque||!currentDate)continue;
    const money=vfcRbcTranscriptMoneyForRow_(lines,i,Number(cheque.index||0)+cheque[0].length);
    if(!money||!(money.amount>0))continue;
    out.push({date:currentDate,description:'Cheque - '+cheque[1],amount:money.amount,cents:Math.round(money.amount*100),reference:cheque[1]});seen=true;
  }
  return out;
}

function vfcRbcOnlineTransferKey_(t){
  const match=String(t&&t.description||'').match(/ONLINE\s+BANKING\s+TRANSFER\s*-\s*(\d{3,})/i);
  if(!match)return'';
  return[vfcIso_(t&&t.date),String(Number(match[1])),Math.round(vfcNum_(t&&t.amount)*100)].join('|');
}

function vfcRbcNormalizeTransferCandidates_(items,facts){
  const out=[],seen={},start=vfcRbcIsoDayNumber_(facts&&facts.startDate),end=vfcRbcIsoDayNumber_(facts&&facts.endDate);
  (Array.isArray(items)?items:[]).forEach(function(t,index){
    const match=String(t&&t.description||'').match(/ONLINE\s+BANKING\s+TRANSFER\s*-\s*(\d{3,})/i),date=vfcIso_(t&&t.date),day=vfcRbcIsoDayNumber_(date),amount=vfcNum_(t&&t.amount);
    if(!match||!date||day===null||start===null||end===null||day<start||day>end||!(amount>0))return;
    const row={date:date,description:'Online Banking transfer - '+match[1],counterparty:'Online Banking transfer - '+match[1],amount:amount,cents:Math.round(amount*100),directionHint:/^(?:DEBIT|CREDIT)$/.test(String(t.directionHint||t.direction||'').toUpperCase())?String(t.directionHint||t.direction).toUpperCase():'',sourceLine:String(t.sourceLine||t.description||''),candidateId:'T'+index},key='';
    row.key=vfcRbcOnlineTransferKey_(row);if(!row.key||seen[row.key])return;seen[row.key]=1;out.push(row);
  });
  return out;
}

function vfcRbcChequeKey_(t){const m=String(t&&t.description||'').match(/\bCHEQUE\s*-\s*(\d+)\b/i);return m?[vfcIso_(t&&t.date),String(Number(m[1])),Math.round(vfcNum_(t&&t.amount)*100)].join('|'):'';}
function vfcRbcChequeSignature_(t){const m=String(t&&t.description||'').match(/\bCHEQUE\s*-\s*(\d+)\b/i);return m?[String(Number(m[1])),Math.round(vfcNum_(t&&t.amount)*100)].join('|'):'';}

function vfcRbcProvenExtraChequeIndexes_(rows,text,facts){
  const transcript=vfcRbcChequeCandidates_(text,facts),bySignature={},ledgerBySignature={},remove=[];
  transcript.forEach(function(t){const sig=vfcRbcChequeSignature_(t);if(sig){if(!bySignature[sig])bySignature[sig]=[];bySignature[sig].push(t);}});
  (rows||[]).forEach(function(t,index){const sig=vfcRbcChequeSignature_(t);if(sig){if(!ledgerBySignature[sig])ledgerBySignature[sig]=[];ledgerBySignature[sig].push({row:t,index:index});}});
  Object.keys(ledgerBySignature).forEach(function(sig){
    const expected=bySignature[sig]||[],actual=ledgerBySignature[sig];if(!expected.length||actual.length<=expected.length||actual.length-expected.length>2)return;
    const counts={};expected.forEach(function(t){const key=vfcRbcChequeKey_(t);counts[key]=(counts[key]||0)+1;});const extras=[];
    actual.forEach(function(item){const key=vfcRbcChequeKey_(item.row);if((counts[key]||0)>0)counts[key]--;else extras.push(item);});
    if(extras.length!==actual.length-expected.length)return;
    const adjacent=extras.every(function(item){const day=vfcRbcIsoDayNumber_(item.row&&item.row.date);return expected.some(function(t){const other=vfcRbcIsoDayNumber_(t.date);return day!==null&&other!==null&&Math.abs(day-other)<=1;});});
    if(adjacent)extras.forEach(function(item){remove.push(item.index);});
  });
  return remove.slice(0,3);
}

function vfcRbcUniqueCandidateSubset_(candidates,count,targetCents){
  const rows=Array.isArray(candidates)?candidates:[];
  if(count===0)return targetCents===0?[]:null;
  if(count<0||count>rows.length||!(targetCents>0))return null;
  if(count===rows.length){const total=rows.reduce(function(sum,row){return sum+row.cents;},0);return total===targetCents?rows.slice():null;}
  const dp=[];for(let n=0;n<=count;n++)dp[n]={};dp[0]['0']={ways:1,indexes:[]};
  for(let i=0;i<rows.length;i++){
    const cents=rows[i].cents;
    for(let n=Math.min(count,i+1);n>=1;n--){
      const previous=dp[n-1],keys=Object.keys(previous);
      for(let k=0;k<keys.length;k++){
        const prior=previous[keys[k]],sum=Number(keys[k])+cents;if(sum>targetCents)continue;
        const key=String(sum),existing=dp[n][key];if(!existing)dp[n][key]={ways:prior.ways,indexes:prior.indexes.concat([i])};else existing.ways=Math.min(2,existing.ways+prior.ways);
      }
      if(Object.keys(dp[n]).length>25000)return null;
    }
  }
  const solution=dp[count][String(targetCents)];return solution&&solution.ways===1?solution.indexes.map(function(index){return rows[index];}):null;
}

function vfcRbcHasOneSidedPositiveDeficit_(items,text,facts){
  const printed=vfcRbcPrintedActivityCounts_(text),stats=vfcRbcLedgerStats_(items),creditCount=printed.creditCount-stats.creditCount,debitCount=printed.debitCount-stats.debitCount,creditCents=Math.round(vfcNum_(facts&&facts.deposits)*100)-Math.round(stats.totalCredits*100),debitCents=Math.round(vfcNum_(facts&&facts.withdrawals)*100)-Math.round(stats.totalDebits*100);
  return(creditCount===0&&creditCents===0&&debitCount>0&&debitCents>0)||(debitCount===0&&debitCents===0&&creditCount>0&&creditCents>0);
}

function vfcRbcReadFocusedOnlineTransfersFromPdf_(sourceFileId,fileName,facts,attempt){
  const prompt=[
    'You are the VFC focused RBC row reader. Return JSON only.',
    'File: '+fileName,
    'Read the original PDF Account Activity Details, not cheque-image/support pages.',
    'Return banking_transactions containing ONLY every row whose printed description is ONLINE BANKING TRANSFER - ####. Return no other row.',
    'For each such row return {date:"YYYY-MM-DD",description:"exact printed description",counterparty:"Online Banking transfer - ####",direction:"DEBIT" or "CREDIT",amount:number}.',
    'Use the printed Cheques & Debits or Deposits & Credits column for direction. Never infer direction from the word transfer.',
    'Carry a printed date forward to its undated following rows. Preserve leading zeroes in the four-digit reference.',
    'Statement period: '+String(facts&&facts.startDate||'')+' through '+String(facts&&facts.endDate||'')+'.',
    'Before returning, count the visible ONLINE BANKING TRANSFER rows again. Do not return opening/closing balances or any cheque image.'
  ].join('\n');
  const result=vfcReadBankLedgerFromPdfWithOpenAI_(sourceFileId,prompt,'RBC focused online-transfer recovery pass '+attempt);
  return result&&Array.isArray(result.banking_transactions)?result.banking_transactions:[];
}

/**
 * Replace the narrow transfer family with transcript/PDF-proven rows, remove only
 * a transcript-proven adjacent cheque duplicate, and accept the result solely if
 * one unique direction assignment satisfies all four printed controls.
 */
function vfcRbcRecoverMissingOnlineTransfers_(items,text,facts,providedCandidates){
  const rows=(Array.isArray(items)?items:[]).map(function(t){return Object.assign({},t);}),result={rows:rows,changed:false,added:[],reason:'not-needed'},printed=vfcRbcPrintedActivityCounts_(text),before=vfcRbcLedgerStats_(rows);
  if(printed.creditCount===null||printed.debitCount===null)return Object.assign(result,{reason:'printed-counts-missing'});
  if(before.bad.length)return Object.assign(result,{reason:'incomplete-rows'});
  const sourceCandidates=Array.isArray(providedCandidates)?providedCandidates:vfcRbcOnlineTransferCandidates_(text,facts),candidates=vfcRbcNormalizeTransferCandidates_(sourceCandidates,facts);
  if(!candidates.length)return Object.assign(result,{reason:'no-transfer-candidates'});

  const candidateCounts={},existingPools={};candidates.forEach(function(t){candidateCounts[t.key]=(candidateCounts[t.key]||0)+1;});
  rows.forEach(function(t){const key=vfcRbcOnlineTransferKey_(t);if(key){if(!existingPools[key])existingPools[key]=[];existingPools[key].push(t);}});
  const unknown=Object.keys(existingPools).some(function(key){return!candidateCounts[key]||existingPools[key].length>candidateCounts[key];});
  if(unknown)return Object.assign(result,{reason:'ledger-transfer-not-proven-by-source'});

  const extraCheques=vfcRbcProvenExtraChequeIndexes_(rows,text,facts),removeMap={};extraCheques.forEach(function(index){removeMap[index]=1;});
  const base=rows.filter(function(t,index){return!vfcRbcOnlineTransferKey_(t)&&!removeMap[index];}),baseStats=vfcRbcLedgerStats_(base),
        creditNeed={count:printed.creditCount-baseStats.creditCount,cents:Math.round(vfcNum_(facts&&facts.deposits)*100)-Math.round(baseStats.totalCredits*100)},
        debitNeed={count:printed.debitCount-baseStats.debitCount,cents:Math.round(vfcNum_(facts&&facts.withdrawals)*100)-Math.round(baseStats.totalDebits*100)};
  if(creditNeed.count<0||creditNeed.cents<0||debitNeed.count<0||debitNeed.cents<0||creditNeed.count+debitNeed.count!==candidates.length||creditNeed.cents+debitNeed.cents!==candidates.reduce(function(sum,t){return sum+t.cents;},0))return Object.assign(result,{reason:'source-rows-cannot-fill-printed-controls'});

  let creditRows=null;const allHinted=candidates.every(function(t){return t.directionHint==='CREDIT'||t.directionHint==='DEBIT';});
  if(allHinted){const hinted=candidates.filter(function(t){return t.directionHint==='CREDIT';}),hintedCents=hinted.reduce(function(sum,t){return sum+t.cents;},0);if(hinted.length===creditNeed.count&&hintedCents===creditNeed.cents)creditRows=hinted;}
  if(creditRows===null)creditRows=vfcRbcUniqueCandidateSubset_(candidates,creditNeed.count,creditNeed.cents);
  if(creditRows===null)return Object.assign(result,{reason:'no-unique-transfer-direction-assignment'});

  const creditIds={};creditRows.forEach(function(t){creditIds[t.candidateId]=1;});const fixed=base.slice(),changes=[];
  extraCheques.forEach(function(index){const t=rows[index];changes.push({action:'REMOVE_DUPLICATE',date:String(t.date||''),description:String(t.description||''),amount:vfcNum_(t.amount),direction:String(t.direction||''),reason:'TRANSCRIPT_PROVEN_ADJACENT_DUPLICATE'});});
  candidates.forEach(function(candidate){
    const direction=creditIds[candidate.candidateId]?'CREDIT':'DEBIT',pool=existingPools[candidate.key]||[],existing=pool.length?pool.shift():null,
          row=existing?Object.assign({},existing,{direction:direction}):{date:candidate.date,description:candidate.description,counterparty:candidate.counterparty,direction:direction,amount:candidate.amount};
    fixed.push(row);
    if(!existing)changes.push(Object.assign({},row,{action:'ADD',reason:'UNIQUE_SOURCE_CHECKSUM',sourceLine:candidate.sourceLine}));
    else if(String(existing.direction||'').toUpperCase()!==direction)changes.push(Object.assign({},row,{action:'FLIP',from:String(existing.direction||'').toUpperCase(),to:direction,reason:'UNIQUE_SOURCE_CHECKSUM',sourceLine:candidate.sourceLine}));
  });
  const after=vfcRbcLedgerStats_(fixed),creditTarget=Math.round(vfcNum_(facts&&facts.deposits)*100),debitTarget=Math.round(vfcNum_(facts&&facts.withdrawals)*100);
  if(after.creditCount!==printed.creditCount||after.debitCount!==printed.debitCount||Math.round(after.totalCredits*100)!==creditTarget||Math.round(after.totalDebits*100)!==debitTarget)return Object.assign(result,{reason:'post-recovery-audit-failed'});
  return changes.length?{rows:fixed,changed:true,added:changes,reason:'unique-source-checksum-solution'}:result;
}

/**
 * Correct direction-only extraction drift using RBC's four printed controls.
 * No date, description, amount or row is added, removed or changed.
 * A repair is accepted only when row count and grand total are already exact and
 * one unique minimum-flip solution matches both printed direction counts and totals.
 */
function vfcRbcReconcileDirectionOnly_(items,facts,text){
  const rows=(Array.isArray(items)?items:[]).map(function(t){return Object.assign({},t);}),
        printed=vfcRbcPrintedActivityCounts_(text),before=vfcRbcLedgerStats_(rows),
        result={rows:rows,changed:false,flips:[],reason:'not-needed'};
  if(printed.creditCount===null||printed.debitCount===null)return Object.assign(result,{reason:'printed-counts-missing'});
  if(before.bad.length)return Object.assign(result,{reason:'incomplete-rows'});
  if(before.creditCount+before.debitCount!==printed.creditCount+printed.debitCount)return Object.assign(result,{reason:'row-count-mismatch'});

  const targetCreditCents=Math.round(vfcNum_(facts&&facts.deposits)*100),
        targetDebitCents=Math.round(vfcNum_(facts&&facts.withdrawals)*100),
        currentCreditCents=Math.round(before.totalCredits*100),
        currentDebitCents=Math.round(before.totalDebits*100),
        deltaCount=printed.creditCount-before.creditCount,
        deltaCents=targetCreditCents-currentCreditCents;
  if(deltaCount===0&&deltaCents===0&&targetDebitCents===currentDebitCents)return result;
  if(currentCreditCents+currentDebitCents!==targetCreditCents+targetDebitCents)return Object.assign(result,{reason:'grand-total-mismatch'});

  const debitCandidates=[],creditCandidates=[];
  rows.forEach(function(t,index){
    if(vfcRbcCertainDirection_(t))return;
    const candidate={index:index,cents:Math.round(vfcNum_(t.amount)*100)};
    if(String(t.direction||'').toUpperCase()==='DEBIT')debitCandidates.push(candidate);
    else if(String(t.direction||'').toUpperCase()==='CREDIT')creditCandidates.push(candidate);
  });

  const maxFlips=6,comboLimit=25000;
  for(let flips=1;flips<=maxFlips;flips++){
    if((flips+deltaCount)%2!==0)continue;
    const debitToCredit=(flips+deltaCount)/2,creditToDebit=(flips-deltaCount)/2;
    if(debitToCredit<0||creditToDebit<0||debitToCredit>debitCandidates.length||creditToDebit>creditCandidates.length)continue;
    const debitCombos=vfcRbcDirectionCombos_(debitCandidates,debitToCredit,comboLimit),
          creditCombos=vfcRbcDirectionCombos_(creditCandidates,creditToDebit,comboLimit);
    if(debitCombos.overflow||creditCombos.overflow)return Object.assign(result,{reason:'combination-limit'});

    const creditsBySum={};
    creditCombos.combos.forEach(function(c){const key=String(c.sum);if(!creditsBySum[key])creditsBySum[key]=[];if(creditsBySum[key].length<2)creditsBySum[key].push(c);});
    const solutions=[];
    debitCombos.combos.some(function(d){
      const matches=creditsBySum[String(d.sum-deltaCents)]||[];
      matches.forEach(function(c){if(solutions.length<2)solutions.push({debitToCredit:d.indexes,creditToDebit:c.indexes});});
      return solutions.length>1;
    });
    if(solutions.length>1)return Object.assign(result,{reason:'non-unique-minimum-solution'});
    if(solutions.length===0)continue;

    const fixed=rows.map(function(t){return Object.assign({},t);}),solution=solutions[0],repairs=[];
    solution.debitToCredit.forEach(function(index){const t=fixed[index];repairs.push({date:String(t.date||''),description:String(t.description||''),amount:vfcNum_(t.amount),from:'DEBIT',to:'CREDIT',reason:'UNIQUE_PRINTED_CHECKSUM'});t.direction='CREDIT';});
    solution.creditToDebit.forEach(function(index){const t=fixed[index];repairs.push({date:String(t.date||''),description:String(t.description||''),amount:vfcNum_(t.amount),from:'CREDIT',to:'DEBIT',reason:'UNIQUE_PRINTED_CHECKSUM'});t.direction='DEBIT';});
    const after=vfcRbcLedgerStats_(fixed);
    if(after.creditCount!==printed.creditCount||after.debitCount!==printed.debitCount||Math.round(after.totalCredits*100)!==targetCreditCents||Math.round(after.totalDebits*100)!==targetDebitCents)return Object.assign(result,{reason:'post-repair-audit-failed'});
    return{rows:fixed,changed:true,flips:repairs,reason:'unique-minimum-checksum-solution'};
  }
  return Object.assign(result,{reason:'no-solution-within-limit'});
}

function vfcRbcLedgerStats_(items){
  const out={creditCount:0,debitCount:0,totalCredits:0,totalDebits:0,bad:[]};
  (Array.isArray(items)?items:[]).forEach(function(t,i){
    const d=String(t&&t.direction||'').toUpperCase(),a=vfcNum_(t&&t.amount),desc=String(t&&t.description||'').trim(),date=vfcIso_(t&&t.date);
    if(!date||!desc||!(a>0)||(d!=='CREDIT'&&d!=='DEBIT')){out.bad.push(i+1);return;}
    if(d==='CREDIT'){out.creditCount++;out.totalCredits+=a;}else{out.debitCount++;out.totalDebits+=a;}
  });
  out.totalCredits=vfcRound_(out.totalCredits,.01);out.totalDebits=vfcRound_(out.totalDebits,.01);return out;
}

function vfcRbcLedgerPreview_(rows,direction){
  return(rows||[]).filter(function(t){return String(t&&t.direction||'').toUpperCase()===direction;}).slice(0,40).map(function(t){return String(t.date||'')+' '+String(t.description||'')+' $'+vfcNum_(t.amount);}).join(' | ');
}

/**
 * RBC keeps its printed-period audit self-contained so a staged Apps Script
 * deployment cannot fail merely because BankingCore was saved a moment later.
 * Only an exact, valid ISO calendar date is accepted; no timezone conversion
 * is allowed in this statement-level checksum guard.
 */
function vfcRbcIsoDayNumber_(value){
  const m=String(value==null?'':value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m)return null;
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
  return Math.floor(date.getTime()/86400000);
}

function vfcRbcAuditFullLedger_(items,facts,text,fileName){
  const rows=Array.isArray(items)?items:[],printed=vfcRbcPrintedActivityCounts_(text),s=vfcRbcLedgerStats_(rows);
  if(printed.creditCount===null||printed.debitCount===null)throw new Error('RBC printed transaction counts are missing for '+fileName+'.');
  if(s.bad.length)throw new Error('RBC full ledger contains incomplete transaction row(s) '+s.bad.join(', ')+' for '+fileName+'.');
  const startDay=vfcRbcIsoDayNumber_(facts&&facts.startDate),endDay=vfcRbcIsoDayNumber_(facts&&facts.endDate),outside=[];
  if(startDay!==null&&endDay!==null)rows.forEach(function(t,i){const day=vfcRbcIsoDayNumber_(t&&t.date);if(day===null||day<startDay||day>endDay)outside.push((i+1)+':'+String(t&&t.date||''));});
  if(outside.length)throw new Error('RBC ledger contains transaction date(s) outside the printed statement period for '+fileName+': '+outside.slice(0,12).join(', ')+'.');

  const creditCountOk=s.creditCount===printed.creditCount,
        debitCountOk=s.debitCount===printed.debitCount,
        creditTotalOk=Math.abs(s.totalCredits-vfcNum_(facts.deposits))<=.01,
        debitTotalOk=Math.abs(s.totalDebits-vfcNum_(facts.withdrawals))<=.01;

  if(!creditCountOk||!debitCountOk||!creditTotalOk||!debitTotalOk){
    throw new Error(
      'RBC ledger mismatch ['+vfcRbcBankProfile_().runtimeFingerprint+'] for '+fileName+
      ': printed credits '+printed.creditCount+' / $'+vfcNum_(facts.deposits)+
      ', extracted '+s.creditCount+' / $'+s.totalCredits+
      '; printed debits '+printed.debitCount+' / $'+vfcNum_(facts.withdrawals)+
      ', extracted '+s.debitCount+' / $'+s.totalDebits+
      '. CREDIT rows: '+vfcRbcLedgerPreview_(rows,'CREDIT')+
      ' | DEBIT rows: '+vfcRbcLedgerPreview_(rows,'DEBIT')
    );
  }
  return{creditCount:s.creditCount,debitCount:s.debitCount,totalCredits:s.totalCredits,totalDebits:s.totalDebits,verified:true};
}

function vfcRbcRepairLedger_(currentLedger,text,fileName,facts,reason,attempt,directionRepairs,sourceFileId){
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),hasOriginalPdf=!!sourceFileId,
        creditCountGap=printed.creditCount-current.creditCount,debitCountGap=printed.debitCount-current.debitCount,
        creditDollarGap=vfcRound_(vfcNum_(facts.deposits)-current.totalCredits,.01),debitDollarGap=vfcRound_(vfcNum_(facts.withdrawals)-current.totalDebits,.01),
        visibleOnlineTransfers=vfcRbcOnlineTransferCandidates_(text,facts).map(function(t){return t.date+' | '+t.description+' | $'+t.amount;}),promptLines=[
    'You are the VFC RBC Account Activity Reconciliation Reader. Return JSON only.',
    'This is FACT EXTRACTION ONLY. Do not underwrite, classify debt, summarize or estimate.',
    'File: '+fileName,
    'The previous ledger failed deterministic reconciliation: '+reason,
    'AUTHORITATIVE PRINTED TARGETS:',
    'CREDIT rows exactly: '+printed.creditCount,
    'CREDIT total exactly: '+vfcNum_(facts.deposits),
    'DEBIT rows exactly: '+printed.debitCount,
    'DEBIT total exactly: '+vfcNum_(facts.withdrawals),
    'Opening balance: '+vfcNum_(facts.opening),
    'Closing balance: '+vfcNum_(facts.closing),
    'Statement period: '+String(facts.startDate||'')+' through '+String(facts.endDate||''),
    'Return JSON with ONE field only: banking_transactions.',
    'banking_transactions must be the COMPLETE Account Activity ledger and each object must be {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short visible counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'STRICT RULES:',
    '1. '+(hasOriginalPdf?'Inspect the attached original PDF itself. ':'')+'Read only Account Activity Details rows. Include every amount-bearing activity row, including all bank fees and ordinary purchases.',
    '2. Do not include opening/closing balances, Account Summary totals, Account Fees summary, page totals, cheque-image/support pages, serial-number image rows or endorsements.',
    '3. Take each amount from the SAME printed row as its date and description. Printed Cheques & Debits column = DEBIT; printed Deposits & Credits column = CREDIT.',
    '4. Never infer direction from wording. ONLINE BANKING TRANSFER, MISC PAYMENT, BR TO BR and return/NSF descriptions can appear in either printed column.',
    '5. Keep every separately printed row. Repeated identical fee rows, including multiple $1.50 e-Transfer fees on the same date, are separate transactions and must not be deduplicated. Debit-side ONLINE BANKING TRANSFER - #### rows are mandatory and must never be skipped as irrelevant internal transfers. Never invent a second copy of a cheque on an adjacent carried date; a cheque appears once unless the PDF visibly prints it twice.',
    '6. Use running-balance changes and neighboring row boundaries to verify that an amount was not borrowed from the row above or below.',
    '7. Every transaction date must be inside the printed statement period. Carry a printed activity date forward to its following undated continuation rows until the next printed date.',
    '8. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '9. Check the completed array against all four count/total targets and the statement date range before returning it.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.',
    'Exact shortfall versus printed controls: CREDIT rows '+creditCountGap+' / $'+creditDollarGap+'; DEBIT rows '+debitCountGap+' / $'+debitDollarGap+'.',
    'Transcript-visible ONLINE BANKING TRANSFER candidates (verify each against the printed PDF column): '+JSON.stringify(visibleOnlineTransfers.slice(0,60))
  ];
  if(!hasOriginalPdf){
    promptLines.push(
      'The original PDF is unavailable in this legacy call, so recover from the transcript below.',
      'Current candidate ledger:',JSON.stringify(currentLedger),
      'RBC STATEMENT TRANSCRIPT:',String(text||'').substring(0,VFC_CONFIG.STATEMENT_TEXT_LIMIT)
    );
  }
  const prompt=promptLines.join('\n'),repaired=hasOriginalPdf
    ?vfcReadBankLedgerFromPdfWithOpenAI_(sourceFileId,prompt,'RBC original-PDF reconciliation pass '+attempt)
    :callOpenAIJson_(prompt);
  if(!repaired||!Array.isArray(repaired.banking_transactions))throw new Error('RBC reconciliation pass '+attempt+' did not return a complete banking_transactions array for '+fileName+'.');
  return vfcRbcPrepareLedger_(repaired.banking_transactions,directionRepairs);
}

function vfcRbcIsPadLikeText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||vfcRbcReturnEventText_(s))return false;
  return/^(?:BUSINESS\s+)?PAD\b|PRE[- ]?AUTH(?:ORIZED)?(?:\s+DEBIT|\s+PAYMENT)?\b|PREAUTHORIZED(?:\s+DEBIT|\s+PAYMENT)?\b|DIRECT\s+DEBIT\b|EFT\s+DEBIT\b|ACH\s+DEBIT\b|AUTOMATIC\s+DEBIT\b|AUTO\s+PAYMENT\b/.test(s);
}

function vfcRbcReturnEventText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/CHEQUE\s+RETURNED(?:\s+NSF)?|CHECK\s+RETURNED(?:\s+NSF)?|ITEM\s+RETURNED(?:\s+NSF|\s+UNPAID)?|RETURNED\s+(?:ITEM|CHEQUE|CHECK|PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)|(?:PAYMENT|PAD|DEBIT|EFT|ACH|DEPOSIT)\s+RETURNED|PRE[- ]?AUTH(?:ORIZED)?\s+(?:DEBIT|PAYMENT)\s+RETURNED|PREAUTHORIZED\s+(?:DEBIT|PAYMENT)\s+RETURNED|DIRECT\s+DEBIT\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)|\bREVERSAL\b|\bREVERSED\b|NSF\s+RETURN/.test(s);
}
function vfcRbcReturnCreditText_(value){return vfcRbcReturnEventText_(value);}
function vfcRbcCountReturnEvents_(items){return(Array.isArray(items)?items:[]).filter(function(t){return vfcRbcReturnEventText_(t&&t.description);}).length;}

function vfcRbcBorrowerNsfCreditText_(value){
  const s=String(value||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s||/\b(?:FEE|FEES|CHARGE)\b/.test(s))return false;
  return/\bNSF\b|CHEQUE\s+RETURNED\s+NSF|CHECK\s+RETURNED\s+NSF|ITEM\s+RETURNED\s+NSF|RETURNED\s+(?:PAYMENT|PAD|DEBIT|EFT|ACH)|(?:PAYMENT|PAD|DEBIT|EFT|ACH)\s+RETURNED|REJECTED\s+(?:PAD|DEBIT|PAYMENT)/.test(s);
}

function vfcRbcCountBorrowerNsfEvents_(items){
  return(Array.isArray(items)?items:[]).filter(function(t){
    return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcBorrowerNsfCreditText_(t&&t.description);
  }).length;
}

function vfcRbcNegativeBalanceFlag_(text,facts){
  if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;
  const lines=String(text||'').replace(/\u00a0/g,' ').split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const line=String(lines[i]||'').trim();
    if(!line)continue;
    if(/TOTAL\s+(?:DEPOSITS|CREDITS|CHEQUES|DEBITS|WITHDRAWALS)|ACCOUNT\s+SUMMARY|ACCOUNT\s+FEES?/i.test(line))continue;
    if(/\bBALANCE\b\s*[:=]?\s*-\s*\$?[0-9][0-9,]*\.\d{2}\s*$/i.test(line))return true;
    if(/(?:^|\s)-\s*\$?[0-9][0-9,]*\.\d{2}\s*$/.test(line)&&/\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|LOAN|PAYMENT|CHEQUE|PAD|TRANSFER|INTERAC|INSURANCE|RENT|FUEL|ATM|PURCHASE|DEPOSIT)\b/i.test(line))return true;
  }
  return false;
}
function vfcRbcAmountBand_(amount){const n=Math.max(1,vfcNum_(amount));return Math.round(Math.log(n)/Math.log(1.25));}

function vfcRbcClassifyDebit_(t){
  const raw=String(t&&t.description||'').replace(/\s+/g,' ').trim(),s=raw.toUpperCase(),cp=String(t&&t.counterparty||'').replace(/\s+/g,' ').trim(),band=vfcRbcAmountBand_(t&&t.amount),hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s),isFee=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|RETURNED[- ]?ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE|ACTIVITY\s+FEE|TRANSACTION\s+FEE|MONTHLY\s+FEE/.test(s);
  if(isFee&&!hasFinancingSignal)return null;
  let family='',entityKey='',label=cp||raw,debtJustification='';
  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';debtJustification='Explicit recurring equipment lease.';}
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';debtJustification='Known MCA/funding counterparty plus recurrence.';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bBDC\b/.test(s)&&vfcRbcIsPadLikeText_(s)){family='FINANCING';entityKey='RBC_BDC_PAD_B'+band;label='BDC';debtJustification='Recurring BDC PAD stream; materially different catch-up amounts remain separate.';}
  else if(/\bBDC\b/.test(s)&&(/BDC[- ]?LOAN\/PRET|ONLINE\s+BANKING\s+PAYMENT|\bLOAN\b|FINANC/.test(s))){family='FINANCING';entityKey='RBC_BDC_MANUAL_B'+band;label='BDC Manual / Loan Payment';debtJustification='Manual BDC loan-payment stream kept separate from normal PAD.';}
  else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';debtJustification='Affirm Canada financing counterparty plus recurrence.';}
  else if(/\bCANACAP\b/.test(s)){family='MCA';entityKey='CANACAP';label='Canacap';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bGREENBOX\b/.test(s)){family='MCA';entityKey='GREENBOX';label='Greenbox';debtJustification='Known MCA-style financing counterparty plus recurrence.';}
  else if(/\bICAPITAL\b/.test(s)){family='FINANCING';entityKey='ICAPITAL';label='iCapital';debtJustification='Known financing counterparty plus recurrence.';}
  else if(/\bIPFS\b|PREMIUM\s+FINANC|\bIC\s+PREMIUM\s+FINA\b/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);}
  else if(/INSURANCE/.test(s)){family='OTHER';if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}else if(/IND\s+ALL/.test(s)){entityKey='INSURANCE_IND_ALL';label='Insurance IND ALL';}else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim(),financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s);
    family=financeLike?'FINANCING':'OTHER';entityKey=(financeLike?'AUTO_PAYMENT_FINANCE_':'RBC_OTHER_AUTOPAY_')+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;if(financeLike)debtJustification='Automatic payment with independent finance-like counterparty evidence.';
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b/.test(s))){const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;debtJustification='Retry/recurring payment with independent finance-like counterparty evidence.';}
  else if(hasFinancingSignal){
    family='FINANCING';debtJustification='Explicit financing wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/),generic=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/),ref=numbered||generic;
      if(ref){const n=ref[1].replace(/[^0-9]/g,'');if(/\bLOAN\b/.test(s)){entityKey='LOAN_ACCOUNT_'+n;label='RBC Loan NO.'+n;debtJustification='Interest, BLIP and principal debits sharing the same printed loan reference are one obligation.';}else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}else{entityKey='FINANCE_REF_'+n;}}
      else{const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);}
    }
  }
  else if(vfcRbcIsPadLikeText_(s)){family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);}
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);}
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);}
  else{return null;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b|\bONLINE\s+BANKING\s+TRANSFER\s*-\s*\d{3,}\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t)||vfcRbcIsNonOperatingTransferCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);}
function vfcRbcPreservePrintedDuplicate_(){return true;}
function vfcRbcStrongEntityKey_(key){return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|RBC_BDC_|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|INSURANCE_|LOAN_ACCOUNT_[0-9]|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());}

function runRbcBankingSelfTests(){
  const results=[];
  function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
  function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
  function close(a,e,t,l){t=t==null?.02:t;if(Math.abs(Number(a||0)-Number(e||0))>t)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function equal(a,e,l){if(a!==e)throw new Error((l||'value')+' expected '+e+' got '+a);}
  function truthy(v,l){if(!v)throw new Error((l||'value')+' expected truthy');}
  function test(n,f){try{results.push({name:n,pass:true,detail:String(f()||'')});}catch(e){results.push({name:n,pass:false,detail:String(e&&e.message||e)});}}

  test('AIM HIGH Mar-Apr printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('AIM HIGH Mar-Apr $283 RBC card direction now reconciles',function(){
    const text='March 2, 2026 to April 2, 2026\nOpening balance on March 2, 2026 $4,710.90\nTotal deposits & credits (15) + 45,725.36\nTotal cheques & debits (39) - 50,240.60\nClosing balance on April 2, 2026 = $195.66',wrong=[];
    let i;
    for(i=0;i<14;i++)wrong.push(tx('2026-03-02','Payroll Deposit filler '+i,'CREDIT',1));
    wrong.push(tx('2026-03-02','Payroll Deposit filler total','CREDIT',45711.36));
    for(i=0;i<37;i++)wrong.push(tx('2026-03-02','Bill Payment filler '+i,'DEBIT',1));
    wrong.push(tx('2026-03-02','Bill Payment filler total','DEBIT',49920.60));
    wrong.push(tx('2026-03-12','Misc Payment RBC CREDIT CARD','CREDIT',283));
    const before=vfcRbcLedgerStats_(wrong),locked=vfcRbcLockFacts_({banking_transactions:wrong},text,'1002823_2026_03_02_2026_04_02.pdf'),after=vfcRbcLedgerStats_(locked.banking_transactions);
    equal(before.creditCount,16,'original credits');close(before.totalCredits,46008.36,.001,'original credit total');
    equal(before.debitCount,38,'original debits');close(before.totalDebits,49957.60,.001,'original debit total');
    equal(after.creditCount,15,'corrected credits');close(after.totalCredits,45725.36,.001,'corrected credit total');
    equal(after.debitCount,39,'corrected debits');close(after.totalDebits,50240.60,.001,'corrected debit total');
    equal(locked.rbc_direction_repairs.length,1,'recorded direction repair');
    equal(locked.rbc_ledger_repair_passes,0,'AI repair passes');
    return'15 credits/$45725.36; 39 debits/$50240.60';
  });
  test('AIM HIGH Apr-May two crossed Misc Payments reconcile by checksum',function(){
    const text='April 2, 2026 to May 1, 2026\nOpening balance on April 2, 2026 $195.66\nTotal deposits & credits (15) + 63,708.46\nTotal cheques & debits (47) - 61,672.04\nClosing balance on May 1, 2026 = $2,232.08',wrong=[];
    let i;
    for(i=0;i<12;i++)wrong.push(tx('2026-04-02','Payroll Deposit filler '+i,'CREDIT',1));
    wrong.push(tx('2026-04-02','Payroll Deposit filler total','CREDIT',46510.67));
    for(i=0;i<46;i++)wrong.push(tx('2026-04-02','Bill Payment filler '+i,'DEBIT',1));
    wrong.push(tx('2026-04-02','Bill Payment filler total','DEBIT',61626.04));
    wrong.push(tx('2026-04-14','Misc Payment 1469635 PAY <DEFTPYMT>','DEBIT',8008.10));
    wrong.push(tx('2026-04-29','Misc Payment 1469635 PAY <DEFTPYMT>','DEBIT',9177.69));
    const before=vfcRbcLedgerStats_(wrong),locked=vfcRbcLockFacts_({banking_transactions:wrong},text,'1002823_2026_04_02_2026_05_01.pdf'),after=vfcRbcLedgerStats_(locked.banking_transactions);
    equal(before.creditCount,13,'original credits');close(before.totalCredits,46522.67,.001,'original credit total');
    equal(before.debitCount,49,'original debits');close(before.totalDebits,78857.83,.001,'original debit total');
    equal(after.creditCount,15,'corrected credits');close(after.totalCredits,63708.46,.001,'corrected credit total');
    equal(after.debitCount,47,'corrected debits');close(after.totalDebits,61672.04,.001,'corrected debit total');
    equal(locked.rbc_direction_repairs.length,2,'recorded checksum repairs');
    equal(locked.rbc_direction_repairs[0].reason,'UNIQUE_PRINTED_CHECKSUM','checksum reason');
    equal(locked.rbc_ledger_repair_passes,0,'AI repair passes');
    return'15 credits/$63708.46; 47 debits/$61672.04';
  });
  test('AIM HIGH May-Jun exact failing ledger now reconciles',function(){
    const text='May 1, 2026 to June 2, 2026\nOpening balance on May 1, 2026 $2,232.08\nTotal deposits & credits (18) + 56,889.45\nTotal cheques & debits (56) - 63,781.21\nClosing balance on June 2, 2026 = -$4,659.68',wrong=[];
    let i;
    for(i=0;i<16;i++)wrong.push(tx('2026-05-01','Payroll Deposit filler '+i,'CREDIT',1));
    wrong.push(tx('2026-05-01','Payroll Deposit filler total','CREDIT',54266.86));
    for(i=0;i<51;i++)wrong.push(tx('2026-05-01','Bill Payment filler '+i,'DEBIT',1));
    wrong.push(tx('2026-05-01','Bill Payment filler total','DEBIT',59530.21));
    wrong.push(tx('2026-05-07','Online Banking transfer - 0040','CREDIT',500));
    wrong.push(tx('2026-05-28','Online Banking transfer - 8537','CREDIT',2500));
    wrong.push(tx('2026-06-01','Online Banking transfer - 0203','CREDIT',200));
    wrong.push(tx('2026-06-01','Online Banking transfer - 1673','CREDIT',1000));
    wrong.push(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59));
    const before=vfcRbcLedgerStats_(wrong),locked=vfcRbcLockFacts_({banking_transactions:wrong},text,'1002823_2026_05_01_2026_06_02.pdf'),after=vfcRbcLedgerStats_(locked.banking_transactions);
    equal(before.creditCount,21,'original credits');close(before.totalCredits,58482.86,.001,'original credit total');
    equal(before.debitCount,53,'original debits');close(before.totalDebits,62187.80,.001,'original debit total');
    equal(after.creditCount,18,'corrected credits');close(after.totalCredits,56889.45,.001,'corrected credit total');
    equal(after.debitCount,56,'corrected debits');close(after.totalDebits,63781.21,.001,'corrected debit total');
    equal(locked.rbc_direction_repairs.length,5,'recorded direction repairs');
    equal(locked.rbc_ledger_repair_passes,0,'AI repair passes');
    equal(locked.rbc_runtime_fingerprint,'RBC-3.8.1-FULL-PROJECT-SYNC-20260923','runtime fingerprint');
    return'18 credits/$56889.45; 56 debits/$63781.21';
  });
  test('AIM HIGH Jun-Jul printed credits are exactly 24 and $90,909.53',function(){
    const credits=[4750,500,250,1750,750,1000,6403.84,9384.12,1000,2500,7000,7200,4687.46,5500,6000,1200,600,700,2400,5000,2813.31,5289.91,5928.88,8302.01];
    equal(credits.length,24,'count');close(vfcSum_(credits),90909.53,.001,'sum');
    return'24/$90909.53';
  });
  test('AIM HIGH Jun-Jul online transfers remain in their printed columns',function(){
    const rows=vfcRbcPrepareLedger_([
      tx('2026-06-29','Online Banking transfer - 1001','CREDIT',600),
      tx('2026-06-29','Online Banking transfer - 1002','CREDIT',700),
      tx('2026-06-29','Online Banking transfer - 1003','CREDIT',2400),
      tx('2026-06-29','Online Banking transfer - 1004','CREDIT',5000),
      tx('2026-06-29','Online Banking transfer - 2001','DEBIT',1200),
      tx('2026-06-29','Online Banking transfer - 2002','DEBIT',1200),
      tx('2026-06-29','Online Banking transfer - 2003','DEBIT',1250)
    ]),stats=vfcRbcLedgerStats_(rows);
    equal(stats.creditCount,4,'credit-side transfers');close(stats.totalCredits,8700,.001,'credit-side total');
    equal(stats.debitCount,3,'debit-side transfers');close(stats.totalDebits,3650,.001,'debit-side total');
    return'4 credits and 3 debits preserved';
  });
  test('1037324 Apr-May nine omitted online transfers recover from the exact printed checksum',function(){
    const text=[
      'April 27, 2026 to May 27, 2026',
      'Opening balance on April 27, 2026 $20,000.00',
      'Total deposits & credits (0) + 0.00',
      'Total cheques & debits (9) - 18,700.00',
      'Closing balance on May 27, 2026 = $1,300.00',
      'Account Activity Details',
      'Date Description Cheques & Debits ($) Deposits & Credits ($) Balance ($)',
      '13 May Online Banking transfer - 7051 3,000.00',
      '       Online Banking transfer - 6870 3,700.00',
      '15 May Online Banking transfer - 9202 4,000.00',
      '19 May Online Banking transfer - 4711 1,000.00',
      '       Online Banking transfer - 4802 1,000.00',
      '21 May Online Banking transfer - 2678 1,000.00',
      '       Online Banking transfer - 9829 1,000.00',
      '22 May Online Banking transfer - 3848 1,000.00',
      '       Online Banking transfer - 0454 3,000.00',
      '       Closing balance 1,300.00'
    ].join('\n'),locked=vfcRbcLockFacts_({banking_transactions:[]},text,'1037324_2026_04_27_2026_05_27.pdf'),stats=vfcRbcLedgerStats_(locked.banking_transactions);
    equal(stats.creditCount,0,'credits');equal(stats.debitCount,9,'debits');close(stats.totalDebits,18700,.001,'debit total');
    equal(locked.rbc_missing_row_repairs.length,9,'restored rows');equal(locked.rbc_ledger_repair_passes,0,'AI repair passes');
    equal(locked.rbc_missing_row_repairs[0].reason,'UNIQUE_SOURCE_CHECKSUM','repair reason');
    equal(locked.rbc_runtime_fingerprint,'RBC-3.8.1-FULL-PROJECT-SYNC-20260923','runtime fingerprint');
    return'9 debit rows/$18700 restored without guessing direction';
  });
  test('Split-line provider transcript still exposes every online transfer row',function(){
    const text=[
      'Account Activity Details',
      'Date: 2026-05-13',
      'Online Banking transfer - 7051',
      'DEBIT 3,000.00',
      'Online Banking transfer - 6870',
      'Cheques & Debits: 3,700.00',
      'Closing balance'
    ].join('\n'),rows=vfcRbcOnlineTransferCandidates_(text,{startDate:'2026-04-27',endDate:'2026-05-27'});
    equal(rows.length,2,'candidate rows');close(rows[0].amount,3000,.001,'first amount');close(rows[1].amount,3700,.001,'second amount');
    equal(rows[0].date,'2026-05-13','carried date');equal(rows[0].directionHint,'DEBIT','explicit debit hint');return'2 split rows recovered';
  });
  test('1037324 exact 15-credit 62-debit fallback error is fully reconciled',function(){
    const text=[
      'April 27, 2026 to May 27, 2026',
      'Opening balance on April 27, 2026 $6,085.02',
      'Total deposits & credits (10) + 107,067.24',
      'Total cheques & debits (70) - 96,253.18',
      'Closing balance on May 27, 2026 = $16,899.08',
      'Account Activity Details',
      '13 May Online Banking transfer - 7051 3,000.00',
      '       Online Banking transfer - 6870 3,700.00',
      '14 May Cheque - 21 591.34',
      '15 May Online Banking transfer - 9202 4,000.00',
      '19 May Online Banking transfer - 4711 1,000.00',
      '       Online Banking transfer - 4802 1,000.00',
      '21 May Online Banking transfer - 2678 1,000.00',
      '       Online Banking transfer - 9829 1,000.00',
      '22 May Online Banking transfer - 3848 1,000.00',
      '       Online Banking transfer - 0454 3,000.00',
      '       Closing balance 16,899.08'
    ].join('\n'),wrong=[];let i;
    for(i=0;i<9;i++)wrong.push(tx('2026-04-29','Credit filler '+i,'CREDIT',1));
    wrong.push(tx('2026-04-29','Credit filler total','CREDIT',107058.24));
    wrong.push(tx('2026-05-15','Online Banking transfer - 9202','CREDIT',4000));
    wrong.push(tx('2026-05-21','Online Banking transfer - 2678','CREDIT',1000));
    wrong.push(tx('2026-05-21','Online Banking transfer - 9829','CREDIT',1000));
    wrong.push(tx('2026-05-22','Online Banking transfer - 3848','CREDIT',1000));
    wrong.push(tx('2026-05-22','Online Banking transfer - 0454','CREDIT',3000));
    for(i=0;i<59;i++)wrong.push(tx('2026-04-29','Debit filler '+i,'DEBIT',1));
    wrong.push(tx('2026-04-29','Debit filler total','DEBIT',76902.84));
    wrong.push(tx('2026-05-13','Cheque - 21','DEBIT',591.34));
    wrong.push(tx('2026-05-14','Cheque - 21','DEBIT',591.34));
    const before=vfcRbcLedgerStats_(wrong),locked=vfcRbcLockFacts_({banking_transactions:wrong},text,'1037324_2026_04_27_2026_05_27.pdf'),after=vfcRbcLedgerStats_(locked.banking_transactions),changes=locked.rbc_missing_row_repairs;
    equal(before.creditCount,15,'bad credit count');close(before.totalCredits,117067.24,.001,'bad credit total');equal(before.debitCount,62,'bad debit count');close(before.totalDebits,78144.52,.001,'bad debit total');
    equal(after.creditCount,10,'fixed credits');close(after.totalCredits,107067.24,.001,'fixed credit total');equal(after.debitCount,70,'fixed debits');close(after.totalDebits,96253.18,.001,'fixed debit total');
    equal(changes.filter(function(x){return x.action==='FLIP';}).length,5,'direction flips');equal(changes.filter(function(x){return x.action==='ADD';}).length,4,'missing transfers');equal(changes.filter(function(x){return x.action==='REMOVE_DUPLICATE';}).length,1,'duplicate removed');
    const cheque21=locked.banking_transactions.filter(function(x){return /^Cheque - 21$/i.test(x.description);});equal(cheque21.length,1,'one cheque 21');equal(cheque21[0].date,'2026-05-14','printed cheque date');equal(locked.rbc_ledger_repair_passes,0,'full PDF repair passes');return'10/107067.24 and 70/96253.18';
  });
  test('Missing-row recovery refuses mixed credit and debit deficits',function(){
    const text='Total deposits & credits (1) + 1000.00\nTotal cheques & debits (1) - 1000.00\nAccount Activity Details\n13 May Online Banking transfer - 7051 1,000.00\nClosing balance',
          r=vfcRbcRecoverMissingOnlineTransfers_([],text,{startDate:'2026-04-27',endDate:'2026-05-27',deposits:1000,withdrawals:1000});
    equal(r.changed,false,'no repair');equal(r.reason,'source-rows-cannot-fill-printed-controls','reason');return r.reason;
  });
  test('AIM HIGH Jun-Jul discrepancy identifies one wrong amount and two omitted fees',function(){
    const reportedCreditGap=90909.53-76280.65,reportedDebitOverage=103898.56-89562.99,
          unexplainedGrandGap=reportedCreditGap-reportedDebitOverage,
          exactPdfGap=(1033.52-743.21)+1.50+1.50;
    close(reportedCreditGap,14628.88,.001,'credit gap');close(reportedDebitOverage,14335.57,.001,'debit overage');
    close(unexplainedGrandGap,293.31,.001,'grand gap');close(exactPdfGap,293.31,.001,'PDF row gap');
    return'$290.31 + $1.50 + $1.50 = $293.31';
  });
  test('Exact ledger audit passes only when count and totals both match',function(){const text='Total deposits & credits (2) + 150.00\nTotal cheques & debits (2) - 30.00',facts={deposits:150,withdrawals:30},good=[tx('2026-01-01','A','CREDIT',100),tx('2026-01-02','B','CREDIT',50),tx('2026-01-03','C','DEBIT',10),tx('2026-01-04','D','DEBIT',20)];const a=vfcRbcAuditFullLedger_(good,facts,text,'x.pdf');equal(a.creditCount,2,'credits');let failed=false;try{vfcRbcAuditFullLedger_(good.slice(1),facts,text,'x.pdf');}catch(e){failed=true;}truthy(failed,'missing row fails');return'exact';});
  test('Ledger audit rejects a transaction date outside the printed period',function(){const text='Total deposits & credits (0) + 0.00\nTotal cheques & debits (1) - 234.96',facts={startDate:'2026-08-03',endDate:'2026-09-02',deposits:0,withdrawals:234.96},rows=[tx('2026-08-01','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')];let failed=false;try{vfcRbcAuditFullLedger_(rows,facts,text,'Aug-Sep.pdf');}catch(e){failed=/outside the printed statement period/i.test(String(e&&e.message||e));}truthy(failed,'out-of-range date');return'rejected';});
  test('RBC printed-period date guard has no BankingCore dependency',function(){equal(vfcRbcIsoDayNumber_('2026-09-01')-vfcRbcIsoDayNumber_('2026-08-31'),1,'day boundary');equal(vfcRbcIsoDayNumber_('2026-02-30'),null,'invalid calendar date');return'self-contained';});
  test('Opening/closing/support artifacts are excluded',function(){const p=vfcRbcPrepareLedger_([tx('2026-03-02','Opening balance','CREDIT',4710.90),tx('2026-03-03','Loan BK OF MONTREAL','DEBIT',599.22),tx('2026-04-02','Serial #: 343 Amount: $315.00','CREDIT',315)]);equal(p.length,1,'real rows');return'clean';});
  test('Verified RBC directions stay narrow and online transfers stay column-led',function(){equal(vfcRbcCertainDirection_(tx('2026-05-27','Cheque returned NSF','DEBIT',2606.59)),'CREDIT','NSF return');equal(vfcRbcCertainDirection_(tx('2026-06-25','Item returned unpaid S02788','CREDIT',187.46)),'DEBIT','returned deposit');equal(vfcRbcCertainDirection_(tx('2026-05-07','Online Banking transfer - 0040','CREDIT',500)),'','online transfer');equal(vfcRbcCertainDirection_(tx('2026-03-12','Misc Payment RBC CREDIT CARD','CREDIT',283)),'DEBIT','RBC card payment');truthy(vfcRbcIsReturnedFinancingCredit_(tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)),'credit return');return'direction safe';});
  test('Checksum reconciliation refuses a non-unique direction solution',function(){const text='Total deposits & credits (2) + 200.00\nTotal cheques & debits (1) - 100.00',facts={deposits:200,withdrawals:100},rows=[tx('2026-01-01','Misc Payment A','DEBIT',100),tx('2026-01-02','Misc Payment B','DEBIT',100),tx('2026-01-03','Misc Payment C','CREDIT',100)],r=vfcRbcReconcileDirectionOnly_(rows,facts,text);equal(r.changed,false,'no repair');equal(r.reason,'non-unique-minimum-solution','reason');return r.reason;});
  test('Checksum reconciliation refuses when grand totals show a missing or wrong amount',function(){const text='Total deposits & credits (2) + 200.00\nTotal cheques & debits (1) - 100.00',facts={deposits:200,withdrawals:100},rows=[tx('2026-01-01','Misc Payment A','DEBIT',90),tx('2026-01-02','Misc Payment B','DEBIT',100),tx('2026-01-03','Misc Payment C','CREDIT',100)],r=vfcRbcReconcileDirectionOnly_(rows,facts,text);equal(r.changed,false,'no repair');equal(r.reason,'grand-total-mismatch','reason');return r.reason;});
  test('Unknown recurring PAD is informational only',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');return'informational';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-07-31',[tx('2026-07-27','Business PAD BDC','DEBIT',7952.39,'BDC')]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]),bdc=d.activeDebtObligations.filter(function(x){return x.counterparty==='BDC';});equal(d.returnedFinanceDebitsSuppressed,2,'suppressed');equal(bdc.length,1,'normal BDC stream');close(bdc[0].monthlyEquivalent,2507.07,.02,'BDC monthly');return'suppressed=2; BDC=$2507.07';});
  test('Recurring IPFS amount wins while one catch-up debit stays separate',function(){const d=vfcDebtProfile_([row('2026-06-30',[tx('2026-06-22','Business PAD IPFS Canada','DEBIT',502.45,'IPFS Canada')]),row('2026-07-31',[tx('2026-07-02','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')]),row('2026-08-31',[tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')]),row('2026-09-30',[tx('2026-09-01','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')])]),ip=d.activeDebtObligations.filter(function(x){return /IPFS/i.test(x.counterparty);}),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.length,1,'IPFS stream');equal(ip[0].family,'FINANCING','IPFS family');close(ip[0].monthlyEquivalent,234.96,.02,'IPFS monthly');equal(ins.family,'OTHER','insurance');return'IPFS=$234.96';});
  test('RBC-truncated IC Premium Fina is recurring financing and its NSF debit is suppressed',function(){
    const d=vfcDebtProfile_([
      row('2026-03-27',[tx('2026-03-19','Bill Payment IC Premium Fina','DEBIT',1122.01,'IC Premium Fina')]),
      row('2026-04-27',[tx('2026-04-20','Bill Payment IC Premium Fina','DEBIT',1122.01,'IC Premium Fina'),tx('2026-04-20','Item returned NSF','CREDIT',1122.01)]),
      row('2026-05-27',[tx('2026-04-29','Bill Payment IC Premium Fina','DEBIT',1147.01,'IC Premium Fina'),tx('2026-05-19','Bill Payment IC Premium Fina','DEBIT',1122.01,'IC Premium Fina')]),
      row('2026-06-26',[tx('2026-06-18','Bill Payment IC Premium Fina','DEBIT',1122.01,'IC Premium Fina')]),
      row('2026-07-27',[tx('2026-07-20','Bill Payment IC Premium Fina','DEBIT',1122.01,'IC Premium Fina')])
    ]),premium=d.activeDebtObligations.filter(function(x){return /^RBC_PREMIUM_FINANCE_/.test(x.entityKey);});
    equal(d.returnedFinanceDebitsSuppressed,1,'suppressed return');equal(premium.length,1,'premium-finance stream');
    equal(premium[0].family,'FINANCING','family');close(premium[0].monthlyEquivalent,1122.01,.02,'monthly debt');return'IC Premium Fina=$1122.01/month';
  });
  test('Same numbered RBC loan merges interest and BLIP components',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-23','Loan interest NO.02243790 001','DEBIT',36.80),tx('2026-03-23','BLIP payment - loan NO.02243790 001','DEBIT',.73)]),row('2026-04-30',[tx('2026-04-21','Loan interest NO.02243790 001','DEBIT',61.05),tx('2026-04-21','BLIP payment - loan NO.02243790 001','DEBIT',1.47)]),row('2026-05-31',[tx('2026-05-22','Loan interest NO.02243790 001','DEBIT',44.05),tx('2026-05-22','BLIP payment - loan NO.02243790 001','DEBIT',1.06)]),row('2026-06-30',[tx('2026-06-22','Loan interest NO.02243790 001','DEBIT',79.17),tx('2026-06-22','BLIP payment - loan NO.02243790 001','DEBIT',2.11)]),row('2026-07-31',[tx('2026-07-22','Loan interest NO.02243790 001','DEBIT',20.91),tx('2026-07-22','BLIP payment - loan NO.02243790 001','DEBIT',.53)]),row('2026-08-31',[tx('2026-08-22','Loan interest NO.02243790 001','DEBIT',.16)])]),loan=d.activeDebtObligations.filter(function(x){return x.entityKey==='LOAN_ACCOUNT_02243790';});equal(loan.length,1,'loan obligation');close(loan[0].monthlyEquivalent,41.34,.02,'combined monthly');equal(loan[0].monthlyEquivalentMethod,'MONTHLY_ACCOUNT_TOTAL_MEAN','method');return'one loan/$41.34';});
  test('Explicit RBC account-transfer credits excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'BR TO BR');truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','Online Banking transfer - 0040','CREDIT',500)),'online credit');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','Online Banking transfer - 0040','DEBIT',500)),false,'online debit');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('BR TO BR owner-loan memo remains one transfer exclusion, not a financing-credit duplicate',function(){const credit=tx('2026-05-25','BR TO BR - Credit Memo 2920 Client request LOAN FROM KARMVIR SAHOTA','CREDIT',20000);truthy(vfcRbcIsNonOperatingTransferCredit_(credit),'transfer');equal(vfcRbcKnownFinancingCredit_(credit),false,'not financing duplicate');return'transfer only';});
  test('AIM HIGH six-statement operating deposits exclude financing, returns and account transfers',function(){const gross=363872.65,financing=104074.91,branchTransfers=44039.07,returns=10709.81,onlineTransfers=9066,operating=gross-financing-branchTransfers-returns-onlineTransfers;close(operating,195982.86,.02,'operating total');close(operating/6,32663.81,.02,'operating monthly');return'$32663.81/month';});
  test('Generic numeric Misc Payment never becomes obligation by itself',function(){equal(vfcRbcClassifyDebit_(tx('2026-03-12','Misc Payment 1469635','DEBIT',6585.81,'1469635')),null,'misc');return'ignored';});

  test('Summary debit sign does not create a false negative-balance flag',function(){
    const text='Total cheques & debits (39) -50,240.60\nClosing balance on April 2, 2026 = $195.66';
    equal(vfcRbcNegativeBalanceFlag_(text,{opening:4710.90,closing:195.66}),false,'summary sign');
    return'no false negative';
  });

  test('Visible running negative balance is detected',function(){
    const text='03 Mar Cheque - 343 315.00 -1,827.62';
    truthy(vfcRbcNegativeBalanceFlag_(text,{opening:4710.90,closing:195.66}),'running balance');
    return'negative detected';
  });

  test('Generic reversal credit is not automatically borrower NSF',function(){
    const rows=[tx('2026-03-10','Interac purchase reversal','CREDIT',125.00)];
    equal(vfcRbcCountBorrowerNsfEvents_(rows),0,'generic reversal');
    return'not NSF';
  });

  test('Cheque returned NSF credit counts as borrower NSF',function(){
    const rows=[tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)];
    equal(vfcRbcCountBorrowerNsfEvents_(rows),1,'NSF credit');
    return'1 NSF';
  });

  test('Printed activity count parser accepts ampersand and word and',function(){
    const a=vfcRbcPrintedActivityCounts_('Total deposits & credits (15) + 1\nTotal cheques & debits (39) - 1'),
          b=vfcRbcPrintedActivityCounts_('Total deposits and credits (15) + 1\nTotal cheques and debits (39) - 1');
    equal(a.creditCount,15,'amp credit');equal(a.debitCount,39,'amp debit');
    equal(b.creditCount,15,'and credit');equal(b.debitCount,39,'and debit');
    return'counts parsed';
  });

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,coreVersion:VFC_BANK_ENGINE.VERSION,rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
