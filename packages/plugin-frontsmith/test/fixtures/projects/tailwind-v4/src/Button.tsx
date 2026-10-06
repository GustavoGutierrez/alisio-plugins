export function Button({ label }: { label: string }) {
  return (
    <button type="button" className="rounded bg-brand px-3 py-1 text-white">
      {label}
    </button>
  );
}
