'use client';

import { useState, type FormEvent } from 'react';

export function ContactForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') ?? '').trim();
    const email = String(data.get('email') ?? '').trim();
    if (!name || !email.includes('@')) {
      setError('Please enter your name and a valid email.');
      return;
    }
    setError(null);
    setSentTo(name);
  }

  if (sentTo) return <p role="status">Thanks, {sentTo}! We will reply soon.</p>;
  return (
    <form onSubmit={onSubmit} aria-label="Contact form" noValidate>
      <label>
        Name <input name="name" />
      </label>
      <label>
        Email <input name="email" type="email" />
      </label>
      <label>
        Message <textarea name="message" />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit">Send</button>
    </form>
  );
}
