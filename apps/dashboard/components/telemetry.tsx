"use client";
import { Activity } from "lucide-react";
import {
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
export const format = (n: number, d = 1) =>
  Number.isFinite(n) ? n.toFixed(d) : "?";
export function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      <span />
      {status}
    </span>
  );
}
export function Chart({
  data,
  field,
  color = "#72e0ac",
  label,
}: {
  data: Array<Record<string, number>>;
  field: string;
  color?: string;
  label: string;
}) {
  if (!data.length)
    return (
      <div className="chart-empty">
        <Activity size={23} />
        <p>No samples yet</p>
        <small>Start a run to collect {label.toLowerCase()}.</small>
      </div>
    );
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 10, right: 12, left: -24, bottom: 0 }}
        >
          <defs>
            <linearGradient
              id={`gradient-${field}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="#25332f"
            vertical={false}
            strokeDasharray="3 5"
          />
          <XAxis
            dataKey="at"
            tickFormatter={(v) =>
              new Date(v).toLocaleTimeString([], {
                minute: "2-digit",
                second: "2-digit",
              })
            }
            minTickGap={60}
            stroke="#788b82"
            fontSize={10}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke="#788b82"
            fontSize={10}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            contentStyle={{
              background: "#17231d",
              border: "1px solid #35483c",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={(v) => new Date(Number(v)).toLocaleTimeString()}
            formatter={(v) => [format(Number(v)), label]}
          />
          <Area
            type="monotone"
            dataKey={field}
            stroke={color}
            strokeWidth={2}
            fill={`url(#gradient-${field})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
