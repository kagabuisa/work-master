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
  ), inventory AS (
    SELECT BTRIM(m.photo_count_id) AS photo_id, SUM(b.quantity) AS inventory_qty
    FROM app_stock_balances b JOIN warehouses w ON w.warehouse=b.warehouse
    JOIN app_master_items m ON m.item_code=b.item_code
    WHERE NULLIF(BTRIM(m.photo_count_id),'') IS NOT NULL
    GROUP BY BTRIM(m.photo_count_id)
  ), ids AS (
    SELECT photo_id FROM inventory UNION
    SELECT BTRIM(m.photo_count_id) FROM app_stock_entry_items i
    JOIN app_master_items m ON m.item_code=i.item_code
    WHERE i.stock_entry_id=$1 AND NULLIF(BTRIM(m.photo_count_id),'') IS NOT NULL UNION
    SELECT photo_id FROM app_reconciliation_photo_counts WHERE stock_entry_id=$1 UNION
    SELECT photo_id FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1 AND photo_id IS NOT NULL
  ) SELECT ids.photo_id, COALESCE(i.inventory_qty,0)::text AS inventory_qty,
    c.auditor_qty::text, c.verified_qty::text
    FROM ids LEFT JOIN inventory i USING(photo_id)
    LEFT JOIN app_reconciliation_photo_counts c ON c.photo_id=ids.photo_id AND c.stock_entry_id=$1
    ORDER BY ids.photo_id`, [voucherId])).rows;
}

function quantity(value) {
  const text=String(value ?? '').trim();
  if (!text) return null;
  if (!/^\d+(?:\.\d{1,3})?$/.test(text) || Number(text) >= 100000000000)
    throw attachmentError('Enter a non-negative quantity with up to three decimal places.');
  return text;
}

async function savePhotoCount(client, voucherId, body, files, user) {
  const auditor=quantity(body.auditor_qty), verified=quantity(body.verified_qty);
  const photoId=String(body.photo_id || '');
  if (files?.length && validateScans(files).some(scan=>!['image/jpeg','image/png'].includes(scan.type)))
    throw attachmentError('Attach JPG or PNG item photos only.');
  const voucher=(await client.query('SELECT entry_type FROM app_stock_entries WHERE id=$1 FOR UPDATE',[voucherId])).rows[0];
  if (voucher?.entry_type!=='reconciliation') throw attachmentError('Stock reconciliation not found.',404);
  const rows=await photoCountRows(client,voucherId);
  if (!rows.some(row=>row.photo_id===photoId)) throw attachmentError('Choose a Photo ID in this reconciliation.');
  await client.query(`INSERT INTO app_reconciliation_photo_counts(stock_entry_id,photo_id,auditor_qty,verified_qty,updated_by)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(stock_entry_id,photo_id) DO UPDATE
    SET auditor_qty=EXCLUDED.auditor_qty, verified_qty=EXCLUDED.verified_qty,
    updated_by=EXCLUDED.updated_by, updated_at=now()`,[voucherId,photoId,auditor,verified,user.username]);
  if(files?.length) await saveAttachments(client,voucherId,files,user,photoId);
}
module.exports={initPhotoCountSchema,photoCountRows,savePhotoCount,quantity};
