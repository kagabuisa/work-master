const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { listDirectory, downloadableFile, saveUploads } = require('../src/project-files');

test('project file browser lists allowed files and rejects traversal and hidden files', async () => {
  const root = await listDirectory();
  assert(root.items.some((item) => item.path === 'README.md' && !item.folder));
  assert(root.items.some((item) => item.path === 'uploads' && item.folder));
  assert.equal((await downloadableFile('README.md')).name, 'README.md');
  for (const invalid of ['../.env', '.env', 'src/../server.js', 'src/.secret', 'data/auth.json', 'uploads/../../server.js']) {
    await assert.rejects(downloadableFile(invalid), { status: 404 });
  }
});

test('uploads preserve duplicates, remain downloadable, and reject invalid names', async () => {
  const basename = `project-files-test-${process.pid}-${Date.now()}.txt`;
  const uploadRoot = path.join(__dirname, '..', 'data', 'project-files');
  const names = [];
  try {
    names.push(...await saveUploads([{ originalname: basename, buffer: Buffer.from('one') }]));
    names.push(...await saveUploads([{ originalname: basename, buffer: Buffer.from('two') }]));
    assert.notEqual(names[0], names[1]);
    assert.equal(await fs.readFile((await downloadableFile(`uploads/${names[0]}`)).filePath, 'utf8'), 'one');
    assert.equal(await fs.readFile((await downloadableFile(`uploads/${names[1]}`)).filePath, 'utf8'), 'two');
    assert((await listDirectory('uploads')).items.some((item) => item.name === names[0]));
    await assert.rejects(saveUploads([{ originalname: '.env', buffer: Buffer.from('bad') }]), { status: 400 });
  } finally {
    await Promise.all(names.map((name) => fs.unlink(path.join(uploadRoot, name))));
  }
});

test('downloads do not follow symlinks inside allowed folders', async () => {
  const uploadRoot = path.join(__dirname, '..', 'data', 'project-files');
  await fs.mkdir(uploadRoot, { recursive: true });
  const name = `project-files-link-${process.pid}-${Date.now()}`;
  const link = path.join(uploadRoot, name);
  try {
    await fs.symlink(path.join(__dirname, '..', 'server.js'), link);
    await assert.rejects(downloadableFile(`uploads/${name}`), { status: 404 });
    assert(!(await listDirectory('uploads')).items.some((item) => item.name === name));
  } finally {
    await fs.unlink(link);
  }
});
