import { getPrinterBatches } from "@/lib/admin";
import { BatchActions } from "./batch-actions";

export const dynamic = "force-dynamic";

export default async function BatchesPage() {
  const { data: batches } = await getPrinterBatches();

  const statusColors: Record<string, string> = {
    queued: "bg-gray-100 text-gray-700",
    at_printer: "bg-yellow-100 text-yellow-700",
    returned: "bg-green-100 text-green-700",
  };

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Printer Batches</h1>
      </div>

      <div className="space-y-4">
        {batches.map((batch: any) => (
          <div key={batch.id} className="bg-white rounded-xl border p-4">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="font-bold">{batch.batch_name}</h3>
                <p className="text-sm text-gray-500">
                  {batch.screen_printer === "printer_1" ? "Printer 1" : "Printer 2"}
                  {batch.printer_batch_backs?.length > 0 &&
                    ` \u2022 ${batch.printer_batch_backs.length} backs`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  statusColors[batch.status] || "bg-gray-100"
                }`}>
                  {batch.status.replace("_", " ")}
                </span>
                <BatchActions batchId={batch.id} currentStatus={batch.status} />
              </div>
            </div>
            {batch.sent_at && (
              <p className="text-xs text-gray-400 mt-2">
                Sent: {new Date(batch.sent_at).toLocaleDateString()}
                {batch.returned_at &&
                  ` | Returned: ${new Date(batch.returned_at).toLocaleDateString()}`}
              </p>
            )}
          </div>
        ))}

        {batches.length === 0 && (
          <p className="text-gray-400 text-center py-8">No batches yet</p>
        )}
      </div>
    </div>
  );
}
