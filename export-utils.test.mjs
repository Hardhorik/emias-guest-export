import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { doctorDetails, documentDate, documentPath, isAllowedBrowserRequest, isAllowedEmiasGuestUrl, safeName, verifyFile, zipDirectory } from './export-utils.mjs';

test('accepts only the exact EMIAS guest origin and blocks third-party requests', () => {
  assert.equal(isAllowedEmiasGuestUrl('https://lk.emias.mos.ru/guest?token=fake'), true);
  assert.equal(isAllowedEmiasGuestUrl('http://lk.emias.mos.ru/guest?token=fake'), false);
  assert.equal(isAllowedEmiasGuestUrl('https://lk.emias.mos.ru.evil.test/guest?token=fake'), false);
  assert.equal(isAllowedEmiasGuestUrl('https://user@lk.emias.mos.ru/guest?token=fake'), false);
  assert.equal(isAllowedBrowserRequest('https://lk.emias.mos.ru/api/1/documents'), true);
  assert.equal(isAllowedBrowserRequest('https://mos.ru/'), false);
  assert.equal(isAllowedBrowserRequest('blob:https://lk.emias.mos.ru/fake'), true);
});

test('doctor and specialty come from the appointment row, not the clinic', () => {
  const item = { key: 'item_inspection_test', text: 'Врач-хирург\nИванов И. И.\n29.10.2024\nГородская поликлиника' };
  const details = doctorDetails(item);
  assert.deepEqual(details, { doctor: 'Иванов И. И.', specialty: 'Врач-хирург' });
  const file = documentPath('Приёмы', { ...item, ...details, date: documentDate(item.text) }, 'Осмотр хирурга.pdf');
  assert.match(file, /2024-10-29__Врач-хирург__Иванов И\. И__.+\.pdf$/);
  assert.deepEqual(doctorDetails({ ...item, text: 'Врач-хирург\n29.10.2024\nКлиника' }), {});
  assert.deepEqual(doctorDetails({ ...item, key: 'item_analyze_test' }), {});
  assert.equal(doctorDetails({ ...item, text: 'Врач\nИванов Иван Иванович\n29.10.2024' }).doctor, 'Иванов Иван Иванович');
  assert.equal(doctorDetails({ ...item, text: 'Врач-хирург\nИВАНОВ И И\n29.10.2024' }).doctor, 'ИВАНОВ И И');
});

test('dates sort chronologically and invalid dates are not invented', () => {
  assert.equal(documentDate('Приём\n09.02.2024\nКлиника'), '2024-02-09');
  assert.equal(documentDate('31.02.2024'), null);
  assert.equal(documentDate('Нет даты'), null);
  assert.equal(documentDate('29.02.2024'), '2024-02-29');
});
test('Windows-safe paths preserve Cyrillic and distinguish duplicate titles', () => {
  const a = documentPath('Приёмы', { key: 'one', date: '2024-02-09' }, 'Осмотр: терапевта.pdf');
  const b = documentPath('Приёмы', { key: 'two', date: '2024-02-09' }, 'Осмотр: терапевта.pdf');
  assert.notEqual(a, b);
  assert.match(a, /2024-02-09__Осмотр_ терапевта__/);
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('../file'), '.._file');
  assert.ok(!path.isAbsolute(documentPath('../../', { key: 'x' }, '../../a.pdf')));
});
test('rejects HTML masquerading as PDF and detects modified downloads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'emias-test-'));
  const file = path.join(dir, 'test.pdf');
  await writeFile(file, '<html>Unauthorized</html>');
  await assert.rejects(verifyFile(file), /PDF/);
  await writeFile(file, '%PDF-1.4\nfixture\n%%EOF');
  const result = await verifyFile(file);
  await verifyFile(file, result.sha256);
  await writeFile(file, '%PDF-1.4\nchanged\n%%EOF');
  await assert.rejects(verifyFile(file, result.sha256), /сумма/);
});
test('creates ZIP with Unicode filename', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'emias-zip-'));
  await writeFile(path.join(dir, 'Документ.txt'), 'Текст');
  const zip = `${dir}.zip`;
  await zipDirectory(dir, zip);
  const data = await readFile(zip);
  assert.equal(data.readUInt32LE(0), 0x04034b50);
  assert.ok(data.includes(Buffer.from('Документ.txt')));
});
