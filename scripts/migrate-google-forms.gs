/**
 * migrate-google-forms.gs — bulk-import existing Google Forms into the
 * dashboard's Forms engine.
 *
 * WHY APPS SCRIPT: it runs as YOU, so it can read every form you own without
 * enabling the Forms API, minting credentials, or sharing each form with the
 * service account. One authorisation, one run, all forms migrated.
 *
 * ── HOW TO USE ────────────────────────────────────────────────────────────
 *  1. Open the Longitude Google Sheet.
 *  2. Extensions → Apps Script. Delete whatever is in the editor.
 *  3. Paste this whole file in. Save (disk icon).
 *  4. In the function dropdown at the top pick `migrateForms` and click Run.
 *     Approve the permission prompt the first time.
 *
 *     THAT IS THE WHOLE JOB — with FORM_URLS left empty it migrates EVERY
 *     Google Form in your Drive in that single run. There is nothing to repeat
 *     per form. `listMyForms` below is an optional preview if you would rather
 *     see the list and hand-pick a subset first.
 *
 *  5. Back in the dashboard, hard-refresh and open Forms. Review the imported
 *     definitions in the FormDefs / FormFields tabs and tweak wording there.
 *
 * ── IF YOUR "FORMS" ARE ACTUALLY SPREADSHEETS ─────────────────────────────
 * If people currently fill in a Google SHEET (a checklist tab, a log people
 * type rows into) rather than a Google Form, use `migrateSheets` instead. It
 * turns each sheet's HEADER ROW into form fields, guessing the field type from
 * the existing data in the column. Point SHEET_FOLDER_ID at the Drive folder
 * holding them, or list specific files in SHEET_URLS.
 *
 * SAFE TO RE-RUN: a form whose formId already exists in FormDefs is skipped,
 * so nothing you have edited gets overwritten.
 *
 * NOT MIGRATED (flagged in the log, needs a manual decision):
 *   · File-upload questions — the dashboard has no file storage yet.
 *   · Grid / checkbox-grid questions — no equivalent single field.
 *   · Page breaks and conditional "go to section based on answer" logic.
 *   · Existing RESPONSES. This moves the form, not its history; old responses
 *     stay in whatever sheet the Google Form already writes to.
 */

// Leave empty to migrate every form in your Drive. Otherwise list edit URLs,
// e.g. ['https://docs.google.com/forms/d/ABC123/edit', ...]
var FORM_URLS = [];

// Who should see the imported forms. Same vocabulary as the FormDefs
// `audience` column: owner, admin, viewer, area_manager, manager, stylist.
var IMPORT_AUDIENCE = 'owner,admin,area_manager';

// ── migrateSheets() settings (only used by that function) ─────────────────
// A Drive folder id holding the spreadsheets to convert. Get it from the
// folder's URL: drive.google.com/drive/folders/THIS_PART
// Leave '' and list files in SHEET_URLS instead. Never scans all of Drive —
// that would sweep up every unrelated spreadsheet you own.
var SHEET_FOLDER_ID = '';
var SHEET_URLS = [];
// Header row number, and how many data rows to sample when guessing a column's
// field type (more rows = better guess, slower run).
var HEADER_ROW = 1;
var SAMPLE_ROWS = 40;
// A column with few enough distinct text values is offered as a dropdown
// rather than a free-text box.
var MAX_CHOICES = 12;

var DEFS_TAB = 'FormDefs';
var FIELDS_TAB = 'FormFields';
var DEFS_COLUMNS = ['formId', 'title', 'description', 'icon', 'audience', 'status', 'sortOrder'];
var FIELDS_COLUMNS = ['formId', 'fieldKey', 'label', 'type', 'required', 'options', 'placeholder', 'help', 'sortOrder'];

/** Print every Google Form you own, so you can pick which to migrate. */
function listMyForms() {
  var files = DriveApp.getFilesByType(MimeType.GOOGLE_FORMS);
  var n = 0;
  while (files.hasNext()) {
    var f = files.next();
    Logger.log((++n) + '. ' + f.getName() + '\n   ' + f.getUrl());
  }
  if (!n) Logger.log('No Google Forms found in your Drive.');
  else Logger.log('\n' + n + ' form(s). Copy the URLs you want into FORM_URLS, or leave it empty to migrate all.');
}

