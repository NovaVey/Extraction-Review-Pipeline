// Hand-rolled rather than a new dependency — CSV quoting is a handful of rules
// (RFC 4180): quote a field if it contains a comma, a quote, or a newline, and
// double up any internal quotes. Small enough that a library isn't justified.
function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return escapeCsvField(String(value));
}

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(toCsvValue).join(',')];
  for (const row of rows) {
    lines.push(row.map(toCsvValue).join(','));
  }
  // CRLF per RFC 4180; trailing newline so the file ends cleanly.
  return lines.join('\r\n') + '\r\n';
}
