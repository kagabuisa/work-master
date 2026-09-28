const fs = require('node:fs/promises');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const UPLOAD_ROOT = path.join(PROJECT_ROOT, 'data', 'project-files');
const ROOT_FILES = new Set(['README.md', 'package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml', 'server.js']);
const ROOT_FOLDERS = new Set(['src', 'views', 'public', 'scripts', 'docs', 'audits', 'tests', 'uploads']);

function badPath() {
  const error = new Error('File or folder not found.');
  error.status = 404;
  return error;
}

function partsFor(value) {
  if (typeof value !== 'string' || value.length > 1000 || value.includes('\\') || value.includes('\0')) throw badPath();
  if (!value) return [];
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) throw badPath();
  if (!ROOT_FOLDERS.has(parts[0]) && !(parts.length === 1 && ROOT_FILES.has(parts[0]))) throw badPath();
  if (ROOT_FILES.has(parts[0]) && parts.length !== 1) throw badPath();
  return parts;
}

function diskPath(parts) {
  return parts[0] === 'uploads'
    ? path.join(UPLOAD_ROOT, ...parts.slice(1))
    : path.join(PROJECT_ROOT, ...parts);
}

async function safeStat(parts) {
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const stat = await fs.lstat(diskPath(parts.slice(0, depth))).catch((error) => {
      if (error.code === 'ENOENT') throw badPath();
      throw error;
    });
    if (stat.isSymbolicLink() || (depth < parts.length && !stat.isDirectory())) throw badPath();
    if (depth === parts.length) return stat;
  }
  throw badPath();
}

async function listDirectory(relative = '') {
  const parts = partsFor(relative);
  if (parts.length === 1 && ROOT_FILES.has(parts[0])) throw badPath();
  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
  let entries;
  if (!parts.length) {
    entries = [
      ...[...ROOT_FOLDERS].map((name) => ({ name, isDirectory: () => true, isFile: () => false })),
      ...[...ROOT_FILES].map((name) => ({ name, isDirectory: () => false, isFile: () => true })),
    ];
  } else {
    const stat = await safeStat(parts);
    if (!stat.isDirectory()) throw badPath();
    entries = await fs.readdir(diskPath(parts), { withFileTypes: true });
  }
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isFile())) continue;
    const childParts = [...parts, entry.name];
    const filePath = diskPath(childParts);
    let stat;
    try { stat = await fs.lstat(filePath); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;
    items.push({
      name: entry.name,
      path: childParts.join('/'),
      folder: stat.isDirectory(),
      size: stat.isFile() ? stat.size : null,
      modified: stat.mtime,
    });
  }
  items.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { path: relative, items, breadcrumbs: parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') })) };
}

async function downloadableFile(relative) {
  const parts = partsFor(relative);
  if (!parts.length) throw badPath();
  if (parts[0] === 'uploads' && parts.length !== 2) throw badPath();
  const filePath = diskPath(parts);
  const stat = await safeStat(parts);
  if (!stat.isFile()) throw badPath();
  return { filePath, name: parts.at(-1) };
}

function cleanUploadName(value) {
  const name = path.basename(String(value || '').replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..' || name.startsWith('.')) {
    const error = new Error('Choose a file with a valid name.');
    error.status = 400;
    throw error;
  }
  return name.slice(0, 180);
}

async function saveUploads(files) {
  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
  const saved = [];
  const namedFiles = files.map((file) => ({ file, name: cleanUploadName(file.originalname) }));
  for (const { file, name } of namedFiles) {
    const extension = path.extname(name);
    const stem = name.slice(0, name.length - extension.length);
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const candidate = attempt ? `${stem} (${attempt})${extension}` : name;
      try {
        await fs.writeFile(path.join(UPLOAD_ROOT, candidate), file.buffer, { flag: 'wx', mode: 0o600 });
        saved.push(candidate);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (attempt === 999) throw new Error('Too many files with the same name.');
      }
    }
  }
  return saved;
}

module.exports = { listDirectory, downloadableFile, saveUploads };
