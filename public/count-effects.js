(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('../src/shared/invoice-math'));
  else root.CountEffects=factory(root.InvoiceMath);
})(typeof globalThis!=='undefined'?globalThis:this,(math)=>{
  const quantity=value=>Math.round(value*1000)/1000;
  function lineEffect(line){
    const raw=line.counted_qty;
    if(raw===null||raw===undefined||String(raw).trim()===''||!Number.isFinite(Number(raw))||Number(raw)<0)
      return {counted:false,quantity:null,value:null};
    const delta=quantity(Number(raw)-Number(line.book_qty));
    const rate=Number(delta>0?line.valuation_rate:line.book_rate);
    const valued=delta===0||Number.isFinite(rate)&&(delta>0?rate>0:rate>=0);
    const value=Number(raw)===0&&line.book_value!=null?-math.roundMoney(line.book_value):delta===0?0:!valued?null:delta<0&&line.book_value!=null&&Number(line.book_qty)>0
      ?-math.prorateMoney(line.book_value,Math.abs(delta),line.book_qty)
      :(delta>=0?1:-1)*math.multiplyMoney(Math.abs(delta),math.roundMoney(rate));
    return {counted:true,quantity:delta,value};
  }
  function summarize(lines){
    const result={total:lines.length,counted:0,pending:0,valuationPending:0,qtyGained:0,qtyLost:0,qtyNet:0,valueGained:0,valueLost:0,valueNet:0};
    for(const line of lines){
      const effect=lineEffect(line);
      if(!effect.counted){result.pending++;continue;}
      result.counted++;
      if(effect.quantity>0)result.qtyGained+=effect.quantity;
      else result.qtyLost-=effect.quantity;
      if(effect.value===null)result.valuationPending++;
      else if(effect.value>0)result.valueGained+=effect.value;
      else result.valueLost-=effect.value;
    }
    result.qtyGained=quantity(result.qtyGained);result.qtyLost=quantity(result.qtyLost);
    result.qtyNet=quantity(result.qtyGained-result.qtyLost);
    result.valueNet=result.valueGained-result.valueLost;
    return result;
  }
  const formatQuantity=value=>new Intl.NumberFormat('en-UG',{maximumFractionDigits:3}).format(Object.is(value,-0)?0:value);
  const formatAmount=value=>new Intl.NumberFormat('en-UG',{maximumFractionDigits:0}).format(value);
  return {lineEffect,summarize,formatQuantity,formatAmount};
});
