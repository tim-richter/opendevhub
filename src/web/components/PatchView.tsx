import { Fragment, type ReactNode, useMemo } from "react";
import { anchorFor, type LineAnchor, parsePatch } from "../review";

/** A unified diff with old and new line numbers. Clicking a number reports that line's comment anchor. */
export function DiffView(props: { patch: string; onAnchor?: (anchor: LineAnchor) => void; renderAfter?: (key: string) => ReactNode }) {
  const hunks = useMemo(() => parsePatch(props.patch), [props.patch]);
  if (hunks.length === 0) return <pre className="diff-raw">{props.patch}</pre>;
  return (
    <table className="diff">
      <tbody>
        {hunks.map((hunk, h) => (
          <Fragment key={h}>
            <tr className="diff-hunk">
              <td colSpan={3}>{hunk.header}</td>
            </tr>
            {hunk.lines.map((line, i) => {
              const anchor = anchorFor(hunk.lines, i);
              const after = props.renderAfter?.(anchor.key);
              const number = (n: number | undefined) =>
                n === undefined ? null : props.onAnchor ? (
                  <button type="button" className="diff-no" title="Comment on this line" onClick={() => props.onAnchor!(anchor)}>
                    {n}
                  </button>
                ) : (
                  n
                );
              return (
                <Fragment key={i}>
                  <tr className={`diff-line ${line.kind}`}>
                    <td className="diff-num">{number(line.oldNo)}</td>
                    <td className="diff-num">{number(line.newNo)}</td>
                    <td className="diff-text">
                      <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
                      {line.text}
                    </td>
                  </tr>
                  {after && (
                    <tr className="diff-after">
                      <td colSpan={3}>{after}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
