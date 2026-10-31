'use strict';
const router=require('express').Router();
const periods=require('../../accounting-periods');
const base='/accounting-periods';
async function render(req,res,error='',status=200) {
 periods.access(req.currentUser);
 const page=Math.max(1,Math.min(100000,Number.parseInt(req.query.page,10)||1));
 const rows=await periods.listPeriods(page);
 res.status(status).render('accounting-periods',{rows:rows.slice(0,50),page,hasNext:rows.length>50,error});
}
router.get(base,async(req,res,next)=>{try{await render(req,res);}catch(e){next(e);}});
router.post(base,async(req,res,next)=>{
 try{await periods.periodAction(req.currentUser,String(req.body.action||''),req.body);res.redirect(303,base);}
 catch(e){if([400,409].includes(e.status)){try{await render(req,res,e.message,e.status);}catch(err){next(err);}}else next(e);}
});
module.exports=router;
