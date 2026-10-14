export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

export function formatDate(epoch: number): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}
