/**
 * VFC Unified Banking Intake 1.0
 *
 * Single shared statement-intake layer for every bank:
 * 1) lock printed statement header facts,
 * 2) parse explicit tagged debit/credit source rows,
 * 3) deterministically reconcile extracted transactions to the printed source direction,
 * 4) preserve critical return/reversal lifecycle rows,
 * 5) pass one clean ledger to BankingCore.
 *
 * Bank-specific wording and classification remain isolated in Bank_<BANK>.gs.
 * Underwriting math remains in BankingCore.gs.
 */
function vfcLockPrintedStatementFacts_(summary,text){summary=summary||{};const facts=vfcExtractPrintedStatementFacts_(text);if(facts.startDate)summary.statement_start_date=facts.startDate;if(facts.endDate)summary.statement_end_date=facts.endDate;if(facts.totalsVerified){summary.opening_balance=facts.opening;summary.closing_balance=facts.closing;summary.total_deposits=facts.deposits;summary.total_withdrawals=facts.withdrawals;}return summary;}
function vfcPrintedMoneyFromLabeledLine_(source,labelPatterns){
  const lines=String(source||'').replace(/\u00a0/g,' ').split(/\r?\n/);
  function moneyFromText_(value){
    const matches=String(value||'').match(/[+\-]?\s*\$?\s*\(?\-?\$?[0-9][0-9,]*\.\d{2}\)?/g)||[];
    if(!matches.length)return null;
    for(let i=matches.length-1;i>=0;i--){const n=vfcPrintedMoney_(matches[i]);if(n!==null)return n;}
    return null;
  }
  for(let i=0;i<lines.length;i++){
    const line=String(lines[i]||'');
    let matched=false;
    for(let j=0;j<labelPatterns.length;j++){if(labelPatterns[j].test(line)){matched=true;break;}}
    if(!matched)continue;
    let value=moneyFromText_(line);
    if(value!==null)return value;
    const next=String(lines[i+1]||'');
    if(next&&!/\b(?:Opening|Beginning|Closing|Ending)\s+balance\b|\bTotal\s+(?:deposits|credits|cheques?|debits|withdrawals)\b/i.test(next)){
      value=moneyFromText_(next);
      if(value!==null)return value;
    }
  }
  return null;
}
function vfcExtractPrintedStatementFacts_(text){
  const source=String(text||'').replace(/\u00a0/g,' '),out={startDate:'',endDate:'',opening:null,closing:null,deposits:null,withdrawals:null,totalsVerified:false};
  const monthRange=source.match(/([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\s+(?:to|through|[-–—])\s+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i),
        isoRange=source.match(/(\d{4}-\d{2}-\d{2})\s+(?:to|through|[-–—])\s+(\d{4}-\d{2}-\d{2})/i),range=monthRange||isoRange;
  if(range){out.startDate=vfcPrintedIsoDate_(range[1]);out.endDate=vfcPrintedIsoDate_(range[2]);}

  out.opening=vfcPrintedMoneyFromLabeledLine_(source,[/\bOpening\s+balance\b/i,/\bBeginning\s+balance\b/i]);
  out.closing=vfcPrintedMoneyFromLabeledLine_(source,[/\bClosing\s+balance\b/i,/\bEnding\s+balance\b/i]);
  out.deposits=vfcPrintedMoneyFromLabeledLine_(source,[/\bTotal\s+deposits\s*(?:&|and)\s+credits\b/i,/\bTotal\s+credits\b/i,/\bTotal\s+deposits\b/i]);
  out.withdrawals=vfcPrintedMoneyFromLabeledLine_(source,[/\bTotal\s+cheques?\s*(?:&|and)\s+debits\b/i,/\bTotal\s+withdrawals\b/i,/\bTotal\s+debits\b/i]);

  if(out.opening===null||out.closing===null||out.deposits===null||out.withdrawals===null){
    const printedDate='(?:[A-Za-z]{3,9}\\s+\\d{1,2},\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})',
          sep='\\s*(?:[|:=]\\s*)*',
          money='([+\\-]?\\s*\\$?\\s*\\(?\\-?\\$?[\\d,]+(?:\\.\\d{2})?\\)?)';
    if(out.opening===null)out.opening=vfcPrintedMoneyAfter_(source,[new RegExp('Opening\\s+balance(?:\\s+on\\s+'+printedDate+')?'+sep+money,'i'),new RegExp('Beginning\\s+balance'+sep+money,'i')]);
    if(out.closing===null)out.closing=vfcPrintedMoneyAfter_(source,[new RegExp('Closing\\s+balance(?:\\s+on\\s+'+printedDate+')?'+sep+money,'i'),new RegExp('Ending\\s+balance'+sep+money,'i')]);
    if(out.deposits===null)out.deposits=vfcPrintedMoneyAfter_(source,[new RegExp('Total\\s+deposits\\s*(?:&|and)\\s+credits(?:\\s*\\(\\d+\\))?'+sep+money,'i'),new RegExp('Total\\s+credits(?:\\s*\\(\\d+\\))?'+sep+money,'i'),new RegExp('Total\\s+deposits(?:\\s*\\(\\d+\\))?'+sep+money,'i')]);
    if(out.withdrawals===null)out.withdrawals=vfcPrintedMoneyAfter_(source,[new RegExp('Total\\s+cheques?\\s*(?:&|and)\\s+debits(?:\\s*\\(\\d+\\))?'+sep+money,'i'),new RegExp('Total\\s+withdrawals(?:\\s*\\(\\d+\\))?'+sep+money,'i'),new RegExp('Total\\s+debits(?:\\s*\\(\\d+\\))?'+sep+money,'i')]);
  }

  if(out.deposits!==null)out.deposits=Math.abs(out.deposits);
  if(out.withdrawals!==null)out.withdrawals=Math.abs(out.withdrawals);
  if(out.opening!==null&&out.closing!==null&&out.deposits!==null&&out.withdrawals!==null){
    const diff=(out.opening+out.deposits-out.withdrawals)-out.closing;
    out.totalsVerified=Math.abs(diff)<=5;
  }
  return out;
}
function vfcPrintedLineHasAmount_(source,labelPatterns,value){
  const target=Math.abs(Number(value));
  if(!isFinite(target))return false;
  const lines=String(source||'').replace(/\u00a0/g,' ').split(/\r?\n/);
  function hasAmount_(text){
    const matches=String(text||'').match(/[+\-]?\s*\$?\s*\(?\-?\$?[0-9][0-9,]*\.\d{2}\)?/g)||[];
    return matches.some(function(m){const n=vfcPrintedMoney_(m);return n!==null&&Math.abs(Math.abs(n)-target)<=.01;});
  }
  for(let i=0;i<lines.length;i++){
    if(!labelPatterns.some(function(re){return re.test(lines[i]);}))continue;
    let block=String(lines[i]||'');
    for(let j=1;j<=3&&i+j<lines.length;j++){
      const next=String(lines[i+j]||'');
      if(j>1&&/\b(?:Opening|Beginning|Closing|Ending)\s+balance\b|\bTotal\s+(?:deposits|credits|cheques?|debits|withdrawals)\b/i.test(next))break;
      block+='\n'+next;
    }
    if(hasAmount_(block))return true;
  }
  return false;
}
function vfcPrintedDateVisible_(source,isoDate){
  const iso=String(isoDate||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))return false;
  const d=new Date(iso+'T12:00:00');
  if(isNaN(d.getTime()))return false;
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'],
        short=months[d.getMonth()].slice(0,3),day=d.getDate(),year=d.getFullYear(),
        text=String(source||'');
  return text.indexOf(iso)>=0||
    new RegExp('(?:'+months[d.getMonth()]+'|'+short+')\\s+'+day+',\\s*'+year,'i').test(text);
}
function vfcSummaryMoneyNull_(v){
  if(v===null||v===undefined||String(v).trim()==='')return null;
  const n=Number(String(v).replace(/[$,()]/g,'').replace(/^\s*\+/,'').trim());
  if(!isFinite(n))return null;
  return /^\s*\(/.test(String(v))?-Math.abs(n):n;
}
function vfcVerifiedHeaderFactsFromText_(text,summary){
  summary=summary||{};
  const start=vfcPrintedIsoDate_(summary.statement_start_date||summary.statementStartDate||''),
        end=vfcPrintedIsoDate_(summary.statement_end_date||summary.statementEndDate||''),
        opening=vfcSummaryMoneyNull_(summary.opening_balance!=null?summary.opening_balance:summary.openingBalance),
        closing=vfcSummaryMoneyNull_(summary.closing_balance!=null?summary.closing_balance:summary.closingBalance),
        deposits=vfcSummaryMoneyNull_(summary.total_deposits!=null?summary.total_deposits:summary.totalDeposits),
        withdrawals=vfcSummaryMoneyNull_(summary.total_withdrawals!=null?summary.total_withdrawals:summary.totalWithdrawals);
  if(!start||!end||opening===null||closing===null||deposits===null||withdrawals===null)return null;
  if(!vfcPrintedDateVisible_(text,start)||!vfcPrintedDateVisible_(text,end))return null;
  if(!vfcPrintedLineHasAmount_(text,[/\bOpening\s+balance\b/i,/\bBeginning\s+balance\b/i],opening))return null;
  if(!vfcPrintedLineHasAmount_(text,[/\bClosing\s+balance\b/i,/\bEnding\s+balance\b/i],closing))return null;
  if(!vfcPrintedLineHasAmount_(text,[/\bTotal\s+deposits\s*(?:&|and)\s+credits\b/i,/\bTotal\s+credits\b/i,/\bTotal\s+deposits\b/i],deposits))return null;
  if(!vfcPrintedLineHasAmount_(text,[/\bTotal\s+cheques?\s*(?:&|and)\s+debits\b/i,/\bTotal\s+withdrawals\b/i,/\bTotal\s+debits\b/i],withdrawals))return null;
  const d=Math.abs((opening+Math.abs(deposits)-Math.abs(withdrawals))-closing);
  if(d>.05)return null;
  return{startDate:start,endDate:end,opening:opening,closing:closing,deposits:Math.abs(deposits),withdrawals:Math.abs(withdrawals),totalsVerified:true,verificationSource:'VISIBLE_HEADER_VALUES'};
}
function vfcResolvePrintedStatementFacts_(text,summary){
  const parsed=vfcExtractPrintedStatementFacts_(text),
        complete=parsed.startDate&&parsed.endDate&&parsed.opening!==null&&parsed.closing!==null&&parsed.deposits!==null&&parsed.withdrawals!==null,
        diff=complete?Math.abs((parsed.opening+parsed.deposits-parsed.withdrawals)-parsed.closing):Infinity;
  if(complete&&diff<=.05){parsed.totalsVerified=true;parsed.verificationSource='PRINTED_PARSER';return parsed;}
  const verified=vfcVerifiedHeaderFactsFromText_(text,summary);
  if(verified)return verified;
  parsed.verificationSource='UNVERIFIED';
  return parsed;
}
function vfcPrintedMoneyAfter_(source,patterns){for(let i=0;i<patterns.length;i++){const match=source.match(patterns[i]);if(!match||!match[1])continue;const value=vfcPrintedMoney_(match[1]);if(value!==null)return value;}return null;}
function vfcPrintedMoney_(value){const raw=String(value||'').trim();if(!raw)return null;const negative=/^\s*-/.test(raw)||/-\s*\$/.test(raw)||/^\s*\(/.test(raw),cleaned=raw.replace(/[^0-9.]/g,'');if(!cleaned)return null;const number=parseFloat(cleaned);return isFinite(number)?(negative?-number:number):null;}
function vfcPrintedIsoDate_(value){if(!value)return'';const direct=String(value).match(/^\d{4}-\d{2}-\d{2}$/);if(direct)return direct[0];const date=new Date(value);return isNaN(date.getTime())?'':Utilities.formatDate(date,Session.getScriptTimeZone(),'yyyy-MM-dd');}


function vfcTaggedSourceAmount_(row,label){
  const text=String(row||'').replace(/\u00a0/g,' '),re=new RegExp('\\b'+String(label||'')+'\\s*(?:[:=]\\s*)?(?:\\$\\s*)?(\\(?-?[0-9][0-9,]*\\.\\d{2}\\)?)','i'),m=text.match(re);
  if(!m)return null;return vfcNumNull_(m[1]);
}
function vfcTaggedSourceDirection_(row,amount){
  const target=vfcRound_(vfcNum_(amount),.01);if(!(target>0))return'';
  const debit=vfcTaggedSourceAmount_(row,'DEBIT'),credit=vfcTaggedSourceAmount_(row,'CREDIT'),
        d=debit!==null&&Math.abs(debit-target)<=.01,c=credit!==null&&Math.abs(credit-target)<=.01;
  if(d===c)return'';return d?'DEBIT':'CREDIT';
}
function vfcSourceDirectionMatchScore_(t,row){
  const hay=String(row||'').toUpperCase(),tokens=vfcTokens_(String(t&&t.counterparty||'')+' '+String(t&&t.description||''));let score=0,seen={};
  tokens.forEach(function(token){if(seen[token])return;seen[token]=1;if(hay.indexOf(token)>=0)score++;});
  return score;
}
function vfcDirectionEvidenceFromSource_(t,text){
  if(!t||!(vfcNum_(t.amount)>0))return'';
  const candidates=[];
  function consider(row,bonus){
    const dir=vfcTaggedSourceDirection_(row,t.amount);if(!dir)return;
    const score=vfcSourceDirectionMatchScore_(t,row)+(bonus||0);
    if(score>0)candidates.push({direction:dir,score:score});
  }
  if(t.source_row)consider(t.source_row,100);
  String(text||'').split(/\r?\n/).forEach(function(line){consider(line,0);});
  if(!candidates.length)return'';
  candidates.sort(function(a,b){return b.score-a.score||a.direction.localeCompare(b.direction);});
  const best=candidates[0],conflict=candidates.some(function(x){return x.direction!==best.direction&&x.score===best.score;});
  return conflict?'':best.direction;
}
function vfcValidateTransactionDirectionsFromSource_(summary,text,bankId){
  summary=Object.assign({},summary||{});
  const txs=Array.isArray(summary.banking_transactions)?summary.banking_transactions:[],corrected=[],verified=[],unresolved=[];
  summary.banking_transactions=txs.map(function(t,index){
    const row=Object.assign({},t),evidence=vfcDirectionEvidenceFromSource_(row,text),before=String(row.direction||'').toUpperCase();
    if(evidence){
      verified.push(index);
      row.source_column=evidence;
      if(before!==evidence){row.direction=evidence;corrected.push({index:index,description:String(row.description||''),amount:vfcRound_(vfcNum_(row.amount),.01),from:before,to:evidence});}
    }else unresolved.push(index);
    delete row.source_row;
    return row;
  });
  summary._direction_validation={method:'SOURCE_COLUMN_TAGS_V1',bankId:String(bankId||'UNKNOWN').toUpperCase(),transactionCount:txs.length,verifiedCount:verified.length,correctedCount:corrected.length,unresolvedCount:unresolved.length,corrections:corrected.slice(0,25)};
  return summary;
}



function vfcIntakeAmount_(value){
  if(value===null||value===undefined||String(value).trim()==='')return null;
  const raw=String(value).trim(),neg=/^\s*-/.test(raw)||/^\s*\(/.test(raw),
        cleaned=raw.replace(/[^0-9.]/g,'');
  if(!cleaned)return null;
  const n=parseFloat(cleaned);
  return isFinite(n)?(neg?-n:n):null;
}
function vfcTaggedFields_(line){
  const fields={};
  String(line||'').split('|').forEach(function(part){
    const m=String(part||'').trim().match(/^(DATE|DESCRIPTION|DEBIT|CREDIT|BALANCE)\b\s*(.*)$/i);
    if(m)fields[m[1].toUpperCase()]=String(m[2]||'').trim();
  });
  return fields;
}
function vfcResolveTaggedStatementDate_(raw,startDate,endDate){
  const value=String(raw||'').trim();
  if(!value)return'';
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value;
  const direct=vfcPrintedIsoDate_(value);
  if(/\d{4}/.test(value)&&direct)return direct;

  const months={JAN:1,JANUARY:1,FEB:2,FEBRUARY:2,MAR:3,MARCH:3,APR:4,APRIL:4,MAY:5,JUN:6,JUNE:6,JUL:7,JULY:7,AUG:8,AUGUST:8,SEP:9,SEPT:9,SEPTEMBER:9,OCT:10,OCTOBER:10,NOV:11,NOVEMBER:11,DEC:12,DECEMBER:12};
  let m=value.match(/^(\d{1,2})\s+([A-Za-z]{3,9})$/),day,month;
  if(m){day=Number(m[1]);month=months[String(m[2]).toUpperCase()];}
  if(!m){m=value.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);if(m){month=months[String(m[1]).toUpperCase()];day=Number(m[2]);}}
  if(!day||!month)return direct||'';

  const start=String(startDate||''),end=String(endDate||''),
        sy=/^\d{4}/.test(start)?Number(start.slice(0,4)):new Date().getFullYear(),
        ey=/^\d{4}/.test(end)?Number(end.slice(0,4)):sy,
        candidates=[];
  for(let y=Math.min(sy,ey)-1;y<=Math.max(sy,ey)+1;y++){
    const iso=y+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');
    const time=Date.parse(iso+'T12:00:00Z');
    if(!isNaN(time))candidates.push({iso:iso,time:time});
  }
  const st=Date.parse(start+'T00:00:00Z'),et=Date.parse(end+'T23:59:59Z');
  const inRange=candidates.filter(function(x){return(!isNaN(st)?x.time>=st-3*86400000:true)&&(!isNaN(et)?x.time<=et+3*86400000:true);});
  if(inRange.length===1)return inRange[0].iso;
  if(inRange.length>1){
    const mid=(!isNaN(st)&&!isNaN(et))?(st+et)/2:inRange[0].time;
    inRange.sort(function(a,b){return Math.abs(a.time-mid)-Math.abs(b.time-mid);});
    return inRange[0].iso;
  }
  return direct||'';
}
function vfcParseTaggedStatementTransactions_(text,summary){
  summary=summary||{};
  const start=vfcPrintedIsoDate_(summary.statement_start_date||summary.statementStartDate||''),
        end=vfcPrintedIsoDate_(summary.statement_end_date||summary.statementEndDate||''),
        out=[];
  String(text||'').split(/\r?\n/).forEach(function(line,index){
    if(!/\bDATE\b/i.test(line)||!/\bDESCRIPTION\b/i.test(line)||!/\bDEBIT\b/i.test(line)||!/\bCREDIT\b/i.test(line))return;
    const f=vfcTaggedFields_(line),date=vfcResolveTaggedStatementDate_(f.DATE,start,end),desc=String(f.DESCRIPTION||'').replace(/\s+/g,' ').trim(),
          debit=vfcIntakeAmount_(f.DEBIT),credit=vfcIntakeAmount_(f.CREDIT);
    const hasDebit=debit!==null&&Math.abs(debit)>0,hasCredit=credit!==null&&Math.abs(credit)>0;
    if(!date||!desc||hasDebit===hasCredit)return;
    out.push({
      date:date,
      description:desc,
      counterparty:desc,
      direction:hasDebit?'DEBIT':'CREDIT',
      amount:Math.abs(hasDebit?debit:credit),
      sourceDirectionVerified:true,
      sourceTagged:true,
      sourceRowIndex:index+1
    });
  });
  return out;
}
function vfcIntakeTxTokens_(value){
  return String(value||'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').split(/\s+/).filter(function(x){
    return x.length>=3&&!/^(THE|AND|PAYMENT|MISC|DEBIT|CREDIT|DATE|DESCRIPTION|BALANCE|INC|LTD|CORP|COMPANY)$/.test(x)&&!/^\d+$/.test(x);
  });
}
function vfcIntakeMatchScore_(a,b){
  const ad=String(a&&a.description||'').toUpperCase().replace(/\s+/g,' ').trim(),
        bd=String(b&&b.description||'').toUpperCase().replace(/\s+/g,' ').trim(),
        at=vfcIntakeTxTokens_(String(a&&a.counterparty||'')+' '+ad),bt=vfcIntakeTxTokens_(bd),seen={};
  let score=0;
  at.forEach(function(t){if(seen[t])return;seen[t]=1;if(bt.indexOf(t)>=0)score+=10;});
  if(ad&&bd&&(ad===bd||ad.indexOf(bd)>=0||bd.indexOf(ad)>=0))score+=50;
  return score;
}
function vfcMatchTaggedTransaction_(tx,tagged,used){
  const date=vfcPrintedIsoDate_(tx&&tx.date||''),amount=Math.abs(vfcIntakeAmount_(tx&&tx.amount)||0),candidates=[];
  (tagged||[]).forEach(function(t,index){
    if(used[index])return;
    if(date&&String(t.date)!==date)return;
    if(Math.abs(Number(t.amount||0)-amount)>.01)return;
    const score=vfcIntakeMatchScore_(tx,t);
    if(score>0)candidates.push({index:index,t:t,score:score});
  });
  if(!candidates.length)return null;
  candidates.sort(function(a,b){return b.score-a.score||a.index-b.index;});
  if(candidates[1]&&candidates[0].score===candidates[1].score&&candidates[0].t.direction!==candidates[1].t.direction)return null;
  used[candidates[0].index]=1;
  return candidates[0].t;
}
function vfcIntakeCriticalTaggedRow_(t){
  const s=String(t&&t.description||'').toUpperCase();
  if(!s||/\bFEE\b|\bCHARGE\b/.test(s))return false;
  return /RETURNED\s+UNPAID|ITEM\s+RETURNED|CHEQUE\s+RETURNED|CHECK\s+RETURNED|RETURNED\s+ITEM|RETURNED\s+PAYMENT|PAYMENT\s+RETURNED|NSF\s+(?:ITEM\s+)?RETURN|\bREVERSAL\b/.test(s);
}
function vfcUnifiedBankStatementIntake_(bankId,summary,text,fileName){
  const id=String(bankId||'UNKNOWN').toUpperCase();
  let locked=vfcLockBankStatementFacts_(id,Object.assign({},summary||{}),text,fileName)||Object.assign({},summary||{});
  const extracted=Array.isArray(locked.banking_transactions)?locked.banking_transactions:[],
        tagged=vfcParseTaggedStatementTransactions_(text,locked),
        used={},corrected=[],out=[];
  let verified=0,unresolved=0;

  extracted.forEach(function(tx,index){
    const row=Object.assign({},tx),match=vfcMatchTaggedTransaction_(row,tagged,used),
          before=String(row.direction||'').toUpperCase();
    if(match){
      row.direction=match.direction;
      row.sourceDirectionVerified=true;
      row.sourceTagged=true;
      row.sourceRowIndex=match.sourceRowIndex;
      verified++;
      if(before!==match.direction)corrected.push({index:index,description:String(row.description||''),amount:Math.abs(vfcIntakeAmount_(row.amount)||0),from:before,to:match.direction});
    }else{
      const evidence=vfcDirectionEvidenceFromSource_(row,text);
      if(evidence){
        row.direction=evidence;
        row.sourceDirectionVerified=true;
        verified++;
        if(before!==evidence)corrected.push({index:index,description:String(row.description||''),amount:Math.abs(vfcIntakeAmount_(row.amount)||0),from:before,to:evidence});
      }else{
        row.sourceDirectionVerified=false;
        unresolved++;
      }
    }
    delete row.source_row;
    out.push(row);
  });

  let addedCritical=0;
  tagged.forEach(function(t,index){
    if(used[index]||!vfcIntakeCriticalTaggedRow_(t))return;
    out.push(Object.assign({},t,{counterparty:t.description}));
    used[index]=1;addedCritical++;
  });

  locked.banking_transactions=out;
  locked._direction_validation={
    method:'UNIFIED_TAGGED_LEDGER_V1',
    intakeEngineVersion:'VFC-BANK-INTAKE-1.0',
    bankId:id,
    transactionCount:out.length,
    taggedRowCount:tagged.length,
    verifiedCount:verified+addedCritical,
    correctedCount:corrected.length,
    unresolvedCount:unresolved,
    criticalRowsAdded:addedCritical,
    corrections:corrected.slice(0,25)
  };
  locked._intake_engine_version='VFC-BANK-INTAKE-1.0';
  return locked;
}

function runBankingIntakeSelfTests(){
  const results=[];
  function test(name,fn){try{results.push({name:name,pass:true,detail:String(fn()||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}
  function equal(a,b,label){if(a!==b)throw new Error((label||'value')+' expected '+b+' but got '+a);}
  function close(a,b,tol,label){if(Math.abs(Number(a||0)-Number(b||0))>(tol==null?.02:tol))throw new Error((label||'value')+' expected '+b+' but got '+a);}

  test('Tagged ledger reads deposit direction from printed CREDIT column',function(){
    const rows=vfcParseTaggedStatementTransactions_(
      'DATE 13 May | DESCRIPTION Misc Payment ZOMI LIFE LTD-A | DEBIT | CREDIT 712.99 | BALANCE 6,848.71',
      {statement_start_date:'2026-05-05',statement_end_date:'2026-06-05'}
    );
    equal(rows.length,1,'row count');equal(rows[0].direction,'CREDIT','direction');close(rows[0].amount,712.99,.001,'amount');return rows[0].direction;
  });

  test('Tagged ledger keeps genuine debit direction',function(){
    const rows=vfcParseTaggedStatementTransactions_(
      'DATE 31 Aug | DESCRIPTION e-Transfer sent Keto Caveman | DEBIT 5,000.00 | CREDIT | BALANCE 530.98',
      {statement_start_date:'2026-08-05',statement_end_date:'2026-09-04'}
    );
    equal(rows[0].direction,'DEBIT','direction');close(rows[0].amount,5000,.001,'amount');return rows[0].direction;
  });

  test('Tagged ledger keeps MRCH debit separate from DP-style credits',function(){
    const rows=vfcParseTaggedStatementTransactions_(
      'DATE 02 Jul | DESCRIPTION Misc Payment MRCH29544070014 29544070014 | DEBIT 554.32 | CREDIT | BALANCE 12,443.67',
      {statement_start_date:'2026-06-05',statement_end_date:'2026-07-03'}
    );
    equal(rows[0].direction,'DEBIT','MRCH direction');return rows[0].direction;
  });

  test('Unified direction match corrects ZOMI and FANTUAN without changing Keto',function(){
    const tagged=vfcParseTaggedStatementTransactions_([
      'DATE 13 May | DESCRIPTION Misc Payment ZOMI LIFE LTD-A | DEBIT | CREDIT 712.99 | BALANCE 6,848.71',
      'DATE 31 Aug | DESCRIPTION e-Transfer sent Keto Caveman | DEBIT 5,000.00 | CREDIT | BALANCE 530.98',
      'DATE 02 Sep | DESCRIPTION Misc Payment FANTUAN | DEBIT | CREDIT 47.47 | BALANCE 8,601.83'
    ].join('\n'),{statement_start_date:'2026-05-05',statement_end_date:'2026-09-04'}),used={},
      z=vfcMatchTaggedTransaction_({date:'2026-05-13',description:'Misc Payment ZOMI LIFE LTD-A',counterparty:'ZOMI LIFE LTD-A',amount:712.99},tagged,used),
      k=vfcMatchTaggedTransaction_({date:'2026-08-31',description:'e-Transfer sent Keto Caveman',counterparty:'Keto Caveman',amount:5000},tagged,used),
      f=vfcMatchTaggedTransaction_({date:'2026-09-02',description:'Misc Payment FANTUAN',counterparty:'FANTUAN',amount:47.47},tagged,used);
    equal(z.direction,'CREDIT','ZOMI');equal(k.direction,'DEBIT','Keto');equal(f.direction,'CREDIT','FANTUAN');return'ZOMI/FANTUAN credits, Keto debit';
  });

  test('Returned customer deposit marker is preserved as critical tagged row',function(){
    const rows=vfcParseTaggedStatementTransactions_(
      'DATE 20 May | DESCRIPTION Item returned unpaid S04453 | DEBIT 16,000.00 | CREDIT | BALANCE 4,750.11',
      {statement_start_date:'2026-05-05',statement_end_date:'2026-06-05'}
    );
    equal(vfcIntakeCriticalTaggedRow_(rows[0]),true,'critical return marker');return rows[0].direction;
  });

  test('No printed direction evidence means no invented correction',function(){
    const fixed=vfcValidateTransactionDirectionsFromSource_(
      {banking_transactions:[{date:'2026-01-01',description:'Misc Payment ABC',counterparty:'ABC',direction:'DEBIT',amount:500}]},
      '01 Jan Misc Payment ABC 500.00 1000.00','RBC'
    );
    equal(fixed.banking_transactions[0].direction,'DEBIT','unchanged direction');
    equal(fixed._direction_validation.unresolvedCount,1,'unresolved count');
    return'no guess';
  });

  const failed=results.filter(function(x){return!x.pass;});
  return{ok:failed.length===0,intakeVersion:'VFC-BANK-INTAKE-1.0',total:results.length,passed:results.length-failed.length,failed:failed.length,results:results};
}
