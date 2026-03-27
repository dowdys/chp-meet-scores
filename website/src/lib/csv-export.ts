/**
 * Generate CSV string from array of objects.
 */
export function toCSV(data: Record<string, unknown>[], columns?: string[]): string {
  if (data.length === 0) return "";
  const cols = columns || Object.keys(data[0]);
  const header = cols.join(",");
  const rows = data.map((row) =>
    cols
      .map((col) => {
        const val = String(row[col] ?? "");
        // Escape quotes and wrap in quotes if contains comma/newline/quote
        if (val.includes(",") || val.includes("\n") || val.includes('"')) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      })
      .join(",")
  );
  return [header, ...rows].join("\n");
}

/**
 * Trigger CSV download in the browser.
 */
export function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
