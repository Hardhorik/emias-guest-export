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

export function ambulanceDetails(item) {
  if (!item.key?.startsWith('item_ambulance_')) return {};
  const lines = String(item.text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const dateIndex = lines.findIndex(line => /^\d{2}\.\d{2}\.\d{4}$/.test(line));
  if (dateIndex < 0) return {};
  const diagnosis = lines.slice(dateIndex + 1)
    .find(line => !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(line));
  return diagnosis ? { diagnosis, title: diagnosis } : {};
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

const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const healthDate = value => {
  if (!value) return '—';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : String(value);
};

export function healthSummaryHtml(summary) {
  const fact = (label, value, date) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value || '—')}</td><td>${escapeHtml(healthDate(date))}</td></tr>`;
  const facilities = (summary.facilities || []).map(item => `<tr><td>${escapeHtml(item.code || '—')}</td><td>${escapeHtml(item.diseaseName || '—')}</td><td>${escapeHtml(item.type || '—')}</td><td>${escapeHtml(healthDate(item.activationDate))}</td><td>${escapeHtml(healthDate(item.expirationDate))}</td></tr>`).join('');
  const diagnoses = (summary.dispensaryObservationDiagnoses || []).map(item => {
    const doctor = item.doctor ? [item.doctor.lastName, item.doctor.firstName, item.doctor.middleName].filter(Boolean).join(' ') : '—';
    return `<tr><td>${escapeHtml(item.code || '—')}</td><td>${escapeHtml(item.title || '—')}</td><td>${escapeHtml(healthDate(item.opened))}</td><td>${escapeHtml(doctor)}</td><td>${escapeHtml(item.doctor?.specialityName || '—')}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Информация о здоровье</title><style>
    @page{size:A4;margin:16mm}body{font:14px/1.45 Arial,sans-serif;color:#20232a}h1{font-size:24px;color:#263479}h2{font-size:18px;margin-top:24px;color:#263479}table{width:100%;border-collapse:collapse;margin:10px 0 18px}th,td{border:1px solid #ccd1df;padding:7px 9px;vertical-align:top;text-align:left}th{background:#eef0f7}thead th{background:#263479;color:white}.note{color:#616779;font-size:12px}</style></head><body>
    <h1>Информация о здоровье</h1><p class="note">Структурированная копия данных из электронной медицинской карты ЕМИАС.</p>
    <h2>Основные сведения</h2><table><thead><tr><th>Показатель</th><th>Значение</th><th>Дата определения</th></tr></thead><tbody>
      ${fact('Группа крови', summary.bloodType?.result, summary.bloodType?.identificationDate)}
      ${fact('Резус-фактор', summary.rhFactor?.result, summary.rhFactor?.identificationDate)}
      ${fact('Группа здоровья ребёнка', summary.childHealthGroup)}
      ${fact('Группа по физкультуре', summary.childPEGroup)}
      ${fact('Группа инвалидности', summary.disabilityGroup)}
    </tbody></table>
    <h2>Дополнительные медицинские сведения</h2>${facilities ? `<table><thead><tr><th>Код</th><th>Наименование</th><th>Тип</th><th>Дата начала</th><th>Дата окончания</th></tr></thead><tbody>${facilities}</tbody></table>` : '<p>Нет данных.</p>'}
    <h2>Диспансерное наблюдение</h2>${diagnoses ? `<table><thead><tr><th>Код</th><th>Диагноз</th><th>Открыт</th><th>Врач</th><th>Специальность</th></tr></thead><tbody>${diagnoses}</tbody></table>` : '<p>Нет данных.</p>'}
  </body></html>`;
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
