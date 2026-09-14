export function startScheduler(run: () => Promise<void>, intervalMs = 60_000) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000)
    throw new Error('INVALID_SCHEDULE_INTERVAL');
  let pending: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped || pending) return;
    pending = Promise.resolve()
      .then(run)
      .catch(() => {
        console.error(JSON.stringify({ event: 'maintenance_incomplete' }));
      })
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  };
}
