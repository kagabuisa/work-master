'use strict';
const path = require('node:path');
const MAX_SCAN_BYTES = 10 * 1024 * 1024;
const MAX_SCAN_FILES = 3;

function attachmentError(message, status = 400) {
  const error = new Error(message); error.status = status; return error;
}

function validateScans(files) {
  if (!files?.length) throw attachmentError('Choose at least one scanned stock sheet.');
  if (files.length > MAX_SCAN_FILES) throw attachmentError('Upload up to three scanned sheets at a time.');
  return files.map((file) => {
    const name = path.basename(String(file.originalname || '').replaceAll('\\', '/'))
      .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
    const buffer = file.buffer;
    if (!name || !buffer?.length) throw attachmentError('Choose a nonempty scanned stock sheet.');
    if (buffer.length > MAX_SCAN_BYTES) throw attachmentError('Each scanned sheet must be no larger than 10 MB.');
    const extension = path.extname(name).toLowerCase();
    let type = '';
    if (extension === '.pdf' && buffer.subarray(0, 5).toString('ascii') === '%PDF-') type = 'application/pdf';
    if (['.jpg', '.jpeg'].includes(extension) && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) type = 'image/jpeg';
    if (extension === '.png' && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) type = 'image/png';
    if (extension === '.csv' && !buffer.includes(0)) type = 'text/csv';
    if (extension === '.xls' && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) type = 'application/vnd.ms-excel';
    if (extension === '.xlsx' && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      && buffer.includes(Buffer.from('[Content_Types].xml')) && buffer.includes(Buffer.from('xl/workbook.xml'))) {
      type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    if (!type) throw attachmentError(`${name}: upload a PDF, JPG, PNG, CSV, or Excel (.xls/.xlsx) sheet with matching file content.`);
    return { name, type, buffer };
  });
}

async function listAttachments(client, voucherId) {
  return (await client.query(`SELECT id, file_name, content_type, byte_size, uploaded_by, uploaded_at
    FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1 ORDER BY uploaded_at, id`, [voucherId])).rows;
}

async function saveAttachments(client, voucherId, files, user) {
  const scans = validateScans(files);
  const { rows } = await client.query('SELECT id, entry_type FROM app_stock_entries WHERE id=$1 FOR UPDATE', [voucherId]);
  if (!rows[0] || rows[0].entry_type !== 'reconciliation') throw attachmentError('Stock reconciliation not found.', 404);
  for (const scan of scans) {
    await client.query(`INSERT INTO app_stock_reconciliation_attachments
      (stock_entry_id, file_name, content_type, byte_size, content, uploaded_by, uploaded_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [voucherId, scan.name, scan.type, scan.buffer.length, scan.buffer, user.username || null, user.id || null]);
  }
  return scans.length;
}

async function findAttachment(client, voucherId, attachmentId) {
  if (!/^\d+$/.test(String(attachmentId))) throw attachmentError('Attachment not found.', 404);
  const { rows } = await client.query(`SELECT file_name, content_type, content FROM app_stock_reconciliation_attachments
    WHERE stock_entry_id=$1 AND id=$2`, [voucherId, attachmentId]);
  if (!rows[0]) throw attachmentError('Attachment not found.', 404);
  return rows[0];
}

async function deleteAttachment(client, voucherId, attachmentId) {
  if (!/^\d+$/.test(String(attachmentId))) throw attachmentError('Attachment not found.', 404);
  const result = await client.query('DELETE FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1 AND id=$2', [voucherId, attachmentId]);
  if (!result.rowCount) throw attachmentError('Attachment not found.', 404);
}

module.exports = { validateScans, listAttachments, saveAttachments, findAttachment, deleteAttachment, attachmentError, MAX_SCAN_BYTES, MAX_SCAN_FILES };
