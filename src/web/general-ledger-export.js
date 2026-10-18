'use strict';
const columns = ['Date', 'Account Code', 'Account Name', 'Debit', 'Credit', 'Account Running Balance', 'Voucher Type', 'Voucher No.', 'Party', 'Narration'];
const values = row => [row.posting_date, row.account_code, row.account_name, Number(row.debit || 0), Number(row.credit || 0), Number(row.running_balance || 0), row.voucher_type, row.voucher_no || row.voucher_id || '', row.party_name || row.party_id || '', row.remarks || ''];
const openingValues = row => ['Opening balance', row.account_code, row.account_name, '', '', row.running_balance, '', '', '', 'Before From; debit positive, credit negative'];
function reviewRows(report) {
  return [
    ...(report.account_summaries || []).map(row => ['Account period summary',row.account_code,row.account_name,row.debit,row.credit,row.closing_balance,'','','',`Opening ${row.opening_balance}; closing = opening + period debit - credit`]),
    ...(report.customer_balances || []).map(row => ['Customer receivable','','','','',row.balance,'','',row.party_name || row.party_id,'Through To; ignores From, Account, Search and Voucher filters. Access restrictions apply.']),
    ...(report.supplier_balances || []).map(row => ['Supplier payable','','','','',row.balance,'','',row.party_name || row.party_id,'Through To; positive = payable, negative = supplier advance. Ignores From, Account, Search and Voucher filters. Access restrictions apply.']),
    ...(report.allocations || []).map(row => ['Source invoice allocation',row.account_code,row.account_name,row.debit,row.credit,'','',row.reference_no,'','Saved source allocation; not an additional posting']),
  ];
}
const csvCell = value => {
  let text = String(value ?? '');
  if (typeof value !== 'number' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
const filterDescription = report => Object.entries(report.filters).filter(([,value]) => value).map(([key,value]) => `${({party_scope:'Party scope',group_by:'Group by',voucher_id:'Voucher ID'})[key] || key}: ${key === 'party_scope' ? (value === 'lines' ? 'Party entries' : 'All related voucher postings') : key === 'group_by' ? 'GL account' : value}`).join(' | ') || 'All transactions';

const { finished } = require('node:stream/promises');
const { once } = require('node:events');
const { setImmediate: yieldToIo } = require('node:timers/promises');

function exportFilename(filters, format) {
  return `general-ledger${filters.from ? '-' + filters.from : ''}${filters.to ? '-to-' + filters.to : ''}.${format}`;
}

async function outputReady(output) {
  if (output.destroyed) throw new Error('Export output closed.');
  if (output.writableNeedDrain) await once(output, 'drain');
}

async function writeGeneralLedgerExport(output, report, format) {
  const complete = finished(output);
  // Attach immediately; a disk/write failure must not become an unhandled rejection.
  complete.catch(() => {});
  try {
    if (format === 'csv') {
      output.write('\uFEFF' + columns.map(csvCell).join(',') + '\r\n');
      for (const row of report.opening_rows || []) {
        output.write(openingValues(row).map(csvCell).join(',') + '\r\n');
        await outputReady(output);
      }
      for await (const row of report.rows) {
        output.write(values(row).map(csvCell).join(',') + '\r\n');
        await outputReady(output);
      }
      output.write(['', '', 'Total', report.summary.debit, report.summary.credit, report.summary.balance, '', '', '', 'Net Balance = opening + period debits - period credits']
        .map(csvCell).join(',') + '\r\n');
      for (const row of reviewRows(report)) { output.write(row.map(csvCell).join(',') + '\r\n'); await outputReady(output); }
      output.end();
    } else if (format === 'xlsx') {
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: false });
      const sheet = workbook.addWorksheet('General Ledger', { views: [{ state: 'frozen', ySplit: 1 }] });
      sheet.columns = columns.map((header, index) => ({ header, width: [15,18,30,18,18,18,22,24,28,50][index] }));
      sheet.autoFilter = { from: 'A1', to: 'J1' };
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16324F' } };
      for (const column of [4,5,6]) sheet.getColumn(column).numFmt = '#,##0.00;[Red]-#,##0.00';
      sheet.getColumn(10).alignment = { wrapText: true, vertical: 'top' };
      sheet.getRow(1).commit();
      for (const row of report.opening_rows || []) sheet.addRow(openingValues(row)).commit();
      let count = 0;
      for await (const row of report.rows) {
        sheet.addRow(values(row)).commit();
        if (++count % 100 === 0) { await yieldToIo(); await outputReady(output); }
      }
      const total = sheet.addRow(['', '', 'Total', report.summary.debit, report.summary.credit, report.summary.balance, '', '', '', 'Net Balance = opening + period debits - period credits']);
      total.font = { bold: true }; total.commit();
      sheet.commit();
      if (reviewRows(report).length) {
        const review=workbook.addWorksheet('Ledger Review');
        review.columns=['Row type','Account Code','Account Name','Debit','Credit','Balance','Voucher Type','Invoice reference','Party','Explanation'].map(header=>({header,width:24}));
        for(const column of [4,5,6]) review.getColumn(column).numFmt='#,##0.00;[Red]-#,##0.00';
        for(const row of reviewRows(report)) review.addRow(row).commit();
        review.commit();
      }
      const info = workbook.addWorksheet('Report Details');
      info.getColumn(1).width = 20; info.getColumn(2).width = 100;
      for (const row of [['Report', 'General Ledger'], ['Filters', filterDescription(report)], ['Entries', count],
        ['Balance', 'Running balance per account including matching history before From; opening rows are not period transactions']]) info.addRow(row).commit();
      info.commit();
      await workbook.commit();
    } else if (format === 'pdf') {
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 34,
        bufferPages: false, info: { Title: 'General Ledger' } });
      doc.on('error', error => output.destroy(error));
      doc.pipe(output);
      try { await renderLedgerTable(doc, report, output); doc.end(); }
      catch (error) { doc.destroy(error); throw error; }
    } else {
      throw new Error('Choose CSV, Excel, or PDF.');
    }
    await complete;
  } catch (error) {
    output.destroy(error);
    await complete.catch(() => {});
    throw error;
  }
}

