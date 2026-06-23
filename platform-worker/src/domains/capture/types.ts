export type CaptureDestination = { type: 'saved-list' };

export type CaptureTokenRecord = { roomId: string; destinationType: 'saved-list' };

export interface CaptureRecord {
  id: string;
  url: string;
  title: string;
  note: string;
  ts: string;
  source: string;
}
