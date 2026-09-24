"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { DailyPoint } from "@/server/services/stats";

const leadsConfig = { leads: { label: "Leads", color: "var(--chart-1)" } } satisfies ChartConfig;
const costConfig = {
  cost: { label: "Agent spend", color: "var(--chart-1)" },
} satisfies ChartConfig;

const shortDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** Visually hidden table so the data is never chart-only (screen readers, copy/paste). */
function DataTable({
  data,
  field,
  label,
  format,
}: {
  data: DailyPoint[];
  field: keyof DailyPoint;
  label: string;
  format: (v: number) => string;
}) {
  return (
    <table className="sr-only">
      <caption>{label} per day</caption>
      <thead>
        <tr>
          <th>Day</th>
          <th>{label}</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.day}>
            <td>{d.day}</td>
            <td>{format(d[field] as number)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LeadsPerDayChart({ data }: { data: DailyPoint[] }) {
  return (
    <>
      <ChartContainer config={leadsConfig} className="aspect-auto h-52 w-full" aria-hidden>
        <BarChart data={data} margin={{ left: -20, right: 4, top: 8 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} strokeOpacity={0.5} />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={shortDay}
          />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
          <ChartTooltip
            cursor={{ fillOpacity: 0.4 }}
            content={<ChartTooltipContent labelFormatter={(v) => shortDay(String(v))} />}
          />
          <Bar
            isAnimationActive={false}
            dataKey="leads"
            fill="var(--color-leads)"
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
          />
        </BarChart>
      </ChartContainer>
      <DataTable data={data} field="leads" label="Leads" format={String} />
    </>
  );
}

export function SpendPerDayChart({ data }: { data: DailyPoint[] }) {
  const usd = (v: number) => `$${v.toFixed(v < 1 ? 3 : 2)}`;
  return (
    <>
      <ChartContainer config={costConfig} className="aspect-auto h-52 w-full" aria-hidden>
        <AreaChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
          <defs>
            <linearGradient id="fillCost" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-cost)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="var(--color-cost)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeOpacity={0.5} />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={shortDay}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={60}
            tickFormatter={(v: number) => usd(v)}
          />
          <ChartTooltip
            cursor={{ strokeDasharray: "3 3" }}
            content={
              <ChartTooltipContent
                labelFormatter={(v) => shortDay(String(v))}
                formatter={(value) => (
                  <span className="flex w-full justify-between gap-4">
                    <span className="text-muted-foreground">Agent spend</span>
                    <span className="font-mono tabular-nums">{usd(Number(value))}</span>
                  </span>
                )}
              />
            }
          />
          <Area
            isAnimationActive={false}
            dataKey="cost"
            type="monotone"
            stroke="var(--color-cost)"
            strokeWidth={2}
            fill="url(#fillCost)"
            dot={false}
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ChartContainer>
      <DataTable data={data} field="cost" label="Agent spend (USD)" format={usd} />
    </>
  );
}