/** Main entry point — converts forms into FormDefs / FormFields rows. */
function migrateForms() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var defsSheet = ensureSheet(ss, DEFS_TAB, DEFS_COLUMNS);
  var fieldsSheet = ensureSheet(ss, FIELDS_TAB, FIELDS_COLUMNS);

  var existing = readColumn(defsSheet, 'formId');
  var forms = FORM_URLS.length ? FORM_URLS.map(openByUrl) : allDriveForms();

  if (!forms.length) { Logger.log('No forms to migrate.'); return; }

  var defRows = [], fieldRows = [], skipped = [], warnings = [];
  var order = (existing.length + 1) * 10;

  forms.forEach(function (form) {
    if (!form) return;
    var title = form.getTitle() || 'Untitled form';
    var formId = slugify(title);
    if (existing.indexOf(formId) !== -1) { skipped.push(title + ' (formId "' + formId + '" already in FormDefs)'); return; }

    defRows.push([formId, title, form.getDescription() || '', '📝', IMPORT_AUDIENCE, 'active', order]);
    order += 10;

    var sort = 10, keys = {};
    form.getItems().forEach(function (item) {
      var mapped = mapItem(item);
      if (mapped.warning) { warnings.push(title + ' → "' + item.getTitle() + '": ' + mapped.warning); return; }
      if (!mapped.type) return;

      // Field keys must be unique inside a form — two questions can share a title.
      var key = slugify(item.getTitle() || ('q' + sort), true);
      if (keys[key]) { key = key + '_' + sort; }
      keys[key] = true;

      fieldRows.push([formId, key, item.getTitle() || key, mapped.type,
                      mapped.required ? 'yes' : '', mapped.options.join('|'),
                      '', item.getHelpText() || '', sort]);
      sort += 10;
    });
    existing.push(formId);
  });

  if (defRows.length) defsSheet.getRange(defsSheet.getLastRow() + 1, 1, defRows.length, DEFS_COLUMNS.length).setValues(defRows);
  if (fieldRows.length) fieldsSheet.getRange(fieldsSheet.getLastRow() + 1, 1, fieldRows.length, FIELDS_COLUMNS.length).setValues(fieldRows);

  Logger.log('Imported ' + defRows.length + ' form(s), ' + fieldRows.length + ' field(s).');
  if (skipped.length) Logger.log('\nSkipped (already present):\n  ' + skipped.join('\n  '));
  if (warnings.length) Logger.log('\nNeeds a manual decision:\n  ' + warnings.join('\n  '));
  Logger.log('\nReview the ' + DEFS_TAB + ' / ' + FIELDS_TAB + ' tabs, then hard-refresh the dashboard.');
}

/**
 * Convert SPREADSHEETS into forms. Each sheet (tab) with a header row becomes
 * one form; each header cell becomes a field. The field type is inferred from
 * the data already in that column — dates stay dates, numbers stay numbers,
 * and a column with a small set of repeated values becomes a dropdown.
 *
 * Also safe to re-run: existing formIds are skipped.
 */
function migrateSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var defsSheet = ensureSheet(ss, DEFS_TAB, DEFS_COLUMNS);
  var fieldsSheet = ensureSheet(ss, FIELDS_TAB, FIELDS_COLUMNS);
  var existing = readColumn(defsSheet, 'formId');

  var books = [];
  if (SHEET_URLS.length) {
    SHEET_URLS.forEach(function (u) {
      try { books.push(SpreadsheetApp.openByUrl(u)); }
      catch (e) { Logger.log('Could not open: ' + u + ' — ' + e.message); }
    });
  } else if (SHEET_FOLDER_ID) {
    var it = DriveApp.getFolderById(SHEET_FOLDER_ID).getFilesByType(MimeType.GOOGLE_SHEETS);
    while (it.hasNext()) {
      try { books.push(SpreadsheetApp.openById(it.next().getId())); } catch (e) { /* skip */ }
    }
  } else {
    Logger.log('Set SHEET_FOLDER_ID to a Drive folder id, or list files in SHEET_URLS, then run again.');
    return;
  }

  if (!books.length) { Logger.log('No spreadsheets found.'); return; }

  var defRows = [], fieldRows = [], skipped = [], empty = [];
  var order = (existing.length + 1) * 10;
  var thisId = ss.getId();

  books.forEach(function (book) {
    if (book.getId() === thisId) return;             // never migrate the dashboard's own sheet
    book.getSheets().forEach(function (sheet) {
      var headers = readHeaderRow(sheet);
      if (!headers.length) { empty.push(book.getName() + ' → ' + sheet.getName()); return; }

      // Single-tab books read better named after the file; multi-tab books
      // need the tab name to stay distinguishable.
      var label = book.getSheets().length > 1
        ? book.getName() + ' — ' + sheet.getName()
        : book.getName();
      var formId = slugify(label);
      if (existing.indexOf(formId) !== -1) { skipped.push(label); return; }

      defRows.push([formId, label, 'Imported from the "' + book.getName() + '" spreadsheet.',
                    '📋', IMPORT_AUDIENCE, 'active', order]);
      order += 10;

      var sort = 10, keys = {};
      headers.forEach(function (h, i) {
        var guess = guessColumnType(sheet, i + 1);
        var key = slugify(h, true);
        if (keys[key]) key = key + '_' + sort;
        keys[key] = true;
        fieldRows.push([formId, key, h, guess.type, '', guess.options.join('|'), '', '', sort]);
        sort += 10;
      });
      existing.push(formId);
    });
  });

  if (defRows.length) defsSheet.getRange(defsSheet.getLastRow() + 1, 1, defRows.length, DEFS_COLUMNS.length).setValues(defRows);
  if (fieldRows.length) fieldsSheet.getRange(fieldsSheet.getLastRow() + 1, 1, fieldRows.length, FIELDS_COLUMNS.length).setValues(fieldRows);

  Logger.log('Imported ' + defRows.length + ' form(s) from spreadsheets, ' + fieldRows.length + ' field(s).');
  if (skipped.length) Logger.log('\nSkipped (already present):\n  ' + skipped.join('\n  '));
  if (empty.length) Logger.log('\nNo header row found (skipped):\n  ' + empty.join('\n  '));
  Logger.log('\nNOTE: every imported field is optional and the types are guesses.'
    + '\nSet `required` to yes where needed and check the `type` column in ' + FIELDS_TAB + '.');
}

/** Header cells, trimmed, stopping at the first blank. */
function readHeaderRow(sheet) {
  if (sheet.getLastRow() < HEADER_ROW || sheet.getLastColumn() < 1) return [];
  var row = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  var out = [];
  for (var i = 0; i < row.length; i++) {
    var v = String(row[i] == null ? '' : row[i]).trim();
    if (!v) break;
    out.push(v);
  }
  return out;
}

/** Infer a field type for one column from the values already in it. */
function guessColumnType(sheet, col) {
  var first = HEADER_ROW + 1;
  var n = Math.min(SAMPLE_ROWS, sheet.getLastRow() - HEADER_ROW);
  if (n <= 0) return { type: 'text', options: [] };

  var vals = sheet.getRange(first, col, n, 1).getValues()
    .map(function (r) { return r[0]; })
    .filter(function (v) { return v !== '' && v !== null; });
  if (!vals.length) return { type: 'text', options: [] };

  var dates = 0, nums = 0, longText = 0, distinct = {};
  vals.forEach(function (v) {
    if (Object.prototype.toString.call(v) === '[object Date]') dates++;
    else if (typeof v === 'number') nums++;
    else {
      var s = String(v).trim();
      if (s.length > 60) longText++;
      distinct[s] = true;
    }
  });

  var total = vals.length;
  if (dates / total > 0.6) return { type: 'date', options: [] };
  if (nums / total > 0.6) return { type: 'number', options: [] };
  if (longText / total > 0.3) return { type: 'textarea', options: [] };

  var choices = Object.keys(distinct);
  // Repeated values across enough rows means a fixed vocabulary, not free text.
  if (choices.length && choices.length <= MAX_CHOICES && total >= choices.length * 2) {
    choices.sort();
    return { type: choices.length > 6 ? 'select' : 'radio', options: choices };
  }
  return { type: 'text', options: [] };
}

