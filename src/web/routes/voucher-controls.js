'use strict';
const router=require('express').Router();
const controls=require('../../voucher-controls');
const {getPostgresPool,withPostgresTransaction}=require('../../core');
const bases=[['purchases','/purchases'],['journals','/journals'],['stock','/stock/entries']];
router.use(async(req,res,next)=>{
  res.locals.voucherControl=null;
  const match=/^\/(purchases|journals|stock\/entries)\/([1-9][0-9]*)(?:\/(?:edit|drawer))?$/.exec(req.path);
  if (!match) return next();
  try {
    const kind=match[1]==='stock/entries'?'stock':match[1];
    res.locals.voucherControl=await controls.view(getPostgresPool(),kind,Number(match[2]));
    next();
  } catch(error) { next(error); }
});
for(const [kind,base] of bases)for(const approve of [false,true]) {
  router.post(base+'/:id/'+(approve?'action-approval':'action-request'),async(req,res,next)=>{
    try {
      await withPostgresTransaction(async client=>{
        const user=await require('../../sales-controls').currentUser(client);
        const fresh={path:req.path,method:req.method,body:req.body,currentUser:user};
        if (!require('../../authorize').permissionCheck(fresh) || !await require('../../authorize').scopeCheck(fresh)) {
          throw Object.assign(new Error('You cannot access this voucher action.'),{status:403});
        }
        await controls.act(client,kind,req.params.id,req.body,approve);
      });
      res.redirect(303,base+'/'+req.params.id);
    } catch(error) {
      if (error.status && error.status<500) res.redirect(303,base+'/'+req.params.id+'?error='+encodeURIComponent(error.message));
      else next(error);
    }
  });
}
module.exports=router;
