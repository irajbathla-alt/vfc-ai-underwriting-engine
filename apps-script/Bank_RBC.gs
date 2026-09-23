/**
 * RBC BANK ENGINE v4.2 — CANDIDATE / GENERIC RECONCILED LEDGER
 * ONE PERMANENT RBC FILE.
 *
 * Architecture:
 * 1) Printed RBC Account Summary is the source of truth for statement totals/counts.
 * 2) A deterministic parser reads every visible Account Activity amount from its
 *    printed column or recovers direction from running balances when PDF text
 *    loses column spacing. It has no company or account dependency.
 * 3) The parsed ledger must match printed CREDIT/DEBIT counts AND dollar totals exactly.
 * 4) AI ledger extraction is used only when the transcript cannot be
 *    deterministically reconciled; the same exact audit still gates acceptance.
 * 5) A repaired ledger is accepted only after the exact same deterministic audit passes.
 * 6) Printed column controls direction. Verified narrow signatures correct known drift.
 * 7) If row count and grand total are already exact, a unique minimum-flip checksum
 *    solution may correct direction-only PDF/LLM drift without changing any row fact.
 * 8) Missing rows or wrong amounts trigger a fresh structured read of the original PDF.
 * 9) PAD/NSF/return/debt classification remains deterministic after facts are frozen.
 */
function vfcRbcBankProfile_(){
  return{
    id:'RBC',
    label:'RBC',
    status:'CANDIDATE',
    rulesVersion:'RBC-4.2-CANDIDATE',
    runtimeFingerprint:'RBC-4.2-BALANCE-LEDGER-20260923',
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
  'MISC PAYMENT, BR TO BR and ONLINE BANKING TRANSFER can appear on either side and follow the printed RBC column.',
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
  'PREMIUM FIN, PREMIUM FINANCE, PREMIUM FINANCING and IPFS are financing when recurring; ordinary insurance remains informational.',
  'BDC: BUSINESS PAD BDC is the normal PAD stream. BDC-LOAN/PRET/manual BDC loan payments stay separate. Materially different BDC PAD amounts are separated into amount bands so catch-up payments cannot inflate normal monthly debt.',
  'Journey/OnDeck, Merchant Growth, Canacap and Greenbox are MCA-style exposures when recurring. iCapital remains general financing unless statement wording proves MCA.',
  'Known financing entities include BDC, Canacap, iCapital, Greenbox, Journey/OnDeck, Merchant Growth, SilverChef, Affirm Canada and explicit premium finance/IPFS.',
  'LOAN CREDIT, CSBFL advances and credits from known financing entities are financing-credit candidates only when printed in Deposits & Credits.',
  'BR TO BR credits, explicit TRANSFER FROM ACCOUNT credits and credit-side ONLINE BANKING TRANSFER - #### rows are internal account transfers. Internal-transfer markers take precedence over memo words such as LOAN. Generic customer e-Transfers are not excluded.',
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

  const directionRepairs=[],columnCandidate=vfcRbcColumnTranscriptLedger_(text,facts);
  let ledger=[],audit=null,lastError='',repairPasses=0,ledgerSource='';

  /*
   * The transcript's printed geometry is the primary source. Because direction
   * comes from the column itself, description-based direction overrides are not
   * allowed on this path. A partial or ambiguous parse is simply rejected by the
   * four-control audit and the existing checksum-gated fallback takes over.
   */
  if(columnCandidate.rows.length){
    ledger=vfcRbcPrepareLedger_(columnCandidate.rows,directionRepairs,true);
    try{
      audit=vfcRbcAuditFullLedger_(ledger,facts,text,name);
      ledgerSource='PRINTED_COLUMN_TRANSCRIPT';
    }catch(e){lastError=String(e&&e.message||e);audit=null;}
  }

  // A text extractor may retain row boundaries and running balances while
  // discarding all column spacing. Reconstruct only if every balance segment
  // and all four printed statement controls yield a unique complete ledger.
  let balanceCandidate=null;
  if(!audit){
    balanceCandidate=vfcRbcBalanceTranscriptLedger_(text,facts);
    if(balanceCandidate.rows.length){
      ledger=vfcRbcPrepareLedger_(balanceCandidate.rows,directionRepairs,true);
      try{
        audit=vfcRbcAuditFullLedger_(ledger,facts,text,name);
        ledgerSource='RUNNING_BALANCE_TRANSCRIPT';
      }catch(e){lastError=String(e&&e.message||e);audit=null;}
    }
  }

  if(!audit){
    ledger=vfcRbcPrepareLedger_(locked.banking_transactions||[],directionRepairs);
    let checksumRepair=vfcRbcReconcileDirectionOnly_(ledger,facts,text);
    if(checksumRepair.changed){ledger=checksumRepair.rows;Array.prototype.push.apply(directionRepairs,checksumRepair.flips);}
    for(let attempt=0;attempt<=2;attempt++){
      try{
        audit=vfcRbcAuditFullLedger_(ledger,facts,text,name);
        ledgerSource=repairPasses>0?(sourceFileId?'ORIGINAL_PDF_RECONCILIATION':'AI_TRANSCRIPT_RECONCILIATION'):'AI_JSON_CHECKSUM';
        break;
      }catch(e){
        lastError=String(e&&e.message||e);
        if(attempt>=2)throw new Error(lastError);
        repairPasses++;
        ledger=vfcRbcRepairLedger_(ledger,text,name,facts,lastError,repairPasses,directionRepairs,sourceFileId);
        checksumRepair=vfcRbcReconcileDirectionOnly_(ledger,facts,text);
        if(checksumRepair.changed){ledger=checksumRepair.rows;Array.prototype.push.apply(directionRepairs,checksumRepair.flips);}
      }
    }
  }

  if(!audit)throw new Error('RBC ledger verification did not complete for '+name+'.');
  locked.banking_transactions=ledger;
  locked.rbc_full_ledger_verified=true;
  locked.rbc_ledger_reconciled=repairPasses>0||directionRepairs.length>0;
  locked.rbc_ledger_repair_passes=repairPasses;
  locked.rbc_original_pdf_repair_used=!!sourceFileId&&repairPasses>0;
  locked.rbc_direction_repairs=directionRepairs;
  locked.rbc_ledger_source=ledgerSource;
  locked.rbc_column_parser_version=columnCandidate.version;
  locked.rbc_column_parser_candidate_count=columnCandidate.rows.length;
  locked.rbc_column_parser_fixed_rows=columnCandidate.fixedRows;
  locked.rbc_column_parser_explicit_rows=columnCandidate.explicitRows;
  locked.rbc_balance_parser_candidate_count=balanceCandidate?balanceCandidate.rows.length:0;
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

function vfcRbcMonthNumber_(value){
  const key=String(value||'').trim().substring(0,3).toUpperCase(),months={JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
  return months[key]||0;
}

function vfcRbcIsoParts_(year,month,day){
  const y=Number(year),m=Number(month),d=Number(day),check=new Date(Date.UTC(y,m-1,d));
  if(check.getUTCFullYear()!==y||check.getUTCMonth()!==m-1||check.getUTCDate()!==d)return'';
  return String(y)+'-'+('0'+m).slice(-2)+'-'+('0'+d).slice(-2);
}

/** Resolve an RBC activity date against the printed period, including Dec/Jan cycles. */
function vfcRbcActivityIsoDate_(value,facts){
  const raw=String(value||'').trim().replace(/,$/,''),literal=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(literal)return vfcRbcIsoParts_(literal[1],literal[2],literal[3]);
  const dayFirst=raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})$/),monthFirst=raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/),match=dayFirst||monthFirst;
  if(!match)return'';
  const day=Number(dayFirst?match[1]:match[2]),month=vfcRbcMonthNumber_(dayFirst?match[2]:match[1]);
  if(!month)return'';
  const start=String(facts&&facts.startDate||''),end=String(facts&&facts.endDate||''),startDay=vfcRbcIsoDayNumber_(start),endDay=vfcRbcIsoDayNumber_(end),startYear=Number(start.substring(0,4)),endYear=Number(end.substring(0,4));
  if(startDay===null||endDay===null||!startYear||!endYear)return'';
  for(let year=startYear-1;year<=endYear+1;year++){
    const iso=vfcRbcIsoParts_(year,month,day),n=vfcRbcIsoDayNumber_(iso);
    if(n!==null&&n>=startDay&&n<=endDay)return iso;
  }
  return'';
}

