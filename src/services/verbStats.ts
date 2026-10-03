import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'irregular-verbs.stats.v1';
const BEST_SCORES_KEY = 'irregular-verbs.best-scores.v1';

export type VerbStat = {
  attempts: number;
  correct: number;
  responseCount: number;
  responseMsTotal: number;
};

export type Stats = Record<string, VerbStat>;
export type BestScores = Record<number, number>;

export async function loadBestScores(): Promise<BestScores> {
  try {
    const stored = await AsyncStorage.getItem(BEST_SCORES_KEY);
    return stored ? (JSON.parse(stored) as BestScores) : {};
  } catch {
    return {};
  }
}

export async function saveBestScore(listId: number, score: number): Promise<BestScores> {
  const bestScores = await loadBestScores();
  const updated = { ...bestScores, [listId]: Math.max(bestScores[listId] ?? 0, score) };
  await AsyncStorage.setItem(BEST_SCORES_KEY, JSON.stringify(updated));
  return updated;
}

export async function loadStats(): Promise<Stats> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as Stats) : {};
  } catch {
    return {};
  }
}

export async function saveStats(stats: Stats): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
}

export function addAttempt(
  stats: Stats,
  verbId: string,
  correct: boolean,
  responseMs: number | null,
): Stats {
  const previous = stats[verbId] ?? { attempts: 0, correct: 0, responseCount: 0, responseMsTotal: 0 };
  return {
    ...stats,
    [verbId]: {
      attempts: previous.attempts + 1,
      correct: previous.correct + (correct ? 1 : 0),
      responseCount: previous.responseCount + (responseMs === null ? 0 : 1),
      responseMsTotal: previous.responseMsTotal + (responseMs ?? 0),
    },
  };
}