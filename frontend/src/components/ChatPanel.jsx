import { useEffect, useRef } from "react";
import useStore from "../store/index.js";
import MessageBubble from "./MessageBubble.jsx";

export default function ChatPanel() {
  const messages = useStore((s) => s.messages);
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
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