async function sendGeneralLedgerExport(res, report, format) {
  res.set('Cache-Control', 'private, no-store');
  res.attachment(exportFilename(report.filters, format));
  res.type({ csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' }[format]);
  await writeGeneralLedgerExport(res, report, format);
}

async function renderLedgerTable(doc, report, output) {
  const left = 34;
  const width = doc.page.width - left * 2;
  const bottom = doc.page.height - 54;
  const lineHeight = 11;
  const padding = 6;
  const navy = '#16324F';
  const widths = [24, 60, 120, 68, 68, 76, 106, 92, 160].map(value => value * width / 774);
  const headers = ['#', 'Date', 'Account', 'Debit', 'Credit', 'Balance', 'Voucher', 'Party', 'Narration'];
  const amountFormatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const amount = value => amountFormatter.format(Number(value || 0));
  const wrapCaches = Array.from({ length: 9 }, () => new Map());
  let y;
  let pageNumber = 1;
  const rowCount = report.pagination?.total ?? report.rows.length;

  function header(first = false) {
    doc.font('Helvetica-Bold').fontSize(first ? 23 : 16).fillColor(navy).text('General Ledger', left, 30, { lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor('#64748B').text(`${rowCount.toLocaleString('en-US')} transactions`, left + width - 150, 36, { width: 150, align: 'right', lineBreak: false });
    y = first ? 65 : 58;
    if (first) {
      const labels = { search: 'Search', account: 'Account', party: 'Party', voucher_type: 'Voucher', from: 'From', to: 'To', party_scope: 'Party scope', group_by: 'Group by', voucher_id: 'Voucher ID' };
      const description = Object.entries(report.filters).filter(([,value]) => value).map(([key,value]) => `${labels[key] || key}: ${value}`).join('   |   ') || 'All transactions';
      doc.font('Helvetica').fontSize(9).fillColor('#475569').text(description, left, y, { width });
      y = doc.y + 14;
      const metrics = [['Filtered debits', report.summary.debit], ['Filtered credits', report.summary.credit], ['Net Balance', report.summary.balance]];
      metrics.forEach(([label, value], index) => {
        const x = left + index * (width / 3);
        doc.roundedRect(x, y, width / 3 - 10, 47, 5).fill('#F1F5F9');
        doc.font('Helvetica').fontSize(8).fillColor('#64748B').text(label.toUpperCase(), x + 12, y + 8, { lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(14).fillColor(navy).text(amount(value), x + 12, y + 23, { lineBreak: false });
      });
      y += 61;
    }
    doc.rect(left, y, width, 26).fill(navy);
    let x = left;
    headers.forEach((label, index) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF').text(label, x + padding, y + 9, { width: widths[index] - padding * 2, align: index >= 3 && index <= 5 ? 'right' : 'left', lineBreak: false });
      x += widths[index];
    });
    y += 26;
  }
  function footer() {
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(left, doc.page.height - 37).lineTo(left + width, doc.page.height - 37).strokeColor('#CBD5E1').stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#64748B').text('Balances include opening history per account. Positive = debit; negative = credit. Net Balance includes opening balances.', left, doc.page.height - 27, { lineBreak: false });
    doc.text(`Page ${pageNumber}`, left + width - 110, doc.page.height - 27, { width: 110, align: 'right', lineBreak: false });
    doc.page.margins.bottom = originalBottomMargin;
  }
  function newPage() { footer(); doc.addPage(); pageNumber++; header(); }
  function wrap(value, column) {
    doc.font('Helvetica').fontSize(8);
    const max = widths[column] - padding * 2;
    const lines = [];
    for (const paragraph of String(value ?? '').split(/\r?\n/)) {
      const cache = wrapCaches[column];
      if (cache.has(paragraph)) {
        const cached = cache.get(paragraph);
        cache.delete(paragraph); cache.set(paragraph, cached);
        lines.push(...cached); continue;
      }
      const start = lines.length;
      let remainder = paragraph;
      while (remainder) {
        let low = 1;
        let high = Math.min(32, remainder.length);
        while (high < remainder.length && doc.widthOfString(remainder.slice(0, high)) <= max) high = Math.min(high * 2, remainder.length);
        if (doc.widthOfString(remainder.slice(0, high)) <= max) break;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (doc.widthOfString(remainder.slice(0, mid)) <= max) low = mid;
          else high = mid - 1;
        }
        let length = low;
        // Do not split a surrogate pair when an oversized word wraps.
        if (length > 1 && /[\uD800-\uDBFF]/.test(remainder[length - 1])) length--;
        const prefix = remainder.slice(0, length);
        const space = prefix.lastIndexOf(' ');
        if (space > 0) { lines.push(prefix.slice(0, space)); remainder = remainder.slice(space + 1); }
        else { lines.push(prefix); remainder = remainder.slice(length); }
      }
      lines.push(remainder);
      if (column !== 0 && column !== 5 && paragraph.length <= 2048) {
        if (cache.size >= 256) cache.delete(cache.keys().next().value);
        cache.set(paragraph, lines.slice(start));
      }
    }
    return lines;
  }
  function drawRow(cells, index, total = false) {
    const lines = cells.map(wrap);
    const count = Math.max(...lines.map(cell => cell.length));
    let offset = 0;
    while (offset < count) {
      if (bottom - y < lineHeight + padding * 2) newPage();
      const length = Math.min(count - offset, Math.floor((bottom - y - padding * 2) / lineHeight));
      const height = length * lineHeight + padding * 2;
      doc.rect(left, y, width, height).fill(total ? '#E8EFF6' : index % 2 === 0 ? '#F8FAFC' : '#FFFFFF');
      let x = left;
      lines.forEach((cell, column) => {
        doc.font(total ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(column >= 3 && column <= 5 ? navy : '#334155');
        cell.slice(offset, offset + length).forEach((line, number) => {
          doc.text(line, x + padding, y + padding + number * lineHeight, { width: widths[column] - padding * 2, align: column >= 3 && column <= 5 ? 'right' : 'left', lineBreak: false });
        });
        x += widths[column];
      });
      y += height;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.4).strokeColor('#E2E8F0').stroke();
      offset += length;
      if (offset < count) newPage();
    }
  }
  header(true);
  for (const row of report.opening_rows || []) {
    drawRow(['', 'Opening balance', `${row.account_code}\n${row.account_name}`, '', '', amount(row.running_balance), '', '', report.filters.from ? `Before ${report.filters.from}` : 'Opening is zero'], 0, true);
  }
  let index = 0;
  for await (const row of report.rows) {
    drawRow([
      index + 1, row.posting_date, `${row.account_code || ''}\n${row.account_name || ''}`,
      amount(row.debit), amount(row.credit), amount(row.running_balance),
      `${String(row.voucher_type || '').replaceAll('_', ' ')}\n${row.voucher_no || row.voucher_id || ''}`,
      row.party_name || row.party_id || '', row.remarks || '',
    ], index++);
    if (index % 100 === 0) { await yieldToIo(); await outputReady(output); }
  }
  if (!index) drawRow(['', '', 'No entries found', '', '', '', '', '', ''], 0);
  drawRow(['', '', 'TOTAL / NET BALANCE', amount(report.summary.debit), amount(report.summary.credit), amount(report.summary.balance), '', '', ''], index, true);
  for(const row of reviewRows(report)) {
    drawRow(['',row[0],`${row[1]}\n${row[2]}`,row[3] === '' ? '' : amount(row[3]),row[4] === '' ? '' : amount(row[4]),row[5] === '' ? '' : amount(row[5]),row[7],row[8],row[9]],index++,true);
  }
  footer();
}

module.exports = { sendGeneralLedgerExport, writeGeneralLedgerExport, exportFilename };
