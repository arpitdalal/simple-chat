/** Small role icons — Raycast-style, no USER/ASSISTANT chrome. */
export function UserIcon() {
  return (
    <span className="role-icon user" aria-hidden>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="8" r="4" fill="currentColor" />
        <path
          d="M4 20c0-4 3.6-7 8-7s8 3 8 7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export function AiIcon() {
  return (
    <span className="role-icon ai" aria-hidden>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2l1.2 6.3L19 12l-5.8 3.7L12 22l-1.2-6.3L5 12l5.8-3.7L12 2z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}
