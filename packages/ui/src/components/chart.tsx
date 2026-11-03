"use client"

import * as React from "react"
import * as RechartsPrimitive from "recharts"
import { cn } from "../lib/utils"

/*
 * shadcn's chart: a recharts container that knows each series' label and
 * colour (ChartConfig), plus a tooltip and legend drawn with the theme.
 * Colours come from CSS variables, so charts follow light and dark mode.
 */

export type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode
    icon?: React.ComponentType
    color?: string
  }
}

type ChartContextProps = { config: ChartConfig }

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)
  if (!context) throw new Error("useChart must be used within a <ChartContainer />")
  return context
}

function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"]
}) {
  const uniqueId = React.useId()
  const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
          className
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colors = Object.entries(config).filter(([, c]) => c.color)
  if (!colors.length) return null
  // Only colours from our own config (never user input) go into this style.
  const css = `[data-chart=${id}] {\n${colors.map(([key, c]) => `  --color-${key}: ${c.color};`).join("\n")}\n}`
  return <style>{css}</style>
}

const ChartTooltip = RechartsPrimitive.Tooltip

type TooltipItem = {
  name?: string | number
  value?: number | string
  dataKey?: string | number
  color?: string
  payload?: Record<string, unknown> & { fill?: string }
}

function ChartTooltipContent({
  active,
  payload,
  label,
  className,
  hideLabel = false,
  labelFormatter,
  valueFormatter,
}: {
  active?: boolean
  payload?: TooltipItem[]
  label?: React.ReactNode
  className?: string
  hideLabel?: boolean
  labelFormatter?: (label: React.ReactNode) => React.ReactNode
  valueFormatter?: (value: number | string) => React.ReactNode
}) {
  const { config } = useChart()
  if (!active || !payload?.length) return null
  return (
    <div className={cn("grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl", className)}>
      {!hideLabel ? <div className="font-medium">{labelFormatter ? labelFormatter(label) : label}</div> : null}
      <div className="grid gap-1.5">
        {payload.map((item) => {
          const key = String(item.dataKey ?? item.name ?? "value")
          const itemConfig = config[key] ?? config[String(item.name)]
          const color = item.color ?? item.payload?.fill ?? `var(--color-${key})`
          return (
            <div key={key} className="flex w-full items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />
              <span className="flex-1 text-muted-foreground">{itemConfig?.label ?? item.name}</span>
              <span className="font-mono font-medium text-foreground tabular-nums">
                {item.value === undefined ? "" : valueFormatter ? valueFormatter(item.value) : item.value.toLocaleString()}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const ChartLegend = RechartsPrimitive.Legend

function ChartLegendContent({
  className,
  payload,
}: {
  className?: string
  payload?: { value?: string; dataKey?: string | number; color?: string }[]
}) {
  const { config } = useChart()
  if (!payload?.length) return null
  return (
    <div className={cn("flex items-center justify-center gap-4 pt-3", className)}>
      {payload.map((item) => {
        const key = String(item.dataKey ?? item.value ?? "value")
        return (
          <div key={key} className="flex items-center gap-1.5">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
            <span className="text-muted-foreground">{config[key]?.label ?? item.value}</span>
          </div>
        )
      })}
    </div>
  )
}

export { ChartContainer, ChartLegend, ChartLegendContent, ChartStyle, ChartTooltip, ChartTooltipContent }