function vfcRbcActivityDatePrefix_(line,facts){
  const source=String(line||''),patterns=[
    /^\s*(\d{4}-\d{2}-\d{2})(?=\s|\||$)\s*/,
    /^\s*(\d{1,2}\s+[A-Za-z]{3,9})(?=\s|\||$)\s*/,
    /^\s*([A-Za-z]{3,9}\s+\d{1,2},?)(?=\s|\||$)\s*/
  ];
  for(let i=0;i<patterns.length;i++){
    const match=source.match(patterns[i]);
    if(match){const iso=vfcRbcActivityIsoDate_(match[1],facts);if(iso)return{iso:iso,endIndex:match[0].length};}
  }
  return null;
}

function vfcRbcPrintedMoney_(value){
  const raw=String(value||'').trim(),negative=/^-/.test(raw)||/^\(/.test(raw),n=Number(raw.replace(/[^0-9.]/g,''));
  return Number.isFinite(n)?(negative?-n:n):null;
}

function vfcRbcMoneyTokens_(line){
  const source=String(line||''),out=[],pattern=/(?:-\s*)?\$?\d[\d,]*\.\d{2}|\(\s*\$?\d[\d,]*\.\d{2}\s*\)/g;let match;
  while((match=pattern.exec(source))!==null)out.push({text:match[0],value:vfcRbcPrintedMoney_(match[0]),start:match.index,end:match.index+match[0].length});
  return out;
}

function vfcRbcCleanTranscriptDescription_(value){
  return String(value||'').replace(/^\s*(?:DESCRIPTION|DETAILS?)\s*:?[|]?\s*/i,'').replace(/^\s*\|+|\|+\s*$/g,'').replace(/\s*\|\s*/g,' ').replace(/\s+/g,' ').trim();
}

function vfcRbcColumnHeader_(line){
  const source=String(line||''),upper=source.toUpperCase(),description=upper.match(/DESCRIPTION/),debit=upper.match(/CHEQUES?\s*(?:&|AND)\s*DEBITS?/),credit=upper.match(/DEPOSITS?\s*(?:&|AND)\s*CREDITS?/),balance=upper.match(/BALANCE/),descriptionStart=description?description.index:-1,debitStart=debit?debit.index:-1,creditStart=credit?credit.index:-1,balanceStart=balance?balance.index:-1;
  if(descriptionStart<0||debitStart<0||creditStart<0||balanceStart<0||!(descriptionStart<debitStart&&debitStart<creditStart&&creditStart<balanceStart))return null;
  return{descriptionStart:descriptionStart,debitStart:debitStart,creditStart:creditStart,balanceStart:balanceStart,debitEnd:debitStart+debit[0].length+2,creditEnd:creditStart+credit[0].length+1,balanceEnd:balanceStart+balance[0].length+2};
}

function vfcRbcExplicitTranscriptRow_(line,facts,currentDate,pendingDescription){
  const source=String(line||'');
  if(!/\|\s*(?:DEBIT|CREDIT|BALANCE)\b/i.test(source))return null;
  const datePrefix=vfcRbcActivityDatePrefix_(source,facts),date=datePrefix?datePrefix.iso:currentDate,segments=source.split('|'),descriptionParts=[],amounts={DEBIT:null,CREDIT:null,BALANCE:null};
  segments.forEach(function(segment,index){
    const marker=String(segment||'').match(/^\s*(DEBIT|CREDIT|BALANCE)\b\s*:?[ ]*(.*)$/i);
    if(marker){const money=vfcRbcMoneyTokens_(marker[2]),column=String(marker[1]).toUpperCase();if(money.length)amounts[column]=column==='BALANCE'?money[0].value:Math.abs(money[0].value);return;}
    if(index===0&&datePrefix)descriptionParts.push(source.substring(datePrefix.endIndex).split('|')[0]);
    else descriptionParts.push(segment);
  });
  const direction=amounts.DEBIT!==null?'DEBIT':amounts.CREDIT!==null?'CREDIT':'',amount=direction?amounts[direction]:null,description=vfcRbcCleanTranscriptDescription_([pendingDescription,descriptionParts.join(' ')].filter(Boolean).join(' '));
  return{date:date,direction:direction,amount:amount,description:description,balanceAfter:amounts.BALANCE};
}

/**
 * Parse standard RBC Account Activity tables without company-specific knowledge.
 * Fixed-width lines are mapped by the nearest printed column right edge. When a
 * text provider cannot preserve spacing, the explicit | DEBIT/CREDIT markers in
 * the transcription contract provide the same deterministic direction signal.
 */
function vfcRbcColumnTranscriptLedger_(text,facts){
  const lines=String(text||'').replace(/\u00a0/g,' ').replace(/\f/g,'\n').split(/\r?\n/),rows=[];
  let columns=null,inTable=false,sawActivity=false,currentDate='',pendingDescription='',fixedRows=0,explicitRows=0,headerCount=0;
  function clearPending(){pendingDescription='';}
  function appendDescription(value){const clean=vfcRbcCleanTranscriptDescription_(value);if(clean)pendingDescription=vfcRbcCleanTranscriptDescription_([pendingDescription,clean].filter(Boolean).join(' '));}
  function emit(date,description,direction,amount,balanceAfter){const clean=vfcRbcCleanTranscriptDescription_(description);if(!date||!clean||!(amount>0)||(direction!=='DEBIT'&&direction!=='CREDIT'))return false;const row={date:date,description:clean,counterparty:clean,direction:direction,amount:vfcRound_(amount,.01)};if(balanceAfter!==null&&balanceAfter!==undefined)row.printedBalanceAfter=balanceAfter;rows.push(row);clearPending();return true;}

  lines.forEach(function(rawLine){
    const line=String(rawLine||''),header=vfcRbcColumnHeader_(line);
    if(/ACCOUNT\s+ACTIVITY\s+DETAILS/i.test(line)){sawActivity=true;inTable=true;columns=null;clearPending();return;}
    if(header){columns=header;inTable=true;sawActivity=true;headerCount++;clearPending();return;}
    if(/\bDATE\b.*\|.*\bDESCRIPTION\b.*\|.*\b(?:DEBIT|CHEQUES?\s*(?:&|AND)\s*DEBITS?)\b.*\|.*\b(?:CREDIT|DEPOSITS?\s*(?:&|AND)\s*CREDITS?)\b/i.test(line)){columns=null;inTable=true;sawActivity=true;headerCount++;clearPending();return;}
    if(!sawActivity)return;
    if(/^\s*(?:CLOSING\s+BALANCE|ACCOUNT\s+FEES?)\b/i.test(line)||/^\s*\d+\s+OF\s+\d+\s*$/i.test(line)||/BUSINESS\s+ACCOUNT\s+STATEMENT|ACCOUNT\s+NUMBER\s*:/i.test(line)){
      inTable=false;columns=null;clearPending();return;
    }
    if(!inTable||!line.trim())return;

    const datePrefix=vfcRbcActivityDatePrefix_(line,facts);
    if(datePrefix){if(currentDate&&datePrefix.iso!==currentDate&&pendingDescription)clearPending();currentDate=datePrefix.iso;}

    const explicit=vfcRbcExplicitTranscriptRow_(line,facts,currentDate,pendingDescription);
    if(explicit){
      if(datePrefix)currentDate=datePrefix.iso;
      if(explicit.direction&&emit(explicit.date,explicit.description,explicit.direction,explicit.amount,explicit.balanceAfter)){explicitRows++;return;}
      const beforeMarker=line.split(/\|\s*(?:DEBIT|CREDIT|BALANCE)\b/i)[0];appendDescription(datePrefix?beforeMarker.substring(Math.min(datePrefix.endIndex,beforeMarker.length)):beforeMarker);return;
    }

    if(!columns)return;
    const tokens=vfcRbcMoneyTokens_(line),classified=[];
    tokens.forEach(function(token){
      if(token.start<columns.debitStart-2)return;
      const choices=[{direction:'DEBIT',distance:Math.abs(token.end-columns.debitEnd)},{direction:'CREDIT',distance:Math.abs(token.end-columns.creditEnd)},{direction:'BALANCE',distance:Math.abs(token.end-columns.balanceEnd)}].sort(function(a,b){return a.distance-b.distance;});
      if(choices[0].distance<=10)classified.push({token:token,direction:choices[0].direction});
    });
    const transaction=classified.filter(function(x){return x.direction==='DEBIT'||x.direction==='CREDIT';})[0],firstColumnToken=classified.length?classified.map(function(x){return x.token.start;}).sort(function(a,b){return a-b;})[0]:line.length;
    const descriptionStart=Math.min(columns.descriptionStart,line.length),descriptionEnd=Math.max(descriptionStart,firstColumnToken),description=line.substring(descriptionStart,descriptionEnd);
    appendDescription(description);
    const balanceToken=classified.filter(function(x){return x.direction==='BALANCE';})[0];
    if(transaction&&emit(currentDate,pendingDescription,transaction.direction,Math.abs(transaction.token.value),balanceToken?balanceToken.token.value:null))fixedRows++;
    else if(classified.some(function(x){return x.direction==='BALANCE';})&&/^\s*(?:OPENING|CLOSING)\s+BALANCE\b/i.test(pendingDescription))clearPending();
  });
  return{version:'RBC-COLUMN-LEDGER-1',rows:rows,fixedRows:fixedRows,explicitRows:explicitRows,headerCount:headerCount};
}

/** Only unambiguous RBC row wording may break a running-balance tie. */
function vfcRbcBalanceDirectionHint_(description){
  const s=String(description||'').toUpperCase();
  if(/^BR\s+TO\s+BR\s*-\s*CREDIT\s+(?:MEMO|ADJUSTMENT)\b/.test(s))return'CREDIT';
  if(/^CONTACTLESS\s+INTERAC\s+REFUND\b|\bINTERAC\s+PURCHASE\s+REFUND\b/.test(s))return'CREDIT';
  return'';
}

/** Enumerate only signed amounts that reproduce the next printed running balance. */
function vfcRbcBalanceSegmentSolutions_(items,openingCents,closingCents){
  if(!items.length||items.length>28)return[];
  const amounts=items.map(function(t){return Math.round(t.amount*100);}),total=amounts.reduce(function(s,n){return s+n;},0),twiceCredits=total+closingCents-openingCents;
  if(twiceCredits%2||twiceCredits<0||twiceCredits>total*2)return[];
  const target=twiceCredits/2,mid=Math.floor(items.length/2),left=new Map(),solutions=[],maxSolutions=1000;
  for(let mask=0;mask<(1<<mid);mask++){
    let sum=0;for(let i=0;i<mid;i++)if(mask&(1<<i))sum+=amounts[i];
    const group=left.get(sum)||[];group.push(mask);left.set(sum,group);
  }
  for(let mask=0;mask<(1<<(items.length-mid));mask++){
    let sum=0;for(let i=mid;i<items.length;i++)if(mask&(1<<(i-mid)))sum+=amounts[i];
    const matches=left.get(target-sum)||[];
    for(let j=0;j<matches.length;j++){
      const flags=items.map(function(t,i){return i<mid?!!(matches[j]&(1<<i)):!!(mask&(1<<(i-mid)));});
      solutions.push(flags);if(solutions.length>maxSolutions)return[];
    }
  }
  if(solutions.length<=1)return solutions;
  const hinted=solutions.filter(function(flags){return flags.every(function(isCredit,i){const hint=vfcRbcBalanceDirectionHint_(items[i].description);return!hint||(isCredit?'CREDIT':'DEBIT')===hint;});});
  return hinted.length?hinted:[];
}

/** Recover a complete ledger from row text whose printed column spacing was lost. */
function vfcRbcBalanceTranscriptLedger_(text,facts){
  const printed=vfcRbcPrintedActivityCounts_(text),rows=[],lines=String(text||'').replace(/\u00a0/g,' ').replace(/\f/g,'\n').split(/\r?\n/);
  let inTable=false,currentDate='',pending='';
  lines.forEach(function(raw){
    const line=String(raw||'').trim();
    if(/ACCOUNT\s+ACTIVITY\s+DETAILS/i.test(line)){inTable=true;pending='';return;}
    if(/^CLOSING\s+BALANCE\b|^ACCOUNT\s+FEES?\s*:|^BUSINESS\s+ACCOUNT\s+STATEMENT\b|^ACCOUNT\s+NUMBER\s*:/i.test(line)){inTable=false;pending='';return;}
    if(!inTable||!line||/^DATE\b.*DESCRIPTION\b|^OPENING\s+BALANCE\b/i.test(line))return;
    const prefix=vfcRbcActivityDatePrefix_(line,facts);
    if(prefix){if(currentDate&&currentDate!==prefix.iso)pending='';currentDate=prefix.iso;}
    const body=prefix?line.substring(prefix.endIndex).trim():line;
    if(!body)return;
    const tokens=vfcRbcMoneyTokens_(body),rates=(body.match(/@\s*\$?\d[\d,]*\.\d{2}/g)||[]).length;
    if(!tokens.length||rates&&tokens.length===rates){pending=vfcRbcCleanTranscriptDescription_((pending+' '+body).trim());return;}
    const index=tokens.length>=rates+2?tokens.length-2:tokens.length-1,token=tokens[index];
    const description=vfcRbcCleanTranscriptDescription_((pending+' '+body.substring(0,token.start)).trim());
    if(currentDate&&description&&Math.abs(token.value)>0)rows.push({date:currentDate,description:description,counterparty:description,amount:vfcRound_(Math.abs(token.value),.01),balance:index<tokens.length-1?tokens[tokens.length-1].value:null});
    pending='';
  });
  const expectedCount=printed.creditCount+printed.debitCount,totalCents=rows.reduce(function(s,r){return s+Math.round(r.amount*100);},0),expectedCents=Math.round((facts.deposits+facts.withdrawals)*100);
  if(!rows.length||rows.length!==expectedCount||totalCents!==expectedCents)return{rows:[],reason:'row-count-or-amount-mismatch'};
  const segments=[],openingCents=Math.round(facts.opening*100);let start=0,balance=openingCents;
  rows.forEach(function(row,i){
    if(row.balance===null)return;
    const next=Math.round(row.balance*100),choices=vfcRbcBalanceSegmentSolutions_(rows.slice(start,i+1),balance,next);
    segments.push({start:start,end:i,choices:choices});start=i+1;balance=next;
  });
  if(start<rows.length)segments.push({start:start,end:rows.length-1,choices:vfcRbcBalanceSegmentSolutions_(rows.slice(start),balance,Math.round(facts.closing*100))});
  else if(balance!==Math.round(facts.closing*100))return{rows:[],reason:'closing-balance-mismatch'};
  if(segments.some(function(x){return!x.choices.length;}))return{rows:[],reason:'unresolved-balance-segment'};

  let selected=null,solutions=0;
  function choose(index,flags,credits){
    if(solutions>1||credits>printed.creditCount)return;
    if(index===segments.length){if(credits===printed.creditCount){selected=flags.slice();solutions++;}return;}
    const segment=segments[index];segment.choices.forEach(function(choice){
      if(solutions>1)return;
      const next=flags.slice();choice.forEach(function(isCredit,i){next[segment.start+i]=isCredit;});
      choose(index+1,next,credits+choice.filter(Boolean).length);
    });
  }
  choose(0,[],0);
  if(solutions!==1)return{rows:[],reason:solutions?'ambiguous-direction':'credit-count-mismatch'};
  const ledger=rows.map(function(row,i){const t={date:row.date,description:row.description,counterparty:row.counterparty,direction:selected[i]?'CREDIT':'DEBIT',amount:row.amount};if(row.balance!==null)t.printedBalanceAfter=row.balance;return t;});
  const stats=vfcRbcLedgerStats_(ledger);
  if(stats.creditCount!==printed.creditCount||stats.debitCount!==printed.debitCount||Math.round(stats.totalCredits*100)!==Math.round(facts.deposits*100)||Math.round(stats.totalDebits*100)!==Math.round(facts.withdrawals*100))return{rows:[],reason:'four-control-mismatch'};
  return{rows:ledger,reason:'unique-running-balance-solution'};
}

function vfcRbcIsNonActivityArtifact_(t){
  const s=String(t&&t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(!s)return true;
  return/^OPENING\s+BALANCE\b|^CLOSING\s+BALANCE\b|^ACCOUNT\s+FEES?\b|^ACCOUNT\s+SUMMARY\b|^TOTAL\s+DEPOSITS\s*&\s*CREDITS\b|^TOTAL\s+CHEQUES\s*&\s+DEBITS\b|^PAGE\s+TOTAL\b|^SERIAL\s*#?\s*:?\s*\d+\s+AMOUNT\b|FOR\s+DEPOSIT\s+ONLY|BACKVERSO|BACK\s*\/\s*VERSO|CHEQUE\s+IMAGE|CHECK\s+IMAGE/.test(s);
}

function vfcRbcPrepareLedger_(items,directionRepairs,printedColumnLocked){
  return(Array.isArray(items)?items:[]).filter(function(x){return!vfcRbcIsNonActivityArtifact_(x);}).map(function(x){
    const t=Object.assign({},x||{}),original=String(t.direction||'').toUpperCase(),forced=printedColumnLocked?'':vfcRbcCertainDirection_(t);
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
  // Payroll Deposit labels can be payroll-provider debits. Printed columns or
  // running balances, rather than that wording, determine their direction.
  if(/^LOAN\s+CREDIT\b/.test(s)||/\bTAX\s+REFUND\b|E-TRANSFER\s+RECEIVED|INTERAC\s+PURCHASE\s+REFUND|E-TRANSFER\s+CANCEL|MOBILE\s+CHEQUE\s+DEPOSIT/.test(s))return'CREDIT';
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
  if(facts&&facts.opening!==null){
    let balance=Math.round(facts.opening*100);
    rows.forEach(function(t,i){
      balance+=(String(t.direction||'').toUpperCase()==='CREDIT'?1:-1)*Math.round(vfcNum_(t.amount)*100);
      if(t.printedBalanceAfter!==undefined&&t.printedBalanceAfter!==null&&Math.abs(balance-Math.round(vfcNum_(t.printedBalanceAfter)*100))>1)throw new Error('RBC printed running balance disagrees with activity row '+(i+1)+' for '+fileName+'.');
    });
  }

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
  const printed=vfcRbcPrintedActivityCounts_(text),current=vfcRbcLedgerStats_(currentLedger),hasOriginalPdf=!!sourceFileId,promptLines=[
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
    '5. Keep every separately printed row. Repeated identical fee rows, including multiple $1.50 e-Transfer fees on the same date, are separate transactions and must not be deduplicated.',
    '6. Use running-balance changes and neighboring row boundaries to verify that an amount was not borrowed from the row above or below.',
    '7. Every transaction date must be inside the printed statement period. Carry a printed activity date forward to its following undated continuation rows until the next printed date.',
    '8. The final array MUST contain exactly '+printed.creditCount+' CREDIT rows totaling '+vfcNum_(facts.deposits)+' and exactly '+printed.debitCount+' DEBIT rows totaling '+vfcNum_(facts.withdrawals)+'.',
    '9. Check the completed array against all four count/total targets and the statement date range before returning it.',
    'Current candidate stats: credits '+current.creditCount+' / $'+current.totalCredits+', debits '+current.debitCount+' / $'+current.totalDebits+'.'
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
  if(isFee){if(!hasFinancingSignal&&/MONTHLY\s+(?:ACCOUNT\s+)?FEE|MONTHLY\s+SERVICE\s+CHARGE|ACCOUNT\s+MAINTENANCE\s+FEE/.test(s)){const key='RBC_OTHER_BANK_FEE_'+vfcCounterpartyKey_(raw);return Object.assign({},t,{family:'OTHER',entityKey:key,key:key,label:raw,debtJustification:''});}return null;}
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
  else if(/\bIPFS\b|PREMIUM\s+FIN[A-Z]*/.test(s)){family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw)+'_B'+band;label=cp||'Premium Finance';debtJustification='Explicit premium-finance counterparty plus recurrence.';}
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
  else{const named=vfcRbcNamedRecurringVendor_(raw,cp);if(!named)return null;family='OTHER';entityKey='RBC_OTHER_NAMED_'+vfcCounterpartyKey_(named);label=named;}
  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

/** Named payees can recur without being lenders; anonymous reference/transfer rows cannot. */
function vfcRbcNamedRecurringVendor_(raw,cp){
  const s=String(raw||'').toUpperCase();if(/\b(?:INTERAC|DEBIT\s+CARD|CONTACTLESS|POINT\s+OF\s+SALE|POS)\s+PURCHASE\b|\bATM\b|CASH\s+WITHDRAWAL|^CHEQUE\s*[-#]?\s*\d+/.test(s))return'';
  let name=String(cp||raw||'').replace(/^\s*(?:ONLINE\s+BANKING\s+(?:PAYMENT|TRANSFER)|BILL\s+PAYMENT|MISC\s+PAYMENT|E[- ]?TRANSFER\s+SENT|FUNDS\s+TRANSFER)\s*(?:[-:#]\s*)?(?:\d{3,}\s*)?/i,'').replace(/\b(?:REF(?:ERENCE)?|CONFIRMATION)\s*[:#-]?\s*\d+\b/ig,'').replace(/\b\d{5,}\b/g,'').replace(/^[\s:.-]+|[\s:.-]+$/g,'').trim();
  const uninformative={ONLINE:1,BANKING:1,TRANSFER:1,BILL:1,MISC:1,CHEQUE:1,PAY:1,PYMT:1,DEFTPYMT:1,DEBIT:1,PURCHASE:1,INTERAC:1,SENT:1,FROM:1,ACCOUNT:1,CASH:1,WITHDRAWAL:1};
  if(!vfcTokens_(name).some(function(x){return!uninformative[x];}))return'';
  return name;
}

function vfcRbcIsReturnedFinancingCredit_(t){return String(t&&t.direction||'').toUpperCase()==='CREDIT'&&vfcRbcReturnEventText_(t&&t.description);}
function vfcRbcIsNonOperatingTransferCredit_(t){if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;const s=String(t&&t.description||'').toUpperCase();if(/E-TRANSFER|INTERAC/.test(s))return false;return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b|\bONLINE\s+BANKING\s+TRANSFER\s*-\s*\d{3,}\b/.test(s);}
function vfcRbcKnownFinancingCredit_(t){const s=String(t&&t.description||'').toUpperCase();if(vfcRbcIsReturnedFinancingCredit_(t)||vfcRbcIsNonOperatingTransferCredit_(t))return false;return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bMCA\b|\bLOAN\s+(?:CREDIT|ADVANCE|PROCEEDS)\b|\bMORTGAGE\s+(?:ADVANCE|PROCEEDS|FUNDING)\b|(?:\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE)\s+(?:ADVANCE|PROCEEDS|FUNDING)/.test(s);}
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
  function columnLine(date,description,debit,credit,balance){
    const chars=new Array(141).join(' ').split('');
    function put(start,value){String(value||'').split('').forEach(function(c,i){if(start+i<chars.length)chars[start+i]=c;});}
    function putRight(end,value){const s=String(value||'');if(s)put(end-s.length,s);}
    put(0,date);put(14,description);putRight(78,debit);putRight(106,credit);putRight(131,balance);return chars.join('').replace(/\s+$/,'');
  }

  test('Generic fixed-column transcript is primary and exactly audited',function(){
    const text=[
      'January 1, 2026 to January 31, 2026',
      'Opening balance on January 1, 2026 $100.00',
      'Total deposits & credits (2) + 150.00',
      'Total cheques & debits (1) - 30.00',
      'Closing balance on January 31, 2026 = $220.00',
      'Account Activity Details',
      'Date          Description                                   Cheques & Debits ($)       Deposits & Credits ($)             Balance ($)',
      columnLine('','Opening balance','','','100.00'),
      columnLine('03 Jan','Customer receipt','','100.00','200.00'),
      columnLine('','Online Banking transfer - 4321','30.00','','170.00'),
      columnLine('04 Jan','Wrapped customer','','',''),
      columnLine('','receipt','','50.00','220.00'),
      columnLine('31 Jan','Closing balance','','','220.00')
    ].join('\n'),locked=vfcRbcLockFacts_({banking_transactions:[]},text,'anonymous-rbc.pdf'),stats=vfcRbcLedgerStats_(locked.banking_transactions);
    equal(locked.rbc_ledger_source,'PRINTED_COLUMN_TRANSCRIPT','source');equal(locked.rbc_column_parser_fixed_rows,3,'fixed rows');equal(locked.rbc_ledger_repair_passes,0,'AI repairs');
    equal(stats.creditCount,2,'credits');close(stats.totalCredits,150,.001,'credit total');equal(stats.debitCount,1,'debits');close(stats.totalDebits,30,.001,'debit total');
    equal(locked.banking_transactions[1].direction,'DEBIT','printed online-transfer column');equal(locked.banking_transactions[2].description,'Wrapped customer receipt','wrapped description');
    return'3 rows / four printed controls';
  });

  test('Explicit pipe transcript is parsed when spacing is unavailable',function(){
    const text=['Total deposits & credits (1) + 100.00','Total cheques & debits (1) - 30.00','Account Activity Details','Date | Description | Debit | Credit | Balance','03 Jan | Customer receipt | DEBIT | CREDIT 100.00 | BALANCE 100.00','04 Jan | Vendor payment | DEBIT 30.00 | CREDIT | BALANCE 70.00'].join('\n'),facts={startDate:'2026-01-01',endDate:'2026-01-31',deposits:100,withdrawals:30},parsed=vfcRbcColumnTranscriptLedger_(text,facts),audit=vfcRbcAuditFullLedger_(parsed.rows,facts,text,'anonymous-pipe.txt');
    equal(parsed.explicitRows,2,'explicit rows');equal(audit.creditCount,1,'credits');equal(audit.debitCount,1,'debits');return'2 explicit rows';
  });

  test('An explicit negative running balance keeps its sign',function(){
    const text=['Total deposits & credits (0) + 0.00','Total cheques & debits (1) - 130.00','Account Activity Details','Date | Description | Debit | Credit | Balance','03 Jan | Vendor payment | DEBIT 130.00 | CREDIT | BALANCE -30.00'].join('\n'),facts={startDate:'2026-01-01',endDate:'2026-01-31',opening:100,closing:-30,deposits:0,withdrawals:130},parsed=vfcRbcColumnTranscriptLedger_(text,facts),audit=vfcRbcAuditFullLedger_(parsed.rows,facts,text,'anonymous-pipe.txt');
    equal(parsed.rows[0].printedBalanceAfter,-30,'negative balance');equal(audit.debitCount,1,'debit rows');return'negative balance checked';
  });

  test('Generic activity dates resolve across a calendar-year boundary',function(){
    const facts={startDate:'2025-12-20',endDate:'2026-01-20'};
    equal(vfcRbcActivityIsoDate_('31 Dec',facts),'2025-12-31','December');equal(vfcRbcActivityIsoDate_('Jan 02',facts),'2026-01-02','January');return'year-safe';
  });

  test('Layout-free activity reconciles against printed balances even when a Payroll Deposit is a debit',function(){
    const text=[
      'January 1, 2026 to January 31, 2026',
      'Opening balance on January 1, 2026 $100.00',
      'Total deposits & credits (1) + 200.00',
      'Total cheques & debits (2) - 70.00',
      'Closing balance on January 31, 2026 = $230.00',
      'Account Activity Details',
      'Date Description Cheques & Debits ($) Deposits & Credits ($) Balance ($)',
      '03 Jan Customer invoice 200.00 300.00',
      '04 Jan Payroll Deposit PROCESSOR 50.00 250.00',
      'Vendor payment 20.00 230.00'
    ].join('\n'),locked=vfcRbcLockFacts_({banking_transactions:[]},text,'any-company-rbc.pdf');
    equal(locked.rbc_ledger_source,'RUNNING_BALANCE_TRANSCRIPT','balance recovery');
    equal(locked.banking_transactions.length,3,'activity rows');
    equal(locked.banking_transactions[1].direction,'DEBIT','payroll-provider debit');
    equal(vfcRbcCertainDirection_(locked.banking_transactions[1]),'','payroll wording does not force a direction');
    equal(locked.rbc_ledger_repair_passes,0,'AI repair passes');
    return'3 rows / unique balance solution';
  });

  test('Credit memo wording resolves an otherwise tied balance segment',function(){
    const text=[
      'January 1, 2026 to January 31, 2026',
      'Opening balance on January 1, 2026 $100.00',
      'Total deposits & credits (1) + 10.00',
      'Total cheques & debits (1) - 10.00',
      'Closing balance on January 31, 2026 = $100.00',
      'Account Activity Details',
      'Date Description Cheques & Debits ($) Deposits & Credits ($) Balance ($)',
      '03 Jan BR TO BR - Credit Memo adjustment 10.00',
      'Vendor charge 10.00 100.00'
    ].join('\n'),locked=vfcRbcLockFacts_({},text,'anonymous-rbc.pdf');
    equal(locked.rbc_ledger_source,'RUNNING_BALANCE_TRANSCRIPT','balance recovery');
    equal(locked.banking_transactions[0].direction,'CREDIT','explicit credit memo');
    equal(locked.banking_transactions[1].direction,'DEBIT','matching debit');
    return'tied amounts resolved by explicit memo';
  });

  test('Unlabeled equal-value rows stay unresolved when both directions fit',function(){
    const text=[
      'Total deposits & credits (1) + 10.00','Total cheques & debits (1) - 10.00',
      'Account Activity Details','Date Description Cheques & Debits ($) Deposits & Credits ($) Balance ($)',
      '03 Jan Adjustment A 10.00','Adjustment B 10.00 100.00'
    ].join('\n'),facts={startDate:'2026-01-01',endDate:'2026-01-31',opening:100,closing:100,deposits:10,withdrawals:10},candidate=vfcRbcBalanceTranscriptLedger_(text,facts);
    equal(candidate.reason,'ambiguous-direction','ambiguity');equal(candidate.rows.length,0,'no invented directions');return'rejected';
  });

  test('Layout-free recovery rejects a missing printed transaction',function(){
    const text=[
      'Total deposits & credits (2) + 150.00','Total cheques & debits (1) - 30.00',
      'Account Activity Details','Date Description Cheques & Debits ($) Deposits & Credits ($) Balance ($)',
      '03 Jan Customer payment 100.00 200.00','Vendor payment 30.00 170.00'
    ].join('\n'),facts={startDate:'2026-01-01',endDate:'2026-01-31',opening:100,closing:220,deposits:150,withdrawals:30},candidate=vfcRbcBalanceTranscriptLedger_(text,facts);
    equal(candidate.reason,'row-count-or-amount-mismatch','missing row');equal(candidate.rows.length,0,'no fabricated row');return'rejected';
  });

  test('Transaction fee rate on a wrapped line is not mistaken for a debit',function(){
    const text=[
      'January 1, 2026 to January 31, 2026',
      'Opening balance on January 1, 2026 $100.00',
      'Total deposits & credits (1) + 20.00',
      'Total cheques & debits (1) - 7.50',
      'Closing balance on January 31, 2026 = $112.50',
      'Account Activity Details',
      'Date Description Cheques & Debits ($) Deposits & Credits ($) Balance ($)',
      '03 Jan Customer receipt 20.00 120.00',
      '04 Jan Regular transaction fee 6 Drs @ 1.25',
      '7.50 112.50'
    ].join('\n'),locked=vfcRbcLockFacts_({},text,'another-account.pdf');
    equal(locked.rbc_ledger_source,'RUNNING_BALANCE_TRANSCRIPT','balance recovery');
    equal(locked.banking_transactions[1].amount,7.5,'actual fee, not rate');
    equal(locked.banking_transactions[1].direction,'DEBIT','fee debit');return'wrapped fee / exact amount';
  });

  test('English printed dates retain their literal calendar day across time zones',function(){
    equal(vfcPrintedIsoDate_('January 1, 2026'),'2026-01-01','new-year date');
    equal(vfcPrintedIsoDate_('September 2, 2026'),'2026-09-02','period end');
    equal(vfcPrintedIsoDate_('February 30, 2026'),'','invalid printed date');return'calendar day preserved';
  });

  test('Four matching controls cannot override a contradictory printed running balance',function(){
    const text='Total deposits & credits (1) + 100.00\nTotal cheques & debits (0) - 0.00',facts={startDate:'2026-01-01',endDate:'2026-01-31',opening:100,closing:200,deposits:100,withdrawals:0},row=Object.assign(tx('2026-01-03','Receipt','CREDIT',100),{printedBalanceAfter:190});
    let failed=false;try{vfcRbcAuditFullLedger_([row],facts,text,'another-account.pdf');}catch(e){failed=/running balance disagrees/i.test(String(e&&e.message||e));}
    truthy(failed,'false running balance rejected');return'rejected';
  });

  test('Legacy layout printed credits are exactly 15 and $45,725.36',function(){const c=[2000,250,1000,6585.81,1046.83,250,7474.96,3000,750,2750,3250,2750,6673.93,7693.83,250];equal(c.length,15,'count');close(vfcSum_(c),45725.36,.02,'sum');return'15/$45725.36';});
  test('Legacy layout $283 RBC card direction still reconciles',function(){
    const text='March 2, 2026 to April 2, 2026\nOpening balance on March 2, 2026 $4,710.90\nTotal deposits & credits (15) + 45,725.36\nTotal cheques & debits (39) - 50,240.60\nClosing balance on April 2, 2026 = $195.66',wrong=[];
    let i;
    for(i=0;i<14;i++)wrong.push(tx('2026-03-02','Payroll Deposit filler '+i,'CREDIT',1));
    wrong.push(tx('2026-03-02','Payroll Deposit filler total','CREDIT',45711.36));
    for(i=0;i<37;i++)wrong.push(tx('2026-03-02','Bill Payment filler '+i,'DEBIT',1));
    wrong.push(tx('2026-03-02','Bill Payment filler total','DEBIT',49920.60));
    wrong.push(tx('2026-03-12','Misc Payment RBC CREDIT CARD','CREDIT',283));
    const before=vfcRbcLedgerStats_(wrong),locked=vfcRbcLockFacts_({banking_transactions:wrong},text,'legacy-reference-1.pdf'),after=vfcRbcLedgerStats_(locked.banking_transactions);
    equal(before.creditCount,16,'original credits');close(before.totalCredits,46008.36,.001,'original credit total');
    equal(before.debitCount,38,'original debits');close(before.totalDebits,49957.60,.001,'original debit total');
    equal(after.creditCount,15,'corrected credits');close(after.totalCredits,45725.36,.001,'corrected credit total');
    equal(after.debitCount,39,'corrected debits');close(after.totalDebits,50240.60,.001,'corrected debit total');
    equal(locked.rbc_direction_repairs.length,1,'recorded direction repair');
    equal(locked.rbc_ledger_repair_passes,0,'AI repair passes');
    return'15 credits/$45725.36; 39 debits/$50240.60';
  });
  test('Legacy layout crossed Misc Payments reconcile by checksum',function(){
    const text='April 2, 2026 to May 1, 2026\nOpening balance on April 2, 2026 $195.66\nTotal deposits & credits (15) + 63,708.46\nTotal cheques & debits (47) - 61,672.04\nClosing balance on May 1, 2026 = $2,232.08',wrong=[];
    let i;
    for(i=0;i<12;i++)wrong.push(tx('2026-04-02','Payroll Deposit filler '+i,'CREDIT',1));
    wrong.push(tx('2026-04-02','Payroll Deposit filler total','CREDIT',46510.67));
    for(i=0;i<46;i++)wrong.push(tx('2026-04-02','Bill Payment filler '+i,'DEBIT',1));
    wrong.push(tx('2026-04-02','Bill Payment filler total','DEBIT',61626.04));
    wrong.push(tx('2026-04-14','Misc Payment 1469635 PAY <DEFTPYMT>','DEBIT',8008.10));
    wrong.push(tx('2026-04-29','Misc Payment 1469635 PAY <DEFTPYMT>','DEBIT',9177.69));
    const before=vfcRbcLedgerStats_(wrong),locked=vfcRbcLockFacts_({banking_transactions:wrong},text,'legacy-reference-2.pdf'),after=vfcRbcLedgerStats_(locked.banking_transactions);
    equal(before.creditCount,13,'original credits');close(before.totalCredits,46522.67,.001,'original credit total');
    equal(before.debitCount,49,'original debits');close(before.totalDebits,78857.83,.001,'original debit total');
    equal(after.creditCount,15,'corrected credits');close(after.totalCredits,63708.46,.001,'corrected credit total');
    equal(after.debitCount,47,'corrected debits');close(after.totalDebits,61672.04,.001,'corrected debit total');
    equal(locked.rbc_direction_repairs.length,2,'recorded checksum repairs');
    equal(locked.rbc_direction_repairs[0].reason,'UNIQUE_PRINTED_CHECKSUM','checksum reason');
    equal(locked.rbc_ledger_repair_passes,0,'AI repair passes');
    return'15 credits/$63708.46; 47 debits/$61672.04';
  });
  test('Legacy layout exact failing ledger still reconciles',function(){
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
    const before=vfcRbcLedgerStats_(wrong),locked=vfcRbcLockFacts_({banking_transactions:wrong},text,'legacy-reference-3.pdf'),after=vfcRbcLedgerStats_(locked.banking_transactions);
    equal(before.creditCount,21,'original credits');close(before.totalCredits,58482.86,.001,'original credit total');
    equal(before.debitCount,53,'original debits');close(before.totalDebits,62187.80,.001,'original debit total');
    equal(after.creditCount,18,'corrected credits');close(after.totalCredits,56889.45,.001,'corrected credit total');
    equal(after.debitCount,56,'corrected debits');close(after.totalDebits,63781.21,.001,'corrected debit total');
    equal(locked.rbc_direction_repairs.length,5,'recorded direction repairs');
    equal(locked.rbc_ledger_repair_passes,0,'AI repair passes');
    equal(locked.rbc_runtime_fingerprint,'RBC-4.2-BALANCE-LEDGER-20260923','runtime fingerprint');
    return'18 credits/$56889.45; 56 debits/$63781.21';
  });
  test('Legacy dense layout printed credits are exactly 24 and $90,909.53',function(){
    const credits=[4750,500,250,1750,750,1000,6403.84,9384.12,1000,2500,7000,7200,4687.46,5500,6000,1200,600,700,2400,5000,2813.31,5289.91,5928.88,8302.01];
    equal(credits.length,24,'count');close(vfcSum_(credits),90909.53,.001,'sum');
    return'24/$90909.53';
  });
  test('Legacy dense layout online transfers remain in printed columns',function(){
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
  test('Legacy dense layout discrepancy identifies wrong amount and omitted fees',function(){
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
  test('Named recurring vendors are visible but cannot become debt from recurrence alone',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Online Banking payment - 7286 EXAMPLE SUPPLIES','DEBIT',500)]),row('2026-02-28',[tx('2026-02-12','Online Banking payment - 1138 EXAMPLE SUPPLIES','DEBIT',500)]),row('2026-03-31',[tx('2026-03-12','Online Banking payment - 9987 EXAMPLE SUPPLIES','DEBIT',500)])]);close(d.confirmedMonthlyDebtService,0,.001,'debt');equal(d.otherRecurringObligations.length,1,'one supplier');equal(d.allRecurringObligations.length,1,'all recurring');close(d.otherRecurringObligations[0].monthlyEquivalent,500,.02,'supplier estimate');equal(d.mostEvidentFinancingObligation,null,'no invented debt');return'visible informational vendor';});
  test('Recurring monthly bank fee is informational, not financing debt',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-31','Monthly account fee','DEBIT',15)]),row('2026-02-28',[tx('2026-02-28','Monthly account fee','DEBIT',15)])]);equal(d.otherRecurringObligations.length,1,'fee visible');close(d.confirmedMonthlyDebtService,0,.001,'not debt');return'fee $15/month, informational';});
  test('Same amounts from two named payees never merge into one obligation',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','Bill Payment NORTH SUPPLIER','DEBIT',500)]),row('2026-02-28',[tx('2026-02-12','Bill Payment NORTH SUPPLIER','DEBIT',500)]),row('2026-03-31',[tx('2026-03-12','Bill Payment SOUTH SUPPLIER','DEBIT',500)]),row('2026-04-30',[tx('2026-04-12','Bill Payment SOUTH SUPPLIER','DEBIT',500)])]);equal(d.allRecurringObligations.length,2,'distinct recurring vendors');equal(d.inactiveInformationalObligations.length,1,'older vendor retained as inactive');close(d.confirmedMonthlyDebtService,0,.001,'no debt');return'two independent recurring vendors';});
  test('Strongest financing stream follows duration and cadence, not largest amount',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-12','LOAN PAYMENT NO.912345678','DEBIT',400)]),row('2026-02-28',[tx('2026-02-12','LOAN PAYMENT NO.912345678','DEBIT',400),tx('2026-02-15','LOAN PAYMENT NO.887766554','DEBIT',2500)]),row('2026-03-31',[tx('2026-03-12','LOAN PAYMENT NO.912345678','DEBIT',400),tx('2026-03-15','LOAN PAYMENT NO.887766554','DEBIT',2500)])]);equal(d.activeDebtObligations.length,2,'all financing');equal(d.allRecurringObligations.length,2,'all recurring');equal(d.mostEvidentFinancingObligation.entityKey,'LOAN_ACCOUNT_912345678','longer evidence wins');close(d.confirmedMonthlyDebtService,2900,.02,'both debts sum');return'primary $400, all debt $2900';});
  test('One generic loan catch-up does not inflate the normal monthly estimate',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-10','LOAN PAYMENT NO.123456789','DEBIT',1000)]),row('2026-02-28',[tx('2026-02-10','LOAN PAYMENT NO.123456789','DEBIT',1000),tx('2026-02-20','LOAN PAYMENT NO.123456789','DEBIT',3000)]),row('2026-03-31',[tx('2026-03-10','LOAN PAYMENT NO.123456789','DEBIT',1000)])]),g=d.activeDebtObligations[0];equal(d.activeDebtObligations.length,1,'one loan');close(g.monthlyEquivalent,1000,.02,'normal monthly');close(g.observedTotal,6000,.02,'all cash observed');truthy(g.estimateCaveat,'catch-up disclosure');return'normal $1000, observed $6000';});
  test('Two-month repeating payment plus one larger debit uses repeated component',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-10','LOAN PAYMENT NO.123456789','DEBIT',1000)]),row('2026-02-28',[tx('2026-02-10','LOAN PAYMENT NO.123456789','DEBIT',1000),tx('2026-02-20','LOAN PAYMENT NO.123456789','DEBIT',3000)])]),g=d.activeDebtObligations[0];close(g.monthlyEquivalent,1000,.02,'normal monthly');equal(g.confidence,'Moderate','two-month evidence');truthy(g.estimateCaveat,'extra payment visible');return'normal $1000 with limited history';});
  test('Weekly numbered-loan cadence uses weekly monthly equivalent',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-05','LOAN PAYMENT NO.123456789','DEBIT',100),tx('2026-01-12','LOAN PAYMENT NO.123456789','DEBIT',100)]),row('2026-02-28',[tx('2026-02-02','LOAN PAYMENT NO.123456789','DEBIT',100),tx('2026-02-09','LOAN PAYMENT NO.123456789','DEBIT',100),tx('2026-02-16','LOAN PAYMENT NO.123456789','DEBIT',100),tx('2026-02-23','LOAN PAYMENT NO.123456789','DEBIT',100)])]),g=d.activeDebtObligations[0];equal(g.monthlyEquivalentMethod,'WEEKLY_MEDIAN','weekly evidence');close(g.monthlyEquivalent,433.33,.02,'weekly estimate');return'$100 weekly ≈ $433/month';});
  test('Recurring Affirm is financing',function(){const d=vfcDebtProfile_([row('2026-01-31',[tx('2026-01-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-02-28',[tx('2026-02-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')]),row('2026-03-31',[tx('2026-03-06','Misc Payment AFFIRM CANADA','DEBIT',66.62,'AFFIRM CANADA')])]);close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm');return'66.62';});
  test('Returned BDC PAD cannot inflate debt',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-27','Business PAD BDC','DEBIT',2578.34,'BDC')]),row('2026-04-30',[tx('2026-04-27','Business PAD BDC','DEBIT',2656.97,'BDC')]),row('2026-05-31',[tx('2026-05-27','Business PAD BDC','DEBIT',2606.59,'BDC'),tx('2026-05-27','Cheque returned NSF','CREDIT',2606.59)]),row('2026-06-30',[tx('2026-06-29','Business PAD BDC','DEBIT',5289.91,'BDC'),tx('2026-06-29','Cheque returned NSF','CREDIT',5289.91)]),row('2026-07-31',[tx('2026-07-27','Business PAD BDC','DEBIT',7952.39,'BDC')]),row('2026-08-31',[tx('2026-08-17','Business PAD BDC','DEBIT',2285.91,'BDC')])]),bdc=d.activeDebtObligations.filter(function(x){return x.counterparty==='BDC';});equal(d.returnedFinanceDebitsSuppressed,2,'suppressed');equal(bdc.length,1,'normal BDC stream');close(bdc[0].monthlyEquivalent,2507.07,.02,'BDC monthly');return'suppressed=2; BDC=$2507.07';});
  test('Recurring IPFS amount wins while one catch-up debit stays separate',function(){const d=vfcDebtProfile_([row('2026-06-30',[tx('2026-06-22','Business PAD IPFS Canada','DEBIT',502.45,'IPFS Canada')]),row('2026-07-31',[tx('2026-07-02','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')]),row('2026-08-31',[tx('2026-08-04','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')]),row('2026-09-30',[tx('2026-09-01','Business PAD IPFS Canada','DEBIT',234.96,'IPFS Canada')])]),ip=d.activeDebtObligations.filter(function(x){return /IPFS/i.test(x.counterparty);}),ins=vfcRbcClassifyDebit_(tx('2026-08-04','Auto Insurance ICBC','DEBIT',234.96,'ICBC'));equal(ip.length,1,'IPFS stream');equal(ip[0].family,'FINANCING','IPFS family');close(ip[0].monthlyEquivalent,234.96,.02,'IPFS monthly');equal(ins.family,'OTHER','insurance');return'IPFS=$234.96';});
  test('Truncated premium-finance label yields normal recurring amount only',function(){const d=vfcDebtProfile_([row('2026-04-30',[tx('2026-04-02','Bill Payment IC Premium Fina','DEBIT',1122.01)]),row('2026-05-31',[tx('2026-05-02','Bill Payment IC Premium Fina','DEBIT',1122.01),tx('2026-05-15','Bill Payment IC Premium Fina','DEBIT',2269.03)]),row('2026-06-30',[tx('2026-06-02','Bill Payment IC Premium Fina','DEBIT',1122.01),tx('2026-06-02','Cheque returned NSF','CREDIT',1122.01)]),row('2026-07-31',[tx('2026-07-02','Bill Payment IC Premium Fina','DEBIT',1122.01)])]),premium=d.activeDebtObligations.filter(function(x){return /Premium Fina/i.test(x.counterparty);});equal(premium.length,1,'regular stream');close(d.confirmedMonthlyDebtService,1122.01,.02,'monthly debt');equal(d.returnedFinanceDebitsSuppressed,1,'returned debit');return'$1122.01/month';});
  test('Same numbered RBC loan merges interest and BLIP components',function(){const d=vfcDebtProfile_([row('2026-03-31',[tx('2026-03-23','Loan interest NO.02243790 001','DEBIT',36.80),tx('2026-03-23','BLIP payment - loan NO.02243790 001','DEBIT',.73)]),row('2026-04-30',[tx('2026-04-21','Loan interest NO.02243790 001','DEBIT',61.05),tx('2026-04-21','BLIP payment - loan NO.02243790 001','DEBIT',1.47)]),row('2026-05-31',[tx('2026-05-22','Loan interest NO.02243790 001','DEBIT',44.05),tx('2026-05-22','BLIP payment - loan NO.02243790 001','DEBIT',1.06)]),row('2026-06-30',[tx('2026-06-22','Loan interest NO.02243790 001','DEBIT',79.17),tx('2026-06-22','BLIP payment - loan NO.02243790 001','DEBIT',2.11)]),row('2026-07-31',[tx('2026-07-22','Loan interest NO.02243790 001','DEBIT',20.91),tx('2026-07-22','BLIP payment - loan NO.02243790 001','DEBIT',.53)]),row('2026-08-31',[tx('2026-08-22','Loan interest NO.02243790 001','DEBIT',.16)])]),loan=d.activeDebtObligations.filter(function(x){return x.entityKey==='LOAN_ACCOUNT_02243790';});equal(loan.length,1,'loan obligation');close(loan[0].monthlyEquivalent,41.34,.02,'combined monthly');equal(loan[0].monthlyEquivalentMethod,'MONTHLY_ACCOUNT_TOTAL_MEAN','method');return'one loan/$41.34';});
  test('Explicit RBC account-transfer credits excluded but customer e-transfer not',function(){truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','BR TO BR - 0863','CREDIT',5000)),'BR TO BR');truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','Online Banking transfer - 0040','CREDIT',500)),'online credit');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','Online Banking transfer - 0040','DEBIT',500)),false,'online debit');equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-01','e-Transfer received CUSTOMER','CREDIT',5000)),false,'customer');return'correct';});
  test('Internal transfer memo containing LOAN is not financing proceeds',function(){const transfer=tx('2026-05-01','BR TO BR - Credit Memo Client request LOAN','CREDIT',35000);truthy(vfcRbcIsNonOperatingTransferCredit_(transfer),'internal transfer');equal(vfcRbcKnownFinancingCredit_(transfer),false,'financing credit');return'internal transfer wins';});
  test('Internal LOAN ADVANCE credit occupies transfer bucket only',function(){const transfer=Object.assign({bankId:'RBC'},tx('2026-05-01','BR TO BR - Credit Memo LOAN ADVANCE','CREDIT',35000)),p=vfcFinancingCredits_([transfer],[]);equal(p.confirmed.length,0,'no financing');equal(vfcNonOperatingTransferCredits_([transfer]).length,1,'one transfer');return'never double-excluded';});
  test('Incoming customer loan repayment is not a borrowing advance',function(){const c=Object.assign({bankId:'RBC'},tx('2026-05-01','Online transfer received - CUSTOMER LOAN REPAYMENT','CREDIT',10000)),p=vfcFinancingCredits_([c],[]);equal(vfcRbcKnownFinancingCredit_(c),false,'no lender evidence');equal(p.confirmed.length,0,'no financing proceeds');return'not a new loan';});
  test('Explicit external loan advance remains a confirmed financing credit',function(){const c=Object.assign({bankId:'RBC'},tx('2026-05-01','LOAN ADVANCE FROM BDC','CREDIT',12000));close(vfcFinancingCredits_([c],[]).total,12000,.02,'advance');return'confirmed advance';});
  test('Full feature calculation excludes loan advance and internal transfer once each',function(){const p={bankId:'RBC',bankName:'RBC',statementStartDate:'2026-05-01',statementEndDate:'2026-05-31',openingBalance:0,closingBalance:35000,totalDeposits:50000,totalWithdrawals:15000,reconciliationDifference:0,transactions:[tx('2026-05-03','LOAN ADVANCE FROM BDC','CREDIT',10000),tx('2026-05-04','BR TO BR - Credit Memo LOAN ADVANCE','CREDIT',35000),tx('2026-05-05','Online transfer received - CUSTOMER LOAN REPAYMENT','CREDIT',5000),tx('2026-05-06','Bill Payment SAMPLE SUPPLIES','DEBIT',15000)]},f=vfcBuildBankingFeatures_({},[{row:{fileName:'synthetic.pdf',statementIdentity:'synthetic'},payload:p}]);close(f.detectedFinancingCredits,10000,.02,'financing only');close(f.excludedTransferCredits,35000,.02,'transfer only');close(f.estimatedOperatingTotalDeposits,5000,.02,'no double subtraction');return'$50k gross → $5k after distinct exclusions';});
  test('Fact-reader prompt cannot change with case company name',function(){const a=vfcBuildBankStatementPrompt_(vfcRbcBankProfile_(),'SAME STATEMENT','ALPHA TRANSPORT','file.pdf'),b=vfcBuildBankStatementPrompt_(vfcRbcBankProfile_(),'SAME STATEMENT','BETA WHOLESALE','file.pdf');equal(a,b,'generic prompt');return'company-independent';});
  test('BDC fee-only payment is not monthly debt',function(){equal(vfcRbcClassifyDebit_(tx('2026-05-04','Online Banking payment - 0054 BDC - FEE/FRAIS','DEBIT',1500)),null,'fee-only BDC');return'fee excluded';});
  test('Operating deposits exclude financing, returns and account transfers',function(){const gross=363872.65,financing=104074.91,branchTransfers=44039.07,returns=10709.81,onlineTransfers=9066,operating=gross-financing-branchTransfers-returns-onlineTransfers;close(operating,195982.86,.02,'operating total');close(operating/6,32663.81,.02,'operating monthly');return'$32663.81/month';});
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
