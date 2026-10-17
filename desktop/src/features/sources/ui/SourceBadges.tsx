import { memo, useState } from "react";
import { previewOnlyFor } from "../buildResults";
import { SOURCES, playsViaYoutube, type SourceId, type SourceVariant } from "../types";

export interface SourceBadgesProps {
  source: SourceId;
  previewOnly?: boolean;
  // every copy of the track across sources, including the current one
  variants?: SourceVariant[];
  onPickVariant?: (variant: SourceVariant) => void;
}

const FONT = { fontFamily: "var(--font-inter), sans-serif" } as const;

function tint(color: string, percent: number) {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

function Pill({
  source,
  previewOnly,
  onClick,
  title,
}: {
  source: SourceId;
  previewOnly?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const info = SOURCES[source];
  if (!title) {
    if (previewOnly) title = `${info.label} · prévia de 30s`;
    else if (playsViaYoutube(source)) title = `${info.label} · toca a música inteira pelo YouTube`;
  }
  const content = (
    <>
      <span className="h-[6px] w-[6px] rounded-full shrink-0" style={{ backgroundColor: info.color }} />
      <span>{info.label}</span>
      {previewOnly ? <span className="opacity-70">30s</span> : null}
    </>
  );
  const className =
    "flex items-center gap-[5px] rounded-[5px] px-[7px] py-[3px] text-[11px] leading-none whitespace-nowrap border-0";
  const style = { ...FONT, color: info.color, backgroundColor: tint(info.color, 14) };

  if (!onClick) {
    return (
      <span className={className} style={style} title={title}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${className} cursor-pointer transition-opacity hover:opacity-80`}
      style={style}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {content}
    </button>
  );
}

// "YouTube" pill at the end of a search row, plus a "+2" chip when the same song exists on other sources.
// clicking the chip expands the other sources, clicking one of them plays that copy
function SourceBadges({ source, previewOnly, variants, onPickVariant }: SourceBadgesProps) {
  const [expanded, setExpanded] = useState(false);
  const others = (variants ?? []).filter((v) => v.source !== source);

  return (
    <div
      className="flex items-center gap-[5px] shrink-0"
      data-prevent-drag
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {expanded
        ? others.map((v) => (
            <Pill
              key={v.id}
              source={v.source}
              previewOnly={v.previewOnly}
              onClick={() => onPickVariant?.(v)}
            />
          ))
        : null}

      {others.length > 0 ? (
        <button
          type="button"
          aria-label={`Also on ${others.map((v) => SOURCES[v.source].label).join(", ")}`}
          title={`Also on ${others.map((v) => SOURCES[v.source].label).join(", ")}`}
          className="flex items-center gap-[4px] rounded-[5px] px-[6px] py-[3px] text-[11px] leading-none text-text-secondary bg-border-alpha-14 border-0 cursor-pointer transition-colors hover:text-text-primary"
          style={FONT}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          <span className="flex items-center">
            {others.slice(0, 3).map((v, i) => (
              <span
                key={v.source}
                className="h-[6px] w-[6px] rounded-full"
                style={{ backgroundColor: SOURCES[v.source].color, marginLeft: i === 0 ? 0 : -2 }}
              />
            ))}
          </span>
          <span>{expanded ? "−" : `+${others.length}`}</span>
        </button>
      ) : null}

      <Pill source={source} previewOnly={previewOnlyFor({ source, previewOnly })} />
    </div>
  );
}

export default memo(SourceBadges);
