import type { ReactNode } from "react";

import { splitInlineCode } from "./composerSend.logic";

/** A move toast's text, with each path as code on its own line. */
export function threadMoveToastDescription(text: string): ReactNode {
  const parts = splitInlineCode(text);
  if (parts.every((part) => !part.code)) return text;
  return parts.map((part, index) =>
    part.code ? (
      // oxlint-disable-next-line react/no-array-index-key -- the parts of one fixed sentence
      <code key={index} className="block break-all font-mono text-xs">
        {part.text}
      </code>
    ) : (
      // oxlint-disable-next-line react/no-array-index-key -- the parts of one fixed sentence
      <span key={index}>{part.text}</span>
    ),
  );
}
