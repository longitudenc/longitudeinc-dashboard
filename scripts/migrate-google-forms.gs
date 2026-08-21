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
 *  4. In the function dropdown at the top pick `listMyForms`, click Run, and
 *     approve the permission prompt the first time. The Execution log prints
 *     every form you own with its URL — use it to decide what to migrate.
 *  5. Put the forms you want in FORM_URLS below (or leave it empty to migrate
 *     every form found in your Drive). Save.
 *  6. Pick `migrateForms`, click Run.
 *  7. Back in the dashboard, hard-refresh and open Forms. Review the imported
 *     definitions in the FormDefs / FormFields tabs and tweak wording there.
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
