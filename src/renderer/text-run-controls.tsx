import { useState } from 'react';
import type { DesignNode } from '../shared/design';
import type { TextRun } from '../shared/text-runs';

export function TextRunControls({
  node,
  disabled,
  update,
}: {
  node: DesignNode;
  disabled: boolean;
  update: (patch: Partial<DesignNode>) => void;
}) {
  const [selected, select] = useState(0);
  const runs = node.textRuns ?? [];
  const index = Math.min(selected, Math.max(0, runs.length - 1));
  const run = runs[index];
  const gapStart = runs.find(
    (value, i) => value.start > (runs[i - 1]?.end ?? 0),
  );
  const start = gapStart
    ? (runs[runs.indexOf(gapStart) - 1]?.end ?? 0)
    : (runs.at(-1)?.end ?? 0);
  const end = gapStart?.start ?? node.text.length;
  const edit = (patch: Partial<TextRun>) =>
    update({
      textRuns: runs.map((value, i) =>
        i === index ? { ...value, ...patch } : value,
      ),
    });
  return (
    <>
      <label>
        Styled range
        <select
          disabled={disabled || !runs.length}
          value={index}
          onChange={(event) => select(Number(event.target.value))}
        >
          {!runs.length && <option value={0}>None</option>}
          {runs.map((value, i) => (
            <option key={i} value={i}>
              {value.start + 1}-{value.end}:{' '}
              {node.text.slice(value.start, value.end).slice(0, 24)}
            </option>
          ))}
        </select>
      </label>
      {run && (
        <div className="field-grid">
          {(['start', 'end', 'fontSize', 'fontWeight'] as const).map(
            (field) => {
              const value =
                run[field] ??
                node[field === 'fontSize' ? 'fontSize' : 'fontWeight'] ??
                400;
              return (
                <label key={field}>
                  {
                    {
                      start: 'Start offset',
                      end: 'End offset',
                      fontSize: 'Range size',
                      fontWeight: 'Range weight',
                    }[field]
                  }
                  <input
                    key={`${index}-${field}-${value}`}
                    type="number"
                    defaultValue={value}
                    disabled={disabled}
                    onBlur={(event) => {
                      const next = Number(event.target.value);
                      const valid =
                        event.target.value &&
                        Number.isFinite(next) &&
                        (field === 'start'
                          ? Number.isInteger(next) &&
                            next >= 0 &&
                            next < run.end &&
                            (index === 0 || next >= runs[index - 1].end)
                          : field === 'end'
                            ? Number.isInteger(next) &&
                              next > run.start &&
                              next <=
                                (runs[index + 1]?.start ?? node.text.length)
                            : next >= 1 &&
                              next <= (field === 'fontSize' ? 500 : 1000));
                      if (valid && next !== value) edit({ [field]: next });
                      else event.target.value = String(value);
                    }}
                  />
                </label>
              );
            },
          )}
          <label>
            Range family
            <input
              key={`${index}-${run.fontFamily}`}
              defaultValue={run.fontFamily ?? node.fontFamily ?? 'Arial'}
              disabled={disabled}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value) edit({ fontFamily: value });
              }}
            />
          </label>
          <label>
            Range color
            <input
              type="color"
              value={run.fill ?? node.fill}
              disabled={disabled}
              onChange={(event) => edit({ fill: event.target.value })}
            />
          </label>
          <label>
            Range style
            <select
              value={run.fontStyle ?? node.fontStyle ?? 'normal'}
              disabled={disabled}
              onChange={(event) =>
                edit({ fontStyle: event.target.value as TextRun['fontStyle'] })
              }
            >
              <option value="normal">Normal</option>
              <option value="italic">Italic</option>
            </select>
          </label>
          <label>
            Decoration
            <select
              value={run.decoration ?? 'none'}
              disabled={disabled}
              onChange={(event) =>
                edit({
                  decoration: event.target.value as TextRun['decoration'],
                })
              }
            >
              <option value="none">None</option>
              <option value="underline">Underline</option>
              <option value="line-through">Strikethrough</option>
            </select>
          </label>
        </div>
      )}
      <div className="field-grid">
        <button
          disabled={disabled || start >= end}
          onClick={() => {
            const next = [...runs, { start, end }].sort(
              (a, b) => a.start - b.start,
            );
            select(next.findIndex((value) => value.start === start));
            update({ textRuns: next });
          }}
        >
          Add styled range
        </button>
        <button
          disabled={disabled || !run}
          onClick={() =>
            update({ textRuns: runs.filter((_, i) => i !== index) })
          }
        >
          Remove range
        </button>
      </div>
    </>
  );
}
