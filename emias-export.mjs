#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ambulanceDetails, doctorDetails, documentDate, documentPath, healthSummaryHtml, isAllowedBrowserRequest, isAllowedEmiasGuestUrl, sha256, verifyFile, zipDirectory } from './export-utils.mjs';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  code: { type: 'string' }, out: { type: 'string', default: 'exports' },
  resume: { type: 'string' }, headed: { type: 'boolean', default: false },
  'uploads-only': { type: 'boolean', default: false },
  'health-only': { type: 'boolean', default: false },
  'allow-third-party': { type: 'boolean', default: false },
  browser: { type: 'string' }, timeout: { type: 'string', default: '45000' },
  help: { type: 'boolean', short: 'h' },
} });
if (args.help) {
  console.log(`Использование: node emias-export.mjs "ССЫЛКА" --code КОД
Без ссылки и кода программа запросит их интерактивно.
  --out DIR       Родительская папка (по умолчанию exports)
  --resume DIR    Продолжить незавершённую выгрузку из этой папки
  --headed        Показать браузер
  --browser NAME  Использовать установленный chrome или msedge
  --timeout MS    Таймаут операции, по умолчанию 45000 мс
  --uploads-only  Повторно обработать загруженные документы (с --resume)
  --health-only   Обработать только информацию о здоровье и рецепты
  --allow-third-party  Не блокировать сторонние сетевые запросы страницы
Переменные окружения: EMIAS_GUEST_URL и EMIAS_ACCESS_CODE.
Код завершения: 0 — успешно, 2 — есть пропуски, 1 — ошибка входа/запуска.`);
  process.exit(0);
}

const timeout = Number(args.timeout);
if (args['uploads-only'] && !args.resume) throw new Error('--uploads-only применяется вместе с --resume');
if (args['uploads-only'] && args['health-only']) throw new Error('--uploads-only и --health-only несовместимы');
if (!Number.isFinite(timeout) || timeout < 1000) throw new Error('--timeout должен быть числом >= 1000');
const rl = createInterface({ input: stdin, output: stdout });
let link, code;
try {
  link = positionals[0] || process.env.EMIAS_GUEST_URL || await rl.question('Ссылка временного доступа: ');
  code = args.code || process.env.EMIAS_ACCESS_CODE || await rl.question('Код доступа: ');
} finally { rl.close(); }
if (!isAllowedEmiasGuestUrl(link.trim())) {
  throw new Error('Нужна ссылка https://lk.emias.mos.ru/guest?token=…');
}
const url = new URL(link.trim());
if (!/^\d{5}$/.test(code.trim())) throw new Error('Код должен содержать 5 цифр');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.resolve(args.resume || path.join(args.out, `emias_${timestamp}`));
await mkdir(directory, { recursive: true });
const manifestFile = path.join(directory, 'manifest.json');
const sourceHash = sha256(url.href);
let report = { version: 1, created: new Date().toISOString(), sourceHash, documents: [], sections: [], warnings: [] };
if (args.resume) {
  report = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (report.sourceHash !== sourceHash) throw new Error('Эта папка относится к другой ссылке доступа');
  if (args['uploads-only']) report.sections = report.sections.filter(s => s.category !== 'Загруженные документы');
  else if (args['health-only']) report.sections = report.sections.filter(s => !['Информация о здоровье', 'Рецепты'].includes(s.category));
  else report.sections = [];
  if (!args['uploads-only'] && !args['health-only']) report.warnings = [];
}
async function checkpoint() {
  report.updated = new Date().toISOString();
  await writeFile(`${manifestFile}.partial`, JSON.stringify(report, null, 2), 'utf8');
  await rename(`${manifestFile}.partial`, manifestFile);
}
function warning(text) {
  if (!report.warnings.includes(text)) report.warnings.push(text);
  console.warn(`  Внимание: ${text}`);
}
function errorText(error) {
  // Do not write guest tokens, authentication codes or long Playwright call logs.
  return String(error.message || error).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]').slice(0, 220);
}

