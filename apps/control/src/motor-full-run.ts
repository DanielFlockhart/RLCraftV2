export type MotorTrialResult = {
  episode: number;
  trials: number;
  successes: number;
};

/** Later continuation segments replace replayed episodes from an older checkpoint. */
export function summarizeMotorTrials(
  segments: MotorTrialResult[][],
  episodes: number,
) {
  const byEpisode = new Map<number, MotorTrialResult>();
  for (const segment of segments)
    for (const trial of segment)
      byEpisode.set(trial.episode, trial);
  const recent = [...byEpisode.values()]
    .sort((a, b) => a.episode - b.episode)
    .slice(-episodes);
  const total = recent.reduce((sum, trial) => sum + trial.trials, 0);
  return {
    episodeCount: recent.length,
    successRate: total
      ? recent.reduce((sum, trial) => sum + trial.successes, 0) / total
      : 0,
  };
}
