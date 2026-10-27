    'use strict';

    // --- helpers ------------------------------------------------------------
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    // dollars (not cents) → "$1.2M" / "$50K" / "$5,000"
    function formatMoney(d) {
      d = Number(d) || 0;
      // One decimal, then drop a trailing '.0': 11,749,351 -> $11.7M while a
      // round 12,000,000 stays $12M, so the min-amount slider labels (which read
      // the same formatter) do not gain a pointless $10.0M.
      if (d >= 1e6) return '$' + (d / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
      if (d >= 1e4) return '$' + Math.round(d / 1e3) + 'K';
      return '$' + d.toLocaleString('en-US');
    }
    // Dates are normalised to YYYY-MM-DD everywhere: the screen, the sort keys and
    // the exports all read the same string, so lexical order is chronological order.
    function isoDate(s) {
      if (!s) return '';
      let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);      // MM/DD/YYYY
      if (m) return m[3] + '-' + m[1] + '-' + m[2];
      m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);             // already ISO
      if (m) return m[1] + '-' + m[2] + '-' + m[3];
      return String(s);
    }
    function yearOf(iso) { const m = /(\d{4})/.exec(iso || ''); return m ? m[1] : ''; }
    // Excel stores a date as the number of days since 1899-12-30. Computed in
    // UTC on purpose: a local-time Date carries the timezone offset into the
    // serial as a fraction of a day, and a fractional serial breaks Excel's
    // "equals" date filter. Returns null for anything that is not a real
    // calendar date (empty, "Ongoing", 2026-02-30), so that cell stays text
    // exactly as the screen shows it.
    function excelDateSerial(iso) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
      if (!m) return null;
      const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
      const d = new Date(ms);
      if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
      return (ms - Date.UTC(1899, 11, 30)) / 86400000;
    }
    function usd(v) { return (Number(v) || 0).toLocaleString('en-US'); }
    // A count from the API, or 0 when it is not a finite number, so a
    // malformed field never reaches innerHTML as raw text.
    function safeNum(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
    function todayISO() { return new Date().toISOString().slice(0, 10); }
    // Exports stamp a full timestamp: two exports on the same day must be tellable apart.
    function nowISO() { return new Date().toISOString(); }

    // Grants.gov ships raw agency text: doubled interior spaces and
    // trailing spaces. The Go server relays the CLI's JSON verbatim by
    // design (the CLI owns the schema), so normalising here is the only
    // place that does not move schema ownership into the web app. An
    // upstream fix in grantsgov.go is planned; this stays harmless after
    // it lands.
    function normText(v) {
      if (v == null) return '';
      return String(v).replace(/\s+/g, ' ').trim();
    }

    // Applied once, at bindModule, to the raw records themselves — the single
    // point upstream of BOTH renderTable (via viewRows) and every export
    // (exportShaped keys off COLS, bibEntry reads the raw API fields). Keys that
    // are URLs, dates, identifiers or opportunity numbers are left byte-exact,
    // and non-strings (money) are untouched.
    const NORM_SKIP = /url|link|date|number|num\b|_num|id$|^id$|code/i;
    function normRecord(r) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
      const out = Object.assign({}, r);
      Object.keys(out).forEach(k => {
        const v = out[k];
        if (typeof v === 'string') {
          if (!NORM_SKIP.test(k)) out[k] = normText(v);
        } else if (v && typeof v === 'object') {
          out[k] = normRecord(v);
        }
      });
      return out;
    }

    // Grants.gov spells "no deadline" two ways: an empty close date and the
    // sentinel 2099-01-01. Both mean Ongoing, and screen and export must say so
    // identically. This is the single sentinel — a grant really closing in 2087
    // still exports 2087.
    const ONGOING = 'Ongoing';
    const NO_DEADLINE_SENTINEL = '2099-01-01';
    function closeDateValue(raw) {
      const iso = isoDate(raw);
      if (!iso || iso === NO_DEADLINE_SENTINEL) return ONGOING;
      return iso;
    }

    // deadline badge: today/past=red, <7 days=yellow, else gray; no deadline="Ongoing"
    function closeBadge(raw) {
      const iso = closeDateValue(raw);
      if (iso === ONGOING) return '<span class="dl-badge gray">' + ONGOING + '</span>';
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
      if (!m) return '<span class="dl-badge gray">' + esc(iso) + '</span>';
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const days = Math.round((d - today) / 86400000);
      if (days <= 0) return '<span class="dl-badge red">' + esc(iso) + '</span>';
      if (days < 7)  return '<span class="dl-badge yellow">' + esc(iso) + '</span>';
      return '<span class="dl-badge gray">' + esc(iso) + '</span>';
    }
    // money bar with green/yellow/red tier relative to max
    function moneyBar(amount, max) {
      const pct = Math.max(2, Math.round(amount / Math.max(1, max) * 100));
      const tier = pct >= 66 ? 'green' : pct >= 33 ? 'yellow' : 'red';
      return '<div class="bar-container"><span class="bar-number">' + formatMoney(amount) + '</span>' +
             '<div class="bar-chart ' + tier + '" style="width:' + pct + '%"></div></div>';
    }

    // --- data model ---------------------------------------------------------
    // Raw API rows, exactly as each module received them.
    const lastData = { open: null, nih: null, nsf: null };
    // Per-module view state: the quick filter text and the sort column and direction.
    const view = {
      open: { filter: '', sort: -1, dir: 1 },
      nih:  { filter: '', sort: -1, dir: 1 },
      nsf:  { filter: '', sort: -1, dir: 1 }
    };
    const queryOf = { open: '', nih: '', nsf: '' };
    // The search inputs actually sent with the last successful query, per
    // module. Exports read these, never the live form: a slider moved after the
    // search must not relabel rows that were fetched with the old value.
    const lastParams = { open: null, nih: null, nsf: null };
    // Mirrors validateQueryRows in main.go: a missing or non-positive rows value
    // is replaced by the default there, so the export states what the CLI got.
    const DEFAULT_ROWS = 15;
    function sentRows(n) { return n > 0 ? n : DEFAULT_ROWS; }

    const SOURCE = { open: 'Grants.gov', nih: 'NIH RePORTER', nsf: 'NSF Awards' };
    const ANALYSIS_LABEL = {
      open: 'Open grant opportunity search',
      nih:  'NIH award funding history',
      nsf:  'NSF award funding history'
    };
    // What the CLI's reported total actually counts, per module. NIH RePORTER
    // returns one record per support year, so a multi-year project contributes
    // several records and "awards" would overstate the distinct projects found.
    const MATCH_NOUN = {
      open: 'opportunities',
      nih:  'award records',
      nsf:  'awards'
    };
    const EMPTY_MSG = 'Run an analysis first — or clear the filters, nothing is visible.';

    // One column model per module. `val` is the single source of truth: the table,
    // the quick filter, the sort comparator and all four exports read it. There is
    // deliberately no second accessor path that could drift out of sync.
    const COLS = {
      open: [
        { label: 'Opportunity number', val: r => r.number || '', type: 'text', mono: true },
        { label: 'Title',              val: r => r.title || '',  type: 'text' },
        { label: 'Agency',             val: r => r.agency || r.agencyCode || '', type: 'text' },
        { label: 'Open date',          val: r => isoDate(r.openDate),  type: 'date' },
        { label: 'Close date',         val: r => closeDateValue(r.closeDate), type: 'date', cell: r => closeBadge(r.closeDate) },
        { label: 'Status',             val: r => r.oppStatus || '', type: 'text' },
        { label: 'URL',                val: r => r.id ? 'https://www.grants.gov/search-results-detail/' + r.id : '',
          type: 'text', url: true, sortable: false }
      ],
      nih: [
        { label: 'Project number',          val: r => r.project_num || '',   type: 'text', mono: true },
        { label: 'Title',                   val: r => r.project_title || '', type: 'text' },
        { label: 'Principal investigator',  val: r => (r.contact_pi_name || '').trim(), type: 'text' },
        { label: 'Institution',             val: r => (r.organization && r.organization.org_name) || '', type: 'text' },
        { label: 'Agency',                  val: () => 'NIH', type: 'text' },
        { label: 'Award amount',            val: r => Number(r.award_amount) || 0, type: 'num', money: true },
        { label: 'Fiscal year',             val: r => r.fiscal_year || '', type: 'num' },
        { label: 'URL',                     val: r => r.project_num
            ? 'https://reporter.nih.gov/project-details/' + encodeURIComponent(r.project_num) : '',
          type: 'text', url: true, sortable: false }
      ],
      nsf: [
        { label: 'Award number', val: r => r.id || '',    type: 'text', mono: true },
        { label: 'Title',        val: r => r.title || '', type: 'text' },
        // Same label and accessor as the NIH column: the CLI emits the NSF PI
        // under the NIH field name (contact_pi_name, "SURNAME, FIRSTNAME").
        // A binary older than upstream #1931 omits the key, and the cell then
        // stays empty rather than guessing from the institution.
        { label: 'Principal investigator', val: r => (r.contact_pi_name || '').trim(), type: 'text' },
        { label: 'Institution',  val: r => r.awardeeName || '', type: 'text' },
        { label: 'Agency',       val: () => 'NSF', type: 'text' },
        { label: 'Award amount', val: r => Number(r.fundsObligatedAmt) || 0, type: 'num', money: true },
        { label: 'Start date',   val: r => isoDate(r.startDate), type: 'date' },
        { label: 'End date',     val: r => isoDate(r.expDate),   type: 'date' },
        { label: 'URL',          val: r => r.id
            ? 'https://www.nsf.gov/awardsearch/showAward?AWD_ID=' + encodeURIComponent(r.id) : '',
          type: 'text', url: true, sortable: false }
      ]
    };

    // --- the one and only filter + sort chain -------------------------------
    // Everything the user sees, and everything that gets exported, comes out of
    // here. Filter tokens are ANDed: each whitespace-separated token must appear
    // somewhere in the row.
    function viewRows(key) {
      const raw = lastData[key] || [];
      const cols = COLS[key];
      const st = view[key];
      const tokens = String(st.filter || '').toLowerCase().split(/\s+/).filter(Boolean);
      let rows = raw;
      if (tokens.length) {
        rows = raw.filter(r => {
          const hay = cols.map(c => String(c.val(r))).join(' ').toLowerCase();
          return tokens.every(t => hay.indexOf(t) !== -1);
        });
      }
      if (st.sort >= 0 && cols[st.sort]) {
        const c = cols[st.sort];
        rows = rows.slice().sort((a, b) => {
          let x = c.val(a), y = c.val(b);
          if (c.type === 'num') {                       // money and years sort numerically
            return ((Number(x) || 0) - (Number(y) || 0)) * st.dir;
          }
          x = String(x == null ? '' : x); y = String(y == null ? '' : y);
          if (c.type !== 'date') { x = x.toLowerCase(); y = y.toLowerCase(); }
          return (x < y ? -1 : x > y ? 1 : 0) * st.dir;
        });
      }
      return rows;
    }

    // Search inputs as sent, always stated, empty ones included: an export
    // with no filter text cannot say whether "no date" was chosen or lost.
    function serverFilters(key) {
      const p = lastParams[key];
      if (!p) return [];
      const out = [];
      if (key === 'open') {
        // The CLI asks Grants.gov for posted opportunities only (grantsgov.go).
        out.push('posted only');
        out.push(p.before ? 'closing before ' + p.before : 'no closing date');
        out.push(p.agency ? 'agency: ' + p.agency : 'any agency');
      } else {
        out.push(p.min > 0 ? 'min amount USD ' + usd(p.min) : 'no minimum amount');
        if (key === 'nih') out.push(p.year ? 'FY' + p.year : 'all fiscal years');
      }
      out.push('up to ' + p.rows + ' rows');
      return out;
    }

    // Filters behind the exported rows, in human-readable form: the server
    // filters first, then the quick filter and column sort applied on the page.
    // Used by the origin line and JSON export.filters so both say the same.
    function activeFilters(key) {
      const st = view[key];
      const out = serverFilters(key);
      if (String(st.filter || '').trim()) out.push('filter: "' + String(st.filter).trim() + '"');
      const sc = st.sort >= 0 && COLS[key][st.sort];
      if (sc) out.push('sorted by ' + sc.label + ', ' + (st.dir > 0 ? 'ascending' : 'descending'));
      return out;
    }

    // Rows shaped for export: export column labels as keys, in column order.
    // Money stays a real JavaScript number so Excel and JSON get a number, not text.
    function exportShaped(key) {
      const cols = COLS[key];
      return viewRows(key).map(r => {
        const o = {};
        cols.forEach(c => { o[c.label] = c.money ? (Number(c.val(r)) || 0) : c.val(r); });
        return o;
      });
    }

    // Live view registry: every module that filters or sorts registers a getter
    // returning the rows exactly as the user currently sees them, plus the filters
    // that produced them. Without this the exports silently ignore the on-screen
    // filters and hand back the full result set.
    const viewProviders = {};

    function registerView(key, fn) { viewProviders[key] = fn; }

    function exportRows(key) {
      const p = viewProviders[key];
      if (typeof p === "function") {
        const v = p() || {};
        return { rows: Array.isArray(v.rows) ? v.rows : [], scope: (v.filters || []).join(" · ") };
      }
      return { rows: rowsFromLastData(key) || [], scope: "" };   // fallback: unfiltered module
    }

    // Fallback only — reached when a module never registered a live view.
    function rowsFromLastData(key) {
      const d = lastData[key];
      if (!d) return null;
      if (Array.isArray(d)) return d;
      if (typeof d === "object") {
        for (const k of Object.keys(d)) { if (Array.isArray(d[k])) return d[k]; }
      }
      return null;
    }

    // Provenance line stamped into every exported file, in every format.
    function exportHeader(key) {
      const total = (lastData[key] || []).length;
      const shown = exportRows(key).rows.length;
      const scope = exportRows(key).scope;
      // The API total whenever it is known, even when it equals the rows
      // loaded: "37 of 37" alone cannot be told apart from a run capped at 37.
      const matched = (lastMeta[key] || {}).total;
      const parts = [
        'Grantvera export',
        ANALYSIS_LABEL[key],
        'query: "' + (queryOf[key] || '') + '"',
        'showing ' + shown + ' of ' + total + ' rows loaded' +
          (typeof matched === 'number'
            ? ' (' + matched.toLocaleString('en-US') + ' ' + MATCH_NOUN[key] + ' matched in total)'
            : '')
      ];
      // NSF alone has no registry total: its API returns a recent pool that the
      // CLI ranks within, so the exported rows are the top of a sample, not the
      // whole result set. The screen says so; the file has to as well, or the
      // off-topic tail rows look like errors. Guarded exactly as the on-screen
      // note is — the other two modules have no relevance object at all.
      const rel = (lastMeta[key] || {}).relevance;
      if (rel && rel.examined > 0) {
        let s = 'sampled ' + rel.examined + ' recent awards, ' + rel.matched +
                ' matched all query words, ' + rel.title_matched + ' in the title';
        if (rel.pool_error) {
          s += ' (stopped early after an upstream error at ' + rel.pages_fetched +
               ' of ' + rel.pages_planned + ' pages, so these counts are a floor)';
        }
        parts.push(s);
      }
      // Same OR-semantics fact as the on-screen note, minus the advice: a file
      // is read without a search box in front of it.
      const kh = (lastMeta[key] || {}).keywordHits;
      if (Array.isArray(kh) && kh.length > 1 && kh.some(k => k.hits === 0)) {
        parts.push('per-word hits: ' +
          kh.map(k => k.word + ' ' + k.hits.toLocaleString('en-US')).join(', ') +
          ' (Grants.gov matches any word, not all)');
      }
      if (scope) parts.push(scope);
      parts.push('source: ' + SOURCE[key]);
      parts.push(todayISO());
      return parts.join(' · ');
    }

    // Dash policy for CSV / XLSX / JSON: the raw U+2013 is KEPT. These three
    // formats are UTF-8 end to end (the CSV carries a BOM, XLSX is UTF-8 XML,
    // JSON is UTF-8 by definition), so an en-dash renders correctly and folding
    // it would silently alter the source title. Only BibTeX folds the dash class
    // (see bibEsc), because classic BibTeX may read the file as latin1 and fail
    // the whole entry. The decision is the same for all three of these formats:
    // none of them fold.

    // --- CSV (RFC4180). Excel-safe: BOM + CRLF + explicit separator hint. ----
    // One CSV cell. A text value that a spreadsheet would run as a formula
    // (leading = + - @ or the full-width U+FF1D U+FF0B U+FF0D U+FF20 that Excel also
    // accepts, even after leading spaces/TAB/CR/LF; or a leading TAB CR LF) gets a
    // leading ' so it is shown as text (CSV formula injection).
    // A JS number, or a string that is a plain number such as "-5" or "-1.5",
    // is NOT prefixed: amounts must stay numeric so Excel can SUM and sort them.
    function csvCell(v) {
      // Booleans must be exported as text, otherwise Excel localises them
      // (Hungarian Excel shows IGAZ / HAMIS instead of TRUE / FALSE).
      if (v === null || v === undefined || v === false) return "";
      if (v === true) return "Yes";
      let s = (typeof v === "object") ? JSON.stringify(v) : String(v);
      if (typeof v === "string" && /^[ \t\r\n]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r\n]/.test(s) &&
          !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) s = "'" + s;
      if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    }

    function toCSV(key) {
      const rows = exportRows(key).rows;
      const cols = [];
      rows.forEach(r => Object.keys(r || {}).forEach(k => { if (cols.indexOf(k) === -1) cols.push(k); }));
      const cell = csvCell;
      // "sep=," tells Excel the delimiter regardless of the user's locale.
      const origin = '"' + exportHeader(key).replace(/"/g, '""') + '"';
      const lines = ["sep=,", origin, cols.map(cell).join(",")];
      rows.forEach(r => lines.push(cols.map(c => cell(r ? r[c] : "")).join(",")));
      return "﻿" + lines.join("\r\n");
    }

    function downloadCSV(key, filename) {
      const rows = exportRows(key).rows;
      if (!rows.length) { alert(EMPTY_MSG); return; }
      triggerDownload(new Blob([toCSV(key)], { type: "text/csv;charset=utf-8" }), filename);
    }

    // --- XLSX: origin row, styled header, numeric money column --------------
    function downloadXLSX(key, filename) {
      const shaped = exportRows(key).rows;
      if (!shaped.length) { alert(EMPTY_MSG); return; }
      const cols = COLS[key];
      const vrows = viewRows(key);
      const cellText = v => {
        if (v === null || v === undefined || v === false) return "";
        if (v === true) return "Yes";
        return (typeof v === "object") ? JSON.stringify(v) : v;
      };
      // Money and parseable dates become numbers so Excel can SUM, sort and
      // date-filter them. A date column can also hold text ("Ongoing" for a
      // grant with no deadline); that value is written as text, never guessed.
      const xlsxValue = (c, r) => {
        if (c.money) return Number(c.val(r)) || 0;
        const v = c.val(r);
        if (c.type === 'date') {
          const serial = excelDateSerial(v);
          if (serial !== null) return serial;
        }
        return cellText(v);
      };
      // Row 0 = provenance, row 1 = header, rows 2+ = data.
      const aoa = [[exportHeader(key)], cols.map(c => c.label)];
      vrows.forEach(r => aoa.push(cols.map(c => xlsxValue(c, r))));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, cols.length - 1) } }];

      // Measure each column: long free text goes left and wide, short values centre.
      const colInfo = cols.map(c => {
        let max = String(c.label).length, sum = 0, cnt = 0;
        vrows.forEach(r => {
          const L = String(c.val(r) == null ? '' : c.val(r)).length;
          if (L > max) max = L; sum += L; cnt++;
        });
        const avg = cnt ? sum / cnt : 0;
        const isLong = (max > 22) || (avg > 18);
        return { wch: Math.min(Math.max(max + 2, 10), c.money ? 16 : (isLong ? 90 : 24)), left: isLong,
          money: !!c.money, date: c.type === 'date' };
      });
      ws['!cols'] = colInfo.map(ci => ({ wch: ci.wch }));

      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let R = range.s.r; R <= range.e.r; R++) {
        for (let C = range.s.c; C <= range.e.c; C++) {
          const addr = XLSX.utils.encode_cell({ r: R, c: C });
          if (!ws[addr]) continue;
          if (R === 0) {
            ws[addr].s = { font: { italic: true, color: { rgb: "555555" } },
              alignment: { horizontal: "left", vertical: "center" },
              fill: { fgColor: { rgb: "EDEDED" } } };
          } else if (R === 1) {
            ws[addr].s = { font: { bold: true, color: { rgb: "FFFFFF" } },
              alignment: { vertical: "center", horizontal: "center", wrapText: false },
              fill: { fgColor: { rgb: "4472C4" } },
              border: { bottom: { style: "thin", color: { rgb: "999999" } } } };
          } else {
            const ci = colInfo[C];
            if (ci && ci.money) {
              // Award amount must stay a real number: researchers SUM and sort on it.
              ws[addr].t = 'n';
              ws[addr].z = '#,##0';
              ws[addr].s = { numFmt: '#,##0', alignment: { horizontal: "right", vertical: "center" } };
            } else if (ci && ci.date && typeof ws[addr].v === 'number') {
              // A real date cell, shown in the same YYYY-MM-DD form as the screen.
              ws[addr].t = 'n';
              ws[addr].z = 'yyyy-mm-dd';
              ws[addr].s = { numFmt: 'yyyy-mm-dd', alignment: { horizontal: "center", vertical: "center" } };
            } else {
              ws[addr].s = { alignment: { vertical: "center",
                horizontal: (ci && ci.left) ? "left" : "center", wrapText: false } };
            }
          }
        }
      }
      // No frozen panes: xlsx-js-style 1.2.0 cannot write them. Measured: a sheet
      // written with and without ws['!freeze'] is byte-identical and carries no
      // <pane> element; pane writing is a SheetJS Pro feature. A !freeze line
      // here would only look as if it worked. The autofilter below is what
      // actually reaches the user, and it is what makes the numeric award column
      // sortable inside Excel itself.
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({
        s: { r: 1, c: 0 }, e: { r: range.e.r, c: Math.max(0, cols.length - 1) } }) };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Grantvera");
      XLSX.writeFile(wb, filename);
    }

    // --- BibTeX: a grant is not an article, so every entry is @misc ----------
    // Typographic dashes are folded to ASCII first: biblatex on UTF-8 copes with
    // U+2014, but classic BibTeX reading latin1 fails the whole entry. Matches
    // pubvera-corpova (commit 2ffe793) so the two apps escape identically.
    function bibEsc(v) {
      return String(v == null ? "" : v)
        .normalize("NFC")
        .replace(/[‐‑‒–—―−]/g, "-")
        .replace(/[{}\\]/g, "")
        .replace(/([&%#_$])/g, "\\$1")
        .replace(/\^/g, "\\textasciicircum{}")
        .replace(/~/g, "\\textasciitilde{}")
        .replace(/α/g, "\\ensuremath{\\alpha}")
        .replace(/β/g, "\\ensuremath{\\beta}")
        .replace(/γ/g, "\\ensuremath{\\gamma}")
        .replace(/δ/g, "\\ensuremath{\\delta}")
        .replace(/μ/g, "\\ensuremath{\\mu}")
        .replace(/Δ/g, "\\ensuremath{\\Delta}")
        .trim();
    }
    // A blank field is worse than a missing one: author = {{}} makes Zotero
    // invent a nameless author, so omit the line entirely when there is no value.
    function bibField(name, value, braced) {
      const v = bibEsc(value);
      if (!v) return '';
      const body = braced ? '{{' + v + '}}' : '{' + v + '}';
      return '  ' + name.padEnd(12) + ' = ' + body + ',\n';
    }
    function bibKey(s, fallback) {
      // Separators become '_', not nothing: deleting them made AB-C1 and A-BC1
      // the same key. Never route a cite key through bibEsc — that escapes _ to
      // \_ for FIELD BODIES, and a backslash is invalid inside a cite key.
      const k = String(s == null ? '' : s).replace(/[^A-Za-z0-9]/g, '_');
      return k || fallback;
    }

    function bibEntry(key, r) {
      if (key === 'nih') {
        const num = r.project_num || '';
        return '@misc{' + bibKey(num, 'nihaward') + ',\n' +
          '  title        = {' + bibEsc(r.project_title) + '},\n' +
          bibField('author', r.contact_pi_name, true) +
          bibField('institution', (r.organization && r.organization.org_name) || '') +
          '  howpublished = {NIH RePORTER, project number ' + bibEsc(num) + '},\n' +
          bibField('year', r.fiscal_year) +
          '  url          = {https://reporter.nih.gov/project-details/' + encodeURIComponent(num) + '},\n' +
          '  note         = {NIH - award amount USD ' + usd(r.award_amount) +
                            (r.fiscal_year ? '; FY' + r.fiscal_year : '') + '}\n}';
      }
      if (key === 'nsf') {
        const id = r.id || '';
        return '@misc{NSF' + bibKey(id, 'award') + ',\n' +
          '  title        = {' + bibEsc(r.title) + '},\n' +
          // The author is the principal investigator the CLI now fetches
          // (upstream #1931). Never fall back to the institution: that would
          // invent a corporate author the record does not claim. bibField
          // omits the line when the PI is missing, so an award without one,
          // or a response from an older binary, simply has no author.
          bibField('author', r.contact_pi_name, true) +
          bibField('institution', r.awardeeName) +
          '  howpublished = {NSF Awards, award number ' + bibEsc(id) + '},\n' +
          bibField('year', yearOf(isoDate(r.startDate))) +
          '  url          = {https://www.nsf.gov/awardsearch/showAward?AWD_ID=' + encodeURIComponent(id) + '},\n' +
          '  note         = {NSF - award amount USD ' + usd(r.fundsObligatedAmt) +
                            '; ' + isoDate(r.startDate) + ' to ' + isoDate(r.expDate) + '}\n}';
      }
      const num = r.number || '';
      return '@misc{' + bibKey(num, 'opportunity') + ',\n' +
        '  title        = {' + bibEsc(r.title) + '},\n' +
        bibField('author', r.agency || r.agencyCode, true) +
        '  howpublished = {Grants.gov, opportunity number ' + bibEsc(num) + '},\n' +
        bibField('year', yearOf(isoDate(r.openDate))) +
        '  url          = {' + (r.id ? 'https://www.grants.gov/search-results-detail/' + r.id : 'https://www.grants.gov/') + '},\n' +
        '  note         = {' + bibEsc(r.agency || r.agencyCode || '') + ' - status ' + bibEsc(r.oppStatus) +
                          '; closes ' + closeDateValue(r.closeDate).toLowerCase() + '}\n}';
    }

    function toBibTeX(key) {
      const rows = viewRows(key);
      const out = ['% ' + exportHeader(key)];
      rows.forEach(r => out.push(bibEntry(key, r)));
      return out.join('\n\n') + '\n';
    }

    // The check and the content must come from the SAME call. exportRows
    // returns exportShaped rows, keyed by column LABEL ("Project Title"),
    // while bibEntry reads raw API fields (project_title, contact_pi_name).
    // Checking one and writing the other works today only because toBibTeX
    // reads viewRows itself — a coincidence, not a contract.
    function downloadBibTeX(key, filename) {
      const rows = viewRows(key);
      if (!rows.length) { alert(EMPTY_MSG); return; }
      triggerDownload(new Blob([toBibTeX(key)], { type: "application/x-bibtex;charset=utf-8" }), filename);
    }

    // --- JSON + shared download trigger -------------------------------------
    function downloadJSON(key, filename) {
      const rows = exportRows(key).rows;
      if (!rows.length) { alert(EMPTY_MSG); return; }
      const payload = {
        export: {
          app: 'Grantvera',
          analysis: ANALYSIS_LABEL[key],
          query: queryOf[key] || '',
          filters: activeFilters(key).join(' · '),
          rows_exported: rows.length,
          // rows_loaded is Grantvera-specific: how many rows the CLI returned
          // before the quick filter narrowed them. The other seven apps have no
          // such intermediate step, so they carry rows_exported and rows_total
          // only. Extra keys are additive; the shared pair keeps its meaning.
          rows_loaded: (lastData[key] || []).length,
          // The registry-wide match count from the CLI, not the number of rows
          // fetched. Reporting the page size as the total told the reader that
          // 15 awards exist when the search matched 195,078. Named rows_total
          // to match the other seven apps, where the key means the same thing.
          rows_total: (lastMeta[key] || {}).total || null,
          // What rows_total counts, straight from the same map the screen and
          // the CSV/BibTeX headers use. NIH RePORTER returns one record per
          // support year, so "awards" would overstate distinct projects; the
          // unit has to travel with the number. Null when rows_total is null —
          // a unit beside a missing count would assert knowledge we lack.
          rows_total_unit: (lastMeta[key] || {}).total ? MATCH_NOUN[key] : null,
          source: SOURCE[key],
          exported_at: nowISO()
        },
        rows: rows
      };
      triggerDownload(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), filename);
    }

    function triggerDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // --- result rendering ---------------------------------------------------
    function metaRow(key, filename) {
      const csvName  = String(filename).replace(/\.json$/i, ".csv");
      const xlsxName = String(filename).replace(/\.json$/i, ".xlsx");
      const bibName  = String(filename).replace(/\.json$/i, ".bib");
      // Every toolbar gets its own panel id: aria-controls must name one element.
      metaRow.menuSeq = (metaRow.menuSeq || 0) + 1;
      const menuId = 'dl-menu-' + metaRow.menuSeq;
      // The separator lives with the label, not with the counter, so hiding the
      // label on a narrow viewport cannot leave a dangling em dash behind.
      return '<div class="meta-row"><span class="meta">' +
        '<span class="qlabel">' + esc(ANALYSIS_LABEL[key]) + ' — </span>' +
        '<span class="qcount" id="' + key + '_qc"></span></span>' +
        '<span class="dl-group">' +
        '<input class="qfilter" type="text" placeholder="🔍 Filter results…" ' +
          'data-input="onFilter" data-key="' + esc(key) + '">' +
        '<span class="dl-menu-wrap">' +
        '<button type="button" class="dl dl-trigger" data-action="toggleExportMenu" aria-haspopup="menu" ' +
          'aria-expanded="false" aria-controls="' + menuId + '">⬇ Export ▾</button>' +
        '<span class="dl-menu" role="menu" id="' + menuId + '" hidden>' +
        '<button type="button" class="dl-item" role="menuitem" data-action="downloadXLSX" data-key="' + esc(key) + '" data-filename="' + esc(xlsxName) + '">Excel</button>' +
        '<button type="button" class="dl-item" role="menuitem" data-action="downloadCSV" data-key="' + esc(key) + '" data-filename="' + esc(csvName) + '">CSV</button>' +
        '<button type="button" class="dl-item" role="menuitem" data-action="downloadJSON" data-key="' + esc(key) + '" data-filename="' + esc(filename) + '">JSON</button>' +
        '<button type="button" class="dl-item" role="menuitem" title="BibTeX citation for these awards (@misc)" ' +
          'data-action="downloadBibTeX" data-key="' + esc(key) + '" data-filename="' + esc(bibName) + '">BibTeX</button>' +
        '</span></span>' +
        '</span></div>';
    }
    // ── Export menu (WAI-ARIA APG menu button). Every close path ends in
    // closeExportMenus(opener), so hidden, aria-expanded and focus cannot drift
    // apart. The opener is passed explicitly: WebKit does not focus a button on
    // mouse click. The trigger and the items run through CLICK_ACTIONS and
    // delegate() like every other button; this block only opens, closes and
    // moves focus. Escape in an open menu calls preventDefault, and the modal
    // Escape listener skips a prevented Escape or one that arrives while a menu
    // is still open, so the menu closes and the modal stays open whichever
    // listener runs first.
    function anyExportMenuOpen() {
      return !!document.querySelector('.dl-menu:not([hidden])');
    }
    function closeExportMenus(opener) {
      document.querySelectorAll('.dl-menu:not([hidden])').forEach(m => {
        m.hidden = true;
        const t = document.querySelector('[aria-controls="' + m.id + '"]');
        if (t) t.setAttribute('aria-expanded', 'false');
      });
      if (opener) opener.focus();
    }
    function toggleExportMenu(btn) {
      const menu = document.getElementById(btn.getAttribute('aria-controls'));
      if (!menu) return;
      const wasOpen = !menu.hidden;
      closeExportMenus(null); // at most one menu open
      if (wasOpen) { btn.focus(); return; }
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      const first = menu.querySelector('.dl-item');
      if (first) first.focus();
    }
    document.addEventListener('click', e => {
      const t = e.target;
      if (!t || !t.closest) return;
      // The download itself runs in delegate(), registered later.
      const item = t.closest('.dl-item');
      if (item) {
        closeExportMenus(document.querySelector('[aria-controls="' + item.closest('.dl-menu').id + '"]'));
        return;
      }
      // Untrusted clicks are ignored: triggerDownload() clicks a synthetic <a>.
      if (e.isTrusted && !t.closest('.dl-menu-wrap')) closeExportMenus(null);
    });
    document.addEventListener('keydown', e => {
      const t = e.target;
      if (!t || !t.matches) return;
      // Enter, Space and ArrowDown on the trigger open the menu with the first
      // item focused; preventDefault stops the button's own click for Enter and Space.
      if (t.matches('.dl-trigger') && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        if (e.key !== 'ArrowDown' || t.getAttribute('aria-expanded') !== 'true') toggleExportMenu(t);
        return;
      }
      const menu = document.querySelector('.dl-menu:not([hidden])');
      if (!menu) return;
      const opener = document.querySelector('[aria-controls="' + menu.id + '"]');
      if (e.key === 'Escape') { e.preventDefault(); closeExportMenus(opener); return; }
      if (!menu.contains(t)) return;
      const items = Array.from(menu.querySelectorAll('.dl-item'));
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === 'Tab') closeExportMenus(opener); // focus lands on the trigger, then Tab moves on
    });
    // ── end Export menu

    function renderResult(key, out, filename) {
      const rows = lastData[key] || [];
      if (!rows.length) {
        out.innerHTML = '<div class="error-box">No results found for this query.</div>';
        return;
      }
      out.innerHTML = metaRow(key, filename) + insightRow(key) + '<div class="table-wrap" id="' + key + '_tw"></div>';
      renderTable(key);
    }
    // A size-sorted list shows the largest awards, which are not the typical
    // ones — measured, a topic whose median award is about $420,000 shows
    // multi-million dollar rows at the top. This states the difference rather
    // than leaving the reader to infer it from the table.
    function insightRow(key) {
      const m = lastMeta[key] || {};
      const bits = [];
      if (m.typical && m.typical.population > 0) {
        let s = 'Typical award: about $' + usd(m.typical.estimate);
        // The bracket is how far the bisection narrowed the median's LOCATION,
        // not how the awards themselves are spread. Award sizes are heavily
        // right-skewed: the same result set carries multi-million dollar rows,
        // so claiming half of them sit inside a few-thousand-dollar band would
        // be plainly false. Word it as uncertainty about the median.
        if (m.typical.bracket_high > 0) {
          s += ' — the median across all ' + safeNum(m.typical.population).toLocaleString('en-US') +
               ' award records that match this topic and fiscal year, counted before the minimum-amount filter is applied, lies between $' + usd(m.typical.bracket_low) +
               ' and $' + usd(m.typical.bracket_high) + '.';
        }
        s += ' The table is sorted by size, so it shows the largest awards, not typical ones.';
        // Without a fiscal year the population spans every year RePORTER holds,
        // and each support year of a multi-year project counts separately, so
        // one long-running study can contribute a dozen rows. Measured for
        // "cancer": 195,078 awards and a $315,625 estimate across all years,
        // against 7,823 and $421,875 for FY2024 alone.
        if (!m.year) {
          s += ' This covers every fiscal year on record — pick a year for a figure you can compare against a current application.';
        }
        bits.push(s);
      }
      if (m.relevance && m.relevance.examined > 0) {
        let s = 'Searched ' + safeNum(m.relevance.examined) + ' recent NSF awards; ' +
                safeNum(m.relevance.matched) + ' mention every word of the query, ' +
                safeNum(m.relevance.title_matched) + ' in the title.';
        if (m.relevance.pool_error) {
          s += ' The search stopped early after an upstream error (' +
               safeNum(m.relevance.pages_fetched) + ' of ' + safeNum(m.relevance.pages_planned) +
               ' pages), so these counts are a floor — retry for the full picture.';
        } else if (m.relevance.matched < 10) {
          s += ' Few awards use all of these words together — try fewer or broader words.';
        }
        bits.push(s);
      }
      if (m.source === 'open') {
        bits.push('Newest postings first. Grants.gov leaves records in "posted" status indefinitely, so an older posting date is worth checking at the agency before you rely on it.');
      }
      // Grants.gov ORs the query words: a word that matches nothing on its own
      // leaves the result count unchanged, so a typo is invisible in the totals.
      // Measured: "climate" 61 hits, "climate zzzqqqxxx" also 61, "zzzqqqxxx" 0.
      // Only shown when some word found nothing — when every word matched, the
      // OR semantics did no harm and the note would be noise.
      const kh = m.keywordHits;
      if (Array.isArray(kh) && kh.length > 1) {
        const dead = kh.filter(k => k.hits === 0).map(k => k.word);
        if (dead.length) {
          bits.push('Grants.gov matches any of your words, not all of them: ' +
            kh.map(k => '"' + esc(k.word) + '" ' + safeNum(k.hits).toLocaleString('en-US')).join(', ') +
            '. ' + (dead.length === 1 ? 'That word' : 'Those words') +
            ' found nothing alone, so ' + (dead.length === 1 ? 'it' : 'they') +
            ' did not narrow this search — check the spelling, or search without ' +
            (dead.length === 1 ? 'it' : 'them') + '.');
        }
      }
      if (m.includeCenters === false) {
        bits.push('Center, program and consortium awards are excluded; those fund running a research centre rather than a single project and are one to two orders of magnitude larger.');
      }
      if (!bits.length) return '';
      return '<div class="insight-box">' + bits.map(b => '<p>' + b + '</p>').join('') + '</div>';
    }

    // Redraws the table body and the count from viewRows() — the same call the
    // exports make, so what is counted here is exactly what lands in the file.
    function renderTable(key) {
      const cols = COLS[key];
      const st = view[key];
      const vrows = viewRows(key);
      // Rows loaded, not registry matches: the CLI's total counts every record
      // that matched, and it is appended to the counter below so "4 / 4 rows"
      // cannot be mistaken for "only 4 records exist".
      const total = (lastData[key] || []).length;
      const matched = (lastMeta[key] || {}).total;
      const moneyCol = cols.filter(c => c.money)[0];

      const qc = document.getElementById(key + '_qc');
      if (qc) {
        let t = vrows.length + ' / ' + total + ' rows';
        // Same guard as exportHeader: only worth saying when the registry held
        // more than was fetched.
        if (matched > total) {
          t += ' · ' + matched.toLocaleString('en-US') + ' ' + MATCH_NOUN[key] + ' matched';
        }
        // Two spans, both filled with textContent: no HTML can enter here. The
        // money phrase lives in its own span so the stylesheet can hide it on a
        // narrow viewport, which keeps the decision with the layout instead of
        // freezing a window width into the rendered text.
        qc.textContent = '';
        const always = document.createElement('span');
        always.textContent = t;
        qc.appendChild(always);
        if (moneyCol) {
          const sum = vrows.reduce((a, r) => a + (Number(moneyCol.val(r)) || 0), 0);
          const money = document.createElement('span');
          money.className = 'qmoney';
          money.textContent = ' · USD ' + usd(sum) + ' in rows shown';
          qc.appendChild(money);
        }
      }

      const tw = document.getElementById(key + '_tw');
      if (!tw) return;
      let h = '<table><thead><tr><th class="n">#</th>';
      cols.forEach((c, ci) => {
        if (c.sortable === false) { h += '<th>' + esc(c.label) + '</th>'; return; }
        const glyph = (st.sort === ci) ? (st.dir > 0 ? '↑' : '↓') : '⇅';
        h += '<th class="sortable" data-key="' + key + '" data-col="' + ci + '">' +
             esc(c.label) + ' <span class="sg">' + glyph + '</span></th>';
      });
      h += '</tr></thead><tbody>';
      if (!vrows.length) {
        h += '<tr><td class="n"></td><td class="nomatch" colspan="' + cols.length +
             '">No rows match the current filter.</td></tr>';
      } else {
        const max = moneyCol
          ? Math.max(1, ...vrows.map(r => Number(moneyCol.val(r)) || 0))
          : 1;
        vrows.forEach((r, i) => {
          h += '<tr><td class="n">' + (i + 1) + '</td>';
          cols.forEach(c => {
            let cell;
            if (c.money)      cell = moneyBar(Number(c.val(r)) || 0, max);
            else if (c.url)   { const u = c.val(r);
                                cell = u ? '<a class="verify" href="' + esc(u) +
                                  '" target="_blank" rel="noopener" title="Verify on the official agency record">↗</a>' : '—'; }
            else if (c.cell)  cell = c.cell(r);
            else              cell = esc(c.val(r)) || '—';
            h += '<td' + (c.mono ? ' class="mono"' : '') + '>' + cell + '</td>';
          });
          h += '</tr>';
        });
      }
      h += '</tbody></table>';
      tw.innerHTML = h;
    }

    function onFilter(key, value) {
      view[key].filter = value;
      renderTable(key);
    }

    // Single delegated click handler for every sortable column header.
    document.addEventListener('click', e => {
      const th = e.target.closest ? e.target.closest('th.sortable[data-key]') : null;
      if (!th) return;
      const key = th.getAttribute('data-key');
      const ci = +th.getAttribute('data-col');
      const st = view[key];
      if (!st) return;
      if (st.sort === ci) st.dir = -st.dir; else { st.sort = ci; st.dir = 1; }
      renderTable(key);
    });

    // Wires a module's live view into the export layer. Called after every query.
    // Everything the CLI reports beyond the rows themselves: the registry-wide
    // match count, the typical-award estimate, the relevance counts. Kept per
    // module so the screen can say what the row list alone cannot.
    const lastMeta = {};
    function bindModule(key, rows, query, params, meta) {
      lastData[key] = Array.isArray(rows) ? rows.map(normRecord) : rows;
      lastMeta[key] = meta || {};
      queryOf[key] = query;
      lastParams[key] = params;
      view[key] = { filter: '', sort: -1, dir: 1 };
      registerView(key, () => ({ rows: exportShaped(key), filters: activeFilters(key) }));
    }

    // --- modal plumbing -----------------------------------------------------
    const MODALS = ['open', 'nih', 'nsf'];
    function openModal(name, prefill) {
      MODALS.forEach(closeModal);
      document.getElementById('modal-' + name).classList.add('active');
      const input = document.getElementById(name + '-query');
      if (prefill !== undefined) input.value = prefill;
      setTimeout(() => input.focus(), 50);
    }
    function closeModal(name) {
      document.getElementById('modal-' + name).classList.remove('active');
    }
    MODALS.forEach(name => {
      document.getElementById('modal-' + name).addEventListener('click', e => {
        if (e.target === e.currentTarget) closeModal(name);
      });
    });
    document.addEventListener('keydown', e => {
      // An Escape that belongs to an open Export menu closes only the menu.
      if (e.key === 'Escape' && !e.defaultPrevented && !anyExportMenuOpen()) MODALS.forEach(closeModal);
    });

    // --- delegated event handlers -------------------------------------------
    // The CSP sends script-src-attr 'none', so inline event handler attributes
    // (onclick and friends) never run. Elements name an action in data-action /
    // data-input / data-keydown and one listener per event type looks it up in
    // these maps. Only names listed here can be called: a name coming from the
    // DOM is never resolved through window, so injected markup cannot reach an
    // arbitrary global.
    const CLICK_ACTIONS = {
      openModal:      el => openModal(el.dataset.modal, el.dataset.prefill),
      closeModal:     el => closeModal(el.dataset.modal),
      runOpen:        () => runOpen(),
      runNIH:         () => runNIH(),
      runNSF:         () => runNSF(),
      downloadBibTeX: el => downloadBibTeX(el.dataset.key, el.dataset.filename),
      downloadXLSX:   el => downloadXLSX(el.dataset.key, el.dataset.filename),
      downloadCSV:    el => downloadCSV(el.dataset.key, el.dataset.filename),
      downloadJSON:   el => downloadJSON(el.dataset.key, el.dataset.filename),
      toggleExportMenu: el => toggleExportMenu(el),
      pubveraSignIn:  () => pubveraSignIn()
    };
    const INPUT_ACTIONS = {
      showValue: el => { document.getElementById(el.dataset.target).textContent = el.value; },
      showMoney: el => { document.getElementById(el.dataset.target).textContent = formatMoney(+el.value); },
      onFilter:  el => onFilter(el.dataset.key, el.value)
    };
    // Enter in a query field runs that module's search.
    const ENTER_ACTIONS = {
      runOpen: () => runOpen(),
      runNIH:  () => runNIH(),
      runNSF:  () => runNSF()
    };
    function delegate(attr, actions, e) {
      const el = e.target.closest ? e.target.closest('[' + attr + ']') : null;
      if (!el) return;
      const name = el.getAttribute(attr);
      if (Object.prototype.hasOwnProperty.call(actions, name)) actions[name](el, e);
    }
    document.addEventListener('click', e => delegate('data-action', CLICK_ACTIONS, e));
    document.addEventListener('input', e => delegate('data-input', INPUT_ACTIONS, e));
    document.addEventListener('keydown', e => {
      if (e.key === 'Enter') delegate('data-keydown', ENTER_ACTIONS, e);
    });

    // Fiscal-year choices are generated from today's date rather than
    // hardcoded: a fixed 2020-2024 list had fallen two years behind while
    // RePORTER already returned FY2025 and FY2026 awards, and the typical-award
    // note tells the reader to pick a year for a current comparison. NIH
    // fiscal year N starts on 1 October of year N-1, so from October onwards
    // the next fiscal year is already running and is offered as well.
    (function fillFiscalYears() {
      const sel = document.getElementById('nih-year');
      if (!sel) return;
      const now = new Date();
      const newest = now.getFullYear() + (now.getMonth() >= 9 ? 1 : 0);
      for (let y = newest; y > newest - 7; y--) {
        const o = document.createElement('option');
        o.value = String(y);
        o.textContent = String(y);
        sel.appendChild(o);
      }
    })();

    // --- fetch plumbing -----------------------------------------------------
    // Bearer token for the auth layer sitting in front of the API. Read at
    // REQUEST time, never cached at page load: the Supabase client refreshes the
    // access token in the background, so a token captured once at load would be
    // an hour stale on a page left open. window.sb exists only when /config.json
    // returned a Supabase config (see the module script at the end of this file)
    // — without it the request goes out exactly as it did before sign-in existed,
    // with no Authorization header at all.
    async function authHeaders() {
      if (!window.sb) return {};
      try {
        const { data: { session } } = await window.sb.auth.getSession();
        if (session) return { 'Authorization': 'Bearer ' + session.access_token };
      } catch (e) { /* no token: let the server decide — 401 is handled below */ }
      return {};
    }

    function apiError(message, res, data) {
      const e = new Error(message);
      e.status = res.status;
      e.data = data;
      return e;
    }

    // Every /api/* call goes through here, so no call site can miss the header.
    // /healthz is not routed through it and stays anonymous.
    async function callApi(path, body, resultsEl, btnEl) {
      resultsEl.innerHTML = '<p><span class="loading"></span> Fetching live data…</p>';
      btnEl.disabled = true;
      try {
        // Headers first, before the request is built: getSession() may quietly
        // refresh an expired token.
        const headers = Object.assign({ 'Content-Type': 'application/json' }, await authHeaders());
        const res = await fetch(path, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body)
        });
        // Read as text and parse by hand: this app's own errors come back as plain
        // text from http.Error (including the CLI's stderr), and the auth layer in
        // front of the API is not guaranteed to answer with JSON either. The status
        // has to survive onto the Error object regardless, or errorHTML cannot tell
        // an auth or quota rejection from an ordinary upstream failure.
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); }
        catch { throw apiError(text.slice(0, 300) || ('HTTP ' + res.status), res, null); }
        if (!res.ok) throw apiError(data && data.error ? data.error : text.slice(0, 300), res, data);
        return data;
      } finally {
        btnEl.disabled = false;
      }
    }

    // Bridge to the module script at the end of this file: the sign-in button
    // inside a 401 error card is built as an HTML string, so it reaches this
    // through the delegated click listener (data-action="pubveraSignIn").
    function pubveraSignIn() {
      if (window.pubveraAuth) window.pubveraAuth.signIn();
    }

    // resets_at arrives as an ISO timestamp; show it in the reader's own locale
    // and fall back to the raw value when it is not a parseable date.
    function resetsAtText(v) {
      if (!v) return '';
      const t = new Date(v);
      return isNaN(t.getTime())
        ? String(v)
        : t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }

    // 401/403/503 come from the auth and quota layer in front of the API and each
    // one means something different to the user; every other failure keeps the
    // previous behaviour of showing the error text in the one-line red box.
    function errorHTML(err) {
      const st = err && err.status, d = (err && err.data) || {};
      if (st === 401 && window.pubveraAuth && window.pubveraAuth.unavailable) {
        // The Supabase script did not load, so a sign-in prompt could not work.
        return '<div class="errcard"><h4>Sign-in required</h4>' +
          '<p>Sign-in is unavailable: a required script did not load.</p></div>';
      }
      if (st === 401) {
        // The raw error ("missing/invalid token") tells the user nothing they can
        // act on, and the remedy is always the same, so it is not shown.
        const btn = (window.pubveraAuth && window.pubveraAuth.enabled)
          ? '<button type="button" class="btn" data-action="pubveraSignIn">Sign in with Google</button>'
          : '';
        return '<div class="errcard"><h4>Sign-in required</h4>' +
          '<p>Please sign in to run this search.</p>' + btn + '</div>';
      }
      if (st === 403) {
        // A valid token that is not allowed through: either the plan does not
        // include this app, or the period's quota is used up. Upgrading is the way
        // out of both, but prices belong on the pricing page, not here.
        if (String(d.reason || '') === 'app_locked') {
          return '<div class="errcard"><h4>Not included in your plan</h4>' +
            '<p>Grantvera is not part of your current plan. Upgrading your plan unlocks it.</p></div>';
        }
        let msg = 'You have used up the searches included in your plan for this period.';
        const resets = resetsAtText(d.resets_at);
        if (resets) msg += ' Your quota resets on ' + resets + '.';
        msg += ' Upgrading your plan raises the limit.';
        return '<div class="errcard"><h4>Usage limit reached</h4><p>' + esc(msg) + '</p></div>';
      }
      if (st === 503) {
        // The quota service could not be reached, or this server is at capacity
        // (writeCLIError returns 503 when every CLI slot is taken). Either way the
        // user did nothing wrong, so this must not read as their failure.
        return '<div class="errcard"><h4>Temporarily unavailable</h4>' +
          '<p>The service is temporarily unavailable. Please try again in a moment.</p></div>';
      }
      return '<div class="error-box">⚠ ' + esc(err && err.message ? err.message : String(err)) + '</div>';
    }
    function showError(el, err) {
      el.innerHTML = errorHTML(err);
    }

    // --- OPEN GRANTS ----------------------------------------------------------
    async function runOpen() {
      const query = document.getElementById('open-query').value.trim();
      const out = document.getElementById('open-results');
      if (!query) { out.innerHTML = '<div class="error-box">Please enter a search query.</div>'; return; }
      const body = { query, rows: +document.getElementById('open-rows').value };
      const before = document.getElementById('open-before').value;
      const agency = document.getElementById('open-agency').value;
      if (before) body.closing_before = before;
      if (agency) body.agency = agency;
      try {
        const d = await callApi('/api/search', body, out, document.getElementById('open-btn'));
        const params = { before, agency, rows: sentRows(body.rows) };
        bindModule('open', d.opportunities || [], query, params, { total: d.totalHits, source: 'open', keywordHits: d.keyword_hits });
        renderResult('open', out, 'grantvera-open-grants.json');
      } catch (err) { showError(out, err); }
    }

    // --- NIH ------------------------------------------------------------------
    async function runNIH() {
      const query = document.getElementById('nih-query').value.trim();
      const out = document.getElementById('nih-results');
      if (!query) { out.innerHTML = '<div class="error-box">Please enter a search query.</div>'; return; }
      const body = { query, rows: +document.getElementById('nih-rows').value };
      const min = +document.getElementById('nih-min').value;
      const year = document.getElementById('nih-year').value;
      if (min > 0) body.min_amount = min;
      if (year) body.year = +year;
      try {
        const d = await callApi('/api/nih', body, out, document.getElementById('nih-btn'));
        const params = { min, year, rows: sentRows(body.rows) };
        bindModule('nih', d.projects || [], query, params, { total: d.total, typical: d.typical_award, includeCenters: d.include_centers, year: year ? +year : 0 });
        renderResult('nih', out, 'grantvera-nih-awards.json');
      } catch (err) { showError(out, err); }
    }

    // --- NSF ------------------------------------------------------------------
    async function runNSF() {
      const query = document.getElementById('nsf-query').value.trim();
      const out = document.getElementById('nsf-results');
      if (!query) { out.innerHTML = '<div class="error-box">Please enter a search query.</div>'; return; }
      const body = { query, rows: +document.getElementById('nsf-rows').value };
      const min = +document.getElementById('nsf-min').value;
      if (min > 0) body.min_amount = min;
      try {
        const d = await callApi('/api/nsf', body, out, document.getElementById('nsf-btn'));
        const params = { min, rows: sentRows(body.rows) };
        bindModule('nsf', d.awards || [], query, params, { relevance: d.relevance });
        renderResult('nsf', out, 'grantvera-nsf-awards.json');
      } catch (err) { showError(out, err); }
    }

    // --- build version --------------------------------------------------------
    // The footer shows the CalVer version from GET /version (version.go). Only
    // textContent is written, and a failed fetch leaves the footer without a
    // version. Started from the listener so that evaluating this file (as
    // tools/export_test.js does) touches no DOM and fetches nothing.
    function loadAppVersion() {
      fetch('/version', { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : Promise.reject()))
        .then(d => {
          if (d && typeof d.version === 'string' && d.version) {
            document.getElementById('app-version').textContent = 'Grantvera v' + d.version;
          }
        })
        .catch(() => { /* leave the footer without a version */ });
    }
    document.addEventListener('DOMContentLoaded', loadAppVersion);
