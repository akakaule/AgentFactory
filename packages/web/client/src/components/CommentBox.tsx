import { useState } from 'react';

interface Props {
  onSubmit: (text: string) => void;
}

export function CommentBox({ onSubmit }: Props) {
  const [text, setText] = useState('');

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText('');
  };

  return (
    <div className="af-cbox">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a comment…"
        rows={3}
      />
      <div className="row">
        <button className="af-btn-primary" style={{ height: 32 }} onClick={handleSubmit}>
          Comment
        </button>
      </div>
    </div>
  );
}
