export type GameState = 'HOME' | 'PREP' | 'PLAYING' | 'RESULT';

export interface ScoreData {
  time: number;
  difference: number;
  status: 'GODLIKE' | 'SUCCESS' | 'FAIL';
}
