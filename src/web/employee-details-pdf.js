'use strict';

const path = require('node:path');
const PDFDocument = require('pdfkit');
const { employeeDetailFields } = require('../hr-employee-fields');

async function employeeDetailsPdf({ employee, plans = [], managerName, accounts = [], includePayPlans = false }, { company = {}, formatDate = String, generatedAt = new Date() } = {}) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 48, left: 48, right: 48, bottom: 24 }, bufferPages: true,
    info: { Title: `Employee Details - ${employee.employee_name}`, Author: company.name || 'Work Master', Subject: 'Employee personnel record' } });
  doc.registerFont('Body', path.join(__dirname, '../../public/fonts/roboto/Roboto-Variable.ttf'));
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = 48, width = doc.page.width - 96, bottom = doc.page.height - 66;
  const ink = '#172b3a', muted = '#637381', accent = '#176b66', rule = '#dce4e8';
  const lineHeight = 14;
  let y;
  const display = value => value === null || value === undefined || value === '' ? '—' : String(value);
  const date = value => value ? formatDate(value) : '—';
  function header(first) {
    doc.rect(0, 0, doc.page.width, 5).fill(accent);
    doc.font('Body').fontSize(10).fillColor(accent).text(company.name || employee.company || 'Work Master', left, 30, { width, height: 28, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(first ? 26 : 18).fillColor(ink).text('Employee Details', left, 66, { width });
    doc.font('Body').fontSize(9).fillColor(muted).text('PERSONNEL RECORD', left, first ? 101 : 93, { width });
    if (!first) doc.text(`${employee.employee_id}  ·  ${employee.employee_name}`, left, 111, { width, height: 16, ellipsis: true });
    y = first ? 127 : 143;
  }
  function page() { doc.addPage(); header(false); }
  function ensure(height) { if (y + height > bottom) page(); }
  function section(title) {
    ensure(96);
    doc.rect(left, y, 3, 19).fill(accent);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(title, left + 12, y + 3, { width: width - 12, lineBreak: false });
    y += 31;
  }
  function lines(value, availableWidth) {
    doc.font('Body').fontSize(10);
    const result = [];
    for (const paragraph of display(value).replace(/\r\n?/g, '\n').split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (line && doc.widthOfString(`${line} ${word}`) > availableWidth) { result.push(line); line = ''; }
        if (doc.widthOfString(word) > availableWidth) {
          for (const character of Array.from(word)) {
            if (line && doc.widthOfString(line + character) > availableWidth) { result.push(line); line = ''; }
            line += character;
          }
        } else line += `${line ? ' ' : ''}${word}`;
      }
      result.push(line);
    }
    return result;
  }
  // Split tall fields deliberately so even a 10,000-character paragraph or an
  // unbroken identifier prints in full, with no overlap or clipped text.
  function row(fields) {
    const gap = 24, cellWidth = (width - gap * (fields.length - 1)) / fields.length;
    const remaining = fields.map(([, value]) => lines(value, cellWidth));
    let continued = false;
    while (remaining.some(items => items.length)) {
      ensure(55);
      const count = Math.max(1, Math.floor((bottom - y - 41) / lineHeight));
      const take = Math.min(count, Math.max(...remaining.map(items => items.length)));
      fields.forEach(([label], index) => {
        const x = left + index * (cellWidth + gap);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(muted).text(`${label.toUpperCase()}${continued ? ' (CONTINUED)' : ''}`, x, y, { width: cellWidth, lineBreak: false });
        doc.font('Body').fontSize(10).fillColor(ink);
        remaining[index].splice(0, take).forEach((line, i) => doc.text(line, x, y + 17 + i * lineHeight, { width: cellWidth, lineBreak: false }));
      });
      y += 17 + take * lineHeight + 11;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.4).strokeColor(rule).stroke();
      y += 13;
      if (remaining.some(items => items.length)) { page(); continued = true; }
    }
  }
  header(true);
  section('Employee record');
  row([['Employee name', employee.employee_name]]);
  row([['Employee ID', employee.employee_id], ['Company', employee.company]]);
  row([['Employment status', employee.status]]);
  section('Employment details');
  row([['Department', employee.department], ['Position', employee.designation]]);
  row([['Joining date', date(employee.joining_date)], ['Leaving date', date(employee.leaving_date)]]);
  row([['Manager', managerName ? `${managerName} (${employee.manager_id})` : employee.manager_id], ['Shop / cost center', employee.cost_center]]);
  row([['Branch', employee.branch], ['Employment type', employee.employment_type]]);
  const fields = employeeDetailFields.filter(field => !['department', 'designation'].includes(field.name));
  let pending = [];
  function flush() { if (pending.length) { row(pending); pending = []; } }
  for (const field of fields) {
    if (field.section) { flush(); section(field.section); }
    let value = field.type === 'date' ? date(employee[field.name]) : employee[field.name];
    // Older records may still have a separate reference telephone saved. Keep
    // it visible in the References block when filing the complete record.
    if (field.name === 'references' && employee.details?.references_phone) value = `${value || ''}\nTelephone: ${employee.details.references_phone}`.trim();
    if (field.type === 'textarea' || field.name === 'next_of_kin_relation') { flush(); row([[field.label, value]]); }
    else { pending.push([field.label, value]); if (pending.length === 2) flush(); }
  }
  flush();
  if (includePayPlans) {
    section('Pay-plan history');
    if (!plans.length) row([['Pay plans', 'No pay plan saved.']]);
    const accountName = id => accounts.find(account => String(account.id) === String(id))?.account_name || `Account ID ${id}`;
    for (const plan of plans) {
      row([['Effective from', date(plan.effective_from)]]);
      for (const component of plan.components) {
        const amount = Number(component.amount).toLocaleString('en-UG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        row([[component.label, `${component.kind === 'employer' ? 'Employer contribution' : component.kind === 'deduction' ? 'Deduction' : 'Earning'} · UGX ${amount}\nProrate by paid days: ${component.prorate ? 'Yes' : 'No'}\nAccount: ${accountName(component.account_id)}${component.payable_account_id ? `\nPayable account: ${accountName(component.payable_account_id)}` : ''}`]]);
      }
      row([['Plan notes', plan.notes]]);
    }
  }
  const generated = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(generatedAt);
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const footerY = doc.page.height - 41;
    doc.moveTo(left, footerY - 10).lineTo(left + width, footerY - 10).strokeColor(rule).lineWidth(0.5).stroke();
    doc.font('Body').fontSize(8).fillColor(muted).text(`Generated ${generated} · Kampala`, left, footerY, { width: width - 90, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, left + width - 90, footerY, { width: 90, align: 'right', lineBreak: false });
  }
  doc.end();
  return complete;
}

async function sendEmployeeDetailsPdf(res, data, options) {
  const buffer = await employeeDetailsPdf(data, options);
  const id = String(data.employee.employee_id).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'employee';
  res.set('Cache-Control', 'private, no-store');
  res.attachment(`${id}-employee-details.pdf`);
  res.type('application/pdf');
  return res.send(buffer);
}

module.exports = { employeeDetailsPdf, sendEmployeeDetailsPdf };
