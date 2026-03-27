"use client";

import { toCSV, downloadCSV } from "@/lib/csv-export";

interface CSVExportButtonProps {
  data: Record<string, unknown>[];
  filename: string;
  columns?: string[];
  label?: string;
}

export function CSVExportButton({
  data,
  filename,
  columns,
  label = "Export CSV",
}: CSVExportButtonProps) {
  const handleExport = () => {
    const csv = toCSV(data, columns);
    downloadCSV(csv, filename);
  };

  return (
    <button
      onClick={handleExport}
      disabled={data.length === 0}
      className="bg-gray-100 text-gray-700 px-3 py-1.5 rounded text-sm hover:bg-gray-200 disabled:opacity-50"
    >
      {label}
    </button>
  );
}
