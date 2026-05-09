import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import type { Trade } from "../hooks/useApi";

const column = createColumnHelper<Trade>();
const columns = [
  column.accessor("trade_date", { header: "Trade Date" }),
  column.accessor("politician_name", { header: "Politician" }),
  column.accessor("ticker", { header: "Ticker", cell: (info) => info.getValue() ?? "N/A" }),
  column.accessor("direction", { header: "Direction" }),
  column.accessor("amount_range", { header: "Amount", cell: (info) => info.getValue() ?? "N/A" }),
  column.accessor("source", { header: "Source" })
];

export default function TradeTable({ trades }: { trades: Trade[] }) {
  const table = useReactTable({ data: trades, columns, getCoreRowModel: getCoreRowModel() });
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <table className="w-full text-left text-sm">
        <thead className="bg-[#1b202b] text-xs uppercase text-muted">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} className="px-3 py-3 font-medium">
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className="divide-y divide-line">
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="hover:bg-[#171c26]">
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-3 py-3 text-ink">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
