'use strict';
const { attachmentError, validateScans, saveAttachments } = require('./reconciliation-attachments');

async function initPhotoCountSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS app_reconciliation_photo_counts (
    stock_entry_id BIGINT NOT NULL REFERENCES app_stock_entries(id) ON DELETE CASCADE,
    photo_id TEXT NOT NULL, auditor_qty NUMERIC(14,3), verified_qty NUMERIC(14,3),
    updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(stock_entry_id, photo_id),
    CHECK(auditor_qty >= 0), CHECK(verified_qty >= 0));
    ALTER TABLE app_stock_reconciliation_attachments ADD COLUMN IF NOT EXISTS photo_id TEXT;`);
}

async function photoCountRows(client, voucherId) {
  return (await client.query(`WITH warehouses AS (
    SELECT DISTINCT warehouse FROM app_stock_entry_items WHERE stock_entry_id=$1
    UNION SELECT warehouse FROM wm_inventory_counts WHERE reconciliation_id=$1
  ), inventory AS (
    SELECT BTRIM(m.photo_count_id) AS photo_id, SUM(b.quantity) AS inventory_qty
    FROM app_stock_balances b JOIN warehouses w ON w.warehouse=b.warehouse
    JOIN app_master_items m ON m.item_code=b.item_code
    WHERE NULLIF(BTRIM(m.photo_count_id),'') IS NOT NULL
    GROUP BY BTRIM(m.photo_count_id)
  ), physical_lines AS (
    SELECT BTRIM(m.photo_count_id) AS photo_id, l.counted_qty AS physical_qty
    FROM wm_inventory_count_lines l JOIN wm_inventory_counts c ON c.id=l.count_id
    JOIN app_master_items m ON m.item_code=l.item_code
    WHERE c.reconciliation_id=$1 AND NULLIF(BTRIM(m.photo_count_id),'') IS NOT NULL
    UNION ALL
    SELECT BTRIM(m.photo_count_id), COALESCE(i.counted_quantity,i.quantity)
    FROM app_stock_entry_items i JOIN app_master_items m ON m.item_code=i.item_code
    WHERE i.stock_entry_id=$1 AND NULLIF(BTRIM(m.photo_count_id),'') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM wm_inventory_counts WHERE reconciliation_id=$1)
  ), physical AS (
    SELECT photo_id, CASE WHEN COUNT(physical_qty)=COUNT(*) THEN SUM(physical_qty) END AS physical_qty,
      (COUNT(*)-COUNT(physical_qty))::int AS uncounted_items
    FROM physical_lines GROUP BY photo_id
  ), ids AS (
    SELECT photo_id FROM inventory UNION
    SELECT BTRIM(m.photo_count_id) FROM app_stock_entry_items i
    JOIN app_master_items m ON m.item_code=i.item_code
    WHERE i.stock_entry_id=$1 AND NULLIF(BTRIM(m.photo_count_id),'') IS NOT NULL UNION
    SELECT BTRIM(m.photo_count_id) FROM wm_inventory_count_lines l
    JOIN wm_inventory_counts c ON c.id=l.count_id
    JOIN app_master_items m ON m.item_code=l.item_code
    WHERE c.reconciliation_id=$1 AND NULLIF(BTRIM(m.photo_count_id),'') IS NOT NULL UNION
    SELECT photo_id FROM app_reconciliation_photo_counts WHERE stock_entry_id=$1 UNION
    SELECT photo_id FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1 AND photo_id IS NOT NULL
  ) SELECT ids.photo_id, COALESCE(i.inventory_qty,0)::text AS inventory_qty,
    p.physical_qty::text, COALESCE(p.uncounted_items,0) AS uncounted_items, c.verified_qty::text,
    c.ai_counts->-1 AS ai_result, c.ai_counts AS ai_history, c.ai_review
    FROM ids LEFT JOIN inventory i USING(photo_id)
    LEFT JOIN physical p USING(photo_id)
    LEFT JOIN app_reconciliation_photo_counts c ON c.photo_id=ids.photo_id AND c.stock_entry_id=$1
    ORDER BY ids.photo_id`, [voucherId])).rows;
}

async function photoCountReport(client, voucherId, user) {
  const rows = await photoCountRows(client, voucherId);
  const photos = (await client.query(`SELECT id, photo_id, file_name FROM app_stock_reconciliation_attachments
    WHERE stock_entry_id=$1 AND photo_id IS NOT NULL ORDER BY id`, [voucherId])).rows;
  if(user&&user.role!=='admin')return {rows:rows.map(({ai_result,ai_history,ai_review,...row})=>row),photos};
  return { rows, photos, aiConfigured:require('./photo-count-ai').configured(),
    ...(user?.role==='admin'?{aiCountSettings:await require('./photo-count-settings').getPhotoCountSettings(client)}:{}) };
}

function quantity(value) {
  const text=String(value ?? '').trim();
  if (!text) return null;
  if (!/^\d+(?:\.\d{1,3})?$/.test(text) || Number(text) >= 100000000000)
    throw attachmentError('Enter a non-negative quantity with up to three decimal places.');
  return text;
}

async function savePhotoCount(client, voucherId, body, files, user) {
  if (Object.hasOwn(body,'auditor_qty') || Object.hasOwn(body,'physical_qty'))
    throw attachmentError('Physical Qty comes from the saved physical counts. Edit it on Stock Reconciliation.');
  if(body.review_ai_id&&user?.role!=='admin')throw attachmentError('Only an administrator can review AI counts.',403);
  const verified=quantity(body.verified_qty);
  const photoId=String(body.photo_id || '');
  if (files?.length && validateScans(files).some(scan=>!['image/jpeg','image/png'].includes(scan.type)))
    throw attachmentError('Attach JPG or PNG item photos only.');
  const voucher=(await client.query('SELECT entry_type FROM app_stock_entries WHERE id=$1 FOR UPDATE',[voucherId])).rows[0];
  if (voucher?.entry_type!=='reconciliation') throw attachmentError('Stock reconciliation not found.',404);
  // The caller holds the inventory transaction lock; runtime roles only read count tables.
  const count=(await client.query('SELECT state,revision FROM wm_inventory_counts WHERE reconciliation_id=$1',[voucherId])).rows[0];
  if (count) {
    if (!require('./authorize').can(user,'inventory.count.view')) throw attachmentError('Count View permission is required to save photo counts.',403);
    if (['submitted','abandoned'].includes(count.state)) throw attachmentError('This count is closed. Its photo counts and photos cannot be changed.',409);
    if (String(body.revision)!==String(count.revision)) throw attachmentError('This count has changed. Reload the Photo Count Rpt and save the current revision.',409);
  }
  const rows=await photoCountRows(client,voucherId);
  if (!rows.some(row=>row.photo_id===photoId)) throw attachmentError('Choose a Photo ID in this reconciliation.');
  if(body.action==='remove_photo'){
    if(!/^\d+$/.test(String(body.attachment_id)))throw attachmentError('Photo not found.',404);
    const removed=await client.query('DELETE FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1 AND photo_id=$2 AND id=$3',[voucherId,photoId,body.attachment_id]);
    if(!removed.rowCount)throw attachmentError('Photo not found.',404);
    return;
  }
  if(body.action==='upload_photo'){
    if(files?.length!==1)throw attachmentError('Choose one JPG or PNG photo.');
    await saveAttachments(client,voucherId,files,user,photoId);
    return;
  }
  let review=null;
  if(body.review_ai_id){
    const result=rows.find(row=>row.photo_id===photoId).ai_result;
    if(!result||result.id!==body.review_ai_id||verified===null)throw attachmentError('Reload the AI result and enter a verified quantity before recording review.',409);
    if(result.questions?.length||result.status==='needs_clarification')throw attachmentError('Answer the AI clarification questions before reviewing this result.',409);
    const currentPhoto=(await client.query('SELECT id FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1 AND photo_id=$2 ORDER BY id DESC LIMIT 1',[voucherId,photoId])).rows[0];
    if(result.sources?.length!==1||String(currentPhoto?.id)!==String(result.sources[0].id))throw attachmentError('Select Count Qty for the current photo before saving its AI review.',409);
    const photos=(await client.query('SELECT id,content FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1 AND photo_id=$2 AND id=ANY($3::bigint[]) ORDER BY id',[voucherId,photoId,result.sources.map(p=>p.id)])).rows;
    if(JSON.stringify(require('./photo-count-ai').fingerprint(photos))!==JSON.stringify(result.sources))throw attachmentError('The AI source photos changed. Request a new AI count before reviewing it.',409);
    review={result_id:result.id,verified_qty:verified,reviewed_by:String(user.id),reviewed_at:new Date().toISOString()};
  }
  await client.query(`INSERT INTO app_reconciliation_photo_counts(stock_entry_id,photo_id,verified_qty,updated_by,ai_review)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(stock_entry_id,photo_id) DO UPDATE
    SET verified_qty=EXCLUDED.verified_qty,
    ai_review=EXCLUDED.ai_review,updated_by=EXCLUDED.updated_by, updated_at=now()`,[voucherId,photoId,verified,user.username,review?JSON.stringify(review):null]);
  if(files?.length) await saveAttachments(client,voucherId,files,user,photoId);
}
// Called inside one inventory-exclusive transaction so a failed row rolls back
// the entire save. Evidence triggers advance the revision after each row.
async function saveAllPhotoCounts(client,voucherId,body,user){
  let rows;
  try{rows=JSON.parse(body.rows);}catch{throw attachmentError('Reload the report and try Save all again.');}
  if(!Array.isArray(rows)||!rows.length)throw attachmentError('There are no verified quantity rows to save.');
  const seen=new Set();
  for(const row of rows){
    if(!row||typeof row!=='object'||typeof row.photo_id!=='string'||!row.photo_id||seen.has(row.photo_id))
      throw attachmentError('Save all requires one row per Photo ID.');
    seen.add(row.photo_id);
    quantity(row.verified_qty);
  }
  await client.query('SELECT id FROM app_stock_entries WHERE id=$1 FOR UPDATE',[voucherId]);
  let count=(await client.query('SELECT revision FROM wm_inventory_counts WHERE reconciliation_id=$1',[voucherId])).rows[0];
  if(count&&String(body.revision)!==String(count.revision))throw attachmentError('This count has changed. Reload the Photo Count Rpt and save the current revision.',409);
  for(const row of rows){
    await savePhotoCount(client,voucherId,{photo_id:row.photo_id,verified_qty:row.verified_qty,review_ai_id:row.review_ai_id,revision:count?.revision},[],user);
    if(count)count=(await client.query('SELECT revision FROM wm_inventory_counts WHERE reconciliation_id=$1',[voucherId])).rows[0];
  }
  return {saved:rows.length,revision:count?.revision??null};
}
module.exports={initPhotoCountSchema,photoCountRows,photoCountReport,savePhotoCount,saveAllPhotoCounts,quantity};