/** Google Forms question type → dashboard field type. */
function mapItem(item) {
  var t = item.getType(), out = { type: '', required: false, options: [], warning: '' };
  var IT = FormApp.ItemType;

  switch (t) {
    case IT.TEXT:            out.type = 'text';      out.required = item.asTextItem().isRequired(); break;
    case IT.PARAGRAPH_TEXT:  out.type = 'textarea';  out.required = item.asParagraphTextItem().isRequired(); break;
    case IT.DATE:            out.type = 'date';      out.required = item.asDateItem().isRequired(); break;
    case IT.DATETIME:        out.type = 'date';      out.required = item.asDateTimeItem().isRequired(); break;
    case IT.TIME:            out.type = 'text';      out.required = item.asTimeItem().isRequired(); break;
    case IT.SECTION_HEADER:  out.type = 'section';   break;

    case IT.MULTIPLE_CHOICE: {
      var mc = item.asMultipleChoiceItem();
      out.required = mc.isRequired();
      out.options = mc.getChoices().map(function (c) { return c.getValue(); });
      // A long option list reads better as a dropdown than a stack of radios.
      out.type = out.options.length > 6 ? 'select' : 'radio';
      break;
    }
    case IT.LIST: {
      var li = item.asListItem();
      out.required = li.isRequired();
      out.options = li.getChoices().map(function (c) { return c.getValue(); });
      out.type = 'select';
      break;
    }
    case IT.CHECKBOX: {
      var cb = item.asCheckboxItem();
      out.required = cb.isRequired();
      out.options = cb.getChoices().map(function (c) { return c.getValue(); });
      out.type = 'multiselect';
      break;
    }
    case IT.SCALE: {
      var sc = item.asScaleItem();
      out.required = sc.isRequired();
      for (var i = sc.getLowerBound(); i <= sc.getUpperBound(); i++) out.options.push(String(i));
      out.type = 'select';
      break;
    }

    case IT.FILE_UPLOAD:     out.warning = 'file-upload questions are not supported yet (no file storage)'; break;
    case IT.GRID:            out.warning = 'grid questions have no single-field equivalent — split into separate questions'; break;
    case IT.CHECKBOX_GRID:   out.warning = 'checkbox-grid questions have no equivalent — split into separate questions'; break;
    case IT.PAGE_BREAK:      out.warning = 'page breaks and section branching are not supported — the form becomes one page'; break;
    default:                 break;   // images, videos, plain text blocks: ignored silently
  }
  return out;
}

// ── helpers ────────────────────────────────────────────────────────────────

function allDriveForms() {
  var files = DriveApp.getFilesByType(MimeType.GOOGLE_FORMS), out = [];
  while (files.hasNext()) {
    try { out.push(FormApp.openById(files.next().getId())); }
    catch (e) { /* not openable (e.g. a shortcut) — skip */ }
  }
  return out;
}

function openByUrl(url) {
  try { return FormApp.openByUrl(url); }
  catch (e) { Logger.log('Could not open: ' + url + ' — ' + e.message); return null; }
}

/** "Time-Off / Availability Request" → "time-off-availability-request" */
function slugify(s, underscore) {
  var sep = underscore ? '_' : '-';
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp('^' + sep + '+|' + sep + '+$', 'g'), '')
    .slice(0, 50) || 'form';
}

function ensureSheet(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sh;
}

function readColumn(sheet, header) {
  if (sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getValues();
  var idx = values[0].map(String).indexOf(header);
  if (idx === -1) return [];
  return values.slice(1).map(function (r) { return String(r[idx]).trim(); }).filter(String);
}
