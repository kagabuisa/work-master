'use strict';
const router = require('express').Router();
const crypto = require('node:crypto');
const reset = require('../../transaction-reset');
const { authenticate } = require('../../auth');
const { rateLimit } = require('../../api/security');

function admin(req,res,next) {
  res.set('Cache-Control','private, no-store');
  if (req.currentUser?.role !== 'admin') {
    const error = new Error('Only administrators can access maintenance.'); error.status=403; return next(error);
  }
  next();
}
router.use('/settings/maintenance',admin);

function csrfToken(req,scope) {
  const pair = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('wm_session='));
  if (!pair) { const error = new Error('Sign in again before opening maintenance.'); error.status=403; throw error; }
  return crypto.createHmac('sha256',pair.slice('wm_session='.length)).update(`maintenance:${req.currentUser.id}:${scope}`).digest('hex');
}
function checkCsrf(req,scope) {
  const expected = Buffer.from(csrfToken(req,scope));
  const supplied = Buffer.from(String(req.body.csrf_token || ''));
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected,supplied)) {
    const error = new Error('The confirmation page is invalid. Reload maintenance and try again.'); error.status=403; throw error;
  }
}
async function render(req,res,scope,error=null,status=200) {
  const {scope:resetScope,...data} = await reset.maintenanceView(req.currentUser,scope,req.query.backup || req.body?.backup_id);
  res.status(status).render('maintenance',{...data,resetScope,error,csrfToken:csrfToken(req,scope)});
}
async function failure(req,res,next,error,scope) {
  try { await render(req,res,['financial','all'].includes(scope) ? scope : 'financial',error.message,error.status || 500); }
  catch (renderError) { next(renderError); }
}
router.get('/settings/maintenance',async(req,res,next)=>{
  try { await render(req,res,req.query.scope || 'financial'); } catch(error) { next(error); }
});
router.post('/settings/maintenance/backup',async(req,res,next)=>{
  const scope=req.body.scope;
  try {
    reset.validateScope(scope); checkCsrf(req,scope);
    await rateLimit(req,res,'maintenance-backup',req.currentUser.id,6,900);
    const backup=await reset.createBackup(req.currentUser,scope);
    res.redirect(303,`/settings/maintenance?scope=${scope}&backup=${backup.id}`);
  } catch(error) { await failure(req,res,next,error,scope); }
});
router.get('/settings/maintenance/backups/:id',async(req,res,next)=>{
  try {
    const backup=await reset.backupDownload(req.currentUser,req.params.id);
    res.download(backup.file,backup.name,error=>{if(error&&!res.headersSent)next(error);});
  } catch(error) { next(error); }
});
router.post('/settings/maintenance/reset',async(req,res,next)=>{
  const scope=req.body.scope;
  try {
    reset.validateScope(scope); checkCsrf(req,scope);
    if (req.body.confirmation !== 'RESET TRANSACTIONS') {
      const error=new Error('Type RESET TRANSACTIONS exactly to confirm.');error.status=400;throw error;
    }
    await rateLimit(req,res,'maintenance-password',req.currentUser.id,5,900);
    const verified=await authenticate(req.currentUser.username,String(req.body.password || ''));
    if (!verified || verified.id!==Number(req.currentUser.id) || verified.role!=='admin' || verified.must_change_password) {
      const error=new Error('Your administrator password is incorrect or your administrator access has changed.');error.status=401;throw error;
    }
    await reset.resetTransactions(verified,scope,req.body.backup_id,req.body.confirmation,String(req.body.password || ''));
    res.clearCookie('wm_session',{path:'/'});
    res.redirect(303,'/login?reset=complete');
  } catch(error) { await failure(req,res,next,error,scope); }
});

module.exports=router;