let browser;
try {
  browser = await chromium.launch({
    headless: !args.headed,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'],
    ...(args.browser ? { channel: args.browser } : {}),
  });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'ru-RU' });
  if (!args['allow-third-party']) {
    await context.route('**/*', async route => {
      if (isAllowedBrowserRequest(route.request().url())) {
        await route.continue();
      } else {
        await route.abort('blockedbyclient');
      }
    });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  const settle = async () => {
    // React schedules some requests after the click handler returns.
    await page.waitForTimeout(350);
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 5000) }).catch(() => {});
  };
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByTestId('otp_input').fill(code.trim());
  await page.waitForURL('**/medical-records', { timeout }).catch(async () => {
    throw new Error('Вход не выполнен. Проверьте срок действия ссылки и код доступа.');
  });
  code = undefined;
  console.log(`Вход выполнен. Папка: ${directory}`);
  await page.getByTestId('analyzes_card_container').waitFor();
  await settle();
  const accept = page.getByRole('button', { name: 'принять', exact: true });
  if (await accept.isVisible()) await accept.click();

  async function closeDocument() {
    const close = page.getByTestId('document_header_button').or(page.getByTestId('modal_header_close_button')).first();
    if (await close.isVisible()) {
      await close.click();
      await close.waitFor({ state: 'hidden' });
    }
  }

  async function collect(scope) {
    const entries = await scope.locator('[data-testid]').evaluateAll(nodes => {
      const result = new Map();
      for (const node of nodes) {
        const id = node.getAttribute('data-testid');
        if (!/^item_.+_(download|view)$/.test(id) || !node.getClientRects().length) continue;
        const key = id.replace(/_(download|view)$/, '');
        let parent = node.parentElement;
        let text = '';
        for (let depth = 0; parent && depth < 7; depth++, parent = parent.parentElement) {
          const keys = new Set([...parent.querySelectorAll('[data-testid]')]
            .map(n => n.getAttribute('data-testid')).filter(v => /^item_.+_(download|view)$/.test(v))
            .map(v => v.replace(/_(download|view)$/, '')));
          if (keys.size > 1) break;
          text = parent.innerText || '';
          if (/\b\d{2}\.\d{2}\.\d{4}\b/.test(text)) break;
        }
        const entry = result.get(key) || { key, text };
        entry[id.endsWith('_download') ? 'download' : 'view'] = id;
        result.set(key, entry);
      }
      return [...result.values()];
    });
    return entries.map(item => ({ ...item, date: documentDate(item.text), ...doctorDetails(item), ...ambulanceDetails(item) }));
  }

  async function saveDocument(category, item) {
    const previous = report.documents.find(d => d.key === item.key);
    if (previous?.status === 'saved') {
      try {
        await verifyFile(path.join(directory, previous.file), previous.sha256);
        const nextFile = documentPath(category, item, previous.suggestedFilename || path.basename(previous.file));
        if (nextFile !== previous.file) {
          await mkdir(path.dirname(path.join(directory, nextFile)), { recursive: true });
          await rename(path.join(directory, previous.file), path.join(directory, nextFile));
        }
        const metadataChanged = nextFile !== previous.file || item.title !== previous.title ||
          item.diagnosis !== previous.diagnosis || item.doctor !== previous.doctor || item.specialty !== previous.specialty;
        if (metadataChanged) {
          Object.assign(previous, { file: nextFile, title: item.title, diagnosis: item.diagnosis,
            doctor: item.doctor, specialty: item.specialty });
          await checkpoint();
        }
        return;
      }
      catch { /* Re-download a missing or damaged file. */ }
    }
    const entry = { key: item.key, category, date: item.date, title: item.title, diagnosis: item.diagnosis,
      doctor: item.doctor, specialty: item.specialty, description: item.text, status: 'pending' };
    if (previous) Object.assign(previous, entry); else report.documents.push(entry);
    const record = previous || entry;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let stage = 'закрытие просмотра';
      let onResponse;
      const denied = new Promise(resolve => {
        onResponse = response => {
          const pathname = new URL(response.url()).pathname;
          if (response.status() === 403 && pathname.startsWith('/api/1/document/')) {
            const error = new Error('ЕМИАС запретил доступ к файлу документа (HTTP 403)');
            error.accessDenied = true;
            resolve(error);
          }
        };
        page.on('response', onResponse);
      });
      const withAccessCheck = promise => Promise.race([promise, denied.then(error => { throw error; })]);
      try {
        if (attempt > 1) await closeDocument();
        let button;
        if (item.download) button = page.getByTestId(item.download);
        else {
          stage = 'открытие документа';
          await page.getByTestId(item.view).click();
          button = page.getByTestId('document_download_button')
            .or(page.getByRole('button', { name: 'Скачать заключение + кардиограмму', exact: true }));
          await withAccessCheck(button.or(page.getByTestId('modal_header_close_button')).first().waitFor());
          if (!await button.first().isVisible() && await page.getByTestId('modal_header_close_button').isVisible()) {
            await settle();
            if (!await button.first().isVisible()) {
              const content = await page.getByRole('dialog').innerText();
              const title = item.key.startsWith('item_medical_recommendation_')
                ? 'Рекомендация (текст страницы)' : 'Карточка события (текст страницы)';
              const relative = documentPath(category, item, `${title}.html`);
              const destination = path.join(directory, relative);
              const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              await mkdir(path.dirname(destination), { recursive: true });
              await writeFile(destination, `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:16px/1.5 sans-serif;max-width:900px;margin:32px auto;padding:0 16px}pre{white-space:pre-wrap;font:inherit}</style><h1>${escape(title)}</h1><p>Сохранённый текст из окна ЕМИАС. Оригинальный PDF в этом окне не предоставлен.</p><pre>${escape(content)}</pre></html>`, 'utf8');
              Object.assign(record, await verifyFile(destination), { status: 'saved', file: relative,
                format: 'page-text-html', suggestedFilename: `${title}.html`, error: undefined });
              console.log(`  ✓ ${relative}`);
              await checkpoint();
              return;
            }
          }
          const combined = page.getByRole('button', { name: 'Скачать заключение + кардиограмму', exact: true });
          if (await combined.isVisible()) button = combined;
          if (await page.getByRole('button', { name: 'Запросить изображение исследования', exact: true }).isVisible()) {
            record.imageRequiresSeparateRequest = true;
          }
        }
        const pending = page.waitForEvent('download', { timeout });
        stage = 'скачивание';
        // Register the event before clicking; consume both promises on failure.
        const [download] = await Promise.all([pending, button.first().click()]);
        const failure = await download.failure();
        if (failure) throw new Error(failure);
        const relative = documentPath(category, item, download.suggestedFilename());
        const destination = path.join(directory, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await download.saveAs(destination);
        let verified;
        try { verified = await verifyFile(destination); }
        catch (error) { await unlink(destination).catch(() => {}); throw error; }
        Object.assign(record, verified, { status: 'saved', file: relative, suggestedFilename: download.suggestedFilename(), error: undefined });
        if (!item.date) warning(`${category}: для документа ${item.key} не удалось прочитать дату; папка «без-даты».`);
        console.log(`  ✓ ${relative}`);
        await checkpoint();
        return;
      } catch (error) {
        record.error = `${stage}: ${errorText(error)}`;
        if (error.accessDenied) {
          record.status = 'unavailable';
          warning(`${category}: ${item.key}: ${record.error}`);
          await checkpoint();
          return;
        }
        if (attempt === 1) console.warn(`  Повторная попытка: ${item.key}: ${record.error}`);
        if (attempt === 2) {
          record.status = 'failed';
          warning(`${category}: ${item.key}: ${record.error}`);
          await checkpoint();
        }
      } finally { page.off('response', onResponse); await closeDocument().catch(() => {}); }
    }
  }

  async function saveGenerated(category, key, title, extension, data, format, date = new Date().toISOString().slice(0, 10)) {
    const item = { key: `generated_${key}`, title, date };
    const relative = documentPath(category, item, `${title}.${extension}`);
    const destination = path.join(directory, relative);
    const previous = report.documents.find(document => document.key === item.key);
    if (previous?.status === 'saved') {
      try { await verifyFile(path.join(directory, previous.file), previous.sha256); return previous; }
      catch { /* Recreate a missing or damaged export. */ }
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
    const verified = await verifyFile(destination);
    const record = { ...item, category, ...verified, status: 'saved', file: relative, format };
    if (previous) Object.assign(previous, record); else report.documents.push(record);
    console.log(`  ✓ ${relative}`);
    await checkpoint();
    return record;
  }

  async function saveRecipe(item) {
    const title = item.text.split(/\r?\n/).map(line => line.trim()).find(Boolean) || 'Рецепт';
    const pdfKey = `recipe_pdf_${item.key}`;
    const previousPdf = report.documents.find(document => document.key === pdfKey);
    if (previousPdf?.status === 'saved') {
      try { await verifyFile(path.join(directory, previousPdf.file), previousPdf.sha256); return; }
      catch { /* Re-download a missing or damaged original PDF. */ }
    }
    const [detailsResponse] = await Promise.all([
      page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/3/receipt/details' && response.status() === 200),
      page.getByTestId(item.view).click(),
    ]);
    const details = await detailsResponse.json();
    const modal = page.getByTestId('modal_document_detail').or(page.getByRole('dialog')).first();
    await modal.waitFor(); await settle();
    await saveGenerated('Рецепты', `recipe_${item.key}_data`, `${title} — данные рецепта`, 'json',
      Buffer.from(JSON.stringify(details, null, 2)), 'emias-json', item.date);
    const pending = page.waitForEvent('download', { timeout });
    await modal.locator('button').last().click();
    const download = await pending;
    const failure = await download.failure();
    if (failure) throw new Error(failure);
    const pdfItem = { ...item, key: pdfKey, title };
    const relative = documentPath('Рецепты', pdfItem, download.suggestedFilename());
    const destination = path.join(directory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await download.saveAs(destination);
    let verified;
    try { verified = await verifyFile(destination); }
    catch (error) { await unlink(destination).catch(() => {}); throw error; }
    const record = { key: pdfKey, category: 'Рецепты', date: item.date, title, ...verified,
      status: 'saved', file: relative, format: 'original-pdf', suggestedFilename: download.suggestedFilename() };
    if (previousPdf) Object.assign(previousPdf, record); else report.documents.push(record);
    console.log(`  ✓ ${relative}`);
    await checkpoint();
    await closeDocument();
  }

  const categories = [
    ['analyzes', 'Анализы'], ['inspections', 'Приёмы'], ['research', 'Исследования'],
    ['medical-certificates', 'Справки'], ['disability_forms', 'Больничные'],
    ['epicrisis', 'Выписки'], ['ambulance', 'Скорая помощь'], ['consilium', 'Консилиумы'],
  ];
  for (const [id, category] of (args['uploads-only'] || args['health-only'] ? [] : categories)) {
    const section = { category, status: 'pending', expected: null, found: 0 };
    report.sections.push(section);
    try {
      const card = page.getByTestId(`${id}_card_container`);
      if (!await card.count()) throw new Error('Раздел не найден в интерфейсе');
      const counter = page.getByTestId(`${id}_card_count_value`);
      if (await counter.count()) section.expected = Number(await counter.innerText());
      console.log(`${category}: ${section.expected ?? '?'} документов`);
      const open = page.getByTestId(`${id}_card_open_button`);
      if (!await open.count()) {
        if (section.expected === 0) { section.status = 'empty'; continue; }
        throw new Error('Нет кнопки открытия раздела');
      }
      await open.click();
      const all = page.getByTestId(`${id}_card_all`);
      await all.waitFor();
      await settle();
      if (await all.isEnabled()) await all.click();
      await settle();
      if (section.expected > 0) {
        await page.waitForFunction(({ id, expected }) => {
          const el = document.querySelector(`[data-testid="${id}_card_count_value"]`);
          return el && Number(el.textContent) >= expected;
        }, { id, expected: section.expected }, { timeout });
      }
      if (await counter.count()) section.expected = Math.max(section.expected || 0, Number(await counter.innerText()));
      const items = new Map();
      const readItems = async () => { for (const item of await collect(card)) items.set(item.key, item); };
      await readItems();
      if (id === 'medical-certificates') {
        for (const name of ['Справки', 'Медицинские заключения',
          'Рекомендации по освобождению от посещения образовательного учреждения',
          'Медицинская карта ребенка (форма 026/у-2000)']) {
          const chapter = card.getByRole('button', { name, exact: true });
          if (await chapter.count()) {
            await chapter.click(); await settle();
            for (let chapterPage = 1; chapterPage <= 100; chapterPage++) {
              for (const item of await collect(card)) {
                items.set(item.key, item);
                await saveDocument(category, item);
              }
              const next = card.getByRole('button', { name: String(chapterPage + 1), exact: true });
              if (!await next.count() || !await next.isVisible() || !await next.isEnabled()) break;
              await next.click(); await settle();
            }
          }
        }
      } else {
        // Some sections may expose a "show more" button. Never silently stop at the first page.
        for (let pass = 0; pass < 100; pass++) {
          for (const item of await collect(card)) await saveDocument(category, item);
          const nextPage = card.getByRole('button', { name: String(pass + 2), exact: true });
          if (await nextPage.count() && await nextPage.isVisible() && await nextPage.isEnabled()) {
            await nextPage.click(); await settle(); await readItems();
            continue;
          }
          const more = card.getByRole('button', { name: /^(показать (еще|ещё)|загрузить (еще|ещё))/i });
          if (!await more.count() || !await more.first().isVisible()) break;
          const before = items.size;
          await more.first().click(); await settle(); await readItems();
          if (items.size === before) throw new Error('Кнопка «ещё» не добавила документы');
        }
      }
      section.found = items.size;
      const unavailable = report.documents.filter(d => d.category === category && d.status !== 'saved').length;
      section.unavailable = unavailable;
      section.status = (section.expected === null || section.expected === items.size) && unavailable === 0 ? 'complete' : 'incomplete';
      if (section.status === 'incomplete') warning(`${category}: сайт указал ${section.expected}, найдено ${items.size}.`);
    } catch (error) {
      section.status = 'failed'; section.error = errorText(error);
      warning(`${category}: ${section.error}`);
    } finally { await checkpoint(); }
  }

  if (!args['uploads-only']) {
    const section = { category: 'Информация о здоровье', status: 'pending', found: 0 };
    report.sections.push(section);
    try {
      await page.goto('https://lk.emias.mos.ru/medical-records'); await settle();
      const summaryResponse = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/1/health/summary' && response.status() === 200);
      await page.getByTestId('content_links_health_information_button').click();
      const summary = await (await summaryResponse).json();
      await settle();
      await saveGenerated(section.category, 'health_summary_data', 'Информация о здоровье — данные', 'json',
        Buffer.from(JSON.stringify(summary, null, 2)), 'emias-json');
      const printable = await context.newPage();
      try {
        await printable.setContent(healthSummaryHtml(summary));
        await saveGenerated(section.category, 'health_summary_view', 'Информация о здоровье — сведения', 'pdf',
          await printable.pdf({ format: 'A4', printBackground: true }), 'generated-text-pdf');
      } finally { await printable.close(); }
      section.found = 2;
      section.status = 'complete';
    } catch (error) {
      section.status = 'failed'; section.error = errorText(error);
      warning(`${section.category}: ${section.error}`);
    } finally { await checkpoint(); }

    const recipes = { category: 'Рецепты', status: 'pending', expected: null, found: 0 };
    report.sections.push(recipes);
    try {
      await page.goto('https://lk.emias.mos.ru/medical-records'); await settle();
      const card = page.getByTestId('recipes_container');
      await card.waitFor();
      const counter = page.getByTestId('recipes_count_value');
      recipes.expected = Number(await counter.innerText());
      console.log(`Рецепты: ${recipes.expected} документов`);
      await page.getByTestId('recipes_open_button').click(); await settle();
      const recipeList = card.getByRole('button', { name: 'Рецепты', exact: true });
      await recipeList.waitFor();
      await recipeList.click(); await settle();
      const all = page.getByTestId('recipes_list_all');
      await all.waitFor();
      if (await all.isEnabled()) await all.evaluate(element => element.click());
      await settle();
      if (recipes.expected > 0) {
        await card.locator('[data-testid^="item_recipe_"][data-testid$="_view"]').first().waitFor();
      }
      const items = new Map();
      for (let pass = 0; pass < 100; pass++) {
        for (const item of await collect(card)) {
          items.set(item.key, item);
          try { await saveRecipe(item); }
          catch (error) {
            await closeDocument().catch(() => {});
            const key = `recipe_pdf_${item.key}`;
            const record = report.documents.find(document => document.key === key)
              || { key, category: recipes.category, date: item.date, title: item.text.split(/\r?\n/)[0], status: 'failed' };
            record.status = 'failed'; record.error = errorText(error);
            if (!report.documents.includes(record)) report.documents.push(record);
            warning(`Рецепты: ${item.key}: ${record.error}`);
            await checkpoint();
          }
        }
        const next = card.getByRole('button', { name: String(pass + 2), exact: true });
        if (await next.count() && await next.isVisible() && await next.isEnabled()) {
          await next.click(); await settle(); continue;
        }
        const more = card.getByRole('button', { name: /^(показать (еще|ещё)|загрузить (еще|ещё))/i });
        if (!await more.count() || !await more.first().isVisible()) break;
        const before = items.size;
        await more.first().click(); await settle();
        if ((await collect(card)).length === before) break;
      }
      recipes.found = items.size;
      const unavailable = report.documents.filter(document => document.category === recipes.category && document.status !== 'saved').length;
      recipes.unavailable = unavailable;
      recipes.status = recipes.expected === 0 && items.size === 0 ? 'empty'
        : recipes.expected === items.size && unavailable === 0 ? 'complete' : 'incomplete';
      if (recipes.status === 'incomplete') warning(`Рецепты: сайт указал ${recipes.expected}, найдено ${items.size}.`);
    } catch (error) {
      recipes.status = 'failed'; recipes.error = errorText(error);
      warning(`${recipes.category}: ${recipes.error}`);
    } finally { await checkpoint(); }
  }

  // Other sections vary across accounts. Export known document controls and flag any
  // unsupported content instead of claiming that an unrecognised list is empty.
  for (const [testId, category, emptyPattern] of [
    ['vaccinations_card_open_button', 'Прививки', /Нет данных о профилактических прививках/],
    ['diaries_card_open_button', 'Дневник здоровья', /Нет данных|нет записей/i],
    ['checkups_block_open_button', 'Диспансеризация', /Нет данных|не проходили/i],
    ['content_links_docs_button', 'Загруженные документы', /Пока нет загруженных документов/],
  ].filter(([, category]) => args['uploads-only'] ? category === 'Загруженные документы' : !args['health-only'])) {
    const section = { category, status: 'pending', found: 0 };
    report.sections.push(section);
    try {
      await page.goto('https://lk.emias.mos.ru/medical-records'); await settle();
      const open = page.getByTestId(testId);
      await open.waitFor();
      await open.click(); await settle();
      if (category === 'Загруженные документы' && await page.locator('[data-testid^="document_modal_open-"]').count()) {
        let recordCount = 0;
        await settle();
        const pageCount = await page.locator('button').evaluateAll(nodes => Math.max(1, ...nodes.map(n => n.textContent.trim()).filter(s => /^\d+$/.test(s)).map(Number)));
        for (let number = 1; number <= pageCount; number++) {
          console.log(`Загруженные документы: страница ${number} из ${pageCount}`);
          await page.getByTestId('document_modal_open-0').waitFor();
          const rowIds = await page.locator('[data-testid^="document_modal_open-"]').evaluateAll(nodes => nodes.map(n => n.dataset.testid));
          for (const rowId of rowIds) {
            await page.getByTestId(rowId).click();
            const modal = page.getByRole('dialog');
            await modal.waitFor(); await settle();
            const text = await modal.innerText();
            const title = text.split('\n')[0];
            const files = await modal.locator('[data-testid^="document_modal_file-"]').evaluateAll(nodes => nodes.map(n => ({ id: n.dataset.testid, name: n.innerText })));
            if (!files.length) warning(`Загруженные документы: ${title}: в карточке нет вложений.`);
            for (let index = 0; index < files.length; index++) {
              if (!await page.getByTestId('modal_header_close_button').isVisible()) await page.getByTestId(rowId).click();
              const file = files[index];
              await saveDocument(category, { key: `upload_${sha256(text)}_${index}`, text,
                date: documentDate(text), title: `${title} (${file.name})`, download: file.id });
              section.found++;
            }
            await closeDocument();
            recordCount++;
          }
          if (number === pageCount) break;
          await settle();
          const firstRowText = await page.getByTestId('document_modal_open-0').evaluate(el => {
            let p = el;
            for (let i = 0; i < 7 && p; i++, p = p.parentElement) {
              if (/\d{2}\.\d{2}\.\d{4}/.test(p.innerText)) return p.innerText;
            }
            return null;
          });
          const next = page.locator('button').filter({ hasText: new RegExp(`^\\s*${number + 1}\\s*$`) });
          await next.waitFor();
          await next.click(); await settle();
          await page.waitForFunction(oldText => {
            let p = document.querySelector('[data-testid="document_modal_open-0"]');
            for (let i = 0; i < 7 && p; i++, p = p.parentElement) {
              if (/\d{2}\.\d{2}\.\d{4}/.test(p.innerText)) return p.innerText !== oldText;
            }
            return false;
          }, firstRowText);
        }
        section.records = recordCount;
        section.status = report.documents.some(d => d.category === category && d.status !== 'saved') ? 'incomplete' : 'complete';
        await checkpoint();
        continue;
      }
      let scope = page.locator('body');
      if (category === 'Прививки') scope = page.getByTestId('vaccinations_card_container');
      if (category === 'Дневник здоровья' && await page.getByTestId('diaries_card_container').count()) scope = page.getByTestId('diaries_card_container');
      const items = await collect(scope);
      section.found = items.length;
      for (const item of items) await saveDocument(category, item);
      const text = await scope.innerText();
      if (items.length) {
        section.status = 'unverified';
        warning(`${category}: сохранены распознанные документы, полноту этого раздела нужно проверить вручную.`);
      } else if (emptyPattern.test(text)) section.status = 'empty';
      else {
        section.status = 'unverified';
        warning(`${category}: нет распознанного списка документов; раздел нужно проверить вручную.`);
      }
    } catch (error) {
      section.status = 'failed'; section.error = errorText(error);
      warning(`${category}: ${section.error}`);
    } finally { await checkpoint(); }
  }

  const failed = report.documents.filter(d => d.status !== 'saved');
  const saved = report.documents.filter(d => d.status === 'saved');
  const incomplete = report.sections.some(s => ['failed', 'incomplete', 'unverified'].includes(s.status));
  report.status = failed.length || incomplete ? 'partial' : 'complete';
  report.savedCount = saved.length;
  report.finished = new Date().toISOString();
  await checkpoint();
  await writeFile(path.join(directory, 'README.txt'), [
    'Выгрузка документов ЕМИАС', `Дата: ${report.finished}`, `Сохранено файлов: ${saved.length}`,
    `Статус: ${report.status === 'complete' ? 'завершено' : 'есть разделы, требующие проверки (см. manifest.json)'}`,
    '', 'Структура: Категория / Год / ГГГГ-ММ-ДД__Название__идентификатор.pdf',
    'Для приёмов: ГГГГ-ММ-ДД__Специальность__Фамилия И. О.__идентификатор.pdf, если врач указан в списке.',
    'Дата взята из строки документа на сайте. Если дата не распознана, используется «без-даты».',
    'ЭКГ по возможности скачиваются вместе с кардиограммой.',
    'Изображения исследований, требующие отдельного запроса, не запрашиваются.',
    'HTML — текст карточек, для которых ЕМИАС не предоставил кнопку скачивания файла.',
    'Выгрузка ограничена правами предоставленной гостевой ссылки.',
    'manifest.json: перечень, исходные описания, размеры, SHA-256, ошибки и результаты проверки разделов.',
    '', ...report.warnings,
  ].join('\n'), 'utf8');
  const archive = `${directory}.zip`;
  await zipDirectory(directory, archive);
  console.log(`\nСохранено: ${saved.length}. Ошибок документов: ${failed.length}.\nZIP: ${archive}`);
  if (incomplete) console.log('Некоторые дополнительные разделы требуют проверки: смотрите manifest.json.');
  process.exitCode = report.status === 'complete' ? 0 : 2;
} catch (error) {
  report.status = 'interrupted'; report.error = errorText(error);
  await checkpoint();
  console.error(`Ошибка: ${report.error}\nПродолжение: --resume "${directory}"`);
  process.exitCode = 1;
} finally { await browser?.close(); }
