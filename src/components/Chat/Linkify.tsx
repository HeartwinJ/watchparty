import React from "react";
import { splitLinks } from "./links";

/** Renders text with links opened safely in a new tab. */
export const Linkify = ({ text }: { text?: string }) => {
  if (!text) {
    return null;
  }
  return (
    <>
      {splitLinks(text).map((part, i) =>
        part.type === "link" ? (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        ) : (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        ),
      )}
    </>
  );
};
