import { Fragment, useEffect, useRef } from "react";
import useStore from "../store/index.js";
import MessageBubble from "./MessageBubble.jsx";

export default function ChatPanel() {
  const messages = useStore((s) => s.messages);
  const restoredCount = useStore((s) => s.restoredCount);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, messages[messages.length - 1]?.text]);

  return (
    <div className="chat-panel">
      {messages.length === 0 && (
        <div className="chat-empty">
          Hello! My name is HuRI, how can I help you?
          <br />
          Type a message or use the mic to get started.
        </div>
      )}
      {messages.map((m, i) => (
        <Fragment key={m.id}>
          <MessageBubble message={m} />
          {restoredCount > 0 && i === restoredCount - 1 && (
            // Boundary between what this device remembered (persist.js) and
            // this page load's live session: HuRI's per-connection short-term
            // history restarted here — only what it saved to long-term memory
            // when the previous session ended carries over.
            <div className="chat-divider" role="separator">
              restored from this device · HuRI's short-term context restarts here
            </div>
          )}
        </Fragment>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
