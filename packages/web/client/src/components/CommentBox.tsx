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
    <div style={{ marginTop: '16px' }}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a comment…"
        rows={3}
        style={{ width: '100%', boxSizing: 'border-box', padding: '8px', resize: 'vertical' }}
      />
      <button onClick={handleSubmit} style={{ marginTop: '4px' }}>
        Comment
      </button>
    </div>
  );
}
