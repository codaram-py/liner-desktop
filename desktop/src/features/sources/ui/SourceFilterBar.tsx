import { memo } from "react";
import { SOURCES, SOURCE_ORDER, type SourceId } from "../types";
import type { SourceFilter } from "../buildResults";

export interface SourceFilterBarProps {
  value: SourceFilter;
  onChange: (value: SourceFilter) => void;
  allLabel: string;
  previewLabel?: string;
  // how many 30s clips the current search found, shown on the "Prévia" chip
  previewCount?: number;
  counts?: Partial<Record<SourceId, number>>;
}

function SourceFilterBar({ value, onChange, allLabel, previewLabel = "Prévia", previewCount, counts }: SourceFilterBarProps) {
  const chip = (key: SourceFilter, label: string, opts: { color?: string; count?: number; right?: boolean } = {}) => {
    const isActive = value === key;
    return (
      <button
        key={key}
        type="button"
        onClick={() => onChange(key)}
        className={`flex items-center gap-[6px] px-[10px] py-[5px] rounded-[6px] text-[12px] leading-none border-0 cursor-pointer select-none shrink-0 transition-colors ${
          opts.right ? "ml-auto" : ""
        } ${
          isActive
            ? "bg-border-alpha-14 text-text-primary"
            : "bg-transparent text-text-tertiary hover:text-text-primary hover:bg-border-alpha-14"
        }`}
        style={{ fontFamily: "var(--font-inter), sans-serif" }}
      >
        {opts.color ? <span className="h-[7px] w-[7px] rounded-full" style={{ backgroundColor: opts.color }} /> : null}
        <span>{label}</span>
        {opts.count ? <span className="opacity-60">{opts.count}</span> : null}
      </button>
    );
  };

  return (
    <div className="flex gap-[4px] px-[14px] pb-[4px] shrink-0 overflow-x-auto" data-prevent-drag>
      {chip("all", allLabel)}
      {SOURCE_ORDER.map((source) => chip(source, SOURCES[source].label, { color: SOURCES[source].color, count: counts?.[source] }))}
      {chip("preview", previewLabel, { count: previewCount, right: true })}
    </div>
  );
}

export default memo(SourceFilterBar);
