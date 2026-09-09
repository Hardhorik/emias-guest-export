import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';

export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function isAllowedEmiasGuestUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'lk.emias.mos.ru' &&
      url.port === '' && url.username === '' && url.password === '' &&
      url.pathname === '/guest' && Boolean(url.searchParams.get('token'));
  } catch { return false; }
}

export function isAllowedBrowserRequest(value) {
  try {
    const url = new URL(value);
    return ['data:', 'blob:', 'about:'].includes(url.protocol) ||
      (url.protocol === 'https:' && url.hostname === 'lk.emias.mos.ru' && url.port === '');
  } catch { return false; }
}

export function safeName(value, limit = 85) {
  const result = String(value).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, limit).replace(/[. ]+$/g, '');
  return !result ? 'Документ' : /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result) ? `_${result}` : result;
}

export function documentDate(text) {
  const m = String(text).match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(iso) ? iso : null;
}

export function doctorDetails(item) {
  if (!item.key?.startsWith('item_inspection_')) return {};
  const lines = String(item.text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const dateIndex = lines.findIndex(line => /^\d{2}\.\d{2}\.\d{4}$/.test(line));
  if (dateIndex < 2) return {};
  const doctor = lines[dateIndex - 1];
  const name = /^(?:[А-ЯЁ][А-ЯЁа-яё]+(?:-[А-ЯЁа-яё][А-ЯЁа-яё]+)?\s+)(?:(?:[А-ЯЁ]\.?\s*){1,3}|[А-ЯЁ][А-ЯЁа-яё]+(?:\s+[А-ЯЁ][А-ЯЁа-яё]+)?)$/;
  if (!name.test(doctor)) return {};
  return { doctor, specialty: lines.slice(0, dateIndex - 1).join(' ') };
}

export function documentPath(category, item, suggestedName) {
  const ext = path.extname(suggestedName).toLowerCase();
  const extension = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin';
  const title = item.title || path.basename(suggestedName, ext);
  const date = item.date || 'без-даты';
  const id = sha256(item.key).slice(0, 10);
  const label = item.doctor && item.specialty
    ? `${safeName(item.specialty, 55)}__${safeName(item.doctor, 40)}`
    : safeName(title);
  return path.join(safeName(category), item.date?.slice(0, 4) || 'без-даты', `${date}__${label}__${id}${extension}`);
}

export async function verifyFile(file, expectedHash) {
  const data = await readFile(file);
  if (!data.length) throw new Error('Пустой файл');
  if (path.extname(file).toLowerCase() === '.pdf') {
    if (!data.subarray(0, 5).equals(Buffer.from('%PDF-')) || !data.subarray(-2048).includes(Buffer.from('%%EOF'))) {
      throw new Error('Вместо полного PDF получен повреждённый файл или ответ сервера');
    }
  }
  const hash = sha256(data);
  if (expectedHash && hash !== expectedHash) throw new Error('Контрольная сумма не совпала');
  return { bytes: data.length, sha256: hash };
}

export async function zipDirectory(directory, destination) {
  const partial = `${destination}.partial`;
  const output = createWriteStream(partial);
  const archive = archiver('zip', { zlib: { level: 6 } });
  const complete = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', reject);
  });
  archive.pipe(output);
  archive.directory(directory, false);
  await Promise.all([archive.finalize(), complete]);
  await rename(partial, destination);
  return (await stat(destination)).size;
}
